/**
 * The **installation driver** of `@debuggen/instrumentation`: it turns one
 * validated {@link InstrumentationPlan} into armed runtime hooks and recorded
 * file patches — **runtime hooks first, patches second** — and reports a single
 * aggregated result.
 *
 * ## Why the order is a guarantee and not an optimisation
 *
 * AAP §0.5.1 makes runtime hooks the default and an in-place AST patch the
 * exception, and AAP §0.7.1 Group 1 fixes the sequence: every `runtime`-mode
 * group installs before the first `patch`-mode group. Two consequences follow,
 * and both are promises to the developer rather than implementation details:
 *
 * - A capture whose signals are all satisfiable by hooks starts with **zero
 *   modifications to the working tree**. Nothing is written, so nothing has to
 *   be restored, and a session that ends in a crash leaves no journal entry to
 *   reconcile.
 * - A patch that fails **cannot take down signals that are already live**. The
 *   hooks were armed before the first byte was written, the rollback below
 *   touches only what this call applied, and what remains is a narrower capture
 *   rather than a dead session.
 *
 * ## What this module decides
 *
 * It is the only party that can see every adapter's answer, which makes it the
 * only party that can make two judgements:
 *
 * - **"Nothing at all could be enabled" is the only gap that fails.** Every
 *   other gap — an action the feasibility gate refused, an adapter id no
 *   registry resolves, a signal an adapter could not arm here — is reported
 *   through {@link AggregateInstallResult.unavailable} so that
 *   `apps/local-service/src/instrumentation/service.ts` can render AAP §0.5.5's
 *   "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›."
 *   instead of a failure. Of the gaps, only an install that armed no hook and
 *   patched no file returns `Err`, which the service turns into
 *   `instrumentation.failed`; a gap in an adapter's `unavailable` never fails
 *   an install on its own.
 * - **How far a failed install is unwound.** An adapter that fails part-way —
 *   it rejects, returns something that is not an install result, or returns a
 *   result carrying {@link InstallResult.failure} because an accepted action
 *   could not be completed — fails the whole install. A follow-up's delta
 *   arrives as a new plan version, and AAP §0.4.2 requires that such a failure
 *   reverse-restores the records *this call* applied, including the record
 *   journaled for the failed attempt, and leaves the earlier plan versions'
 *   records exactly as they are — which is what "the session stays at its
 *   previous plan version" means in bytes. See {@link installPlan}'s rollback
 *   section.
 *
 * ## What it deliberately does not know
 *
 * - **No built-in adapter is imported here.** The registry — or a plain array
 *   of adapters — arrives on {@link InstallPlanOptions.adapters}, so the
 *   promise of AAP §0.4.2 holds literally: a seventh adapter is implemented and
 *   registered, and this module does not change. Nothing here imports
 *   `./adapters/**` or `./registry.ts`'s factory; only the registry's *type* is
 *   referenced.
 * - **It writes nothing itself.** Bytes reach a developer's file inside
 *   `patch`-mode adapters, through `./patch/patcher.ts`'s
 *   hash → backup → journal → atomic-rename sequence, and come back through
 *   `./cleanup.ts`'s verified restore. This module opens no database, reads no
 *   environment variable, performs no network call and touches no file: the
 *   journal, the backup store, the clock and the cancellation signal are all
 *   ports on {@link InstrumentationContext}.
 * - **It re-derives no policy.** The two producer configurations are computed
 *   by `./schema/readiness.ts`'s `deriveAgentHookConfig` and
 *   `deriveServerAgentSignals` from the actions that were actually installed,
 *   and the adapters' own contributions are merged with them rather than in
 *   place of them.
 *
 * ## Who calls it
 *
 * - `apps/local-service/src/instrumentation/service.ts` — for the first install
 *   of a session's plan and for a follow-up's delta install
 *   ({@link InstallPlanOptions.delta}), then sends
 *   {@link AggregateInstallResult.agentHooks} as `agent.config` and
 *   {@link AggregateInstallResult.serverSignals} as `server-agent.config`, and
 *   the first three fields as `instrumentation.ready`.
 * - `apps/local-service/src/pipeline/stages/plan.ts` — indirectly, through the
 *   same feasibility surface this module gates on (`./feasibility.ts`), so a
 *   plan is refused at planning time for the same reasons an install would
 *   report it unavailable.
 * - `./index.ts` — the package's only public door, through which both of the
 *   above resolve these symbols.
 */

import { DebuggenError, err, isErr, ok } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

import type {
  InstallFailure,
  InstallResult,
  InstrumentationAdapter,
  InstrumentationContext,
  UnavailableSignal,
} from './adapter.js';
import { restoreModification } from './cleanup.js';
import type { CleanupFailure, RestoreOutcome } from './cleanup.js';
import { checkFeasibility } from './feasibility.js';
import type { InfeasibleAction } from './feasibility.js';
import type { AdapterRegistry } from './registry.js';
import type { ModificationConflict, ModificationRecord } from './schema/modification.js';
import type {
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
  InstrumentationPlan,
  PlanAdapterResolver,
} from './schema/plan.js';
import {
  AGENT_HOOK_KEYS,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
} from './schema/readiness.js';
import type {
  ActionTier,
  ActionTierResolver,
  AgentHookConfig,
  AgentHookKey,
  CaptureSignal,
  ServerAgentSignals,
} from './schema/readiness.js';

// ---------------------------------------------------------------------------
// Ordering and naming policy
// ---------------------------------------------------------------------------

/**
 * The install phases, in the order they run.
 *
 * The literal statement of AAP §0.7.1 Group 1's "runtime → patch", as a tuple
 * rather than two calls, so the phase loop below cannot be reordered by an edit
 * that looks local. An action whose `mode` is neither member is **not** silently
 * dropped — see {@link groupActions}, which reports it as an unavailable signal.
 */
const INSTALL_PHASES: readonly InstrumentationMode[] = Object.freeze(['runtime', 'patch']);

/**
 * The signal name each action type is reported under when the action cannot be
 * installed at all.
 *
 * Only reached for a gap this module discovers *before* an adapter is asked —
 * a feasibility refusal, an unresolvable adapter id, an unknown install mode.
 * Once an adapter has been asked, the gap it reports carries the adapter's own
 * signal name, which is finer than anything a table here could be.
 *
 * Kept inside the closed {@link CaptureSignal} vocabulary on purpose: the
 * service cross-references a reported gap with the plan and with the readiness
 * rows, and a name from outside the vocabulary would match neither. Three rows
 * involve a choice worth recording, because an action type and a signal are not
 * one-to-one:
 *
 * - `'function-timing'` → `'functions'`, which is the signal the patched
 *   symbol's span arrives under in `ServerAgentSignals.functions` and the name
 *   the framework adapter already uses for a patched span.
 * - `'server-span'` → `'routeHandlers'`, because that is what the developer
 *   asked for — the handler boundary inside an incoming request — even though
 *   the span itself is emitted through the same helper as a timed function.
 * - `'db-query-tracking'` → `'prisma'`, the first member of the database family
 *   in {@link CaptureSignal}'s own order, which is also the order the registry
 *   asks the two database adapters in (the ORM first, because a query issued
 *   through it is the one a developer reads in their own source). The two
 *   database signals are enabled and disabled as one family by
 *   `deriveServerAgentSignals`, so naming either is naming the family; the
 *   refusal's `reason` and `hint` carry the specifics.
 */
const CAPTURE_SIGNAL_BY_ACTION_TYPE = {
  'function-timing': 'functions',
  'server-span': 'routeHandlers',
  'react-render-tracking': 'react',
  'fetch-tracking': 'fetch',
  'db-query-tracking': 'prisma',
  'state-tracking': 'state',
  'interaction-tracking': 'interactions',
  'perf-tracking': 'perf',
} as const satisfies Readonly<Record<InstrumentationActionType, CaptureSignal>>;

/**
 * The signal name an action type is reported under.
 *
 * Falls back to the action type itself — which
 * {@link UnavailableSignal.signal}'s widened type accepts — for a value that
 * reached here without passing `./schema/plan.ts`'s schema. A gap the developer
 * can read is worth more than an exception thrown inside the reporting path.
 *
 * @param type The action type to name.
 * @returns The closed signal name, or the type as written when it is not one of
 * the eight.
 */
function signalForActionType(type: InstrumentationActionType): CaptureSignal | (string & {}) {
  return CAPTURE_SIGNAL_BY_ACTION_TYPE[type] ?? type;
}

