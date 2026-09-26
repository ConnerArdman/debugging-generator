/**
 * The **adapter registry** of `@debuggen/instrumentation`: the single place
 * adapter identity is enumerated, and the extension point: *adding an adapter
 * means implementing {@link InstrumentationAdapter} and registering it, with
 * no orchestrator change.*
 *
 * ## What this module owns, and what it deliberately does not
 *
 * It owns three things and nothing else:
 *
 * - {@link ADAPTER_IDS}, the ids of the six built-in adapters. This tuple is
 *   the **only** enumeration of adapter identity in the repository:
 *   `./adapter.ts` types {@link InstrumentationAdapter.id} as a `string` and
 *   says so explicitly, `./schema/plan.ts` and `./schema/readiness.ts` keep
 *   their `adapter` fields bounded strings, and every other module that needs
 *   an id reads it off an adapter or a plan rather than restating a list.
 * - the mapping from an action type to the adapter that installs it and the
 *   mode it installs it in, read off each adapter's own claim declaration —
 *   see {@link AdapterClaimDeclaration} for why the declaration lives beside
 *   each implementation rather than in a table here.
 * - the registry object itself: {@link createAdapterRegistry},
 *   {@link AdapterRegistry} and the standalone {@link registerAdapter}.
 *
 * It does **not** own which adapters a session uses, how their actions are
 * ordered, or when they are installed. `./installer.ts` receives the adapters
 * it needs as an argument and looks each one up by the `adapter` field a
 * normalised plan carries, so a seventh adapter changes nothing there; and
 * because `resolveActionType` answers from claim declarations rather than from
 * a hand-written type-to-adapter table, a seventh adapter changes nothing here
 * beyond one entry in {@link ADAPTER_IDS} and one factory.
 *
 * ## Who calls this
 *
 * - `apps/local-service/src/instrumentation/service.ts` builds one registry per
 *   service process and hands the adapters it holds to the installer, the
 *   readiness gate and cleanup.
 * - `apps/local-service/src/pipeline/stages/plan.ts` passes the registry to
 *   `normalizePlan` as its `resolver`, which is why
 *   {@link AdapterRegistry} extends {@link PlanAdapterResolver}: normalisation
 *   asks one question — "which adapter claims this action type, and how does it
 *   install it?" — and the registry is the production answer. The same stage
 *   asks {@link AdapterRegistry.handling} and {@link AdapterRegistry.claimants}
 *   for the capability catalog the planning prompt is given, so a model is
 *   offered the signals this project can actually produce.
 * - `./feasibility.ts` takes the registry as its optional `resolver` and
 *   reports an action no adapter claims before anything is installed.
 * - `docs/ARCHITECTURE.md`'s adapter extension guide documents this surface:
 *   implement {@link InstrumentationAdapter}, declare `claims`, call
 *   {@link registerAdapter}.
 *
 * ## Why `schema/plan.ts` must never import this file
 *
 * Normalisation needs a resolver; a resolver needs adapters; adapters need the
 * plan vocabulary. Stated as imports that is a cycle, so `./schema/plan.ts`
 * declares the requirement **structurally** as {@link PlanAdapterResolver} and
 * this file satisfies it. The dependency therefore runs one way —
 * `schema/plan.ts` → `adapters/**` → this module → consumers — and the
 * registry can be replaced by an object literal in a suite without either side
 * importing the other.
 *
 * ## Importing this module registers nothing
 *
 * `package.json` declares `sideEffects: false` and this file keeps that true.
 * Module scope holds two frozen tables — a tuple of id strings and a record of
 * *factory references* — and no adapter instance: there is no top-level `new`,
 * no top-level call of a factory, no mutable module state, no environment
 * variable read, no filesystem or network access and no console use. Every
 * adapter is constructed inside {@link createAdapterRegistry}, which is what
 * lets a suite build a registry per test and a service build one per process
 * without either inheriting the other's state.
 */

import { DebuggenError, err, noopLogger, ok } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

import type { InstrumentationAdapter, InstrumentationContext } from './adapter.js';
import { isInstrumentationActionType, isInstrumentationMode } from './schema/plan.js';
import type {
  AdapterActionResolution,
  InstrumentationActionType,
  InstrumentationMode,
  PlanAdapterResolver,
} from './schema/plan.js';
import {
  BROWSER_PERFORMANCE_ADAPTER_ID,
  createBrowserPerformanceAdapter,
} from './adapters/browser-performance.js';
import { FETCH_ADAPTER_ID, createFetchAdapter } from './adapters/fetch.js';
import { NEXTJS_ADAPTER_ID, createNextJsAdapter } from './adapters/nextjs.js';
import { POSTGRES_ADAPTER_ID, createPostgresAdapter } from './adapters/postgres.js';
import { PRISMA_ADAPTER_ID, createPrismaAdapter } from './adapters/prisma.js';
import { REACT_ADAPTER_ID, createReactAdapter } from './adapters/react.js';

