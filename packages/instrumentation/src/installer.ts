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
 *   previous plan version" means in bytes. What an adapter *reported* is not
 *   the authority on what this call applied: every append made through the
 *   journal the adapters are handed is remembered as it happens, the session's
 *   journal is read before the first adapter is asked and again when the
 *   install fails, and every record appended in between is unwound whether or
 *   not an adapter mentioned it — an adapter that reports success while having
 *   journaled a record it did not report fails the install for that reason.
 *   See {@link installPlan}'s rollback section.
 * - **Which revision an install may stamp.** Every record this call journals
 *   is stamped with {@link InstrumentationContext.planVersion}, so the plan
 *   document, the context, a delta's named predecessor and the revisions the
 *   journal says are standing in the project must all agree. An install on
 *   which they disagree is refused before any hook is armed or any byte is
 *   written, because proceeding would file its patches under a revision the
 *   session does not hold and break the follow-up chain cleanup unwinds.
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
import type {
  ModificationConflict,
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from './schema/modification.js';
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
   * Exactly {@link InstrumentationContext.planVersion} minus one — AAP §0.4.2
   * builds plan version *n + 1* from plan version *n* — checked before
   * anything is installed, and checked again against the journal: no record
   * that may still stand in the project — `applied`, `pending` or `failed` —
   * may carry a revision above the one being installed. It is also the version
   * the session returns to when the delta fails part-way, and naming it in the
   * error is what makes "left at its previous plan version" checkable rather
   * than a claim.
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
   * Equal to the plan document's own `planVersion` by construction: the patch
   * layer stamps every record of this round from the context, so an install
   * whose plan document names a different revision is refused before anything
   * is armed or written rather than recorded under a revision it is not.
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
 * 0. **The revision.** The plan document's `planVersion` must equal the
 *    context's — the revision every record of this round is stamped with — and
 *    a delta's `previousPlanVersion` must be the revision immediately before
 *    it. Both are checked before anything else happens and throw when they
 *    fail, because they are the caller's wiring (see `@throws`).
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
 * 4. **The journal baseline.** The session's records are listed once, before
 *    the first adapter is asked. The listing is what a rollback compares
 *    against, and it is where the revision is checked against what is actually
 *    installed: a record that may still stand in the project — `applied`,
 *    `pending` or `failed` — may not carry a revision above the one being
 *    installed, and for a whole-plan install it may not carry an earlier one
 *    either (installing every action again would patch over it — that is a
 *    delta's job). An install that is already cancelled stops before this step
 *    and reads nothing. From here on, adapters are handed the context with its
 *    journal wrapped in an install-scoped ledger that remembers every record
 *    appended through it, in append order and in the latest state the journal
 *    returned.
 * 5. **Runtime groups, then patch groups.** Within each phase, groups install
 *    in the adapters' registration order and each group's actions are ordered
 *    by id, so two installs of the same plan install identically.
 * 6. **Aggregation.** `applied` is concatenated in application order,
 *    `runtimeHooks` is de-duplicated with first-occurrence order kept,
 *    `unavailable` is concatenated, and the two producer configurations are
 *    computed by `./schema/readiness.ts`'s derivations from the actions of the
 *    adapters that actually enabled something, then widened by those adapters'
 *    own contributions.
 *
 * ## What counts as failure
 *
 * `Err` is returned in exactly four situations, and none is "a signal turned
 * out to be unavailable". The first two are refusals: they return before any
 * adapter is asked, so no hook is armed, no record is journaled and no byte is
 * written.
 *
 * - **The journal could not be read** for the baseline. The error carries
 *   `'STORE_ERROR'` with `details.reason` `'journal-unreadable'`: without the
 *   baseline a failed install could not be unwound completely, so none is
 *   started.
 * - **The journal contradicts the revision** — step 4 found a standing record
 *   the install's revision cannot account for. The error carries
 *   `'SESSION_INVALID_STATE'` with `details.reason` `'plan-version-conflict'`
 *   and the revisions the journal holds.
 * - **Nothing at all could be enabled** — no modification applied and no
 *   runtime hook armed. The error carries `'INSTRUMENTATION_UNAVAILABLE'` and a
 *   `hint` naming the most actionable blocked signal, because the service turns
 *   it into `instrumentation.failed`. Before it is returned the journal is
 *   listed once more: should it hold a record this call appended — which only
 *   an adapter writing past its context's journal could leave unnoticed until
 *   here — the install is unwound as an unreported modification instead, so
 *   the sentence "no file was modified" is never said over a patched file.
 * - **An adapter failed part-way** — it rejected, returned something that is
 *   not an install result, returned a result carrying
 *   {@link InstallResult.failure} because an action it accepted for install
 *   could not be completed (a patch refused or failed after the feasibility
 *   gate admitted it, a write-path failure, a cancellation mid-sequence), or
 *   returned an otherwise ordinary result while the ledger shows it appended a
 *   record it did not report. The error carries
 *   `'INSTRUMENTATION_INSTALL_FAILED'`, its `details.reason` is
 *   `'adapter-failed'`, `'invalid-result'`, `'action-failed'` or
 *   `'unreported-modification'` respectively (`'aborted'` whenever the
 *   context's signal is aborted), and nothing that adapter armed or contributed
 *   is aggregated.
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
 * a developer has edited.
 *
 * The set is decided by the journal, not by what the adapters said. Two
 * independent sources name the records this call appended: the install's
 * ledger, which saw every append made through the journal the adapters were
 * handed, and a second listing of the session's journal compared with the
 * baseline, which also sees an append made past it. The set is every record
 * either source names — whether an adapter reported it or not: an adapter that
 * journaled a patch and then rejected, returned something that is not an
 * install result, reported a failure without its attempt's record, or reported
 * success without the record still has its edit unwound — together with every
 * record an adapter reported (the earlier groups' {@link InstallResult.applied},
 * the failing adapter's own, and the record it journaled for the failed
 * attempt, {@link InstallFailure.record}). Each is taken in the latest state
 * the journal holds or returned, a record already `reverted` is left out, and
 * the set is ordered by the journal's append order (the ledger's, when the
 * listing is unavailable), so the last write is the first restored. A record
 * an adapter reported that neither source holds goes last, in reported order,
 * and is attempted first. Each record is settled by the reconciliation table
 * of AAP §0.5.1: closed without a write when its file still holds the
 * original, restored when the file holds the patch, re-reported when it is
 * already a conflict, and reported as a conflict otherwise. A second listing
 * that fails therefore costs the rollback nothing it could reach through the
 * adapters' journal: the ledger still names every record appended through it,
 * and the error records that the listing failed. Records from earlier plan
 * versions are left applied, so a failed delta leaves the project holding
 * exactly the instrumentation the previous plan version installed: a chained
 * record's backup is the *previous* instrumented content, so restoring the
 * delta's record returns the file to that state rather than to its pristine
 * bytes.
 * Reverse application order is what keeps a chain over one file unwound
 * strictly last-applied-first.
 *
 * Rollback outcomes are collected, never swallowed and never retried in a
 * loop: each record is attempted once, a file that may not be restored is
 * reported as a conflict with its backup retained, and every restore failure is
 * summarised in the returned error's `details` and logged. `details.discovered`
 * names the records no adapter reported, and `details.journalReread` says
 * whether the second listing was taken (`'listed'`), could not be
 * (`'failed'`), or was not needed because no adapter had been asked
 * (`'not-needed'`).
 *
 * {@link InstrumentationContext.signal} is honoured between groups: an abort
 * unwinds this call's records the same way and returns the same error code.
 *
 * @param plan The normalised plan to install. Its `instrumentationTargets` are
 * the action set; its `planVersion` must equal the context's — see
 * {@link AggregateInstallResult.planVersion}.
 * @param context The session's context: the project root, the state directory,
 * the code graph and queries the gate reads, the journal and backup store the
 * patch layer and the rollback write through, the logger, and the optional
 * clock and cancellation signal.
 * @param options The adapters to ask, the delta to apply, and whether the gate
 * has already run.
 * @returns `ok(result)` describing everything that was enabled — even where
 * some signals were not — or `err(error)` for the four failures above.
 * @throws {DebuggenError} `'INTERNAL'` when the caller's own wiring is wrong: a
 * context with no logger, project root, plan version, journal (one that cannot
 * append, update and list a session's records) or backup store; a plan whose
 * `instrumentationTargets` is not an array; a plan belonging to a different
 * session than the context; a plan whose `planVersion` differs from the
 * context's; a delta that is not an object, whose `previousPlanVersion` is not
 * the revision immediately before the context's, or whose `actionIds` is not
 * an array; or no adapters at all. These say nothing about the developer's
 * project, so they are not reported as unavailable signals — and each is
 * thrown before any adapter is asked or the journal is touched.
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
  const targets = requireInstallablePlan(plan, context);
  const delta = requireValidDelta(options.delta, context);
  const planVersion = context.planVersion;
  const previousPlanVersion = delta?.previousPlanVersion;

  const selected = selectActions(targets, delta, context, logger);
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
    delta: delta !== undefined,
  });

  // Already cancelled: no adapter has been asked, so there is nothing of this
  // call's to unwind and no reason to read the journal at all.
  if (isAborted(context)) {
    return err(
      await unwind([], context, {
        reason: 'aborted',
        planVersion,
        previousPlanVersion,
        tracking: undefined,
      }),
    );
  }

  // The journal as it stood before this call, which is both what a rollback is
  // measured against and the evidence the revision is checked against. Either
  // failing refuses the install before any hook is armed or byte written.
  const journaled = await takeJournalBaseline(context, previousPlanVersion);

  if (isErr(journaled)) {
    return err(journaled.error);
  }

  const baseline = journaled.value;
  const contradiction = checkInstalledRevisions(baseline, context, delta);

  if (contradiction !== undefined) {
    logger.error(contradiction.message, {
      sessionId: context.sessionId,
      ...contradiction.details,
    });

    return err(contradiction);
  }

  // Every adapter is handed the context with its journal wrapped in this
  // install's ledger, so each record appended through it is known the moment
  // the journal accepts it — independently of what the adapter reports and of
  // whether the journal can be listed again later.
  const ledger = createInstallLedger(context.journal);
  const tracking: InstallTracking = { baseline, ledger };
  const adapterContext: InstrumentationContext = { ...context, journal: ledger.journal };

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
            tracking,
          }),
        );
      }

      const appendsBefore = ledger.count();
      let raw: InstallResult;

      try {
        raw = await group.adapter.install(group.actions, adapterContext);
      } catch (caught) {
        // A rejection carries no records, but the adapter may have journaled
        // — and written — before it rejected: `unwind` recovers those from the
        // ledger and the journal, so its edit is reversed too.
        return err(
          await unwind(applied, context, {
            reason: 'adapter-failed',
            adapterId: group.adapter.id,
            planVersion,
            previousPlanVersion,
            cause: caught,
            tracking,
          }),
        );
      }

      const reported = readInstallResult(raw);

      if (reported === undefined) {
        // Likewise: a value that is not an install result says nothing about
        // what was written, so the ledger and the journal say it instead.
        return err(
          await unwind(applied, context, {
            reason: 'invalid-result',
            adapterId: group.adapter.id,
            planVersion,
            previousPlanVersion,
            tracking,
          }),
        );
      }

      const failure = reported.failure;

      if (failure !== undefined) {
        // The fatal channel: an action this adapter accepted could not be
        // completed. Nothing it armed or contributed is aggregated, and every
        // record this call applied — the earlier groups', this adapter's own,
        // the one it journaled for the failed attempt, and any the journal
        // holds that it did not mention — is reverse-restored, last write
        // first, before the error returns.
        return err(
          await unwind(rollbackSetOf(applied, reported.applied, failure.record), context, {
            reason: isAborted(context) ? 'aborted' : 'action-failed',
            adapterId: group.adapter.id,
            planVersion,
            previousPlanVersion,
            cause: failure.error,
            failure,
            tracking,
          }),
        );
      }

      // An ordinary result is only as good as its `applied` list: a record this
      // adapter appended and did not report would be missing from what the
      // service watches and shows, and — on the nothing-enabled path — from
      // what a failure unwinds. The ledger saw every append, so a mismatch is
      // caught here, before anything this adapter armed is aggregated.
      const unreported = unreportedAppends(ledger.appendedSince(appendsBefore), reported.applied);

      if (unreported.length > 0) {
        return err(
          await unwind(rollbackSetOf(applied, reported.applied, undefined), context, {
            reason: isAborted(context) ? 'aborted' : 'unreported-modification',
            adapterId: group.adapter.id,
            planVersion,
            previousPlanVersion,
            unreported: unreported.length,
            tracking,
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
        tracking,
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
    // A failed install, so the journal is consulted before the error is
    // composed: a record this call appended past the adapters' journal would
    // otherwise stay in the project under an error that says no file was
    // modified. Nothing found — the ordinary case — costs one read.
    const leftovers = await collectRollbackSet([], context, tracking);

    if (leftovers.records.length > 0) {
      return err(
        await unwindCollected(leftovers, context, {
          reason: 'unreported-modification',
          planVersion,
          previousPlanVersion,
          unreported: leftovers.discovered.length,
          tracking,
        }),
      );
    }

    const error = nothingEnabledError(unavailable, {
      sessionId: context.sessionId,
      planVersion,
      selected: selected.length,
      feasible: candidates.length,
      adapters: lookup.count,
      journalReread: leftovers.reread,
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

  if (
    !hasMethod(context.journal, 'append') ||
    !hasMethod(context.journal, 'updateStatus') ||
    !hasMethod(context.journal, 'listBySession')
  ) {
    throw new DebuggenError(
      'INTERNAL',
      'An install was given a context with no modification journal.',
      {
        hint: "Pass the service's modification journal, which records an edit before it is written, lists a session's records for the rollback baseline, and is what a rollback transitions.",
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
 * Two mismatches are refused, and for the same reason: the records this
 * install produces are stamped from the context, so a plan that names another
 * session or another revision would have its patches filed under an identity
 * it does not have.
 *
 * - A *session* mismatch would file the records under the context's session
 *   while the plan named another, and nothing downstream could reconcile the
 *   two.
 * - A *revision* mismatch would do the same to the revision: the patch layer
 *   stamps {@link InstrumentationContext.planVersion} on every record it
 *   journals, so the journal would say revision *n* was installed while the
 *   session holds the plan document of revision *m*, and the follow-up chain —
 *   which cleanup unwinds by revision, and which the next delta names as its
 *   predecessor — would describe a plan that was never installed. The caller
 *   builds the context from the plan it installs; there is no legitimate
 *   reason for the two to differ.
 *
 * @param plan The plan to install.
 * @param context The session's context.
 * @returns The plan's actions.
 * @throws {DebuggenError} `'INTERNAL'` for a non-array action list, a session
 * mismatch or a revision mismatch — before anything is armed, read or written.
 */
function requireInstallablePlan(
  plan: InstrumentationPlan,
  context: InstrumentationContext,
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
    throw new DebuggenError(
      'INTERNAL',
      'An install was given a plan document whose planVersion differs from the revision the context stamps on every record.',
      {
        hint: 'Build the install context from the plan being installed — { ...context, planVersion: plan.planVersion } — so every modification record is stamped with the revision it belongs to.',
        details: {
          planDocumentVersion: plan.planVersion,
          contextPlanVersion: context.planVersion,
        },
      },
    );
  }

  return plan.instrumentationTargets;
}

/**
 * Checks a follow-up's delta names a usable predecessor, and returns it.
 *
 * A delta says "revision *previous* is installed; apply these additions as
 * revision *n*". AAP §0.4.2 defines a follow-up that needs more evidence as
 * plan version *n + 1* built from plan version *n*, so the predecessor must be
 * exactly {@link InstrumentationContext.planVersion} minus one. Anything else
 * is refused: a predecessor at or above the revision would have the rollback
 * return the session to a revision after the one it failed to install, and one
 * further below would skip a revision the session holds — which the journal
 * cannot always reveal, because a revision whose signals were all runtime hooks
 * journals nothing. That no *later* revision stands in the project is checked
 * separately, against the baseline, by {@link checkInstalledRevisions}.
 *
 * @param delta The delta the caller passed, if any.
 * @param context The session's context, whose revision was already validated.
 * @returns The delta, or `undefined` for a whole-plan install.
 * @throws {DebuggenError} `'INTERNAL'` for a delta that is not an object, a
 * predecessor that is not the revision immediately before the context's, or an
 * `actionIds` that is not an array — before anything is armed, read or
 * written.
 */
function requireValidDelta(
  delta: InstallDelta | undefined,
  context: InstrumentationContext,
): InstallDelta | undefined {
  const candidate: unknown = delta;

  if (candidate === undefined) {
    return undefined;
  }

  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new DebuggenError('INTERNAL', 'An install was given a delta that is not an object.', {
      hint: 'Pass options.delta as { previousPlanVersion, actionIds } for a follow-up, or omit it to install the whole plan.',
    });
  }

  const { previousPlanVersion, actionIds } = candidate as {
    previousPlanVersion?: unknown;
    actionIds?: unknown;
  };

  // Revisions count from 1, so plan version 1 has no predecessor to build on.
  if (context.planVersion < 2 || previousPlanVersion !== context.planVersion - 1) {
    throw new DebuggenError(
      'INTERNAL',
      'An install was given a delta whose previous plan version is not the revision immediately before the one being installed.',
      {
        hint: "A follow-up's delta installs plan version n + 1 over plan version n: set previousPlanVersion to the context's planVersion minus one.",
        details: { previousPlanVersion, planVersion: context.planVersion },
      },
    );
  }

  if (!Array.isArray(actionIds)) {
    throw new DebuggenError(
      'INTERNAL',
      'An install was given a delta whose actionIds is not an array.',
      {
        hint: 'List the ids of the actions the follow-up added, drawn from the plan being installed.',
        details: { planVersion: context.planVersion, previousPlanVersion },
      },
    );
  }

  return delta;
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
// The journal baseline
//
// The session's journal is read once before the first adapter is asked and
// once more if the install fails. The first reading is the evidence the
// revision is checked against; the difference between the two readings is the
// set of records this call journaled, which is what a rollback must unwind
// whether or not an adapter reported them. Both readings go through the port,
// and neither changes anything in it.
// ---------------------------------------------------------------------------

/**
 * The statuses in which a record's instrumentation may still stand in the
 * project on the journal's own account.
 *
 * `applied` is on disk; `pending` and `failed` are a write sequence that did
 * not finish, whose file may hold the patch until reconciliation decides. A
 * `conflict` is left out — the developer owns that file now, and the record is
 * kept only so it is reported — and `reverted` is closed.
 */
const STANDING_STATUSES: ReadonlySet<ModificationStatus> = new Set<ModificationStatus>([
  'applied',
  'pending',
  'failed',
]);

/** What the journal held for this session before the first adapter was asked. */
interface JournalBaseline {
  /** The id of every record the session's journal held. */
  readonly ids: ReadonlySet<string>;

  /**
   * The records whose instrumentation may stand in the project — see
   * {@link STANDING_STATUSES} — in append order.
   */
  readonly standing: readonly ModificationRecord[];
}

/**
 * Lists this session's records through the journal port, defensively.
 *
 * The port promises `err` rather than an exception, and a list of the
 * session's own records; both promises are checked rather than trusted,
 * because the journal is caller-supplied and a rollback that believed a
 * malformed listing would unwind the wrong set. A record of another session is
 * dropped, and so is anything that cannot be addressed as a record.
 *
 * @param context The session's context.
 * @returns The session's records in append order, or `err` with
 * `'STORE_ERROR'`.
 */
async function readSessionJournal(
  context: InstrumentationContext,
): Promise<Result<ModificationRecord[]>> {
  let listed: unknown;

  try {
    listed = await context.journal.listBySession(context.sessionId);
  } catch (caught) {
    return err(DebuggenError.from(caught, 'STORE_ERROR'));
  }

  if (typeof listed !== 'object' || listed === null || !('ok' in listed)) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        'The modification journal answered a session listing with something that is not a result.',
        {
          hint: "Pass a journal whose listBySession resolves to ok(records) or err(error), as the service's store does.",
        },
      ),
    );
  }

  const answer = listed as Result<unknown>;

  if (isErr(answer)) {
    return err(DebuggenError.from(answer.error, 'STORE_ERROR'));
  }

  const rows = asList(answer.value);

  if (rows === undefined) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        'The modification journal answered a session listing with something that is not a list.',
        {
          hint: "Pass a journal whose listBySession resolves to the session's records in append order.",
        },
      ),
    );
  }

  return ok(rows.filter(isRecordLike).filter((record) => record.sessionId === context.sessionId));
}

/**
 * Takes the baseline, or refuses the install because it cannot be taken.
 *
 * Refusing is the only safe answer to an unreadable journal: the baseline is
 * what lets a failed install find the records an adapter journaled without
 * reporting them, and an install started without it could leave such an edit
 * in the project. The refusal happens before any adapter is asked, so nothing
 * is armed and nothing is written.
 *
 * @param context The session's context.
 * @param previousPlanVersion The delta's predecessor, for the error's details.
 * @returns The baseline, or `err` with `'STORE_ERROR'` and `details.reason`
 * `'journal-unreadable'`.
 */
async function takeJournalBaseline(
  context: InstrumentationContext,
  previousPlanVersion: number | undefined,
): Promise<Result<JournalBaseline>> {
  const listed = await readSessionJournal(context);

  if (isErr(listed)) {
    const details = {
      reason: 'journal-unreadable',
      sessionId: context.sessionId,
      planVersion: context.planVersion,
      previousPlanVersion,
      code: listed.error.code,
    };
    const error = new DebuggenError(
      'STORE_ERROR',
      'The modification journal could not be read, so no instrumentation was installed: without it a failed install could not be unwound completely.',
      {
        hint: 'Check that the Debug Generator state directory is readable and writable, then start the session\u2019s instrumentation again. No hook was armed and no file was modified.',
        details,
        cause: listed.error,
      },
    );

    context.logger.error(error.message, details);

    return err(error);
  }

  return ok({
    ids: new Set(listed.value.map((record) => record.id)),
    standing: listed.value.filter((record) => STANDING_STATUSES.has(record.status)),
  });
}

/**
 * Names one or more plan versions for a sentence.
 *
 * @param versions The versions, ascending and de-duplicated.
 * @returns `"plan version 2"`, `"plan versions 1 and 2"` or
 * `"plan versions 1, 2 and 3"`.
 */
function planVersionsPhrase(versions: readonly number[]): string {
  const spelled = versions.map((version) => String(version));
  const last = spelled.at(-1) ?? '';

  if (spelled.length <= 1) {
    return `plan version ${last}`;
  }

  return `plan versions ${spelled.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * The distinct plan versions a set of records carries, ascending.
 *
 * @param records The records.
 * @returns Each version once, smallest first.
 */
function planVersionsOf(records: readonly ModificationRecord[]): number[] {
  return [...new Set(records.map((record) => record.planVersion))].sort(
    (left, right) => left - right,
  );
}

/**
 * Checks the revision being installed against the revisions the journal says
 * stand in the project.
 *
 * Two contradictions, each of which would mislabel what the session holds if
 * the install went ahead:
 *
 * - **A later revision stands** — for a whole plan and a delta alike.
 *   Installing revision *n* over records of a revision *m > n* would stamp the
 *   older revision's patches on top of the newer ones and leave the session
 *   claiming the older plan; for a delta it would also make the rollback's
 *   promise — "left at plan version *n − 1*" — false.
 * - **A whole-plan install over an earlier revision.** A whole plan re-applies
 *   every action and the patch layer stamps each with this revision, so the
 *   actions the earlier revision already instrumented would be patched a
 *   second time, chained over their own instrumentation. Additions to an
 *   installed plan are a delta's job.
 *
 * A delta's records below its predecessor are the earlier links of the chain
 * it extends and are consistent; {@link requireValidDelta} has already made
 * the predecessor the revision immediately before this one, so no revision
 * lies between the two. Records at this very revision are consistent in every
 * case: they are what a retried install of the same revision finds, and an
 * adapter treats them as already applied.
 *
 * @param baseline The journal as it stood before this call.
 * @param context The session's context.
 * @param delta The delta, for a follow-up install.
 * @returns `undefined` when the journal agrees, or the
 * `'SESSION_INVALID_STATE'` error to refuse the install with.
 */
function checkInstalledRevisions(
  baseline: JournalBaseline,
  context: InstrumentationContext,
  delta: InstallDelta | undefined,
): DebuggenError | undefined {
  const planVersion = context.planVersion;
  const later = baseline.standing.filter((record) => record.planVersion > planVersion);
  const earlier =
    delta === undefined
      ? baseline.standing.filter((record) => record.planVersion < planVersion)
      : [];

  if (later.length === 0 && earlier.length === 0) {
    return undefined;
  }

  const conflicting = later.length > 0 ? later : earlier;
  const named = planVersionsPhrase(planVersionsOf(conflicting));
  let message: string;
  let hint: string;

  if (later.length > 0) {
    message = `Plan version ${String(planVersion)} cannot be installed: this session's journal records instrumentation of ${named} standing in the project, which is later.`;
    hint =
      "Install the session's latest plan version, or end the session so its instrumentation is removed before an earlier plan is installed.";
  } else {
    message = `Plan version ${String(planVersion)} cannot be installed as a whole plan: this session's journal records instrumentation of ${named} standing in the project, and installing every action again would patch over it.`;
    hint =
      'Install the follow-up as a delta \u2014 options.delta naming the installed plan version and the ids of the added actions \u2014 so only the additions are applied.';
  }

  return new DebuggenError('SESSION_INVALID_STATE', message, {
    hint,
    details: {
      reason: 'plan-version-conflict',
      planVersion,
      previousPlanVersion: delta?.previousPlanVersion,
      installedPlanVersions: planVersionsOf(baseline.standing),
      conflictingRecords: conflicting.map((record) => record.id).slice(0, MAX_REPORTED_ITEMS),
      conflictingRecordCount: conflicting.length,
    },
  });
}

/**
 * Every record appended through the journal an install hands its adapters.
 *
 * The adapters are handed the context with {@link InstallLedger.journal} in
 * place of the session's journal. It forwards every call unchanged and
 * remembers each record the journal accepts on `append` — in append order —
 * together with the latest state the journal returned for it on
 * `updateStatus`. "Which records did this call append" is therefore a fact the
 * installer observed as it happened, not something it must reconstruct from a
 * listing that may itself fail at the moment a rollback needs it.
 */
interface InstallLedger {
  /** The journal adapters are handed: the session's, recording what it accepts. */
  readonly journal: ModificationJournal;

  /** How many records have been appended through it so far. */
  readonly count: () => number;

  /**
   * The records appended through it from the `start`-th append onwards, in
   * append order, each in the latest state the journal returned for it.
   *
   * @param start How many appends to skip; `0` for every one.
   */
  readonly appendedSince: (start: number) => ModificationRecord[];
}

/** What a failed install's rollback is measured against. */
interface InstallTracking {
  /** The session's journal as it stood before the first adapter was asked. */
  readonly baseline: JournalBaseline;

  /** Every record appended through the adapters' journal during this call. */
  readonly ledger: InstallLedger;
}

/**
 * The record a journal call answered with, when it answered `ok` with one.
 *
 * Read structurally, because the journal is caller-supplied: an answer that is
 * not a result, or whose value cannot be addressed as a record, teaches the
 * ledger nothing.
 *
 * @param answer What the journal returned.
 * @returns The record, or `undefined`.
 */
function recordOfAnswer(answer: unknown): ModificationRecord | undefined {
  if (typeof answer !== 'object' || answer === null || !('ok' in answer)) {
    return undefined;
  }

  const result = answer as Result<unknown>;

  return isErr(result) || !isRecordLike(result.value) ? undefined : result.value;
}

/**
 * Wraps a journal in an install-scoped ledger.
 *
 * Every method forwards to the wrapped journal as a method call, so an
 * implementation that relies on `this` — the service's store — behaves exactly
 * as it would unwrapped, and every answer, rejection and exception reaches the
 * caller untouched. Only an `ok` answer is remembered: an `append` the journal
 * refused does not authorise the write that follows it in the patch sequence,
 * and a record the journal persisted despite refusing is still found by the
 * second listing.
 *
 * @param journal The session's journal.
 * @returns The ledger.
 */
function createInstallLedger(journal: ModificationJournal): InstallLedger {
  const order: string[] = [];
  const latest = new Map<string, ModificationRecord>();

  return {
    journal: {
      append: async (record: ModificationRecord): Promise<Result<ModificationRecord>> => {
        const answer = await journal.append(record);
        const stored = recordOfAnswer(answer);

        if (stored !== undefined) {
          if (!latest.has(stored.id)) {
            order.push(stored.id);
          }

          latest.set(stored.id, stored);
        }

        return answer;
      },
      updateStatus: async (
        id: string,
        status: ModificationStatus,
        patch?: ModificationStatusPatch,
      ): Promise<Result<ModificationRecord>> => {
        const answer = await journal.updateStatus(id, status, patch);
        const stored = recordOfAnswer(answer);

        if (stored !== undefined && latest.has(stored.id)) {
          latest.set(stored.id, stored);
        }

        return answer;
      },
      listBySession: (sessionId: string): Promise<Result<ModificationRecord[]>> =>
        journal.listBySession(sessionId),
      listOpen: (): Promise<Result<ModificationRecord[]>> => journal.listOpen(),
    },
    count: (): number => order.length,
    appendedSince: (start: number): ModificationRecord[] =>
      order.slice(start).flatMap((id) => {
        const record = latest.get(id);

        return record === undefined ? [] : [record];
      }),
  };
}

/**
 * The records an adapter appended and left out of an ordinary result.
 *
 * A record the adapter itself took back to `reverted` is not counted: nothing
 * of it stands. Anything else — `applied`, or a `pending` or `failed` attempt
 * the adapter stepped past — is a modification its result does not describe,
 * which the adapter contract rules out.
 *
 * @param appended What the ledger saw the adapter append, in append order.
 * @param reported The records the adapter reported as applied.
 * @returns The unreported records, in append order.
 */
function unreportedAppends(
  appended: readonly ModificationRecord[],
  reported: readonly ModificationRecord[],
): ModificationRecord[] {
  const reportedIds = new Set(reported.map((record) => record.id));

  return appended.filter((record) => record.status !== 'reverted' && !reportedIds.has(record.id));
}

/** How the second journal listing of a failed install went. */
type JournalReread = 'listed' | 'failed' | 'not-needed';

/** The records a failed install unwinds, and how they were found. */
interface RollbackSet {
  /** The records to reverse-restore, in application order. */
  readonly records: ModificationRecord[];

  /**
   * The ids of the records in the set that no adapter reported — appended
   * during this call and named by the ledger or by the second listing.
   */
  readonly discovered: string[];

  /** Whether, and how successfully, the journal was listed again. */
  readonly reread: JournalReread;
}

/**
 * The records a failed install must reverse-restore, decided by what was
 * journaled rather than by what was reported.
 *
 * Taken into the set:
 *
 * - every record this call appended, as either of two independent sources
 *   names it — the install's ledger, which saw every append made through the
 *   adapters' journal, and a second listing of the session's journal compared
 *   with the baseline, which also sees an append made past it. That includes
 *   every record no adapter mentioned: the edit of an adapter that journaled a
 *   patch and then rejected, returned something that is not an install result,
 *   reported a failure without its attempt's record, or reported an ordinary
 *   result without it;
 * - every record an adapter reported, even one that predates the baseline — an
 *   adapter reports a record it found already applied at this revision as part
 *   of its state, and a failed install returns the session to the revision
 *   before this one, which that record does not belong to.
 *
 * Each record is taken in the latest state known for it — the listing's, then
 * the ledger's, then the reported copy — and one already `reverted` is left
 * out: nothing of it remains to restore.
 *
 * The order is application order, so that {@link rollbackApplied}, which walks
 * it backwards, restores the last write first. With a listing: the listing's
 * append order, then any record only the ledger holds in the ledger's order,
 * then any reported record neither holds. When the listing fails the ledger
 * stands in for it: reported records that predate the baseline come first —
 * they were journaled before anything this call appended — then the ledger's
 * records in append order, then any reported record neither the baseline nor
 * the ledger holds. A failed listing therefore costs the rollback nothing it
 * could reach through the adapters' journal; only an append made past that
 * journal, which only a listing can see, is out of its reach.
 *
 * With no tracking — the install was cancelled before any adapter was asked —
 * nothing of this call's can have been journaled, and nothing is read.
 *
 * @param reported The records the adapters reported, in application order.
 * @param context The session's context, with the session's own journal.
 * @param tracking The baseline and the ledger, or `undefined` when no adapter
 * was asked.
 * @returns The set, the unreported ids and how the listing went.
 */
async function collectRollbackSet(
  reported: readonly ModificationRecord[],
  context: InstrumentationContext,
  tracking: InstallTracking | undefined,
): Promise<RollbackSet> {
  if (tracking === undefined) {
    return { records: [...reported], discovered: [], reread: 'not-needed' };
  }

  const listed = await readSessionJournal(context);
  const ledgered = tracking.ledger.appendedSince(0);
  const ledgeredById = new Map(ledgered.map((record) => [record.id, record] as const));
  const reportedIds = new Set(reported.map((record) => record.id));
  const taken = new Set<string>();
  const records: ModificationRecord[] = [];
  const discovered: string[] = [];

  // `appendedByThisCall` admits a record no adapter reported; a reported one
  // is admitted either way, and a reverted one never is.
  const take = (record: ModificationRecord, appendedByThisCall: boolean): void => {
    if (taken.has(record.id)) {
      return;
    }

    taken.add(record.id);

    const wasReported = reportedIds.has(record.id);

    if ((!appendedByThisCall && !wasReported) || record.status === 'reverted') {
      return;
    }

    records.push(record);

    if (!wasReported) {
      discovered.push(record.id);
    }
  };

  if (isErr(listed)) {
    context.logger.error(
      'the modification journal could not be re-read for a rollback; the install ledger names the records this call appended through the adapters',
      {
        sessionId: context.sessionId,
        planVersion: context.planVersion,
        reported: reported.length,
        ledgered: ledgered.length,
        code: listed.error.code,
      },
    );

    for (const record of reported) {
      if (tracking.baseline.ids.has(record.id) && !ledgeredById.has(record.id)) {
        take(record, false);
      }
    }
  } else {
    for (const record of listed.value) {
      take(record, !tracking.baseline.ids.has(record.id) || ledgeredById.has(record.id));
    }
  }

  for (const record of ledgered) {
    take(record, true);
  }

  for (const record of reported) {
    take(ledgeredById.get(record.id) ?? record, true);
  }

  const reread: JournalReread = isErr(listed) ? 'failed' : 'listed';

  if (discovered.length > 0) {
    context.logger.warn('records of this install that no adapter reported are unwound too', {
      sessionId: context.sessionId,
      planVersion: context.planVersion,
      discovered: discovered.slice(0, MAX_REPORTED_ITEMS),
      discoveredCount: discovered.length,
      reread,
    });
  }

  return { records, discovered, reread };
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
   * rejected, a value that is not an install result, a result that carried a
   * failure through the fatal channel, or a journal holding a record this call
   * appended that no adapter's result reported.
   */
  readonly reason:
    'aborted' | 'adapter-failed' | 'invalid-result' | 'action-failed' | 'unreported-modification';

  /**
   * The adapter that was installing, when one was — absent for an
   * `'unreported-modification'` found after every adapter had answered.
   */
  readonly adapterId?: string | undefined;

  /**
   * For `'unreported-modification'`: how many records this call appended that
   * no adapter reported.
   */
  readonly unreported?: number | undefined;

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

  /**
   * The journal baseline and the install's ledger, which the rollback set is
   * completed from — or `undefined` when the install stopped before any
   * adapter was asked, so nothing of this call's can be in the journal.
   * Required rather than optional so that no failure path can forget to state
   * it.
   */
  readonly tracking: InstallTracking | undefined;
}

/**
 * The records the adapters reported for a failed install, in application
 * order — the reported half of the rollback set, which
 * {@link collectRollbackSet} completes from the install's ledger and the
 * journal.
 *
 * The earlier groups' records, then the failing adapter's own, then the record
 * it journaled for the failed attempt — which is therefore the first one
 * {@link rollbackApplied} restores when the journal cannot place it, because
 * it is the last write that may have touched the project. De-duplicated by
 * record id with the first occurrence's position kept, so an adapter that
 * listed its failed record in both places does not have it restored twice (the
 * second attempt would find the file already restored and report a conflict
 * that is not one).
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
 * When the second journal listing failed, the set came from the install's
 * ledger, which saw every record appended through the journal the adapters
 * were handed. The sentence says exactly that — what was restored, counted
 * over those records — and that the listing which would also have seen a
 * record written past that journal could not be taken, instead of claiming
 * the project is back where it was.
 *
 * @param report What the rollback achieved.
 * @param attempted How many records it had to reverse.
 * @param previousPlanVersion The revision the session returns to, when this was
 * a delta install.
 * @param reread How the journal re-read went.
 * @returns One or two sentences for the error message.
 */
function describeRollback(
  report: RollbackReport,
  attempted: number,
  previousPlanVersion: number | undefined,
  reread: JournalReread,
): string {
  const settled = report.conflicts.length === 0 && report.failures.length === 0;

  if (reread === 'failed') {
    const unconfirmed =
      'The modification journal could not be re-read to confirm that no record was written past the journal the adapters were handed.';

    if (attempted === 0) {
      return `No file modification was journaled through the adapters, so nothing had to be restored. ${unconfirmed}`;
    }

    return settled
      ? `All ${String(attempted)} file modification(s) journaled through the adapters were restored. ${unconfirmed}`
      : `${String(report.restored.length)} of ${String(attempted)} file modification(s) journaled through the adapters were restored; ${String(report.conflicts.length)} file(s) were left exactly as they stand and ${String(report.failures.length)} could not be restored. ${unconfirmed}`;
  }

  if (attempted === 0) {
    return 'No file had been modified, so nothing had to be restored.';
  }

  const destination =
    previousPlanVersion === undefined
      ? 'so this install left no instrumentation in the project'
      : `so the project holds exactly the instrumentation plan version ${String(previousPlanVersion)} installed`;

  if (settled) {
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
 * The headline for an install stopped by a record no adapter reported.
 *
 * @param adapterId The adapter whose ordinary result left the record out, or
 * `undefined` when the record was found only after every adapter had answered.
 * @param unreported How many such records there were.
 * @returns One sentence for the error message.
 */
function unreportedHeadline(adapterId: string | undefined, unreported: number): string {
  const count = `${String(unreported)} file modification(s)`;

  return adapterId === undefined
    ? `No adapter reported enabling any instrumentation, yet this install journaled ${count} that no adapter reported.`
    : `The adapter "${adapterId}" returned an install result that leaves out ${count} it journaled.`;
}

/**
 * Unwinds a failed or cancelled install and builds the error that reports it.
 *
 * The records unwound are {@link collectRollbackSet}'s: what the adapters
 * reported, completed from the install's ledger and from the journal against
 * the baseline, so an edit an adapter journaled without reporting is unwound
 * too.
 *
 * @param reported The records the adapters reported, in application order,
 * including a failed attempt's record last. The length of the completed set is
 * reported as `details.attempted`.
 * @param context The session's context, with the session's own journal.
 * @param input Why the install stopped, and what to measure the rollback
 * against.
 * @returns The error to return in the failure channel.
 */
async function unwind(
  reported: readonly ModificationRecord[],
  context: InstrumentationContext,
  input: UnwindInput,
): Promise<DebuggenError> {
  return unwindCollected(
    await collectRollbackSet(reported, context, input.tracking),
    context,
    input,
  );
}

/**
 * Reverse-restores an already collected rollback set and builds the error that
 * reports it.
 *
 * For an `'action-failed'` stop the headline names the adapter and the target
 * and quotes the failure's own message, and the hint is the failure's own hint
 * whenever the rollback left the project intact — it names the recovery for
 * the cause — falling back to the generic re-ask otherwise. An
 * `'unreported-modification'` stop names the adapter whose result left records
 * out, or says that none reported them, and its hint names the defect. A
 * rollback that left conflicts always points at them instead, and one whose
 * second journal listing failed points at the journal store, whose start-up
 * reconciliation settles any record the ledger could not have seen.
 *
 * @param set The records to reverse-restore, from {@link collectRollbackSet}.
 * @param context The session's context, with the session's own journal.
 * @param input Why the install stopped.
 * @returns The error to return in the failure channel.
 */
async function unwindCollected(
  set: RollbackSet,
  context: InstrumentationContext,
  input: UnwindInput,
): Promise<DebuggenError> {
  const report = await rollbackApplied(set.records, context);
  const settled = report.conflicts.length === 0 && report.failures.length === 0;
  const intact = settled && set.reread !== 'failed';
  const adapter = input.adapterId ?? 'unknown';
  const headline =
    input.reason === 'aborted'
      ? 'Installing instrumentation was cancelled before it finished.'
      : input.reason === 'invalid-result'
        ? `The adapter "${adapter}" did not return an install result.`
        : input.reason === 'action-failed'
          ? failedActionHeadline(adapter, input.failure)
          : input.reason === 'unreported-modification'
            ? unreportedHeadline(input.adapterId, input.unreported ?? set.discovered.length)
            : `The adapter "${adapter}" failed while installing its share of the plan.`;
  const failureHint = input.failure?.error.hint;
  const hint = intact
    ? input.reason === 'aborted'
      ? "Start the session's instrumentation again when you are ready to capture."
      : input.reason === 'action-failed' && isNonEmptyString(failureHint)
        ? failureHint
        : input.reason === 'unreported-modification'
          ? 'Nothing from this attempt remains in the project. An adapter must report every file modification it journals, so this is a defect in the adapter: report it with the service log.'
          : 'Nothing from this attempt remains in the project; ask the question again to install instrumentation afresh.'
    : !settled
      ? 'Review the reported conflicts before installing again: the original bytes are kept in this session\u2019s backup directory and no file was overwritten.'
      : "Every modification journaled through the adapters was restored, but the journal store did not answer a listing: check it before installing again. Restarting the Debug Generator service reconciles any record of this session's that is still open.";
  const details: Record<string, unknown> = {
    reason: input.reason,
    planVersion: input.planVersion,
    previousPlanVersion: input.previousPlanVersion,
    adapter: input.adapterId,
    ...(input.failure === undefined ? {} : { failedAction: failedActionFacts(input.failure) }),
    ...(input.reason === 'unreported-modification'
      ? { unreported: input.unreported ?? set.discovered.length }
      : {}),
    journalReread: set.reread,
    discovered: set.discovered.slice(0, MAX_REPORTED_ITEMS),
    discoveredCount: set.discovered.length,
    attempted: set.records.length,
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
    `${headline} ${describeRollback(report, set.records.length, input.previousPlanVersion, set.reread)}`,
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

  /**
   * How the journal listing that looked for records no adapter reported went:
   * `'listed'` when it confirmed there were none, `'failed'` when only the
   * install's ledger — which saw nothing appended through the adapters'
   * journal — stands behind "no file was modified".
   */
  readonly journalReread: JournalReread;
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
      journalReread: facts.journalReread,
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