/**
 * Orders two ids or names by code unit, without a locale.
 *
 * `localeCompare` is deliberately avoided for the reason `./schema/readiness.ts`
 * records: its result depends on host locale data, so the same plan would
 * install in a different order on two machines and an ordering assertion would
 * pass or fail by environment.
 *
 * @param left First string.
 * @param right Second string.
 * @returns `-1`, `0` or `1`.
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
// Public shapes
// ---------------------------------------------------------------------------

/**
 * Which actions of a plan version are new, for a follow-up's delta install.
 *
 * AAP §0.4.2's follow-up path builds plan version *n + 1* as the previous plan
 * **plus** additive actions, never removing an installed one, so an install of
 * version *n + 1* must apply only the additions: re-installing an action that
 * version *n* already applied would layer a second patch over a file the
 * journal already records as instrumented, and the chain cleanup unwinds would
 * no longer describe the file's history.
 *
 * The decision of which actions are new belongs to
 * `apps/local-service/src/pipeline/stages/followup.ts`, which holds both plan
 * versions; this module is told the answer and applies it.
 */
export interface InstallDelta {
  /**
   * The plan version whose instrumentation is already installed.
   *
   * Recorded on the failure path rather than consulted during the install: it
   * is the version the session returns to when a delta fails part-way, and
   * naming it in the error is what makes "left at its previous plan version"
   * checkable rather than a claim.
   */
  readonly previousPlanVersion: number;

  /**
   * The ids of the actions to install, drawn from the plan being installed.
   *
   * Matched against `plan.instrumentationTargets` by
   * {@link InstrumentationAction.id}, which normalisation keeps stable across
   * plan versions precisely so this match is possible. An id the plan does not
   * carry is logged and ignored — it can install nothing, and failing the whole
   * install over it would withdraw the signals the other delta actions would
   * have provided.
   */
  readonly actionIds: readonly string[];
}

/**
 * How to run {@link installPlan}.
 *
 * One required member and two optional ones, as an object rather than
 * positional arguments so that a later option does not change a signature two
 * callers already use.
 */
export interface InstallPlanOptions {
  /**
   * The adapters that may be asked to install, as the registry the service
   * holds or as a plain array.
   *
   * **Passed in, never imported.** This is the seam that keeps the promise of
   * AAP §0.4.2 — an adapter is added by implementing the contract and
   * registering it, with no orchestrator change — and it is what lets a suite
   * drive this driver with fakes.
   *
   * A registry also answers {@link PlanAdapterResolver}, so it is forwarded to
   * the feasibility gate as its resolver and an action whose type no registered
   * adapter claims is refused before its file is looked at. A plain array
   * carries no claim index, so that check is skipped for it and an action whose
   * adapter id is not in the array is reported as unavailable instead.
   *
   * Order matters and is honoured: a registry's registration order
   * (`AdapterRegistry.adapters()`) or the array's own order is the order groups
   * install in within each phase.
   */
  readonly adapters: AdapterRegistry | readonly InstrumentationAdapter[];

  /**
   * The additive actions to install, when this is a follow-up's delta install.
   *
   * Absent — the default — installs the whole plan, which is the first install
   * of a session.
   */
  readonly delta?: InstallDelta | undefined;

  /**
   * Skips the feasibility gate.
   *
   * For the one caller that has already run it over exactly these actions
   * against exactly this context and does not want the syntax trees walked
   * twice. It does **not** skip any of the safety that matters: bytes still
   * reach a file only through the patcher's recorded, hash-checked sequence, and
   * an adapter still refuses an action it cannot install.
   *
   * Default `false`. Prefer leaving it so: the gate is what turns "this symbol
   * is not in the index" into a sentence the developer can act on, rather than
   * into an adapter-level failure.
   */
  readonly skipFeasibility?: boolean | undefined;
}

/**
 * What one install of one plan version did, across every adapter.
 *
 * The first three fields are exactly the `instrumentation.ready` payload of
 * AAP §0.4.2 — `{ applied, runtimeHooks, unavailable }` — and the next two are
 * exactly what the service sends the two telemetry producers as `agent.config`
 * and `server-agent.config`. Nothing needs re-deriving downstream.
 *
 * Every array is deterministic: two installs of the same plan against the same
 * project produce the same arrays in the same order.
 */
export interface AggregateInstallResult {
  /**
   * Every modification record this install applied, in the order it applied
   * them.
   *
   * Empty whenever the plan's signals were all satisfiable by runtime hooks,
   * which is the outcome AAP §0.5.1 prefers. The order is the order cleanup
   * must reverse, and `apps/local-service/src/instrumentation/watcher.ts`
   * watches exactly these files for a developer's own edits.
   */
  readonly applied: ModificationRecord[];

  /**
   * The runtime hooks that were armed, named for a developer to read,
   * de-duplicated with the first occurrence's position kept.
   *
   * The evidence behind the editor's "Preparing instrumentation" checklist.
   */
  readonly runtimeHooks: string[];

  /**
   * Every signal that could not be enabled, in report order: the feasibility
   * gate's refusals in plan order first, then the gaps the adapters reported in
   * install order.
   *
   * A non-empty list is **not** a failure. It is the graceful-degradation
   * channel of AAP §0.5.5, and the capture proceeds with what is available.
   */
  readonly unavailable: UnavailableSignal[];

  /**
   * The page agent's hook configuration, derived from the actions that were
   * actually installed and widened by the adapters' own contributions.
   *
   * Sent as `agent.config`. Dormant — every flag false — when nothing in the
   * page was armed.
   */
  readonly agentHooks: AgentHookConfig;

  /**
   * The dev-server preload's signal set, derived the same way.
   *
   * Sent as `server-agent.config`. Fully disabled for a browser-only plan,
   * which is AAP §0.5.1's promise that an unrelated plan collects no backend or
   * database telemetry.
   */
  readonly serverSignals: ServerAgentSignals;

  /**
   * Each adapter's own result, in install order — runtime-mode groups first.
   *
   * Kept so the service can attribute a gap or a modification to the adapter
   * that reported it, and so a suite can assert the ordering guarantee this
   * module exists to provide.
   */
  readonly perAdapter: InstallResult[];

  /**
   * The plan revision this install stamped, from
   * {@link InstrumentationContext.planVersion}.
   *
   * The context is authoritative, not the plan document: which revision is
   * being installed is the caller's statement, and every record of this round is
   * stamped from it.
   */
  readonly planVersion: number;
}

/**
 * What an unwound install left behind. Module-private: its contents reach a
 * caller as the summarised `details` of the returned error and as a log record,
 * because `Result`'s failure channel is a {@link DebuggenError}.
 */
interface RollbackReport {
  /** Records whose files were restored and verified. */
  readonly restored: ModificationRecord[];

  /** Records whose files were left as the developer left them, and why. */
  readonly conflicts: ModificationConflict[];

  /** Records the rollback could not finish, with their errors. */
  readonly failures: CleanupFailure[];
}

/** One adapter's actions for one phase, with the order it installs in. */
interface AdapterGroup {
  /** The adapter to ask. */
  readonly adapter: InstrumentationAdapter;

  /** The phase this group belongs to. */
  readonly mode: InstrumentationMode;

  /** The adapter's position in the registry's registration order. */
  readonly order: number;

  /** The actions to install, ordered by id. */
  readonly actions: InstrumentationAction[];
}

/** What {@link groupActions} produced. */
interface GroupingResult {
  /** The groups, ordered within each phase. */
  readonly groups: AdapterGroup[];

  /** The gaps grouping itself discovered: unresolvable adapters, unknown modes. */
  readonly unavailable: UnavailableSignal[];
}

/** The adapters an install may ask, as this module needs to consult them. */
interface AdapterLookup {
  /** The adapter registered under an id, or `undefined` when none is. */
  readonly get: (id: string) => InstrumentationAdapter | undefined;

  /** An adapter's position in registration order; unknown ids sort last. */
  readonly orderOf: (id: string) => number;

  /** The claim resolver, when the caller passed a registry. */
  readonly resolver: PlanAdapterResolver | undefined;

  /** How many adapters are available to ask. */
  readonly count: number;
}

// ---------------------------------------------------------------------------
// The public API
// ---------------------------------------------------------------------------