// ---------------------------------------------------------------------------
// Adapter identity
//
// The one enumeration of adapter identity in the product. Every
// member is imported from the module that implements it rather than spelled
// again here, so an id that moved is a compile error in this file instead of a
// plan whose actions resolve to an adapter the installer cannot look up.
// ---------------------------------------------------------------------------

/**
 * The ids of the six built-in adapters, **in the order they are registered**.
 *
 * The order is the resolution order: {@link AdapterRegistry.resolveActionType}
 * answers with the first registered adapter that claims a type and — when it
 * was given a context — can handle the project, so this tuple decides which of
 * two claimants of the same type is asked first. It is grouped by what an
 * adapter costs:
 *
 * 1. `'react'`, `'browser-performance'`, `'fetch'` — the page-agent adapters.
 *    Every signal they claim is a runtime hook, so they write nothing to a
 *    developer's working tree and come first for that reason.
 * 2. `'nextjs'` — the framework adapter, whose claims install as recorded,
 *    reversible patches and therefore cost a modification record.
 * 3. `'prisma'`, `'postgres'` — the database adapters, which claim the same
 *    action type as each other and are separated by
 *    {@link InstrumentationAdapter.canHandle}: each answers `true` only for a
 *    project whose code graph carries its own kind of database access. Where a
 *    project carries both, the ORM is asked first, because a query issued
 *    through it is the one a developer reads in their own source.
 *
 * Also the order {@link createAdapterRegistry} constructs the built-ins in:
 * the factory table is keyed by these ids and iterated in this order, so the
 * tuple is the single source of both facts.
 *
 * ## No membership predicate
 *
 * There is deliberately no `isAdapterId` here, and `AdapterId` is not the type
 * of {@link InstrumentationAdapter.id}. A third-party adapter registered
 * through {@link registerAdapter} carries an id no tuple in this repository can
 * contain, and a stored plan or modification record read back after an upgrade
 * may name an adapter that has since been removed. A membership test would
 * invite rejecting both, so identity is compared against a *registered*
 * adapter — {@link AdapterRegistry.get} — and never against this list.
 *
 * @see AdapterId for the union of the six literals.
 */
export const ADAPTER_IDS = Object.freeze([
  REACT_ADAPTER_ID,
  BROWSER_PERFORMANCE_ADAPTER_ID,
  FETCH_ADAPTER_ID,
  NEXTJS_ADAPTER_ID,
  PRISMA_ADAPTER_ID,
  POSTGRES_ADAPTER_ID,
] as const);

/**
 * One of the six built-in adapter ids.
 *
 * Derived from {@link ADAPTER_IDS} rather than declared beside it, so the
 * runtime tuple and the static union cannot drift. Use it where a value is
 * known to name a **built-in** — the factory table below, a test that walks the
 * built-ins — and use `string` where a value is any registered adapter's id,
 * which is how `./schema/plan.ts`, `./schema/readiness.ts` and
 * {@link AdapterRegistry.get} all type it.
 */
export type AdapterId = (typeof ADAPTER_IDS)[number];

// ---------------------------------------------------------------------------
// The claim declaration
//
// `./adapter.ts` declares no claims member: the contract is five methods, and
// which action types an adapter installs is a fact this registry reads off the
// adapter. The declaration nevertheless lives beside each implementation,
// because the adapter is the thing that knows whether its signal can be
// satisfied by a runtime hook or needs a patch — and the mode belongs with the
// code that honours it. The shapes below are what the six built-ins already
// export, widened to accept either form a hand-written or third-party adapter
// might reasonably use.
// ---------------------------------------------------------------------------

/**
 * One claim: an action type, and the mode the adapter installs it in.
 *
 * Structural rather than imported by the adapters, for the cycle reason in this
 * file's overview — `./adapters/fetch.ts`, `./adapters/nextjs.ts`,
 * `./adapters/prisma.ts` and `./adapters/postgres.ts` each declare an
 * equivalent entry type of their own and are assignable to this one. Extra
 * members are welcome: the fetch adapter's entries also carry the capture
 * signal they collect, and a declaration is read for `type` and `mode` only.
 *
 * Named `AdapterClaimEntry` rather than `AdapterClaim` because
 * `./adapters/fetch.ts` already exports the latter and the package's barrel
 * re-exports both modules; two exports of one name would be an ambiguous
 * re-export rather than a convenience.
 */
export interface AdapterClaimEntry {
  /** The action type claimed, from `./schema/plan.ts`'s closed vocabulary. */
  readonly type: InstrumentationActionType;

  /**
   * How an action of that type is installed — and therefore whether a
   * developer's file is touched at all.
   */
  readonly mode: InstrumentationMode;
}

/**
 * The record form of a claim declaration: action type to install mode.
 *
 * What `./adapters/react.ts` and `./adapters/browser-performance.ts` export.
 * `Partial`, because an adapter claims some of the eight action types and never
 * all of them, and `Readonly`, because a declaration is handed out as-is.
 */
export type AdapterClaimTable = Readonly<
  Partial<Record<InstrumentationActionType, InstrumentationMode>>
>;

/**
 * An adapter's claim declaration, in either of the two forms the built-ins use.
 *
 * Both are accepted because both are already in the repository and neither is
 * more correct: a list reads better for an adapter whose entries carry more
 * than a mode, a record reads better for one whose entries carry less. The
 * registry normalises whichever it is given into a single lookup at
 * registration time, so the rest of the product never sees the difference.
 *
 * A declaration is read **once, when the adapter is registered**. Mutating it
 * afterwards has no effect, which is what makes
 * {@link AdapterRegistry.resolveActionType} stable within a session — the
 * property normalisation relies on, since it asks once per target and installs
 * against the answer it validated.
 */
export type AdapterClaimDeclaration = readonly AdapterClaimEntry[] | AdapterClaimTable;

/**
 * An {@link InstrumentationAdapter} that declares what it claims.
 *
 * The declaration is optional, because the contract does not require it: an
 * adapter with no `claims` is registered, appears in
 * {@link AdapterRegistry.handling}, proposes actions and reports readiness like
 * any other — it simply resolves no action type, so no plan routes to it. That
 * is a legal adapter (a readiness-only probe is one), and it is logged at
 * registration so an author who forgot the declaration can see why nothing
 * reaches their `install`.
 *
 * Every built-in carries one. The property name is `claims` on both sides of
 * this contract by agreement: all six adapters under `./adapters/**` export a
 * `claims` member on their adapter object and a matching `*_ADAPTER_CLAIMS`
 * constant beside it.
 */
export interface ClaimingAdapter extends InstrumentationAdapter {
  /** What this adapter claims, and in which mode. */
  readonly claims?: AdapterClaimDeclaration | undefined;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The adapters a session can install with, and the questions the pipeline asks
 * about them.
 *
 * One registry is built per service process by
 * `apps/local-service/src/instrumentation/service.ts` and shared across
 * sessions: an adapter holds no session state — every fact it needs arrives on
 * the {@link InstrumentationContext} of each call — so there is nothing for a
 * second registry to isolate. A suite builds its own with injected fakes
 * instead (see {@link CreateAdapterRegistryOptions.adapters}).
 *
 * Extends {@link PlanAdapterResolver}, which is the whole of what
 * `normalizePlan` and `./feasibility.ts` need: both accept the registry
 * as their `resolver` with no adapter-specific knowledge at all.
 *
 * Every method is a **question**, never an instruction. Nothing here installs,
 * removes, patches or configures anything: `./installer.ts` and `./cleanup.ts`
 * do that, with the adapters this registry hands them.
 */
export interface AdapterRegistry extends PlanAdapterResolver {
  /**
   * Every registered adapter, in registration order.
   *
   * The order the built-ins appear in is {@link ADAPTER_IDS}'s, and an adapter
   * added through {@link register} joins the end — so resolution order is
   * stable and documented rather than dependent on a map's iteration order.
   *
   * A fresh array each call, so a caller that sorts or reverses the result
   * cannot reorder the registry through it.
   *
   * @returns The adapters, in registration order.
   */
  adapters(): readonly InstrumentationAdapter[];

  /**
   * The adapter registered under `id`, if any.
   *
   * How `./installer.ts` turns a normalised action's `adapter` field back into
   * the object that installs it, and how `./cleanup.ts` finds the adapter a
   * modification record names. `undefined` is an expected answer rather than a
   * failure: a stored plan read back after an upgrade may name an adapter that
   * has since been removed, and the caller reports that as an unavailable
   * signal rather than treating the session as corrupt.
   *
   * @param id An adapter id — any string, since a third-party adapter's id is
   * not a member of {@link ADAPTER_IDS}.
   * @returns The adapter, or `undefined` when none is registered under that id.
   */
  get(id: string): InstrumentationAdapter | undefined;

  /**
   * Adds an adapter to the end of the registry.
   *
   * This is the adapter extension point: a framework adapter that
   * implements {@link InstrumentationAdapter} and declares its `claims` becomes
   * available to the planner, the installer and cleanup through this one call,
   * and no orchestrator module changes. {@link registerAdapter} is the same
   * operation written as a free function, for callers that read better that
   * way.
   *
   * The adapter's claim declaration is read here, once, and normalised into the
   * lookup {@link resolveActionType} answers from.
   *
   * Refused — with an `Err`, never an exception — when the adapter does not
   * satisfy the contract at runtime (a value that is not an object, a
   * non-string or blank `id`, an `id` carrying a control character or longer
   * than the 64 characters a stored plan and a readiness report accept, or a
   * missing contract method) or when its id is already taken. Both are
   * expected failures at a boundary where the adapter may have been written in
   * JavaScript, and both carry `'INSTRUMENTATION_UNAVAILABLE'`: the consequence
   * is that the signals that adapter would have provided cannot be enabled
   * here. A duplicate id is refused rather than resolved in favour of either
   * candidate, because the id is what a stored plan, a modification record and
   * a readiness report all address an adapter by — two adapters under one id
   * would make every one of those ambiguous.
   *
   * @param adapter The adapter to register.
   * @returns `ok(undefined)` when it was added; otherwise `err` explaining
   * which rule it broke, with `details.reason` naming it.
   */
  register(adapter: InstrumentationAdapter): Result<void>;