/**
 * Installs a validated plan — or a follow-up's delta of it — and reports what
 * was enabled, what was written and what could not be done here.
 *
 * ## The sequence
 *
 * 1. **The action set.** The whole plan, or — when {@link InstallPlanOptions.delta}
 *    is present — only the actions the delta names, matched by id. An action an
 *    earlier plan version already applied is therefore never installed twice.
 * 2. **The feasibility gate** (`./feasibility.ts`), unless
 *    {@link InstallPlanOptions.skipFeasibility}. Every refusal becomes an
 *    {@link UnavailableSignal} — the signal named from the action's type, the
 *    two sentences taken from the refusal — and the action is dropped. Nothing
 *    is silently discarded.
 * 3. **Grouping by adapter.** Each remaining action's `adapter` field is looked
 *    up in the registry or array that was passed in. An id nothing resolves,
 *    and an action whose `mode` is neither phase, are reported as unavailable
 *    rather than thrown — a stored plan read back after an upgrade may name an
 *    adapter that has since been removed, and that is a narrower capture, not a
 *    corrupt session.
 * 4. **Runtime groups, then patch groups.** Within each phase, groups install
 *    in the adapters' registration order and each group's actions are ordered
 *    by id, so two installs of the same plan install identically.
 * 5. **Aggregation.** `applied` is concatenated in application order,
 *    `runtimeHooks` is de-duplicated with first-occurrence order kept,
 *    `unavailable` is concatenated, and the two producer configurations are
 *    computed by `./schema/readiness.ts`'s derivations from the actions of the
 *    adapters that actually enabled something, then widened by those adapters'
 *    own contributions.
 *
 * ## What counts as failure
 *
 * `Err` is returned in exactly two situations, and neither is "a signal turned
 * out to be unavailable":
 *
 * - **Nothing at all could be enabled** — no modification applied and no
 *   runtime hook armed. The error carries `'INSTRUMENTATION_UNAVAILABLE'` and a
 *   `hint` naming the most actionable blocked signal, because the service turns
 *   it into `instrumentation.failed`.
 * - **An adapter failed part-way** — it rejected, returned something that is
 *   not an install result, or returned a result carrying
 *   {@link InstallResult.failure}: an action it accepted for install could not
 *   be completed (a patch refused or failed after the feasibility gate
 *   admitted it, a write-path failure, a cancellation mid-sequence). The error
 *   carries `'INSTRUMENTATION_INSTALL_FAILED'`, its `details.reason` is
 *   `'adapter-failed'`, `'invalid-result'` or `'action-failed'` respectively
 *   (`'aborted'` whenever the context's signal is aborted), and nothing that
 *   adapter armed or contributed is aggregated.
 *
 * Everything else returns `Ok`, including an install with a long `unavailable`
 * list: partial capability is the graceful-degradation path of AAP §0.5.5, and
 * the developer is told "Continuing with: ‹enabled list›" rather than shown a
 * dead session. A gap an adapter reports in `unavailable` — a preload that is
 * absent or silent, a hook installed after React — never fails an install.
 *
 * ## Rollback: what "left at its previous plan version" means
 *
 * If an adapter fails after one or more {@link ModificationRecord}s have been
 * applied **within this call**, those records — and only those — are
 * reverse-restored, latest first, through `./cleanup.ts`'s
 * `restoreModification`, which verifies each file against the record's
 * `instrumentedHash` before writing its backup back and never overwrites a file
 * a developer has edited. The set is every record the earlier groups applied,
 * then the failing adapter's own {@link InstallResult.applied}, then the record
 * it journaled for the failed attempt ({@link InstallFailure.record}) — last,
 * so it is the first restored — de-duplicated by record id. That last record
 * is settled by the reconciliation table of AAP §0.5.1: closed without a write
 * when its file still holds the original, restored when the file holds the
 * patch, reported as a conflict otherwise. Records from earlier plan versions
 * are left applied, so a failed delta leaves the project holding exactly the
 * instrumentation the previous plan version installed: a chained record's
 * backup is the *previous* instrumented content, so restoring the delta's
 * record returns the file to that state rather than to its pristine bytes.
 * Reverse application order is what keeps a chain over one file unwound
 * strictly last-applied-first.
 *
 * Rollback outcomes are collected, never swallowed and never retried in a
 * loop: each record is attempted once, a file that may not be restored is
 * reported as a conflict with its backup retained, and every restore failure is
 * summarised in the returned error's `details` and logged. A record a failing
 * adapter journaled but reported neither in `applied` nor as its failure's
 * `record` — a rejecting adapter's, typically — is outside this call's view; it
 * is an open journal entry, which is what `./cleanup.ts`'s
 * `reconcileModifications` acts on at the next service start.
 *
 * {@link InstrumentationContext.signal} is honoured between groups: an abort
 * unwinds this call's records the same way and returns the same error code.
 *
 * @param plan The normalised plan to install. Its `instrumentationTargets` are
 * the action set; its `planVersion` is *not* what the install stamps — see
 * {@link AggregateInstallResult.planVersion}.
 * @param context The session's context: the project root, the state directory,
 * the code graph and queries the gate reads, the journal and backup store the
 * patch layer and the rollback write through, the logger, and the optional
 * clock and cancellation signal.
 * @param options The adapters to ask, the delta to apply, and whether the gate
 * has already run.
 * @returns `ok(result)` describing everything that was enabled — even where
 * some signals were not — or `err(error)` for the two failures above.
 * @throws {DebuggenError} `'INTERNAL'` when the caller's own wiring is wrong: a
 * context with no logger, project root, plan version, journal or backup store; a
 * plan whose `instrumentationTargets` is not an array; a plan belonging to a
 * different session than the context; or no adapters at all. These say nothing
 * about the developer's project, so they are not reported as unavailable
 * signals.
 *
 * @example A session's first install
 * ```ts
 * const installed = await installPlan(plan, context, { adapters: registry });
 *
 * if (isErr(installed)) {
 *   send({ type: 'instrumentation.failed', payload: { sessionId, error: installed.error.toPayload() } });
 *   return;
 * }
 *
 * const { applied, runtimeHooks, unavailable, agentHooks, serverSignals } = installed.value;
 * send({ type: 'instrumentation.ready', payload: { sessionId, applied, runtimeHooks, unavailable } });
 * sendToAgent({ type: 'agent.config', payload: { sessionId, captureId, hooks: agentHooks } });
 * ```
 *
 * @example A follow-up's delta install
 * ```ts
 * const installed = await installPlan(nextPlan, { ...context, planVersion: nextPlan.planVersion }, {
 *   adapters: registry,
 *   delta: { previousPlanVersion: plan.planVersion, actionIds: addedActionIds },
 * });
 * ```
 */
export async function installPlan(
  plan: InstrumentationPlan,
  context: InstrumentationContext,
  options: InstallPlanOptions,
): Promise<Result<AggregateInstallResult>> {
  const logger = requireUsableContext(context);
  const lookup = requireAdapters(options);
  const targets = requireInstallablePlan(plan, context, logger);
  const planVersion = context.planVersion;
  const previousPlanVersion = options.delta?.previousPlanVersion;

  const selected = selectActions(targets, options.delta, context, logger);
  const unavailable: UnavailableSignal[] = [];
  let candidates: readonly InstrumentationAction[] = selected;

  if (options.skipFeasibility !== true) {
    const gated = gateFeasibility(selected, context, lookup.resolver);
    candidates = gated.feasible;
    unavailable.push(...gated.unavailable);
  }

  const grouping = groupActions(candidates, lookup);
  unavailable.push(...grouping.unavailable);

  logger.debug('installing an instrumentation plan', {
    sessionId: context.sessionId,
    planVersion,
    previousPlanVersion,
    selected: selected.length,
    feasible: candidates.length,
    groups: grouping.groups.length,
    adapters: lookup.count,
    delta: options.delta !== undefined,
  });

  const applied: ModificationRecord[] = [];
  const perAdapter: InstallResult[] = [];
  const hooks = new Set<string>();
  const installedActions: InstrumentationAction[] = [];
  const agentContributions: Partial<AgentHookConfig>[] = [];
  const serverContributions: Partial<ServerAgentSignals>[] = [];
  const tiers = new Map<string, ActionTier>();

  for (const phase of INSTALL_PHASES) {
    for (const group of grouping.groups) {
      if (group.mode !== phase) {
        continue;
      }

      if (isAborted(context)) {
        return err(
          await unwind(applied, context, {
            reason: 'aborted',
            adapterId: group.adapter.id,
            planVersion,
            previousPlanVersion,
          }),
        );
      }

      let raw: InstallResult;

      try {
        raw = await group.adapter.install(group.actions, context);
      } catch (caught) {
        return err(
          await unwind(applied, context, {
            reason: 'adapter-failed',
            adapterId: group.adapter.id,
            planVersion,
            previousPlanVersion,
            cause: caught,
          }),
        );
      }

      const reported = readInstallResult(raw);

      if (reported === undefined) {
        return err(
          await unwind(applied, context, {
            reason: 'invalid-result',
            adapterId: group.adapter.id,
            planVersion,
            previousPlanVersion,
          }),
        );
      }

      const failure = reported.failure;

      if (failure !== undefined) {
        // The fatal channel: an action this adapter accepted could not be
        // completed. Nothing it armed or contributed is aggregated, and every
        // record this call applied — the earlier groups', this adapter's own,
        // and the one it journaled for the failed attempt, which goes last so
        // it is restored first — is reverse-restored before the error returns.
        return err(
          await unwind(rollbackSetOf(applied, reported.applied, failure.record), context, {
            reason: isAborted(context) ? 'aborted' : 'action-failed',
            adapterId: group.adapter.id,
            planVersion,
            previousPlanVersion,
            cause: failure.error,
            failure,
          }),
        );
      }

      perAdapter.push(raw);
      applied.push(...reported.applied);
      unavailable.push(...reported.unavailable);

      for (const hook of reported.runtimeHooks) {
        hooks.add(hook);
      }

      const tier = reported.enabled ? tierOfResult(raw) : 'unknown';

      if (reported.enabled) {
        for (const action of group.actions) {
          tiers.set(action.id, tier);
        }

        installedActions.push(...group.actions);

        if (raw.agentHooks !== undefined) {
          agentContributions.push(raw.agentHooks);
        }

        if (raw.serverSignals !== undefined) {
          serverContributions.push(raw.serverSignals);
        }
      }

      logger.debug('an adapter installed its share of the plan', {
        sessionId: context.sessionId,
        planVersion,
        adapter: group.adapter.id,
        mode: group.mode,
        actions: group.actions.length,
        applied: reported.applied.length,
        runtimeHooks: reported.runtimeHooks.length,
        unavailable: reported.unavailable.length,
        enabled: reported.enabled,
        tier,
      });
    }
  }

  if (isAborted(context)) {
    return err(
      await unwind(applied, context, {
        reason: 'aborted',
        planVersion,
        previousPlanVersion,
      }),
    );
  }

  const resolver: ActionTierResolver = {
    tierOf: (action: InstrumentationAction): ActionTier => tiers.get(action.id) ?? 'unknown',
  };
  const agentHooks = mergeAgentHooks(
    deriveAgentHookConfig(installedActions, { tiers: resolver }),
    agentContributions,
  );
  const serverSignals = mergeServerSignals(
    deriveServerAgentSignals(installedActions, { tiers: resolver }),
    serverContributions,
  );
  const runtimeHooks = [...hooks];

  if (applied.length === 0 && runtimeHooks.length === 0) {
    const error = nothingEnabledError(unavailable, {
      sessionId: context.sessionId,
      planVersion,
      selected: selected.length,
      feasible: candidates.length,
      adapters: lookup.count,
    });

    logger.error(error.message, {
      sessionId: context.sessionId,
      planVersion,
      unavailable: unavailable.length,
      hint: error.hint,
    });

    return err(error);
  }

  logger.info('instrumentation installed', {
    sessionId: context.sessionId,
    planVersion,
    applied: applied.length,
    runtimeHooks,
    unavailable: unavailable.map((gap) => gap.signal).slice(0, MAX_REPORTED_ITEMS),
    adapters: perAdapter.map((result) => result.adapterId),
  });

  return ok({
    applied,
    runtimeHooks,
    unavailable,
    agentHooks,
    serverSignals,
    perAdapter,
    planVersion,
  });
}