  /**
   * Every adapter that claims `type`, in registration order.
   *
   * The plural of {@link resolveActionType}, for the planning stage's
   * capability catalog and for a diagnostic that needs to say *which* adapters
   * could have supplied a signal. `'db-query-tracking'` is the case that makes
   * it plural: the ORM and the driver adapter both claim it, and which of them
   * applies is settled by `context`.
   *
   * @param context The session's context, which narrows the answer to the
   * adapters whose {@link InstrumentationAdapter.canHandle} is `true` for this
   * project; or `undefined` to ask purely about claims, which is what a
   * catalog of "what this build can install at all" wants.
   * @param type The action type to ask about.
   * @returns The claiming adapters, in registration order; empty when none
   * claims the type or none of the claimants can handle the project.
   */
  claimants(
    context: InstrumentationContext | undefined,
    type: InstrumentationActionType,
  ): readonly InstrumentationAdapter[];

  /**
   * Resolves the adapter and install mode for one action type — the single
   * question `normalizePlan` asks.
   *
   * The first claimant in registration order wins; when a `context` is given,
   * only claimants that can handle the project are considered, so a plan for a
   * project that reaches its database through the driver directly resolves to
   * the driver adapter and not to the ORM one.
   *
   * **Total and non-throwing.** An action type no adapter claims — and one no
   * *applicable* adapter claims, when a context narrowed the candidates —
   * resolves to `undefined`, which normalisation turns into a rejection of the
   * whole plan and the feasibility gate reports per action. That
   * distinction matters here: normalisation runs on a model's output, where a
   * thrown exception is an unretryable product defect rather than a rejection
   * the planner can act on, so this method does not throw — not for an
   * unclaimed type, not for a value outside the action-type vocabulary, and not
   * when an adapter's own capability probe throws (that adapter is treated as
   * declining the project and the probe's failure is logged).
   *
   * Free of side effects, and stable for as long as the registry's membership
   * is: two calls with the same arguments give the same answer, which is what
   * lets normalisation install against the resolution it validated.
   *
   * @param type The action type to resolve.
   * @param context The session's context, when the caller holds one. Omitted —
   * as {@link PlanAdapterResolver} declares it, and as normalisation calls it —
   * the answer is decided by claims and registration order alone.
   * @returns The claiming adapter's id and the mode it installs the type in, or
   * `undefined` when nothing applicable claims it.
   */
  resolveActionType(
    type: InstrumentationActionType,
    context?: InstrumentationContext,
  ): AdapterActionResolution | undefined;

  /**
   * Every adapter with something to offer this project, in registration order.
   *
   * The `canHandle` capability probe applied across the registry: the
   * planning stage builds its capability catalog from this list, and the
   * readiness gate aggregates a readiness report from each member. It
   * is a question about the project's *shape* — does the code graph carry
   * components, requests, route handlers, database calls? — and not about
   * whether a producer is attached: an adapter whose signal needs the
   * dev-server preload still appears here, and reports the gap through its own
   * readiness rows.
   *
   * An adapter whose probe throws is excluded and logged, so one broken
   * third-party adapter cannot take the planning stage down with it.
   *
   * @param context The session's context.
   * @returns The applicable adapters, in registration order.
   */
  handling(context: InstrumentationContext): readonly InstrumentationAdapter[];
}

/**
 * What {@link createAdapterRegistry} accepts.
 *
 * Both members are optional: the production call is `createAdapterRegistry()`,
 * and the service adds a logger.
 */
export interface CreateAdapterRegistryOptions {
  /**
   * The adapters to register, **instead of** the six built-ins.
   *
   * A replacement rather than an addition, which is what a suite needs: a test
   * of resolution order, of a duplicate id, or of an installer's routing wants
   * exactly the fakes it supplied and nothing else. To *extend* the built-ins,
   * omit this member and call {@link registerAdapter} for each addition — which
   * is also what a third-party adapter does in production.
   *
   * Registered in the order given, and all-or-nothing: an entry that
   * {@link AdapterRegistry.register} would refuse — a malformed adapter, or two
   * entries sharing an id — makes construction throw rather than silently
   * yielding a registry missing an adapter the caller believes is in it. An
   * empty array is legal and gives an empty registry, which resolves nothing.
   */
  readonly adapters?: readonly InstrumentationAdapter[] | undefined;