// ---------------------------------------------------------------------------
// Caller invariants
//
// The conditions below are defects in the calling code, not facts about the
// developer's project, so they are thrown rather than reported as unavailable
// signals — exactly the split `./feasibility.ts` draws. Each names the one
// thing that would fix it.
// ---------------------------------------------------------------------------

/**
 * How many ids or names a log field or an error detail carries before it is
 * truncated.
 *
 * Both destinations are read by people: a log line that scrolls for a hundred
 * ids and an error payload that has to travel to two user interfaces are worse
 * than a bounded one plus a count, which every call site also emits.
 */
const MAX_REPORTED_ITEMS = 20;

/**
 * Whether a value carries a callable member under `name`.
 *
 * Structural rather than `instanceof`, because a context, a registry or an
 * adapter may have been built by another bundle or written in JavaScript.
 *
 * @param value Any value.
 * @param name The member to look for.
 * @returns `true` when the member is a function.
 */
function hasMethod(value: unknown, name: string): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return typeof (value as Record<string, unknown>)[name] === 'function';
}

/**
 * Whether a value is a string with at least one non-whitespace character.
 *
 * @param value Any value.
 * @returns `true` when the value is usable as an id, a name or a label.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Checks the context members this module and its rollback path depend on, and
 * returns its logger.
 *
 * The code graph and query surface are *not* checked here: they belong to the
 * feasibility gate, which validates them itself and which a caller may
 * legitimately skip.
 *
 * @param context The context to check.
 * @returns The context's logger.
 * @throws {DebuggenError} `'INTERNAL'` when a member is missing or unusable.
 */
function requireUsableContext(context: InstrumentationContext): Logger {
  const logger: unknown = context.logger;

  if (!hasMethod(logger, 'debug') || !hasMethod(logger, 'error')) {
    throw new DebuggenError('INTERNAL', 'An install was given a context with no logger.', {
      hint: 'Pass the session logger, or noopLogger from @debuggen/shared when no output is wanted.',
    });
  }

  if (!isNonEmptyString(context.projectRoot)) {
    throw new DebuggenError('INTERNAL', 'An install was given a context with no project root.', {
      hint: 'Pass the absolute POSIX project root the service resolved from the workspace folder.',
    });
  }

  if (!Number.isInteger(context.planVersion) || context.planVersion < 1) {
    throw new DebuggenError(
      'INTERNAL',
      'An install was given a context with no plan version to stamp.',
      {
        hint: "Set the context's planVersion to the revision being installed, counting from 1.",
        details: { planVersion: context.planVersion },
      },
    );
  }

  if (!hasMethod(context.journal, 'append') || !hasMethod(context.journal, 'updateStatus')) {
    throw new DebuggenError(
      'INTERNAL',
      'An install was given a context with no modification journal.',
      {
        hint: "Pass the service's modification journal, which records an edit before it is written and is what a rollback transitions.",
      },
    );
  }

  if (typeof context.backups !== 'object' || context.backups === null) {
    throw new DebuggenError('INTERNAL', 'An install was given a context with no backup store.', {
      hint: 'Build the context with createBackupStore over the session id and the product state directory.',
    });
  }

  return context.logger;
}

/**
 * Builds the adapter lookup, and checks that at least one adapter was offered.
 *
 * An empty registry or array can install nothing at all, and reporting that
 * through {@link AggregateInstallResult.unavailable} would blame the
 * developer's project for a wiring mistake in the caller — so it is thrown
 * here rather than reported there.
 *
 * @param options The install options.
 * @returns The lookup the install resolves every action through.
 * @throws {DebuggenError} `'INTERNAL'` when no adapters were passed, or none
 * carries a usable id.
 */
function requireAdapters(options: InstallPlanOptions): AdapterLookup {
  const adapters: unknown = options.adapters;

  if (typeof adapters !== 'object' || adapters === null) {
    throw new DebuggenError('INTERNAL', 'An install was given no adapters to ask.', {
      hint: 'Pass options.adapters: the service\u2019s adapter registry, or an array of adapters in a suite.',
    });
  }

  const lookup = adapterLookup(options.adapters);

  if (lookup.count === 0) {
    throw new DebuggenError('INTERNAL', 'An install was given an empty set of adapters.', {
      hint: 'Register the built-in adapters with createAdapterRegistry before installing a plan, or pass the adapters a suite wants asked.',
    });
  }

  return lookup;
}

/**
 * Checks the plan can be installed against this context, and returns its
 * actions.
 *
 * A plan version that disagrees with the context's is a warning rather than a
 * refusal: the context is authoritative about which revision is being stamped
 * (see {@link AggregateInstallResult.planVersion}), and a re-install of an
 * earlier plan document under a new revision is legitimate. A *session*
 * mismatch is not: the records this install produces would be filed under the
 * context's session while the plan named another, and nothing downstream could
 * reconcile the two.
 *
 * @param plan The plan to install.
 * @param context The session's context.
 * @param logger The context's logger.
 * @returns The plan's actions.
 * @throws {DebuggenError} `'INTERNAL'` for a non-array action list or a session
 * mismatch.
 */
function requireInstallablePlan(
  plan: InstrumentationPlan,
  context: InstrumentationContext,
  logger: Logger,
): readonly InstrumentationAction[] {
  const targets: unknown = plan.instrumentationTargets;

  if (!Array.isArray(targets)) {
    throw new DebuggenError(
      'INTERNAL',
      'An install was given a plan whose instrumentationTargets is not an array.',
      {
        hint: 'Parse the plan with parseInstrumentationPlan before installing it, so a malformed plan is reported as PLAN_INVALID rather than here.',
      },
    );
  }

  if (isNonEmptyString(plan.sessionId) && plan.sessionId !== context.sessionId) {
    throw new DebuggenError(
      'INTERNAL',
      'An install was given a plan belonging to a different session than the context.',
      {
        hint: "Install a session's plan with that session's context, so every modification record is filed under the session that owns it.",
        details: { planSessionId: plan.sessionId, contextSessionId: context.sessionId },
      },
    );
  }

  if (plan.planVersion !== context.planVersion) {
    logger.warn('installing a plan document whose planVersion differs from the context', {
      sessionId: context.sessionId,
      planVersion: context.planVersion,
      planDocumentVersion: plan.planVersion,
    });
  }

  return plan.instrumentationTargets;
}