  /**
   * Where this registry's own diagnostics go. Defaults to `noopLogger`.
   *
   * It logs one `debug` line per registration and a `warn` for each thing it
   * had to ignore: an unreadable claim, a claim declared twice with two modes,
   * a capability probe that threw. Nothing is written to the console directly.
   *
   * **Not passed to the built-in adapters.** Each adapter's own
   * `options.logger` is documented as an override of
   * {@link InstrumentationContext.logger}, and the context's logger is the one
   * the service binds the session and capture ids to — so handing this one down
   * would replace richer output with poorer. An adapter logs through the
   * context it is called with.
   */
  readonly logger?: Logger | undefined;
}

// ---------------------------------------------------------------------------
// Internals: reading a claim declaration, and refusing an adapter that cannot
// be routed to
//
// Everything below treats an adapter as a value that arrived from outside this
// package. The compiler guarantees the shape for a TypeScript caller, but the
// extension point is public and an adapter may be written in JavaScript, so a
// declaration is validated against the real vocabularies rather than trusted,
// and a probe that throws is contained rather than propagated. No function
// here throws.
// ---------------------------------------------------------------------------

/** The normalised claim lookup one adapter is registered with. */
type AdapterClaimMap = ReadonlyMap<InstrumentationActionType, InstrumentationMode>;

/** One registered adapter, with its claims resolved once at registration. */
interface RegistryEntry {
  /** The adapter itself, exactly as it was registered. */
  readonly adapter: InstrumentationAdapter;