// ---------------------------------------------------------------------------
// Action selection and the feasibility gate
// ---------------------------------------------------------------------------

/**
 * The actions this call installs: the whole plan, or a delta's additions.
 *
 * @param targets The plan's actions.
 * @param delta The delta, when this is a follow-up install.
 * @param context The session's context.
 * @param logger The context's logger.
 * @returns The selected actions, in plan order.
 */
function selectActions(
  targets: readonly InstrumentationAction[],
  delta: InstallDelta | undefined,
  context: InstrumentationContext,
  logger: Logger,
): readonly InstrumentationAction[] {
  if (delta === undefined) {
    return targets;
  }

  const wanted = new Set(delta.actionIds);
  const selected = targets.filter((action) => wanted.has(action.id));
  const found = new Set(selected.map((action) => action.id));
  const missing = [...wanted].filter((id) => !found.has(id));

  if (delta.previousPlanVersion >= context.planVersion) {
    logger.warn('a delta install names a previous plan version that is not earlier', {
      sessionId: context.sessionId,
      planVersion: context.planVersion,
      previousPlanVersion: delta.previousPlanVersion,
    });
  }

  if (missing.length > 0) {
    logger.warn('a delta install named actions this plan does not carry; they were ignored', {
      sessionId: context.sessionId,
      planVersion: context.planVersion,
      missing: missing.slice(0, MAX_REPORTED_ITEMS),
      missingCount: missing.length,
    });
  }

  return selected;
}

/** What {@link gateFeasibility} produced. */
interface GateResult {
  /** The actions that may be installed, in plan order. */
  readonly feasible: readonly InstrumentationAction[];

  /** One reported gap per refused action, in plan order. */
  readonly unavailable: UnavailableSignal[];
}

/**
 * Runs the feasibility gate and turns every refusal into a reported gap.
 *
 * The refusal's own two sentences are carried verbatim — they were written for
 * the developer, and rewording them here would make the same condition read
 * differently depending on which module reported it.
 *
 * @param actions The actions to judge.
 * @param context The session's context.
 * @param resolver The adapter claim resolver, when the caller passed a
 * registry.
 * @returns The installable actions and the gaps.
 */
function gateFeasibility(
  actions: readonly InstrumentationAction[],
  context: InstrumentationContext,
  resolver: PlanAdapterResolver | undefined,
): GateResult {
  const report = checkFeasibility(actions, context, { resolver });

  return {
    feasible: report.feasible,
    unavailable: report.rejected.map(unavailableForRejection),
  };
}

/**
 * The reported gap for one refused action.
 *
 * @param rejection The gate's refusal.
 * @returns The gap, named in the closed signal vocabulary where the action's
 * type maps onto it.
 */
function unavailableForRejection(rejection: InfeasibleAction): UnavailableSignal {
  return {
    signal: signalForActionType(rejection.action.type),
    reason: rejection.reason,
    hint: rejection.hint,
  };
}

// ---------------------------------------------------------------------------
// Adapters: resolution, order and grouping
// ---------------------------------------------------------------------------

/**
 * Whether the adapters were passed as a registry rather than as an array.
 *
 * Structural: anything that answers `adapters()` and `get()` is treated as a
 * registry, which is what lets a suite pass a stub without constructing the
 * real one.
 *
 * @param value What the caller passed.
 * @returns `true` for a registry.
 */
function isAdapterRegistry(
  value: AdapterRegistry | readonly InstrumentationAdapter[],
): value is AdapterRegistry {
  return !Array.isArray(value) && hasMethod(value, 'adapters') && hasMethod(value, 'get');
}

/**
 * The position of each adapter id in registration order.
 *
 * @param adapters The adapters, in the order they were registered.
 * @returns A map from id to index.
 */
function orderIndex(adapters: readonly InstrumentationAdapter[]): Map<string, number> {
  const order = new Map<string, number>();

  for (const adapter of adapters) {
    if (isNonEmptyString(adapter?.id) && !order.has(adapter.id)) {
      order.set(adapter.id, order.size);
    }
  }

  return order;
}

/**
 * A registry's members, in registration order, defensively.
 *
 * A registry is caller-supplied code and may be a stub or a third-party
 * implementation; a listing that throws costs the install its *ordering*
 * information and nothing else, because every action is still resolved through
 * `get()` and an unresolvable id is reported as a gap.
 *
 * @param registry The registry to list.
 * @returns Its adapters, or an empty list when it could not be asked.
 */
function listRegisteredAdapters(registry: AdapterRegistry): readonly InstrumentationAdapter[] {
  try {
    return registry.adapters();
  } catch {
    return [];
  }
}

/**
 * The adapters, as this module consults them.
 *
 * Both a registry's `adapters()` and its `get()` are called defensively: a
 * third-party registry is ordinary caller-supplied code, and a probe that
 * throws must cost the signals that adapter would have supplied and nothing
 * more — which is reported as an unavailable gap by {@link groupActions}.
 *
 * @param adapters The registry or array the caller passed.
 * @returns The lookup.
 */
function adapterLookup(
  adapters: AdapterRegistry | readonly InstrumentationAdapter[],
): AdapterLookup {
  if (isAdapterRegistry(adapters)) {
    const order = orderIndex([...listRegisteredAdapters(adapters)]);

    return {
      get: (id: string): InstrumentationAdapter | undefined => {
        try {
          return adapters.get(id);
        } catch {
          return undefined;
        }
      },
      orderOf: (id: string): number => order.get(id) ?? order.size,
      resolver: hasMethod(adapters, 'resolveActionType') ? adapters : undefined,
      count: order.size,
    };
  }

  const byId = new Map<string, InstrumentationAdapter>();

  for (const adapter of adapters) {
    if (isNonEmptyString(adapter?.id) && !byId.has(adapter.id)) {
      byId.set(adapter.id, adapter);
    }
  }

  const order = orderIndex([...byId.values()]);

  return {
    get: (id: string): InstrumentationAdapter | undefined => byId.get(id),
    orderOf: (id: string): number => order.get(id) ?? order.size,
    resolver: undefined,
    count: byId.size,
  };
}

/**
 * Groups the installable actions by adapter and phase, and orders the groups.
 *
 * Two conditions are reported rather than dropped, and both are survivable:
 * an `adapter` id nothing resolves — a stored plan read back after the adapter
 * was removed, or a registry whose lookup threw — and a `mode` that is neither
 * phase, which only a value that bypassed `./schema/plan.ts` can carry. Each is
 * reported once per adapter and signal, so one missing adapter with five
 * actions does not fill a user interface with five identical rows.
 *
 * @param actions The actions to group, in plan order.
 * @param lookup The adapters to resolve against.
 * @returns The ordered groups and the gaps grouping discovered.
 */
function groupActions(
  actions: readonly InstrumentationAction[],
  lookup: AdapterLookup,
): GroupingResult {
  const groups = new Map<string, AdapterGroup>();
  const unavailable: UnavailableSignal[] = [];
  const reported = new Set<string>();

  const report = (key: string, gap: UnavailableSignal): void => {
    if (!reported.has(key)) {
      reported.add(key);
      unavailable.push(gap);
    }
  };

  for (const action of actions) {
    const signal = signalForActionType(action.type);
    const adapter = lookup.get(action.adapter);

    if (adapter === undefined) {
      report(`adapter:${action.adapter}:${signal}`, {
        signal,
        reason: `no adapter is registered under the id "${action.adapter}" that this plan resolved the action to`,
        hint: 'Ask this question again so the plan resolves against the adapters this build registers, or register the adapter that installs this signal.',
      });
      continue;
    }

    if (!INSTALL_PHASES.includes(action.mode)) {
      report(`mode:${action.mode}:${signal}`, {
        signal,
        reason: `the action's install mode "${action.mode}" is neither runtime nor patch`,
        hint: 'Normalise the plan with normalizePlan before installing it, so every action carries the mode its adapter installs it in.',
      });
      continue;
    }

    const key = `${action.mode}\u0000${adapter.id}`;
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, {
        adapter,
        mode: action.mode,
        order: lookup.orderOf(adapter.id),
        actions: [action],
      });
      continue;
    }

    existing.actions.push(action);
  }

  const ordered = [...groups.values()];

  for (const group of ordered) {
    group.actions.sort((left, right) => compareText(left.id, right.id));
  }

  ordered.sort(
    (left, right) => left.order - right.order || compareText(left.adapter.id, right.adapter.id),
  );

  return { groups: ordered, unavailable };
}

// ---------------------------------------------------------------------------
// Reading an adapter's answer
//
// An adapter may be a third-party implementation written in JavaScript, so its
// result is read structurally before it is aggregated. A result that is not an
// install result at all is the "failing result" case of the rollback contract;
// an individual element that is not usable is left out of the aggregate rather
// than taking the install down, because a malformed hook label is not worth a
// dead session while a malformed modification record must never reach the
// rollback loop as though it were restorable.
// ---------------------------------------------------------------------------

/**
 * An adapter's {@link InstallFailure}, after it has been read.
 *
 * Every member has been narrowed from what a possibly third-party adapter
 * returned: the error is a real {@link DebuggenError}, a string fact is kept
 * only when it is non-blank, a record only when the rollback can address it,
 * and a conflict report only when it is an object. The report itself is never
 * copied into an error's details or a log line — it holds diffs — and only its
 * presence is recorded.
 */
interface ReportedFailure {
  /** The failure's coded error, which becomes the returned error's `cause`. */
  readonly error: DebuggenError;

  /** The signal the failed action would have supplied, when it was named. */
  readonly signal?: InstallFailure['signal'] | undefined;

  /** The failed action's id, when it was named. */
  readonly actionId?: string | undefined;

  /** The failed target's project-relative file, when it was named. */
  readonly file?: string | undefined;

  /** The symbol the failed action addressed, when it was named. */
  readonly symbol?: string | undefined;

  /** The record journaled for the failed attempt, when there is one. */
  readonly record?: ModificationRecord | undefined;

  /** The baseline-conflict report, when there is one. Never logged. */
  readonly conflict?: ModificationConflict | undefined;
}

/** What one adapter's result contributes, after it has been read. */
interface ReportedInstall {
  /** The usable modification records, in the order the adapter applied them. */
  readonly applied: ModificationRecord[];

  /** The usable hook labels. */
  readonly runtimeHooks: string[];

  /** The usable gap reports. */
  readonly unavailable: UnavailableSignal[];

  /** Whether this adapter enabled anything at all: a hook or a modification. */
  readonly enabled: boolean;

  /**
   * The fatal-channel report, when the adapter could not complete an action it
   * accepted. Present means the caller unwinds instead of aggregating.
   */
  readonly failure?: ReportedFailure | undefined;
}

/**
 * Narrows an unknown value to a list without admitting `any` elements.
 *
 * @param value Any value.
 * @returns The value as a list of unknowns, or `undefined` when it is not an
 * array.
 */
function asList(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value as readonly unknown[];
}

/**
 * Whether a value carries the members the rollback path addresses a record by.
 *
 * Deliberately not a full schema parse: the record was produced and journaled
 * by the patch layer, and `restoreModification` re-reads and re-verifies every
 * hash itself. What this rules out is a value that cannot even be attributed to
 * a file or a session, which would make a rollback failure unreportable.
 *
 * @param value Any value.
 * @returns `true` when the value can be treated as a modification record.
 */
function isRecordLike(value: unknown): value is ModificationRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { id?: unknown; sessionId?: unknown; file?: unknown };

  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.sessionId) &&
    isNonEmptyString(candidate.file)
  );
}

/**
 * Whether a value is a hook label a developer could read.
 *
 * @param value Any value.
 * @returns `true` for a non-blank string.
 */
function isHookLabel(value: unknown): value is string {
  return isNonEmptyString(value);
}

/**
 * Whether a value is a gap report with all three fields a user interface
 * renders.
 *
 * @param value Any value.
 * @returns `true` when the value can be shown as an unavailable signal.
 */
function isUnavailableLike(value: unknown): value is UnavailableSignal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { signal?: unknown; reason?: unknown; hint?: unknown };

  return (
    isNonEmptyString(candidate.signal) &&
    typeof candidate.reason === 'string' &&
    typeof candidate.hint === 'string'
  );
}

/**
 * The outcome of reading an adapter's `failure` member.
 *
 * Three answers rather than two, because "no failure" and "not a failure at
 * all" call for different unwinds: an absent member is the ordinary success an
 * adapter written before the fatal channel existed returns, while a member of
 * the wrong type means the value is not an install result.
 */
type FailureReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly failure: ReportedFailure }
  | { readonly kind: 'invalid' };

/**
 * Reads an adapter's `failure` member structurally.
 *
 * `undefined` and `null` are no failure — the additive contract, under which an
 * explicit `failure: undefined` is an ordinary success. A non-array object is a
 * failure, whatever else it carries: an adapter that took the trouble to report
 * one has not completed its install, and the worst reading of a malformed
 * report is to ignore it. Anything else — a string, a number, an array — is not
 * a failure report, and makes the whole value not an install result.
 *
 * @param value The member as the adapter returned it.
 * @returns The reading.
 */
function readFailure(value: unknown): FailureReading {
  if (value === undefined || value === null) {
    return { kind: 'none' };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid' };
  }

  const candidate = value as {
    error?: unknown;
    signal?: unknown;
    actionId?: unknown;
    file?: unknown;
    symbol?: unknown;
    record?: unknown;
    conflict?: unknown;
  };
  const { signal, actionId, file, symbol, record, conflict } = candidate;

  return {
    kind: 'failed',
    failure: {
      // `from` returns a real error unchanged and normalises anything else,
      // so a JavaScript adapter that reported a bare string or nothing at all
      // still yields a coded error the service can send.
      error: DebuggenError.from(candidate.error, 'INSTRUMENTATION_INSTALL_FAILED'),
      ...(isNonEmptyString(signal) ? { signal } : {}),
      ...(isNonEmptyString(actionId) ? { actionId } : {}),
      ...(isNonEmptyString(file) ? { file } : {}),
      ...(isNonEmptyString(symbol) ? { symbol } : {}),
      ...(isRecordLike(record) ? { record } : {}),
      ...(typeof conflict === 'object' && conflict !== null
        ? { conflict: conflict as ModificationConflict }
        : {}),
    },
  };
}

/**
 * Reads one adapter's result, or reports that it is not one.
 *
 * A result carrying a failure is read leniently: only its `applied` records
 * matter — they are the adapter's share of the rollback set — and every other
 * member is ignored, as the contract states, so a malformed hook list beside a
 * real failure does not cost the rollback the records the adapter did return.
 *
 * @param value What the adapter returned.
 * @returns What it contributes, or `undefined` when the value is not an install
 * result — the condition the caller unwinds on.
 */
function readInstallResult(value: InstallResult): ReportedInstall | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const candidate = value as {
    applied?: unknown;
    runtimeHooks?: unknown;
    unavailable?: unknown;
    failure?: unknown;
  };
  const applied = asList(candidate.applied);
  const failure = readFailure(candidate.failure);

  if (failure.kind === 'invalid') {
    return undefined;
  }

  if (failure.kind === 'failed') {
    return {
      applied: (applied ?? []).filter(isRecordLike),
      runtimeHooks: [],
      unavailable: [],
      enabled: false,
      failure: failure.failure,
    };
  }

  const runtimeHooks = asList(candidate.runtimeHooks);
  const unavailable = asList(candidate.unavailable);

  if (applied === undefined || runtimeHooks === undefined || unavailable === undefined) {
    return undefined;
  }

  const records = applied.filter(isRecordLike);
  const hooks = runtimeHooks.filter(isHookLabel);

  return {
    applied: records,
    runtimeHooks: hooks,
    unavailable: unavailable.filter(isUnavailableLike),
    enabled: records.length > 0 || hooks.length > 0,
  };
}

// ---------------------------------------------------------------------------
// The two producer configurations
//
// `./schema/readiness.ts` owns the policy: which hooks an action type arms,
// which patched symbols belong in the preload's `functions` list, and the two
// prerequisites that hold a correlated trace together. This module supplies it
// with the actions that were actually installed, tells it which tier each one
// ran in, and then widens the answer with the adapters' own contributions.
// ---------------------------------------------------------------------------

/**
 * Whether an adapter's contribution arms anything in the page.
 *
 * @param contribution The adapter's page-agent contribution, if any.
 * @returns `true` when at least one hook is switched on.
 */
function armsAnyAgentHook(contribution: Partial<AgentHookConfig> | undefined): boolean {
  if (typeof contribution !== 'object' || contribution === null) {
    return false;
  }

  return AGENT_HOOK_KEYS.some((key) => contribution[key] === true);
}

/**
 * Whether an adapter's contribution arms anything in the dev-server process.
 *
 * @param contribution The adapter's preload contribution, if any.
 * @returns `true` when at least one signal is switched on or one symbol is
 * named.
 */
function armsAnyServerSignal(contribution: Partial<ServerAgentSignals> | undefined): boolean {
  if (typeof contribution !== 'object' || contribution === null) {
    return false;
  }

  if (
    contribution.http === true ||
    contribution.routeHandlers === true ||
    contribution.fetch === true ||
    contribution.prisma === true ||
    contribution.pg === true
  ) {
    return true;
  }

  return (asList(contribution.functions) ?? []).length > 0;
}