  /** Its claim declaration, normalised. Empty when it declared none. */
  readonly claims: AdapterClaimMap;
}

/** The answer every query gives when nothing matched: one shared frozen array. */
const NO_ADAPTERS: readonly InstrumentationAdapter[] = Object.freeze([]);

/** Highest code point of the C0 control block, `NUL` included. */
const C0_CONTROL_MAX = 0x1f;

/** Lowest code point of the `DEL`/C1 control block. */
const C1_CONTROL_MIN = 0x7f;

/** Highest code point of the C1 control block. */
const C1_CONTROL_MAX = 0x9f;

/**
 * Longest adapter id a registered adapter may carry, in UTF-16 code units.
 *
 * Mirrors the `adapter` bound of `./schema/plan.ts` and
 * `./schema/readiness.ts`, which keep theirs module-private. It has to be
 * enforced here as well: an id longer than those schemas store would register,
 * resolve action types and then fail every plan routed to it as `PLAN_INVALID`
 * — a product defect, logged and never retried against the model — and every
 * readiness report naming it, rather than being refused once, where the
 * adapter's author can act on it.
 */
const MAX_ADAPTER_ID_LENGTH = 64;

/** How much of a rejected string value a diagnostic repeats. */
const MAX_DESCRIBED_LENGTH = 64;

/**
 * Whether a string carries a C0 control character, `DEL` or a C1 control
 * character.
 *
 * A character-code scan rather than a regular expression, for the reason
 * `./schema/target.ts` and `./schema/modification.ts` give: a literal control
 * range in a regular expression trips ESLint's `no-control-regex`, and the
 * intent reads better as a predicate. Load-bearing for an adapter id, which is
 * a map key, a stored field on every plan and modification record, a string
 * rendered in two user interfaces and a value named in log lines — where a
 * `NUL` truncates at the next C boundary and an `ESC` begins a terminal escape
 * sequence.
 *
 * @param value The string to scan.
 * @returns `true` when at least one control character is present.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= C0_CONTROL_MAX || (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX)) {
      return true;
    }
  }

  return false;
}

/**
 * Narrows an unknown value to an array of unknowns.
 *
 * `Array.isArray` on its own narrows to `any[]`, which would make every read of
 * an element an unchecked one. Wrapping it in a predicate keeps `unknown`
 * elements, so each is validated below.
 *
 * @param value Any value.
 * @returns `true` when `value` is an array.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Reads one property of an object without asserting anything about its type.
 *
 * @param value The object to read from.
 * @param key The property name.
 * @returns The property's value, as `unknown`.
 */
function propertyOf(value: object, key: string): unknown {
  return (value as Readonly<Record<string, unknown>>)[key];
}

/**
 * Describes a rejected value for a diagnostic, without repeating it wholesale.
 *
 * Claim types and modes are vocabulary strings rather than captured data, so
 * naming a rejected one is what makes the warning actionable; it is still
 * clamped, and a non-string is reported by its type alone.
 *
 * @param value The value that could not be read.
 * @returns A short, printable description.
 */
function describeUnreadable(value: unknown): string {
  if (typeof value !== 'string') {
    return value === null ? 'null' : typeof value;
  }

  return value.length <= MAX_DESCRIBED_LENGTH ? value : `${value.slice(0, MAX_DESCRIBED_LENGTH)}…`;
}

/**
 * Adds one `(type, mode)` pair to a claim lookup, validating both.
 *
 * The first declaration of a type wins, and a second one with a *different*
 * mode is warned about rather than silently preferred: install ordering depends
 * on the mode (`./installer.ts` installs every runtime-mode group before any
 * patch-mode group), so a declaration that says both would otherwise change
 * behaviour invisibly.
 *
 * @param claims The lookup being built.
 * @param type The declared action type, unvalidated.
 * @param mode The declared install mode, unvalidated.
 * @param adapterId The declaring adapter, for the log line.
 * @param logger Where an ignored claim is reported.
 */
function addClaim(
  claims: Map<InstrumentationActionType, InstrumentationMode>,
  type: unknown,
  mode: unknown,
  adapterId: string,
  logger: Logger,
): void {
  if (!isInstrumentationActionType(type) || !isInstrumentationMode(mode)) {
    logger.warn('ignored an unreadable adapter claim', {
      adapter: adapterId,
      type: describeUnreadable(type),
      mode: describeUnreadable(mode),
    });

    return;
  }

  const existing = claims.get(type);
  if (existing !== undefined) {
    if (existing !== mode) {
      logger.warn('kept the first mode an adapter declared for an action type', {
        adapter: adapterId,
        type,
        kept: existing,
        ignored: mode,
      });
    }

    return;
  }

  claims.set(type, mode);
}

/**
 * Normalises an adapter's claim declaration into a lookup, in either form.
 *
 * Called once per adapter, by {@link AdapterRegistry.register}. An absent
 * declaration gives an empty lookup — a registered adapter that resolves no
 * action type — and so does an unreadable one, with a warning: refusing the
 * adapter outright would cost the product a `canHandle` and a readiness report
 * over a declaration the contract does not even require.
 *
 * @param adapter The adapter being registered.
 * @param logger Where ignored claims are reported.
 * @returns The claims, in declaration order.
 */
function resolveClaims(adapter: InstrumentationAdapter, logger: Logger): AdapterClaimMap {
  const declaring: ClaimingAdapter = adapter;
  const declaration: unknown = declaring.claims;
  const claims = new Map<InstrumentationActionType, InstrumentationMode>();

  if (declaration === undefined || declaration === null) {
    return claims;
  }

  if (isUnknownArray(declaration)) {
    for (const entry of declaration) {
      if (typeof entry !== 'object' || entry === null) {
        logger.warn('ignored an adapter claim that is not an object', {
          adapter: adapter.id,
          entry: describeUnreadable(entry),
        });

        continue;
      }

      addClaim(claims, propertyOf(entry, 'type'), propertyOf(entry, 'mode'), adapter.id, logger);
    }

    return claims;
  }

  if (typeof declaration !== 'object') {
    logger.warn('ignored an adapter claim declaration that is neither a list nor a table', {
      adapter: adapter.id,
      declaration: describeUnreadable(declaration),
    });

    return claims;
  }

  for (const key of Object.keys(declaration)) {
    addClaim(claims, key, propertyOf(declaration, key), adapter.id, logger);
  }

  return claims;
}

/**
 * Checks that a value can be registered and addressed as an adapter.
 *
 * Two rules, both from the contract in `./adapter.ts`: the id is a non-blank,
 * single-line string no longer than {@link MAX_ADAPTER_ID_LENGTH} — it is a map
 * key, a field on every stored plan and modification record, and a value named
 * in two user interfaces — and the five contract methods are callable, because
 * the installer, cleanup and the readiness gate will call them without asking
 * again.
 *
 * A candidate that is not an object at all — `null`, `undefined`, a string —
 * carries no id, so it is refused under the first rule rather than allowed to
 * throw a `TypeError` out of a function whose contract is to return a refusal.
 *
 * Each method is read through the typed member rather than by name, so renaming
 * one in the contract fails this function at compile time instead of turning
 * every registration into a refusal at runtime.
 *
 * @param adapter The candidate.
 * @returns The refusal, or `undefined` when the candidate is registrable.
 */
function validateAdapter(adapter: InstrumentationAdapter): DebuggenError | undefined {
  const candidate: unknown = adapter;
  const id: unknown =
    (typeof candidate === 'object' && candidate !== null) || typeof candidate === 'function'
      ? propertyOf(candidate, 'id')
      : undefined;

  if (
    typeof id !== 'string' ||
    id.trim().length === 0 ||
    id.length > MAX_ADAPTER_ID_LENGTH ||
    hasControlCharacter(id)
  ) {
    return new DebuggenError(
      'INSTRUMENTATION_UNAVAILABLE',
      `An instrumentation adapter must carry a non-blank, single-line string id of at most ${String(MAX_ADAPTER_ID_LENGTH)} characters.`,
      {
        hint: 'Give the adapter a stable, kebab-case id: it is the value stored plans and modification records address it by.',
        details: { reason: 'invalid-id', id: describeUnreadable(id) },
      },
    );
  }

  // Each member is read as the operand of `typeof` and named beside it: the
  // property access is what the compiler checks, so renaming a contract method
  // fails here at build time, and the literal is only what the refusal says.
  const missing: string[] = [];

  if (typeof adapter.canHandle !== 'function') {
    missing.push('canHandle');
  }

  if (typeof adapter.createPlan !== 'function') {
    missing.push('createPlan');
  }

  if (typeof adapter.install !== 'function') {
    missing.push('install');
  }

  if (typeof adapter.remove !== 'function') {
    missing.push('remove');
  }

  if (typeof adapter.readiness !== 'function') {
    missing.push('readiness');
  }

  if (missing.length > 0) {
    return new DebuggenError(
      'INSTRUMENTATION_UNAVAILABLE',
      `The instrumentation adapter "${id}" does not implement: ${missing.join(', ')}.`,
      {
        hint: 'Implement every method of the InstrumentationAdapter contract: canHandle, createPlan, install, remove and readiness.',
        details: { reason: 'incomplete-contract', adapter: id, missing },
      },
    );
  }

  return undefined;
}

/**
 * The refusal for an id that is already registered.
 *
 * @param id The contested id.
 * @returns The error {@link AdapterRegistry.register} answers with.
 */
function duplicateIdError(id: string): DebuggenError {
  return new DebuggenError(
    'INSTRUMENTATION_UNAVAILABLE',
    `An instrumentation adapter is already registered under the id "${id}".`,
    {
      hint: 'Give the new adapter an id of its own; an id identifies one adapter for the life of every plan and modification record that names it.',
      details: { reason: 'duplicate-id', adapter: id },
    },
  );
}

// ---------------------------------------------------------------------------
// The built-ins
//
// Factory references, not instances: this table is data, and nothing in it runs
// until `createAdapterRegistry` iterates it. Typed as a total record over
// `AdapterId`, which is what makes "one factory per id in `ADAPTER_IDS`" a
// compile-time fact rather than a convention — a seventh id with no factory,
// or a factory with no id, fails here.
// ---------------------------------------------------------------------------

/**
 * The factory for each built-in adapter, keyed by its id.
 *
 * Every factory is called with no arguments, so each adapter applies its own
 * documented defaults — bounds, clocks — and reads its logger from the
 * {@link InstrumentationContext} of each call. See
 * {@link CreateAdapterRegistryOptions.logger} for why the registry's logger is
 * not passed down.
 */
const BUILT_IN_ADAPTER_FACTORIES: Readonly<Record<AdapterId, () => InstrumentationAdapter>> =
  Object.freeze({
    [REACT_ADAPTER_ID]: createReactAdapter,
    [BROWSER_PERFORMANCE_ADAPTER_ID]: createBrowserPerformanceAdapter,
    [FETCH_ADAPTER_ID]: createFetchAdapter,
    [NEXTJS_ADAPTER_ID]: createNextJsAdapter,
    [PRISMA_ADAPTER_ID]: createPrismaAdapter,
    [POSTGRES_ADAPTER_ID]: createPostgresAdapter,
  });

/**
 * Constructs the six built-in adapters, in {@link ADAPTER_IDS} order.
 *
 * Called from inside {@link createAdapterRegistry} and nowhere else, so
 * importing this module constructs nothing. Each adapter is a fresh, frozen,
 * stateless object; two registries therefore share no adapter instance even
 * though they would behave identically.
 *
 * @returns The built-in adapters, in registration order.
 */
function createBuiltInAdapters(): readonly InstrumentationAdapter[] {
  return ADAPTER_IDS.map((id) => BUILT_IN_ADAPTER_FACTORIES[id]());
}

// ---------------------------------------------------------------------------
// The factory, and the free-function registration wrapper
// ---------------------------------------------------------------------------

/**
 * Builds a registry.
 *
 * `createAdapterRegistry()` is the production call: it constructs and registers
 * the six built-in adapters in {@link ADAPTER_IDS} order, which is what
 * `apps/local-service/src/instrumentation/service.ts` does once per process
 * before handing the result to the planning stage (as `normalizePlan`'s
 * `resolver`), to `./installer.ts` and to `./cleanup.ts`.
 *
 * Construction is where every adapter instance in this module comes from —
 * module scope holds only the frozen id tuple and the frozen table of factory
 * references — so importing this file has no effect and two registries share no
 * state.
 *
 * ## Failures
 *
 * Construction is all-or-nothing and **throws** when an adapter in the list
 * cannot be registered: a malformed adapter or two entries sharing an id. That
 * is an invariant violation in the caller's own list rather than a condition to
 * recover from — a registry silently missing an adapter would show up much
 * later, as a plan that cannot resolve a signal the developer was told to
 * expect. Registration *after* construction is the recoverable case and returns
 * a `Result` instead; see {@link AdapterRegistry.register}.
 *
 * @param options Adapters to register instead of the built-ins, and where the
 * registry's own diagnostics go. Both optional.
 * @returns The registry, frozen. Its membership can still grow through
 * {@link AdapterRegistry.register}.
 *
 * @example
 * ```ts
 * // Production: the six built-ins, and the resolver normalisation asks.
 * const registry = createAdapterRegistry({ logger });
 * const plan = normalizePlan(authored, { sessionId, planVersion: 1, resolver: registry });
 *
 * // A suite: exactly the fakes it supplied.
 * const isolated = createAdapterRegistry({ adapters: [fakeAdapter] });
 * ```
 */
export function createAdapterRegistry(options: CreateAdapterRegistryOptions = {}): AdapterRegistry {
  const logger = options.logger ?? noopLogger;

  // Registration order is the array; the map is the index. Both are private to
  // this closure, and the only mutation in the module.
  const entries: RegistryEntry[] = [];
  const byId = new Map<string, RegistryEntry>();

  /**
   * Asks one adapter whether it has anything to offer this project, treating a
   * thrown probe as "no".
   *
   * `canHandle` is documented as cheap, synchronous and graph-only, but it is
   * third-party code on a path that must not throw: normalisation calls
   * `resolveActionType` on a model's output, where an exception is an
   * unretryable defect rather than a rejection the planner can act on.
   */
  const canHandle = (adapter: InstrumentationAdapter, context: InstrumentationContext): boolean => {
    try {
      return adapter.canHandle(context) === true;
    } catch (cause) {
      logger.warn('an adapter capability probe threw; treating it as inapplicable here', {
        adapter: adapter.id,
        reason: DebuggenError.from(cause).message,
      });

      return false;
    }
  };

  /** Whether an entry claims `type` and, when a context was given, applies. */
  const applies = (
    entry: RegistryEntry,
    type: InstrumentationActionType,
    context: InstrumentationContext | undefined,
  ): boolean =>
    entry.claims.has(type) && (context === undefined || canHandle(entry.adapter, context));

  const register = (adapter: InstrumentationAdapter): Result<void> => {
    const invalid = validateAdapter(adapter);
    if (invalid !== undefined) {
      return err(invalid);
    }

    const id = adapter.id;
    if (byId.has(id)) {
      return err(duplicateIdError(id));
    }

    const entry: RegistryEntry = { adapter, claims: resolveClaims(adapter, logger) };
    entries.push(entry);
    byId.set(id, entry);

    logger.debug('registered an instrumentation adapter', {
      adapter: id,
      position: entries.length - 1,
      claimedTypes: [...entry.claims.keys()],
    });

    return ok(undefined);
  };

  const registry: AdapterRegistry = {
    adapters: (): readonly InstrumentationAdapter[] =>
      Object.freeze(entries.map((entry) => entry.adapter)),

    get: (id: string): InstrumentationAdapter | undefined => byId.get(id)?.adapter,

    register,

    claimants: (
      context: InstrumentationContext | undefined,
      type: InstrumentationActionType,
    ): readonly InstrumentationAdapter[] => {
      if (!isInstrumentationActionType(type)) {
        return NO_ADAPTERS;
      }

      const claiming = entries
        .filter((entry) => applies(entry, type, context))
        .map((entry) => entry.adapter);

      return claiming.length === 0 ? NO_ADAPTERS : Object.freeze(claiming);
    },

    resolveActionType: (
      type: InstrumentationActionType,
      context?: InstrumentationContext,
    ): AdapterActionResolution | undefined => {
      if (!isInstrumentationActionType(type)) {
        return undefined;
      }

      for (const entry of entries) {
        const mode = entry.claims.get(type);

        if (mode === undefined || (context !== undefined && !canHandle(entry.adapter, context))) {
          continue;
        }

        return Object.freeze({ adapter: entry.adapter.id, mode });
      }

      return undefined;
    },

    handling: (context: InstrumentationContext): readonly InstrumentationAdapter[] => {
      const applicable = entries
        .filter((entry) => canHandle(entry.adapter, context))
        .map((entry) => entry.adapter);

      return applicable.length === 0 ? NO_ADAPTERS : Object.freeze(applicable);
    },
  };

  const initial = options.adapters ?? createBuiltInAdapters();

  for (const adapter of initial) {
    const registered = register(adapter);

    if (!registered.ok) {
      throw new DebuggenError(
        registered.error.code,
        `Could not build the adapter registry: ${registered.error.message}`,
        {
          hint: 'Every adapter in the list must implement the contract and carry an id no other adapter in the list uses.',
          details: { supplied: initial.length, registered: entries.length },
          cause: registered.error,
        },
      );
    }
  }

  logger.debug('built an adapter registry', {
    adapters: entries.length,
    builtIn: options.adapters === undefined,
  });

  return Object.freeze(registry);
}

/**
 * Registers an adapter with a registry — the adapter extension point as one
 * call.
 *
 * Exactly {@link AdapterRegistry.register}, as a free function: the adapter
 * extension guide in `docs/ARCHITECTURE.md` reads
 * `registerAdapter(registry, myAdapter)`, and a caller holding both values
 * reads better that way than reaching through the registry. The delegation is
 * the whole implementation, so the contract, the refusals and the error codes
 * are that method's and are documented there.
 *
 * @param registry The registry to add to.
 * @param adapter The adapter to register.
 * @returns `ok(undefined)` when it was added; otherwise `err` explaining which
 * rule it broke.
 *
 * @example
 * ```ts
 * const outcome = registerAdapter(registry, createMyFrameworkAdapter());
 * if (!outcome.ok) {
 *   logger.error('adapter rejected', { reason: outcome.error.message });
 * }
 * ```
 */
export function registerAdapter(
  registry: AdapterRegistry,
  adapter: InstrumentationAdapter,
): Result<void> {
  return registry.register(adapter);
}