/**
 * Which tier an adapter's actions ran in, read off what the adapter armed.
 *
 * The installer knows which adapter installed each action but nothing about
 * where an adapter's instrumentation lives, and `./schema/readiness.ts`
 * deliberately never learns an adapter id. The adapter's own contributions
 * settle it: one that armed page hooks and nothing in the server ran in the
 * browser, one that armed server signals and nothing in the page ran in the
 * dev-server process, and anything else is `'unknown'` — which the derivations
 * read as "decide from the action type alone", their documented default.
 *
 * The distinction earns its place on one case in particular: a `patch`-mode
 * `function-timing` action installed by a browser-tier adapter is timed by the
 * page's own span helper, so classifying it `'browser'` keeps its symbol out of
 * the preload's `functions` list, where it would ask the server to wrap a name
 * that never runs there.
 *
 * @param result The adapter's result.
 * @returns The tier its actions are attributed to.
 */
function tierOfResult(result: InstallResult): ActionTier {
  const browser = armsAnyAgentHook(result.agentHooks);
  const server = armsAnyServerSignal(result.serverSignals);

  if (browser && !server) {
    return 'browser';
  }

  if (server && !browser) {
    return 'server';
  }

  return 'unknown';
}

/**
 * Widens the derived page-agent configuration with the adapters'
 * contributions.
 *
 * Additive only: a flag an adapter reports `true` is switched on, and one it
 * reports `false` never switches a derived flag off — an adapter speaks for the
 * hooks it claims and says nothing about the rest. The final pass re-closes the
 * prerequisite `deriveAgentHookConfig` states for the actions it could see: if
 * any hook ended up on, the interaction listener is on, because it is what mints
 * the trace root and opens the window in which the request patch injects
 * `traceparent` — without it browser and server spans become two unrelated
 * trees and the capture fails silently.
 *
 * @param derived The configuration derived from the installed actions.
 * @param contributions Each adapter's contribution, in install order.
 * @returns A fresh configuration.
 */
function mergeAgentHooks(
  derived: AgentHookConfig,
  contributions: readonly Partial<AgentHookConfig>[],
): AgentHookConfig {
  const merged: Record<AgentHookKey, boolean> = { ...derived };

  for (const contribution of contributions) {
    for (const key of AGENT_HOOK_KEYS) {
      if (contribution[key] === true) {
        merged[key] = true;
      }
    }
  }

  if (AGENT_HOOK_KEYS.some((key) => merged[key])) {
    merged.interactions = true;
  }

  return merged;
}

/**
 * Widens the derived preload signal set with the adapters' contributions.
 *
 * Additive in the same way, and it re-closes the same kind of prerequisite:
 * whenever anything on this tier ended up requested, the incoming-request and
 * route-handler spans are switched on, because they are the spine a server
 * trace hangs off — the request span is where the browser's `traceparent` is
 * extracted and the handler span is what parents the rest, so a database or
 * function span collected without them arrives as a flagged orphan instead of a
 * row in a tree.
 *
 * Symbol names are de-duplicated and ordered by code unit, matching the
 * derivation, so one plan always produces one frame.
 *
 * @param derived The signal set derived from the installed actions.
 * @param contributions Each adapter's contribution, in install order.
 * @returns A fresh signal set, with a `functions` array no caller shares.
 */
function mergeServerSignals(
  derived: ServerAgentSignals,
  contributions: readonly Partial<ServerAgentSignals>[],
): ServerAgentSignals {
  let http = derived.http;
  let routeHandlers = derived.routeHandlers;
  let fetch = derived.fetch;
  let prisma = derived.prisma;
  let pg = derived.pg;
  const functions = new Set<string>((asList(derived.functions) ?? []).filter(isNonEmptyString));

  for (const contribution of contributions) {
    http = http || contribution.http === true;
    routeHandlers = routeHandlers || contribution.routeHandlers === true;
    fetch = fetch || contribution.fetch === true;
    prisma = prisma || contribution.prisma === true;
    pg = pg || contribution.pg === true;

    for (const symbol of (asList(contribution.functions) ?? []).filter(isNonEmptyString)) {
      functions.add(symbol);
    }
  }

  if (!http && !routeHandlers && !fetch && !prisma && !pg && functions.size === 0) {
    return {
      http: false,
      routeHandlers: false,
      fetch: false,
      prisma: false,
      pg: false,
      functions: [],
    };
  }

  return {
    http: true,
    routeHandlers: true,
    fetch,
    prisma,
    pg,
    functions: [...functions].sort(compareText),
  };
}

// ---------------------------------------------------------------------------
// Failure: rollback and the two errors
// ---------------------------------------------------------------------------

/**
 * Whether the caller has cancelled this install.
 *
 * @param context The session's context.
 * @returns `true` when the context's signal is aborted.
 */
function isAborted(context: InstrumentationContext): boolean {
  return context.signal?.aborted === true;
}

/** Why an install is being unwound, and what the error should say about it. */
interface UnwindInput {
  /**
   * The condition that stopped the install: a cancellation, an adapter that
   * rejected, a value that is not an install result, or a result that carried
   * a failure through the fatal channel.
   */
  readonly reason: 'aborted' | 'adapter-failed' | 'invalid-result' | 'action-failed';

  /** The adapter that was installing, when one was. */
  readonly adapterId?: string | undefined;

  /** The plan revision this install was stamping. */
  readonly planVersion: number;

  /** The revision the session returns to, for a delta install. */
  readonly previousPlanVersion?: number | undefined;

  /** What the adapter threw, or the error its reported failure carried. */
  readonly cause?: unknown;

  /**
   * The failure the adapter reported through the fatal channel, when it did.
   *
   * Its identifying facts are added to the error's details and its own message
   * and hint are quoted; its conflict report, which holds diffs, is not copied.
   */
  readonly failure?: ReportedFailure | undefined;
}

/**
 * The records a failed install must reverse-restore, in application order.
 *
 * The earlier groups' records, then the failing adapter's own, then the record
 * it journaled for the failed attempt — which is therefore the first one
 * {@link rollbackApplied} restores, because it is the last write that may have
 * touched the project. De-duplicated by record id with the first occurrence's
 * position kept, so an adapter that listed its failed record in both places
 * does not have it restored twice (the second attempt would find the file
 * already restored and report a conflict that is not one).
 *
 * @param earlier The records the groups before the failing one applied.
 * @param reported The failing adapter's {@link InstallResult.applied}.
 * @param failed The record journaled for the failed attempt, when there is one.
 * @returns A fresh array in application order.
 */
function rollbackSetOf(
  earlier: readonly ModificationRecord[],
  reported: readonly ModificationRecord[],
  failed: ModificationRecord | undefined,
): ModificationRecord[] {
  const seen = new Set<string>();
  const set: ModificationRecord[] = [];

  for (const record of [...earlier, ...reported, ...(failed === undefined ? [] : [failed])]) {
    if (!seen.has(record.id)) {
      seen.add(record.id);
      set.push(record);
    }
  }

  return set;
}

/**
 * Builds the failure report for one record the rollback could not finish.
 *
 * @param record The record that was being restored.
 * @param error Why it could not be.
 * @returns The failure.
 */
function rollbackFailure(record: ModificationRecord, error: DebuggenError): CleanupFailure {
  return {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    error,
  };
}

/**
 * Reverse-restores exactly the records this install applied.
 *
 * Strictly latest-first over the application order, which is what unwinds a
 * chain over one file last-applied-first: a chained record's backup holds the
 * content the *previous* plan version's patch left, so restoring this call's
 * records returns each file to the state the previous plan version installed
 * and leaves that version's records applied.
 *
 * Every record is attempted exactly once. A file that may not be restored is a
 * conflict — reported, backup retained, nothing written — and a restore that
 * could not be completed is a collected failure. Neither is retried, because a
 * second attempt would read the same bytes and reach the same verdict, and
 * neither is swallowed.
 *
 * @param records The records this install applied, in application order.
 * @param context The session's context, which satisfies the cleanup context.
 * @returns What came back, what conflicted and what failed.
 */
async function rollbackApplied(
  records: readonly ModificationRecord[],
  context: InstrumentationContext,
): Promise<RollbackReport> {
  const restored: ModificationRecord[] = [];
  const conflicts: ModificationConflict[] = [];
  const failures: CleanupFailure[] = [];

  for (const record of [...records].reverse()) {
    let outcome: Result<RestoreOutcome>;

    try {
      outcome = await restoreModification(record, context);
    } catch (caught) {
      failures.push(rollbackFailure(record, DebuggenError.from(caught, 'CLEANUP_PARTIAL')));
      continue;
    }

    if (isErr(outcome)) {
      failures.push(rollbackFailure(record, DebuggenError.from(outcome.error, 'CLEANUP_PARTIAL')));
      continue;
    }

    if (outcome.value.conflict !== undefined) {
      conflicts.push(outcome.value.conflict);
      continue;
    }

    restored.push(record);
  }

  return { restored, conflicts, failures };
}

/**
 * The sentence describing what an unwound install left behind.
 *
 * @param report What the rollback achieved.
 * @param attempted How many records it had to reverse.
 * @param previousPlanVersion The revision the session returns to, when this was
 * a delta install.
 * @returns One sentence for the error message.
 */
function describeRollback(
  report: RollbackReport,
  attempted: number,
  previousPlanVersion: number | undefined,
): string {
  if (attempted === 0) {
    return 'No file had been modified, so nothing had to be restored.';
  }

  const destination =
    previousPlanVersion === undefined
      ? 'so this install left no instrumentation in the project'
      : `so the project holds exactly the instrumentation plan version ${String(previousPlanVersion)} installed`;

  if (report.conflicts.length === 0 && report.failures.length === 0) {
    return `All ${String(attempted)} file modification(s) this install applied were restored, ${destination}.`;
  }

  return `${String(report.restored.length)} of ${String(attempted)} file modification(s) this install applied were restored; ${String(report.conflicts.length)} file(s) were left exactly as they stand and ${String(report.failures.length)} could not be restored.`;
}

/**
 * Ends a sentence the way a message quoted mid-paragraph needs.
 *
 * @param text A developer-facing message.
 * @returns The trimmed message, with a full stop when it had no terminal
 * punctuation.
 */
function asSentence(text: string): string {
  const trimmed = text.trim();

  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The headline for an install an adapter reported as failed.
 *
 * Names the adapter, then the target when the failure named one — the symbol
 * and its file, or whichever of the two is known — and then quotes the
 * failure's own message, which was written for the developer and says *why*.
 *
 * @param adapter The failing adapter's id.
 * @param failure The failure it reported, when one was read.
 * @returns One or two sentences for the error message.
 */
function failedActionHeadline(adapter: string, failure: ReportedFailure | undefined): string {
  const target =
    failure?.symbol !== undefined && failure.file !== undefined
      ? `${failure.symbol} in ${failure.file}`
      : (failure?.symbol ?? failure?.file);
  const opening =
    target === undefined
      ? `The adapter "${adapter}" could not complete an action it accepted for install:`
      : `The adapter "${adapter}" could not instrument ${target}:`;

  return `${opening} ${asSentence(failure?.error.message ?? 'the adapter gave no reason')}`;
}

/**
 * The identifying facts of a reported failure, as they go into the returned
 * error's details and its log line.
 *
 * Identifiers, a project-relative path, a signal name, a code and a boolean —
 * never the conflict report, whose three-way diffs are file content, and never
 * any other byte of a file (AAP §0.5.2).
 *
 * @param failure The failure the adapter reported.
 * @returns A JSON-serialisable summary.
 */
function failedActionFacts(failure: ReportedFailure): Record<string, unknown> {
  return {
    actionId: failure.actionId,
    file: failure.file,
    symbol: failure.symbol,
    signal: failure.signal,
    code: failure.error.code,
    recordId: failure.record?.id,
    conflictReported: failure.conflict !== undefined,
  };
}

/**
 * Unwinds a failed or cancelled install and builds the error that reports it.
 *
 * For an `'action-failed'` stop the headline names the adapter and the target
 * and quotes the failure's own message, and the hint is the failure's own hint
 * whenever the rollback left the project intact — it names the recovery for
 * the cause — falling back to the generic re-ask otherwise; a rollback that
 * left conflicts always points at them instead.
 *
 * @param applied The rollback set: every record this install applied, in
 * application order, including a failed attempt's record last. Its length is
 * reported as `details.attempted`.
 * @param context The session's context.
 * @param input Why the install stopped.
 * @returns The error to return in the failure channel.
 */
async function unwind(
  applied: readonly ModificationRecord[],
  context: InstrumentationContext,
  input: UnwindInput,
): Promise<DebuggenError> {
  const report = await rollbackApplied(applied, context);
  const intact = report.conflicts.length === 0 && report.failures.length === 0;
  const adapter = input.adapterId ?? 'unknown';
  const headline =
    input.reason === 'aborted'
      ? 'Installing instrumentation was cancelled before it finished.'
      : input.reason === 'invalid-result'
        ? `The adapter "${adapter}" did not return an install result.`
        : input.reason === 'action-failed'
          ? failedActionHeadline(adapter, input.failure)
          : `The adapter "${adapter}" failed while installing its share of the plan.`;
  const failureHint = input.failure?.error.hint;
  const hint = intact
    ? input.reason === 'aborted'
      ? "Start the session's instrumentation again when you are ready to capture."
      : input.reason === 'action-failed' && isNonEmptyString(failureHint)
        ? failureHint
        : 'Nothing from this attempt remains in the project; ask the question again to install instrumentation afresh.'
    : 'Review the reported conflicts before installing again: the original bytes are kept in this session\u2019s backup directory and no file was overwritten.';
  const details: Record<string, unknown> = {
    reason: input.reason,
    planVersion: input.planVersion,
    previousPlanVersion: input.previousPlanVersion,
    adapter: input.adapterId,
    ...(input.failure === undefined ? {} : { failedAction: failedActionFacts(input.failure) }),
    attempted: applied.length,
    restored: report.restored.map((record) => record.id).slice(0, MAX_REPORTED_ITEMS),
    restoredCount: report.restored.length,
    conflicts: report.conflicts.map((conflict) => conflict.recordId).slice(0, MAX_REPORTED_ITEMS),
    conflictCount: report.conflicts.length,
    failures: report.failures.slice(0, MAX_REPORTED_ITEMS).map((failure) => ({
      recordId: failure.recordId,
      file: failure.file,
      code: failure.error.code,
      message: failure.error.message,
    })),
    failureCount: report.failures.length,
  };
  const error = new DebuggenError(
    'INSTRUMENTATION_INSTALL_FAILED',
    `${headline} ${describeRollback(report, applied.length, input.previousPlanVersion)}`,
    input.cause === undefined ? { hint, details } : { hint, details, cause: input.cause },
  );

  context.logger.error(error.message, { sessionId: context.sessionId, ...details });

  return error;
}

/** The counts an install that enabled nothing reports alongside its gaps. */
interface NothingEnabledFacts {
  /** The session the install belonged to. */
  readonly sessionId: string;

  /** The revision it was stamping. */
  readonly planVersion: number;

  /** How many actions the plan or delta selected. */
  readonly selected: number;

  /** How many of them the feasibility gate admitted. */
  readonly feasible: number;

  /** How many adapters were available to ask. */
  readonly adapters: number;
}

/**
 * The gap a developer should act on first.
 *
 * The first reported gap that carries an action, in report order — which is the
 * plan's own order for the gate's refusals and install order for the adapters'.
 * Deterministic on purpose: the same plan against the same project must name
 * the same blocked signal every time, or the sentence the developer reads would
 * change between two identical attempts.
 *
 * @param unavailable Every reported gap.
 * @returns The gap to quote, or `undefined` when none was reported.
 */
function mostActionableGap(
  unavailable: readonly UnavailableSignal[],
): UnavailableSignal | undefined {
  return unavailable.find((gap) => isNonEmptyString(gap.hint)) ?? unavailable[0];
}

/**
 * The error for an install that armed no hook and modified no file.
 *
 * The one hard failure of AAP §0.5.5: the message carries that section's
 * sentence for the blocked signal and the hint carries that signal's own
 * recovery action, because the service renders both into
 * `instrumentation.failed`.
 *
 * @param unavailable Every reported gap.
 * @param facts The counts that explain how the install reached this state.
 * @returns The error.
 */
function nothingEnabledError(
  unavailable: readonly UnavailableSignal[],
  facts: NothingEnabledFacts,
): DebuggenError {
  const blocked = mostActionableGap(unavailable);
  const headline =
    'No instrumentation could be enabled for this plan: no runtime hook was armed and no file was modified.';
  const message =
    blocked === undefined
      ? `${headline} No adapter reported a gap, so the plan resolved to no installable action.`
      : `${headline} Could not enable ${blocked.signal}: ${blocked.reason}.`;
  const hint =
    blocked !== undefined && isNonEmptyString(blocked.hint)
      ? blocked.hint
      : 'Ask the question again so the plan names at least one action an installed adapter can enable here.';

  return new DebuggenError('INSTRUMENTATION_UNAVAILABLE', message, {
    hint,
    details: {
      sessionId: facts.sessionId,
      planVersion: facts.planVersion,
      selected: facts.selected,
      feasible: facts.feasible,
      adapters: facts.adapters,
      blockedSignal: blocked?.signal,
      unavailable: unavailable.slice(0, MAX_REPORTED_ITEMS).map((gap) => ({
        signal: gap.signal,
        reason: gap.reason,
        hint: gap.hint,
      })),
      unavailableCount: unavailable.length,
    },
  });
}
