/**
 * The follow-up stage of the reasoning pipeline: a developer asks something
 * further about a session that has already been analysed and shown a panel,
 * and this module decides — once, through the model-output gate — whether the
 * evidence already stored answers it or whether more has to be measured, and
 * then carries out exactly one of the two paths AAP §0.4.2's Follow-up row
 * specifies (AAP §0.4.2, "AI stage boundaries", Follow-up row; §0.5.1; §0.5.3;
 * §0.5.4; §0.5.5; §0.7.1 Group 2; §0.8.1 slice 11).
 *
 * ## The two paths, and why the choice is a safety decision
 *
 * ```text
 * existing evidence   needsNewCapture = false and the accepted delta is empty
 *                     generated → analyzing → generated
 *                     the analysis and the panel are regenerated from the STORED
 *                     capture as analyses[n+1] and panelVersion n+1, each naming
 *                     its predecessor in `supersedes`; no file is touched
 *
 * new capture         needsNewCapture = true or the accepted delta is non-empty
 *                     generated → planning → instrumenting → ready
 *                     planVersion n+1 = the previous plan + the accepted delta;
 *                     only the delta is installed; the developer reproduces again
 * ```
 *
 * The paths differ in what they touch, not only in sequencing: the first adds
 * versioned rows and nothing else, the second writes to the developer's working
 * tree through the instrumentation service. {@link followUpPathFor} makes the
 * choice total and explicit, and a run never executes both.
 *
 * ## The additive-only rule is enforced here, not trusted
 *
 * `prompts/followup/v001.md` tells the model that a follow-up may only add.
 * This module does not rely on that: {@link diffAdditionalActions} classifies
 * every proposed action against the installed plan with the upstream
 * `actionIdentityKey` and refuses — each with its own reason code — a
 * re-emission, a removal, a replacement, a re-scope and a duplicate. The new
 * plan is then built as the previous plan **plus** the accepted delta
 * ({@link buildFollowUpPlanInput}), normalised with the previous actions so
 * every installed action keeps its id, validated internally, and checked once
 * more after normalisation: an installed action whose id, target, type, adapter
 * or mode changed is a product defect that stops the run before anything is
 * installed. The reason is cleanup: modification records form `previousRecordId`
 * chains that are restored in strict reverse order, each step verifying that
 * the file still hashes to that record's `instrumentedHash`. A re-emitted or
 * re-scoped action breaks that equality and turns a restorable file into a
 * conflict left in the developer's tree.
 *
 * ## The model-output gate (AAP §0.5.3)
 *
 * One call to `generateStructuredWithRepair` against
 * {@link followUpDecisionSchema}, with at most `DEFAULT_MAX_REPAIRS` repairs.
 * There is no second repair loop, no retry and no fallback decision: a rejected
 * decision is a stage failure that changes nothing. The plan the new-capture
 * path produces is held to the same deterministic steps Stage 3 uses —
 * `normalizePlan` → `instrumentationPlanSchema` → `checkPlanFeasibility` — and
 * a normalisation or internal-validation failure is a product defect logged
 * by its closed shape and its failing paths, and never re-prompted.
 *
 * ## What this stage owns, and what it hands on
 *
 * - **The decision and the delta.** Everything else is delegated: request
 *   rendering and the outbound guard to `../context-builder.js`; the analysis
 *   regeneration to an {@link AnalysisRegenerationPort} (the analyze stage,
 *   which verifies and stores through `../../analysis/facts.js`); the panel
 *   regeneration to a {@link PanelRegenerationPort} (the panel subsystem, which
 *   owns the gate, validation, fallback, persistence and `panel.generated`);
 *   installation to `../../instrumentation/service.js`, the only writer of the
 *   project, which records both hashes, the backup and the diff before any byte
 *   is written, applies only the delta and reverse-restores a delta that failed
 *   part-way.
 * - **Versions come from their owners.** The next plan version is
 *   `SessionsRepo.nextPlanVersion`; analysis and panel versions are assigned
 *   by the store through the delegated modules. Nothing here computes a
 *   version, and no row is ever updated in place.
 * - **A regeneration supersedes exactly what the decision was made against.**
 *   The existing-evidence path names the analysis and the panel it loaded — the
 *   analysis port's `supersedes`, the panel port's `expectedPredecessor` — and
 *   each owner refuses, before its model call and again inside the store's
 *   insert transaction, a predecessor that is no longer the session's latest.
 *   The latest panel is also re-read before the analysis is regenerated, so a
 *   panel stored while the follow-up was being decided stops the run before
 *   anything is stored. Each of those refusals carries
 *   `details.reason: 'supersedes-stale'` and fails the run — this stage's own
 *   check and the panel port's as `SESSION_INVALID_STATE`; a regenerated
 *   artifact that still names another predecessor fails it with `STORE_ERROR`
 *   (`analysis-ladder-inconsistent`, `panel-ladder-inconsistent`). No outcome
 *   is recorded for a failed run, so the follow-up stays unanswered.
 * - **Plan version n+1 is recorded only after its install succeeded**, so a
 *   delta that failed part-way leaves the session's plan ladder — and the
 *   baseline of the next follow-up — at version n. `SessionManager.recordPlan`
 *   writes the `plans` row and the session record that mirrors it in one
 *   transaction, so the ladder this stage reads and the `SessionRecord.plans`
 *   the capture stage arms from move together or not at all.
 * - **An install that cannot be kept is undone here.** The installer unwinds a
 *   delta that fails inside its own call. Every failure after the delta is on
 *   disk — an install that reports an error once it has applied, an install
 *   that leaves another version active, a plan version that could not be
 *   recorded — is compensated by this stage (AAP §0.4.2, Follow-up row): the
 *   journal records of plan version n+1 are reverse-restored newest first with
 *   `@debuggen/instrumentation`'s `restoreModification`, which never
 *   overwrites a file a developer has edited, and the service's arming state is
 *   returned to plan version n with `InstrumentationService.restoreArming`, so
 *   the files, the next capture and the plan ladder all stand at version n
 *   again. A failed operation is never left at n+1.
 * - **Claims are verified, not trusted.** An install error that names version
 *   n active is the installer's claim that its own unwind finished; the
 *   journal is read to confirm no record of n+1 is still open, and a record
 *   that is — the unwind left a conflict, a failure or an unread journal — is
 *   compensated here too. A `recordPlan` failure whose re-read ladder is at
 *   n+1 is kept only when the stored plan is this run's and the session record
 *   holds it as well (a failure after the commit, such as a broadcast); any
 *   other split is undone and reported.
 * - **Conflicts are reported, never touched.** A record of n+1 already in
 *   `conflict` — a developer edited the file after the patch — stops its
 *   file's chain like a conflict found while restoring: nothing is written,
 *   its backup is kept, the records under it are reported skipped, and the
 *   compensation is not claimed complete.
 * - **Clients see the outcome.** The service announced the n+1 records as
 *   applied before the failure; once a compensation has settled them, their
 *   final states are mirrored onto `SessionRecord.modifications` with
 *   `SessionManager.patch`, which broadcasts `session.updated`.
 * - **Session status is never written.** The orchestrator performs every
 *   transition through the session manager; {@link FollowUpStageInput.onPathChosen}
 *   and {@link FollowUpStageInput.beforeInstall} are its seams. This module
 *   records the follow-up with `SessionManager.appendFollowUp`, its outcome
 *   links with `recordFollowUpOutcome`, and a compensation's record states
 *   with `patch`, whose `SessionPatch` has no status member.
 * - **Progress.** The `followup` group, the `plan` group of the new-capture
 *   path and the `generate-panel` group of the existing-evidence path are
 *   emitted here with the titles `../../sessions/progress.ts` owns. The
 *   `instrument` group (including the Step-8 rows and "Ready to capture") is
 *   emitted by the instrumentation service from the installed set, and the
 *   `analyze` group by the analysis port, so neither is repeated here. A row
 *   that cannot be sent is logged and never fails the stage.
 *
 * ## No hardcoded behaviour (AAP §0.5.4)
 *
 * The follow-up question is passed through to the context builder, the
 * analysis port and the panel port verbatim; it is never compared, searched or
 * switched on. No adapter id, route, file, symbol, component or application
 * name appears here, and no plan or panel is authored: every addition comes
 * from the validated decision, every resolution from the live registry.
 *
 * ## Privacy (AAP §0.5.2)
 *
 * Log records carry the stage, the path, plan, analysis and panel versions,
 * counts, rejection reason codes, prompt versions, error codes and the
 * product-minted ids of modification records a compensation touched — never the
 * question, a prompt, the model output, a statement, a file's contents, a diff,
 * SQL, a URL or a token. The product-defect record of a plan version that
 * failed normalisation or validation (AAP §0.5.3) is no exception: exactly as
 * Stage 3's does, it describes the authoring input by its closed shape and
 * names where the defect is, never the input's objective, hypotheses or
 * rationales (CWE-532). Errors composed here carry codes, product-minted ids,
 * counts and enumerated reasons, never payload values.
 *
 * @module
 */

import {
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  actionIdentityKey,
  checkPlanFeasibility,
  instrumentationActionSchema,
  instrumentationPlanSchema,
  instrumentationTargetInputSchema,
  normalizePlan,
  orderRestorationChain,
  restoreModification,
} from '@debuggen/instrumentation';
import type {
  AdapterRegistry,
  FeasibilityReport,
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationContext,
  InstrumentationPlan,
  InstrumentationPlanInput,
  InstrumentationTargetInput,
  ModificationRecord,
  ModificationStatus,
  ObservedReadinessInputs,
  PlanAdapterResolver,
  ProblemUnderstanding,
  RestoreOutcome,
} from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  generateStructuredWithRepair,
  modelUnavailableMessage,
} from '@debuggen/model-provider';
import type { ModelProvider, PromptStage } from '@debuggen/model-provider';
import type { PanelSpec } from '@debuggen/panel-schema';
import { isPlainRecord } from '@debuggen/protocol';
import type { AnalysisResult, ProgressStage, SessionRecord } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isSafeRelativePath,
  noopLogger,
  normalizePosix,
  ok,
  toPosix,
  tryCatch,
} from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import type { AnalysisFollowUpContext, AnalysisSummarizer } from '../../analysis/summarize.js';
import type {
  CodeAnalysisHandles,
  InstallRequest,
  InstrumentationOutcome,
  InstrumentationService,
} from '../../instrumentation/service.js';
import { sessionLogger, subsystemLogger } from '../../logging.js';
import type { PanelGenerationResult, PanelRegenerationRequest } from '../../panels/generate.js';
import type { FollowUpOutcome, RecordedPlan, SessionManager } from '../../sessions/manager.js';
import {
  FAILURE_COPY_BY_CODE,
  authorProductText,
  isProductAuthoredText,
} from '../../sessions/progress.js';
import type { SessionProgress } from '../../sessions/progress.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { ModificationsRepo } from '../../store/modifications-repo.js';
import type { PanelsRepo } from '../../store/panels-repo.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import type {
  ContextBuilder,
  PipelineStageContext,
  StagePlaceholder,
  StageRequestBuild,
} from '../context-builder.js';
import type { AnalyzeStageInput, AnalyzeStageResult } from './analyze.js';
import { authoredPlanShape, refusedFieldPath } from './plan.js';
import { buildFollowUpDecisionSchema } from './reply-schemas.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * This stage's name in both vocabularies it reports under: protocol's
 * `PROGRESS_STAGES` (the `session.progress` rows) and the model boundary's
 * `PROMPT_STAGES` (the prompt file and the recorded prompt version). The
 * `satisfies` clause turns a rename in either tuple into a compile error here
 * (AAP §0.4.2, the Follow-up row; §0.5.3, versioned prompts per stage).
 */
export const FOLLOW_UP_STAGE = 'followup' as const satisfies ProgressStage & PromptStage;

/** The progress stage of the new-capture path's plan-version gate (protocol's `PROGRESS_STAGES`). */
const PLAN_STAGE = 'plan' as const satisfies ProgressStage;

/** The progress stage the delta install is filed under; its rows belong to the instrumentation service. */
const INSTRUMENT_STAGE = 'instrument' as const satisfies ProgressStage;

/** The progress and prompt stage of the analysis regeneration; its rows belong to the analysis port. */
const ANALYZE_STAGE = 'analyze' as const satisfies ProgressStage & PromptStage;

/** The progress and prompt stage of the panel regeneration; this stage emits its rows. */
const GENERATE_PANEL_STAGE = 'generate-panel' as const satisfies ProgressStage & PromptStage;

/** The logger subsystem binding of every pipeline module, per `../../logging.ts`. */
const PIPELINE_SUBSYSTEM = 'pipeline';

/**
 * The artifact name the structured-output loop quotes in repair feedback and
 * in a rejection's `details.schemaName`. The guard's refusal is one terse root
 * issue, so this label is what tells a repair turn which artifact it is
 * rewriting (AAP §0.5.3, the repair loop of every structured output).
 */
export const FOLLOW_UP_DECISION_SCHEMA_NAME = 'follow-up decision';

/** The upstream-style type label a rejection of {@link followUpDecisionSchema} reads (`expected FollowUpDecision`). */
const FOLLOW_UP_DECISION_LABEL = 'FollowUpDecision';

/**
 * The most additional actions one decision may propose: the target bound of
 * `InstrumentationPlanInput.instrumentationTargets`, since a decision naming
 * more than one plan can hold could never be honoured. The combined plan
 * (previous plus delta) is held to that same bound again by `normalizePlan`
 * (AAP §0.4.2, the Follow-up row's `additionalActions`).
 */
export const MAX_FOLLOW_UP_ADDITIONAL_ACTIONS = 64;

/**
 * The two execution paths of AAP §0.4.2's Follow-up row, as a closed
 * vocabulary. The order is the order the Follow-up row lists them in.
 */
export const FOLLOW_UP_PATHS = Object.freeze(['existing-evidence', 'new-capture'] as const);

/** One member of {@link FOLLOW_UP_PATHS} (AAP §0.4.2, the Follow-up row). */
export type FollowUpPath = (typeof FOLLOW_UP_PATHS)[number];

/**
 * Why {@link diffAdditionalActions} refused a proposed action. Every code
 * names one way an action could break the additive-only rule (AAP §0.4.2,
 * §0.5.1); see {@link FollowUpDeltaRejection.reason} for each definition.
 */
export const FOLLOW_UP_DELTA_REJECTION_REASONS = Object.freeze([
  're-emission',
  'removal',
  'replacement',
  're-scope',
  'duplicate',
] as const);

/** One member of {@link FOLLOW_UP_DELTA_REJECTION_REASONS} (AAP §0.4.2, §0.5.1). */
export type FollowUpDeltaRejectionReason = (typeof FOLLOW_UP_DELTA_REJECTION_REASONS)[number];

/**
 * The next step attached to a decision the model never shaped correctly.
 *
 * Replaces the structured-output loop's generic hint, which offers a
 * deterministic substitute artifact: that holds for a plan or a panel and not
 * here, where no fallback decision exists by design (AAP §0.5.3). The
 * developer is told what actually recovers.
 */
const DECISION_REJECTION_HINT =
  'No follow-up decision was accepted, so nothing was changed: the session keeps its current analysis, panel and instrumentation. Ask the follow-up again; if it keeps failing, check the configured model.';

/* -------------------------------------------------------------------------------------------------
 * Compile-time contract checks
 * ---------------------------------------------------------------------------------------------- */

/** Compiles only when `T` is exactly `true`; the repository's type-assertion idiom. */
type AssertTrue<T extends true> = T;

/** `true` when each of `A` and `B` is assignable to the other; the tuple wrap stops distribution. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The seven placeholders `prompts/followup/v001.md` declares, which this stage
 * supplies through `ContextBuilder.buildFollowUpRequest`: the question and the
 * five stored artifacts it hands over, and `outputSchema`, which the builder
 * renders from the authoring target schema.
 */
type FollowUpSuppliedPlaceholders =
  | 'followUpQuestion'
  | 'understanding'
  | 'plan'
  | 'captureSummary'
  | 'analysis'
  | 'panel'
  | 'outputSchema';

/**
 * Compile-time proof that the follow-up prompt's placeholder contract
 * (`STAGE_PLACEHOLDERS.followup`, itself drift-tested against the prompt file
 * by `../context-builder.test.ts`) is exactly what this stage supplies. An
 * eighth placeholder added to the prompt fails `tsc -b` here. Exported so
 * `noUnusedLocals` treats it as used; it has no runtime existence (AAP §0.5.3,
 * prompts as versioned repository files).
 */
export type FollowUpPromptPlaceholdersCovered = AssertTrue<
  MutuallyAssignable<StagePlaceholder<typeof FOLLOW_UP_STAGE>, FollowUpSuppliedPlaceholders>
>;

/* -------------------------------------------------------------------------------------------------
 * The FollowUpDecision contract — owned by this stage: a total guard, and the schema built on it
 * ---------------------------------------------------------------------------------------------- */

/**
 * One additional action a follow-up decision proposes: either an **authoring
 * target** — `{ file, symbol, type, rationale? }`, the shape
 * `prompts/followup/v001.md` asks for and the `{{outputSchema}}` document the
 * context builder renders from `InstrumentationPlanInput.instrumentationTargets`
 * — or a fully **resolved** `InstrumentationAction`, the literal element type of
 * AAP §0.4.2's `FollowUpDecision`. Both are the upstream types, reused rather
 * than restated. Whichever form arrives, the id, the adapter and the mode of
 * every accepted addition are assigned by deterministic code
 * (`normalizePlan`), never taken from the proposal.
 */
export type FollowUpAdditionalAction = InstrumentationTargetInput | InstrumentationAction;

/**
 * The follow-up stage's validated output artifact (AAP §0.4.2, Follow-up row):
 * whether answering the new question needs a new capture, and the additional
 * instrumentation it needs.
 *
 * `prompts/followup/v001.md` states that this artifact's schema is owned by the
 * stage module, so the runtime check is this module's total guard
 * {@link isFollowUpDecision}, and {@link followUpDecisionSchema} is built on it
 * by `./reply-schemas.ts` — the one module of this folder that imports the
 * validation library, which this module does not. **If an upstream schema for
 * this shape ever appears, switch to it and delete the local guard**: two
 * definitions of a cross-boundary shape is the defect AAP §0.2.3 names.
 */
export interface FollowUpDecision {
  /** Whether answering the follow-up needs a new capture. A real boolean, never a truthy value. */
  readonly needsNewCapture: boolean;
  /** The additions the follow-up needs; additive only, and checked by {@link diffAdditionalActions}. */
  readonly additionalActions: readonly FollowUpAdditionalAction[];
}

/** The keys of a decision, exactly. */
const DECISION_KEYS: ReadonlySet<string> = new Set(['needsNewCapture', 'additionalActions']);

/** The keys an authoring target may carry (`rationale` is optional). */
const TARGET_KEYS: ReadonlySet<string> = new Set(['file', 'symbol', 'type', 'rationale']);

/** The keys of a resolved action, exactly. */
const RESOLVED_ACTION_KEYS: ReadonlySet<string> = new Set([
  'id',
  'file',
  'symbol',
  'type',
  'adapter',
  'mode',
  'rationale',
]);

/** The keys only a resolved action carries; any one of them selects the resolved form. */
const RESOLUTION_KEYS: readonly string[] = Object.freeze(['id', 'adapter', 'mode']);

/** The action-type vocabulary widened to `string`, for a membership test that asserts nothing. */
const ACTION_TYPE_VALUES: readonly string[] = INSTRUMENTATION_ACTION_TYPES;

/** The install-mode vocabulary widened to `string`, for a membership test that asserts nothing. */
const MODE_VALUES: readonly string[] = INSTRUMENTATION_MODES;

/** Marks a property that is absent — or is not a plain data property, which counts the same. */
const ABSENT: unique symbol = Symbol('absent');

/**
 * Reads one **own data** property without invoking a getter and without
 * consulting the prototype chain.
 *
 * @param container The object or array to read.
 * @param key The property name or index.
 * @returns The value, or {@link ABSENT} for a missing key or an accessor.
 */
function dataProperty(container: object, key: string | number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    return ABSENT;
  }
  const value: unknown = descriptor.value;
  return value;
}

/**
 * Whether a value is a plain JSON object: `isPlainRecord`, and created as an
 * object literal (prototype `Object.prototype`) — the only object shape decoded
 * model output takes. A class instance and a null-prototype object are refused.
 */
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype;
}

/**
 * Whether every own key of `record` is an enumerable data property named in
 * `allowed`: an unknown key, a symbol key or an accessor is refused.
 */
function hasOnlyAllowedKeys(record: object, allowed: ReadonlySet<string>): boolean {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return false;
    }
  }
  return true;
}

/** Whether a value is a string carrying at least one non-whitespace character. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Whether a value is one of the eight action types. */
function isKnownActionType(value: unknown): value is InstrumentationActionType {
  return typeof value === 'string' && ACTION_TYPE_VALUES.includes(value);
}

/** Whether a value is one of the two install modes. */
function isKnownMode(value: unknown): boolean {
  return typeof value === 'string' && MODE_VALUES.includes(value);
}

/**
 * The normal form of a project-relative path: POSIX separators, then lexical
 * normalisation — the rule `normalizePlan` applies, so an identity key computed
 * here matches the one computed on the normalised plan.
 */
function normalizeActionFile(file: string): string {
  return normalizePosix(toPosix(file));
}

/**
 * Whether a value is one valid authoring target. Each condition is checked on
 * its own — known keys only, `file` a string whose normal form is a safe
 * project-relative path (`isSafeRelativePath`), `symbol` non-blank, `type` in
 * `INSTRUMENTATION_ACTION_TYPES`, `rationale` non-blank when present — and the
 * imported `instrumentationTargetInputSchema` then decides everything else: the
 * length bounds, the single-line symbol rule and the targetless-marker rule.
 */
function isAuthoringTarget(value: Readonly<Record<string, unknown>>): boolean {
  if (!hasOnlyAllowedKeys(value, TARGET_KEYS)) {
    return false;
  }
  const file = dataProperty(value, 'file');
  if (typeof file !== 'string' || !isSafeRelativePath(normalizeActionFile(file))) {
    return false;
  }
  if (!isNonBlankString(dataProperty(value, 'symbol'))) {
    return false;
  }
  if (!isKnownActionType(dataProperty(value, 'type'))) {
    return false;
  }
  const rationale = dataProperty(value, 'rationale');
  if (rationale !== ABSENT && !isNonBlankString(rationale)) {
    return false;
  }
  return instrumentationTargetInputSchema.safeParse(value).success;
}

/**
 * Whether a value is one valid resolved action. Each condition is checked on
 * its own — exactly the seven keys, `id` non-blank, `file` a safe
 * project-relative path already in its normal form, `symbol` non-blank, `type`
 * in `INSTRUMENTATION_ACTION_TYPES`, `adapter` non-blank, `mode` in
 * `INSTRUMENTATION_MODES`, `rationale` non-blank — and the imported
 * `instrumentationActionSchema` then decides the id shape, every length bound
 * and the targetless rules.
 */
function isResolvedActionValue(value: Readonly<Record<string, unknown>>): boolean {
  if (!hasOnlyAllowedKeys(value, RESOLVED_ACTION_KEYS)) {
    return false;
  }
  if (!isNonBlankString(dataProperty(value, 'id'))) {
    return false;
  }
  const file = dataProperty(value, 'file');
  if (typeof file !== 'string' || !isSafeRelativePath(file) || file !== normalizeActionFile(file)) {
    return false;
  }
  if (!isNonBlankString(dataProperty(value, 'symbol'))) {
    return false;
  }
  if (!isKnownActionType(dataProperty(value, 'type'))) {
    return false;
  }
  if (!isNonBlankString(dataProperty(value, 'adapter'))) {
    return false;
  }
  if (!isKnownMode(dataProperty(value, 'mode'))) {
    return false;
  }
  if (!isNonBlankString(dataProperty(value, 'rationale'))) {
    return false;
  }
  return instrumentationActionSchema.safeParse(value).success;
}

/**
 * Whether a value is one valid {@link FollowUpAdditionalAction}. A plain object
 * that carries any of `id`, `adapter` or `mode` is judged as a resolved action
 * (and must then carry all seven fields); any other plain object is judged as
 * an authoring target. Total: it never throws (AAP §0.5.3: every model
 * output is validated before it can affect anything).
 *
 * @param value Any value, typically one element of decoded model output.
 * @returns `true` only for a valid addition, narrowing it.
 */
export function isFollowUpAdditionalAction(value: unknown): value is FollowUpAdditionalAction {
  try {
    if (!isJsonObject(value)) {
      return false;
    }
    const resolved = RESOLUTION_KEYS.some((key) => Object.hasOwn(value, key));
    return resolved ? isResolvedActionValue(value) : isAuthoringTarget(value);
  } catch {
    return false;
  }
}

/** The unguarded body of {@link isFollowUpDecision}; may throw on hostile input. */
function checkDecision(value: unknown): boolean {
  if (!isJsonObject(value) || !hasOnlyAllowedKeys(value, DECISION_KEYS)) {
    return false;
  }
  if (typeof dataProperty(value, 'needsNewCapture') !== 'boolean') {
    return false;
  }
  const additions = dataProperty(value, 'additionalActions');
  if (!Array.isArray(additions)) {
    return false;
  }
  const list: readonly unknown[] = additions;
  if (list.length > MAX_FOLLOW_UP_ADDITIONAL_ACTIONS) {
    return false;
  }
  for (let index = 0; index < list.length; index += 1) {
    const element = dataProperty(list, index);
    if (element === ABSENT || !isFollowUpAdditionalAction(element)) {
      return false;
    }
  }
  return true;
}

/**
 * The total type guard of the {@link FollowUpDecision} artifact (AAP §0.4.2,
 * §0.5.3): the runtime check behind {@link followUpDecisionSchema}.
 *
 * Accepts exactly a plain object with the two keys `needsNewCapture` — a real
 * boolean — and `additionalActions` — a dense list of at most
 * {@link MAX_FOLLOW_UP_ADDITIONAL_ACTIONS} elements, every one of which passes
 * {@link isFollowUpAdditionalAction}. Unknown keys are refused at every level
 * and only own data properties are read, so a getter never runs. It checks
 * shape only: whether the additions respect the additive-only rule is
 * {@link diffAdditionalActions}'s question, answered against the installed plan.
 *
 * Total: it never throws — a cyclic, proxied or otherwise hostile value is
 * simply `false`.
 *
 * @param value Any value, typically decoded model output.
 * @returns `true` only for a valid decision, narrowing it.
 */
export function isFollowUpDecision(value: unknown): value is FollowUpDecision {
  try {
    return checkDecision(value);
  } catch {
    return false;
  }
}

/**
 * The authoring schema of the {@link FollowUpDecision} artifact, for
 * `generateStructuredWithRepair` (AAP §0.4.2, §0.5.3).
 *
 * Built by `./reply-schemas.ts` because this is the schema a real provider
 * renders for the model, and both of its routes (the schema-constrained format
 * and the forced tool call) need a JSON Schema document with an object root,
 * which an opaque schema cannot produce. {@link isFollowUpDecision} decides
 * first, so the guard and the schema cannot disagree and a hostile value never
 * reaches the structural half; a refusal reads `expected FollowUpDecision` and
 * quotes nothing, and the stage passes {@link FOLLOW_UP_DECISION_SCHEMA_NAME}
 * so the repair turn names the artifact it is rewriting. The structural half —
 * `needsNewCapture` and the upstream target and action schemas — is what the
 * model is constrained by. A parse returns a structurally equal copy of the
 * decision.
 */
export const followUpDecisionSchema = buildFollowUpDecisionSchema({
  label: FOLLOW_UP_DECISION_LABEL,
  admits: isFollowUpDecision,
  maxAdditionalActions: MAX_FOLLOW_UP_ADDITIONAL_ACTIONS,
});

/* -------------------------------------------------------------------------------------------------
 * The additive-only rule — pure, and enforced in code
 * ---------------------------------------------------------------------------------------------- */

/**
 * One proposed action {@link diffAdditionalActions} refused. Carries the
 * proposal's position, the reason code, its action type and — when the
 * proposal collided with an installed action — that action's product-minted
 * id. Never a file, a symbol or a rationale, so it is safe to log (AAP §0.4.2,
 * §0.5.1, §0.5.2).
 */
export interface FollowUpDeltaRejection {
  /** The proposal's index in `additionalActions`. */
  readonly index: number;
  /**
   * Why it was refused:
   *
   * - `'re-emission'` — it restates an installed action: the same identity
   *   (`actionIdentityKey`: file, symbol and type) and, when it is a resolved
   *   action, the same id, adapter and mode. A reworded rationale is still a
   *   re-emission. The installed action already covers it.
   * - `'removal'` — it addresses an installed action by id while naming a
   *   different file or symbol: applying it would take that id — and the
   *   modification chain recorded against it — away from the target it
   *   instruments, which removes the installed action from the plan.
   * - `'replacement'` — it has an installed action's identity but a different
   *   body: another id, or another adapter. Installing it would patch a target
   *   the chain already covers a second time.
   * - `'re-scope'` — it alters an installed action's scope: it addresses the
   *   installed action by id on the same file and symbol with another type, or
   *   restates its identity with another install mode.
   * - `'duplicate'` — it repeats an identity an earlier proposal of the same
   *   decision was already accepted for.
   */
  readonly reason: FollowUpDeltaRejectionReason;
  /** The proposal's action type. */
  readonly actionType: InstrumentationActionType;
  /** The installed action the proposal collided with, when it collided with one. */
  readonly installedActionId?: string | undefined;
}

/** What {@link diffAdditionalActions} concluded about a decision's proposals (AAP §0.4.2, §0.5.1). */
export interface FollowUpActionDelta {
  /**
   * The accepted additions, in proposal order, as authoring targets with their
   * file in normal form. Ids, adapters and modes are deliberately absent: they
   * are assigned by `normalizePlan`, which is the only place they may come from.
   */
  readonly accepted: readonly InstrumentationTargetInput[];
  /** The refused proposals, in proposal order. */
  readonly rejected: readonly FollowUpDeltaRejection[];
}

/** Whether an addition is in the resolved form (it then carries an id, an adapter and a mode). */
function isResolvedAction(action: FollowUpAdditionalAction): action is InstrumentationAction {
  return Object.hasOwn(action, 'id');
}

/** An addition as an authoring target: its file in normal form, its rationale kept when present. */
function toAuthoringTarget(
  action: FollowUpAdditionalAction,
  file: string,
): InstrumentationTargetInput {
  const rationale = action.rationale;
  return rationale !== undefined && rationale.trim().length > 0
    ? { file, symbol: action.symbol, type: action.type, rationale }
    : { file, symbol: action.symbol, type: action.type };
}

/** The verdict on one proposal: a refusal, or `undefined` for an addition. */
interface ProposalVerdict {
  readonly reason: FollowUpDeltaRejectionReason;
  readonly installed?: InstrumentationAction | undefined;
}

/** Classifies one proposal against the installed actions and the additions already accepted. */
function classifyProposal(
  action: FollowUpAdditionalAction,
  file: string,
  key: string,
  installedByKey: ReadonlyMap<string, InstrumentationAction>,
  installedById: ReadonlyMap<string, InstrumentationAction>,
  acceptedKeys: ReadonlySet<string>,
): ProposalVerdict | undefined {
  const resolved = isResolvedAction(action) ? action : undefined;

  // A proposal that addresses an installed action by its id but names a
  // different identity is an attempt to change that installed action.
  const addressed = resolved === undefined ? undefined : installedById.get(resolved.id);
  if (addressed !== undefined && actionIdentityKey(addressed) !== key) {
    const sameTarget = addressed.file === file && addressed.symbol === action.symbol;
    return { reason: sameTarget ? 're-scope' : 'removal', installed: addressed };
  }

  const installed = installedByKey.get(key);
  if (installed !== undefined) {
    if (resolved === undefined) {
      return { reason: 're-emission', installed };
    }
    if (resolved.id !== installed.id) {
      return { reason: 'replacement', installed };
    }
    if (resolved.mode !== installed.mode) {
      return { reason: 're-scope', installed };
    }
    if (resolved.adapter !== installed.adapter) {
      return { reason: 'replacement', installed };
    }
    return { reason: 're-emission', installed };
  }

  if (acceptedKeys.has(key)) {
    return { reason: 'duplicate' };
  }
  return undefined;
}

/**
 * The additive-only rule of AAP §0.4.2, enforced: the part of a decision's
 * proposals that may be added to the installed plan, and a typed refusal for
 * every proposal that may not.
 *
 * **Why the rule is load-bearing.** Every installed action owns modification
 * records that form a `previousRecordId` chain per file: when a later plan
 * version patches an already-patched file, the new record takes the earlier
 * record's `instrumentedHash` as its `originalHash` and links the earlier
 * record. Cleanup restores each chain strictly in reverse order, verifying at
 * each step that the file hashes to that record's `instrumentedHash` before
 * writing its backup (AAP §0.5.1). A re-emitted, replaced or re-scoped action
 * would add a second layer for a target the chain already covers — or move an
 * id off the target its records describe — and break that equality, turning a
 * restorable file into a conflict left in the developer's tree. So the delta
 * may **only add**, and this function never trusts the model's statement that
 * it did.
 *
 * Identity is the imported `actionIdentityKey` — `(file, symbol, type)` with
 * the file in its normal form — and nothing else: not ids, not deep equality,
 * not a concatenation of this module's own. An authoring target that names a
 * new type on an already instrumented file and symbol is therefore an
 * **addition** (it alters no installed action); only a proposal that
 * addresses an installed action by id, or restates an installed identity with
 * another body, can re-scope or replace one.
 *
 * Pure and deterministic: no clock, no logger, no I/O, and proposal order is
 * preserved in both lists.
 *
 * @param previousActions The installed plan version's actions, verbatim.
 * @param proposed The decision's `additionalActions`, already validated by
 * {@link isFollowUpDecision}.
 * @returns The accepted additions (authoring targets, normal-form files) and
 * the refusals.
 *
 * @example
 * ```ts
 * const delta = diffAdditionalActions(plan.instrumentationTargets, decision.additionalActions);
 * // delta.accepted → appended to the previous plan as planVersion n + 1
 * // delta.rejected → [{ index: 0, reason: 're-emission', actionType, installedActionId }]
 * ```
 */
export function diffAdditionalActions(
  previousActions: readonly InstrumentationAction[],
  proposed: readonly FollowUpAdditionalAction[],
): FollowUpActionDelta {
  const installedByKey = new Map<string, InstrumentationAction>();
  const installedById = new Map<string, InstrumentationAction>();
  for (const action of previousActions) {
    const key = actionIdentityKey(action);
    if (!installedByKey.has(key)) {
      installedByKey.set(key, action);
    }
    if (!installedById.has(action.id)) {
      installedById.set(action.id, action);
    }
  }

  const acceptedKeys = new Set<string>();
  const accepted: InstrumentationTargetInput[] = [];
  const rejected: FollowUpDeltaRejection[] = [];

  for (const [index, action] of proposed.entries()) {
    const file = normalizeActionFile(action.file);
    const key = actionIdentityKey({ file, symbol: action.symbol, type: action.type });
    const verdict = classifyProposal(
      action,
      file,
      key,
      installedByKey,
      installedById,
      acceptedKeys,
    );
    if (verdict !== undefined) {
      rejected.push(
        Object.freeze({
          index,
          reason: verdict.reason,
          actionType: action.type,
          ...(verdict.installed !== undefined ? { installedActionId: verdict.installed.id } : {}),
        }),
      );
      continue;
    }
    acceptedKeys.add(key);
    accepted.push(Object.freeze(toAuthoringTarget(action, file)));
  }

  return Object.freeze({ accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
}

/**
 * The path a decision takes (AAP §0.4.2, Follow-up row), total over its two
 * inputs: `'new-capture'` when the decision asks for a new capture **or** the
 * additive-only rule accepted at least one addition — instrumentation only
 * ever produces evidence through a capture, so an accepted addition always
 * means a new capture — and `'existing-evidence'` otherwise.
 *
 * @param needsNewCapture The decision's own answer.
 * @param delta The additive-only verdict on its proposals.
 * @returns The one path the run executes.
 */
export function followUpPathFor(
  needsNewCapture: boolean,
  delta: FollowUpActionDelta,
): FollowUpPath {
  return needsNewCapture || delta.accepted.length > 0 ? 'new-capture' : 'existing-evidence';
}

/** An installed action restated as an authoring target, verbatim: file, symbol, type and rationale. */
function installedAsTarget(action: InstrumentationAction): InstrumentationTargetInput {
  return {
    file: action.file,
    symbol: action.symbol,
    type: action.type,
    rationale: action.rationale,
  };
}

/**
 * The authoring input of `planVersion n + 1`: **the previous plan plus the
 * accepted delta** — never the delta alone, and never the previous plan with
 * anything dropped (AAP §0.4.2). The objective, the capture phrases and the
 * hypotheses are the previous version's, verbatim; every installed action is
 * restated first, in its installed order, so `normalizePlan` (given the
 * previous actions) hands each one its installed id, and the additions follow
 * in proposal order. Pure.
 *
 * @param previous The installed plan version.
 * @param delta The accepted additions from {@link diffAdditionalActions}.
 * @returns The authoring input to normalise as the next plan version.
 */
export function buildFollowUpPlanInput(
  previous: InstrumentationPlan,
  delta: readonly InstrumentationTargetInput[],
): InstrumentationPlanInput {
  return {
    objective: previous.objective,
    capture: [...previous.capture],
    instrumentationTargets: [...previous.instrumentationTargets.map(installedAsTarget), ...delta],
    hypotheses: [...previous.hypotheses],
  };
}

/**
 * The index of the first installed action the normalised next version does
 * not carry unchanged — same position, id, file, symbol, type, adapter and
 * mode — or `undefined` when every installed action survived intact and the
 * version holds exactly the installed actions plus `deltaLength` more whose
 * ids no installed action uses. Anything else is a product defect: installing
 * it would re-instrument or re-scope a file the journal already records.
 */
function findAlteredInstalledAction(
  previous: readonly InstrumentationAction[],
  next: readonly InstrumentationAction[],
  deltaLength: number,
): number | undefined {
  for (const [index, before] of previous.entries()) {
    const after = next[index];
    if (
      after?.id !== before.id ||
      after.file !== before.file ||
      after.symbol !== before.symbol ||
      after.type !== before.type ||
      after.adapter !== before.adapter ||
      after.mode !== before.mode
    ) {
      return index;
    }
  }
  if (next.length !== previous.length + deltaLength) {
    return previous.length;
  }
  const installedIds = new Set(previous.map((action) => action.id));
  for (let index = previous.length; index < next.length; index += 1) {
    const addition = next[index];
    if (addition === undefined || installedIds.has(addition.id)) {
      return index;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Ports — consumer-declared, satisfied structurally by the owning modules
 * ---------------------------------------------------------------------------------------------- */

/**
 * The panel regeneration this stage delegates to on the existing-evidence path
 * (AAP §0.4.2: `panelVersion n + 1` with `supersedes` naming panel `n`).
 *
 * Declared here, consumer-side — the pattern behind `SessionBroadcaster`,
 * `SessionCleanupRunner` and the orchestrator's stage overrides — and typed
 * with a **type-only** import of `../../panels/generate.js`, so the panel
 * contract stays single-defined while no runtime edge into the panel subsystem
 * exists from this folder. `PanelGenerator` satisfies it as-is; the service's
 * wiring passes it. An implementation owns the whole of panel generation — the
 * prompt, the gate, validation, fallback, persistence and `panel.generated` —
 * and **emits no progress row**: this stage emits the `generate-panel` group
 * around the call.
 *
 * The request names the panel the follow-up was decided against in
 * `expectedPredecessor`. An implementation stores a panel superseding exactly
 * that panel or none at all: a session whose latest panel is another one is
 * refused — before its model call, and by the store inside its insert
 * transaction — with `SESSION_INVALID_STATE` and
 * `details.reason: 'supersedes-stale'`, storing and broadcasting nothing. A
 * returned panel naming any other predecessor fails the run as
 * `panel-ladder-inconsistent` rather than being delivered.
 */
export interface PanelRegenerationPort {
  /**
   * Regenerates, validates, stores and broadcasts the next panel version of a
   * capture, answering the follow-up question.
   *
   * @param request The session, the stored capture, both questions, the
   * regenerated analysis, the capture summary, the recorded prompt version,
   * the panel the new one must supersede (`expectedPredecessor`) and the
   * cancellation signal.
   * @returns The stored panel — a fallback panel included — or the subsystem's
   * typed error, the stale-predecessor refusal included. Never rejects.
   */
  regenerate(
    request: PanelRegenerationRequest,
  ): Promise<Result<PanelGenerationResult, DebuggenError>>;
}

/**
 * The analysis regeneration this stage delegates to on the existing-evidence
 * path (AAP §0.4.2: `analyses[n + 1]` with `supersedes` naming analysis `n`).
 *
 * Consumer-declared and typed with a type-only import of `./analyze.js`; the
 * analyze stage satisfies it as-is. Called with `regenerate: true`, it re-runs
 * the analysis against the **stored** capture: the summarizer builds the
 * bounded input (carrying the follow-up question from the stage context), the
 * analysis gate runs once, and `../../analysis/facts.js` verifies the findings
 * against the capture and stores them through `acceptFindings`, which takes the
 * next version and the superseded id from the store. An implementation emits
 * its own `analyze` progress rows — the analyze stage does — so this stage
 * emits none for that step.
 */
export interface AnalysisRegenerationPort {
  /**
   * Regenerates and stores the next analysis version of a stored capture.
   *
   * @param context The run's stage context, carrying the follow-up question and
   * the stored capture's id.
   * @param input The capture, the session's understanding, the recorded prompt
   * version, `regenerate: true` and the analysis to supersede.
   * @returns The stored analysis, or the failing subsystem's typed error.
   * Never rejects.
   */
  run(
    context: PipelineStageContext,
    input: AnalyzeStageInput,
  ): Promise<Result<AnalyzeStageResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Module contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * The collaborators of the follow-up stage, all injected (AAP §0.7.1 Group 2).
 * Each member is typed as the narrowest slice of its owner's interface this
 * stage calls, so the full service objects — and a test's fakes — are
 * accepted, and the types themselves document that this stage writes no
 * status, no analysis row, no panel row and appends no modification record.
 * The one journal transition it causes is a compensation's: an installed delta
 * that cannot be kept has its records moved to `reverted` (or `conflict`) by
 * `restoreModification`, through the journal of the context the
 * instrumentation service builds — and those final states are then mirrored
 * onto the session record's `modifications` with `SessionManager.patch`.
 */
export interface FollowUpStageDeps {
  /** Renders the versioned follow-up prompt and runs the outbound guard. */
  readonly contextBuilder: Pick<ContextBuilder, 'buildFollowUpRequest'>;
  /** The configured model provider; called only through `generateStructuredWithRepair`. */
  readonly provider: ModelProvider;
  /** The bounded follow-up context (previous analysis and panel ids) and the stored capture summary. */
  readonly summarizer: Pick<AnalysisSummarizer, 'buildFollowUpContext' | 'loadCaptureSummary'>;
  /** Regenerates the analysis on the existing-evidence path (normally the analyze stage). */
  readonly analysisRegeneration: AnalysisRegenerationPort;
  /** Regenerates the panel on the existing-evidence path (normally the panel generator). */
  readonly panelRegeneration: PanelRegenerationPort;
  /**
   * Builds the adapter context and installs the delta — the only writer to the
   * project — and, when an installed delta cannot be kept, restores the
   * service's arming state to the previous plan version (`restoreArming`). The
   * compensation's file restores go through `restoreModification` over the
   * context this service builds, so its journal and backup store are the
   * service's own; a successful run never reaches `restoreArming`.
   */
  readonly instrumentation: Pick<
    InstrumentationService,
    'buildContext' | 'install' | 'restoreArming'
  >;
  /** The live adapter registry: the only source of adapter identity and install mode. */
  readonly registry: AdapterRegistry;
  /**
   * The plan ladder — the installed version and the next version's number —
   * and the session record, read (never written) for two things only: to
   * confirm that a plan version whose recording reported a failure is held by
   * both the ladder and the record before the run keeps it, and as the base a
   * compensation's record states are merged onto.
   */
  readonly sessions: Pick<
    SessionsRepo,
    'latestPlanVersion' | 'getPlan' | 'nextPlanVersion' | 'get'
  >;
  /**
   * The analysis and panel history, read one row at a time: the latest version
   * of each; the latest panel again once the path is chosen, to prove it is
   * still the panel the follow-up was decided against; and — to prove a
   * regeneration appended a version rather than mutating one — the superseded
   * analysis by its id. The whole ladder is never listed, so a follow-up's
   * reads stay constant as the session's history grows.
   */
  readonly panels: Pick<PanelsRepo, 'getAnalysis' | 'getLatestAnalysis' | 'getLatestPanel'>;
  /** The modification journal, read only: the chain head of each file the delta patches. */
  readonly modifications: Pick<ModificationsRepo, 'latestRecordForFile'>;
  /**
   * Records the follow-up, its outcome links and plan version n + 1, and —
   * after a compensation — patches `modifications` with the final states of
   * the records it settled. Never a status: `SessionPatch` has no such member.
   */
  readonly sessionManager: Pick<
    SessionManager,
    'appendFollowUp' | 'recordFollowUpOutcome' | 'recordPlan' | 'patch'
  >;
  /** Emits the `followup`, `plan` and `generate-panel` groups; owns every title. */
  readonly progress: Pick<SessionProgress, 'stageStarted' | 'stageCompleted' | 'stageFailed'>;
  /** A parent logger, bound to the session per run; absent, the context's logger is used. */
  readonly logger?: Logger | undefined;
  /**
   * The repair budget of the decision gate: an integer from `0` to
   * `DEFAULT_MAX_REPAIRS`, defaulting to the maximum (AAP §0.5.3). A value
   * outside that range fails every run with `CONFIG_INVALID` before anything
   * is sent or recorded.
   */
  readonly maxRepairs?: number | undefined;
  /** An id factory for the delta's new action ids; defaults to `normalizePlan`'s own. */
  readonly newActionId?: (() => string) | undefined;
}

/**
 * What one follow-up run is asked (AAP §0.4.2, Follow-up row). The prior
 * understanding, the installed plan, the latest capture summary, analysis and
 * panel are loaded through the injected repositories, never passed in.
 */
export interface FollowUpStageInput {
  /** The follow-up question, verbatim. Rendered into prompts only; never compared or searched. */
  readonly followUpQuestion: string;
  /**
   * The identity of this ask (protocol's `followUpAttemptIdSchema`), handed to
   * `SessionManager.appendFollowUp` untouched: a fresh id records a new
   * follow-up, the id of the session's latest unanswered follow-up retries it
   * in place. This stage never mints, compares or rewrites it.
   */
  readonly attemptId: string;
  /**
   * The follow-up prompt version to use. Absent, the version recorded on the
   * session is reused — a reopened session's follow-up keeps the prompt it
   * started with even after that version has been superseded — and failing
   * that the manifest's current one.
   */
  readonly promptVersion?: string | undefined;
  /**
   * The readiness facts the service has observed, placed on the adapter
   * context of plan version n + 1 so the registry resolves against this
   * machine. Absent means nothing has reported yet.
   */
  readonly readiness?: ObservedReadinessInputs | undefined;
  /**
   * The orchestrator's seam for the path's first transition — `generated →
   * analyzing` or `generated → planning` — since this stage writes no status.
   * Called once per run, after the decision is validated and, on the
   * new-capture path, after plan version n + 1 has passed the deterministic
   * gate: before anything is stored, regenerated or installed. An `Err` (or a
   * throw) stops the run with nothing changed beyond the recorded question.
   */
  readonly onPathChosen?:
    ((path: FollowUpPath) => Promise<Result<unknown, DebuggenError>>) | undefined;
  /**
   * The orchestrator's seam for `planning → instrumenting` on the new-capture
   * path, called with the validated, not yet recorded plan version n + 1 just
   * before the delta is installed. An `Err` (or a throw) stops the run before
   * anything is installed.
   */
  readonly beforeInstall?:
    ((plan: InstrumentationPlan) => Promise<Result<unknown, DebuggenError>>) | undefined;
}

/**
 * What the decision gate produced, common to both paths (AAP §0.4.2, §0.5.3).
 * Log its counts, never its contents.
 */
export interface FollowUpDecisionSummary {
  /** The decision's own answer to "is a new capture needed". */
  readonly needsNewCapture: boolean;
  /** How many additions the decision proposed. */
  readonly proposedActions: number;
  /** The additions the additive-only rule accepted, as authoring targets. */
  readonly acceptedActions: readonly InstrumentationTargetInput[];
  /** The proposals it refused, each with its reason code. */
  readonly rejectedActions: readonly FollowUpDeltaRejection[];
  /** The follow-up prompt version actually loaded; the orchestrator records it on the session. */
  readonly promptVersion: string;
  /** Repairs the decision gate spent (at most `DEFAULT_MAX_REPAIRS`). */
  readonly repairs: number;
  /** Provider attempts in total, the accepted one included. */
  readonly attempts: number;
  /** The provider implementation that answered, as it reports itself. */
  readonly providerId: string;
  /** The model that produced the accepted answer, as the provider reports it. */
  readonly model: string;
}

/** The fields both variants of {@link FollowUpStageResult} carry. */
interface FollowUpStageResultBase {
  /** Which path the run executed; the discriminant. */
  readonly path: FollowUpPath;
  /** The validated decision and the additive-only verdict on it. */
  readonly decision: FollowUpDecisionSummary;
  /** The session record as last stored by this run. */
  readonly session: SessionRecord;
  /**
   * Whether the follow-up's outcome links were stamped onto its record. The
   * links are bookkeeping recorded after the path's artifacts are stored, so a
   * store failure there is reported here and logged, never used to disown
   * artifacts that already exist.
   */
  readonly outcomeRecorded: boolean;
}

/**
 * The existing-evidence outcome (`generated → analyzing → generated`): the
 * regenerated analysis and panel, each a new version superseding its
 * predecessor. `analysis` and `panel` are exactly what the orchestrator hands
 * the state machine's `analyzing → generated` guard. No file was touched
 * (AAP §0.4.2, the Follow-up row's existing-evidence path; §0.5.5).
 */
export interface FollowUpExistingEvidenceResult extends FollowUpStageResultBase {
  readonly path: 'existing-evidence';
  /** The stored capture both regenerations were drawn from. */
  readonly captureId: string;
  /** The regenerated, verified and stored analysis (`analyses[n + 1]`). */
  readonly analysis: AnalysisResult;
  /** Its version, as the store assigned it. */
  readonly analysisVersion: number;
  /** The analysis it supersedes. */
  readonly supersededAnalysisId: string;
  /** The regenerated, validated and stored panel (`panelVersion n + 1`). */
  readonly panel: PanelSpec;
  /** Its version, as the store assigned it. */
  readonly panelVersion: number;
  /** The panel it supersedes. */
  readonly supersededPanelId: string;
  /** Whether the panel is the deterministic fallback, shown under the fallback banner. */
  readonly fallbackPanel: boolean;
  /** The analyze prompt version actually rendered. */
  readonly analysisPromptVersion: string;
  /** The generate-panel prompt version actually rendered. */
  readonly panelPromptVersion: string;
}

/**
 * The new-capture outcome (`generated → planning → instrumenting → ready`):
 * plan version n + 1, recorded after its delta was installed, and the
 * installation outcome whose readiness verdict the orchestrator's guarded
 * `instrumenting → ready` edge needs. The developer is asked to reproduce the
 * issue again; the next capture drives `analyzing → generated` through the
 * orchestrator, not through this stage (AAP §0.4.2, the Follow-up row's
 * new-capture path; §0.5.1).
 */
export interface FollowUpNewCaptureResult extends FollowUpStageResultBase {
  readonly path: 'new-capture';
  /** Plan version n + 1 as recorded: the previous plan plus the delta. */
  readonly plan: InstrumentationPlan;
  /** Its version on the session's plan ladder. */
  readonly planVersion: number;
  /** The version it builds on — the one the delta was computed against. */
  readonly previousPlanVersion: number;
  /** The delta's resolved actions, with the ids, adapters and modes normalisation assigned. */
  readonly delta: readonly InstrumentationAction[];
  /** The feasibility report of plan version n + 1 (installed actions re-checked, delta included). */
  readonly feasibility: FeasibilityReport;
  /**
   * How many distinct files the delta's **feasible** patch-mode actions touch
   * that already carry a live modification chain head
   * (`ModificationsRepo.latestRecordForFile`, status other than `reverted`):
   * each is a file whose next record the installer links through
   * `previousRecordId` (AAP §0.5.1). A refused action patches nothing, so it
   * is not counted.
   */
  readonly chainedFiles: number;
  /** The installation outcome, as the instrumentation service returned it. Do not install again. */
  readonly installation: InstrumentationOutcome;
}

/**
 * The outcome of a successful follow-up run, discriminated on
 * {@link FollowUpStageResultBase.path} so the orchestrator cannot confuse the
 * two paths' artifacts (AAP §0.4.2, the Follow-up row).
 */
export type FollowUpStageResult = FollowUpExistingEvidenceResult | FollowUpNewCaptureResult;

/**
 * The follow-up stage: the factory-plus-single-`run` shape the orchestrator's
 * `StageOverrides` port substitutes in tests (AAP §0.4.2, the Follow-up row;
 * §0.7.1 Group 2; §0.8.1 slice 11).
 */
export interface FollowUpStage {
  /**
   * Decides a follow-up question and executes the one path it takes.
   *
   * Never throws for an expected failure. Every failure is an `Err` carrying
   * the failing subsystem's own `DebuggenError`, with `details.stage` set to the
   * stage it belongs to (`followup`, `plan`, `instrument`, `analyze` or
   * `generate-panel`) so the orchestrator can file the session's failure under
   * it. The stage writes no session status. A new-capture failure after the
   * delta was installed keeps the failing subsystem's code, has one sentence
   * appended to its message stating what the compensation left in the project,
   * carries the compensation's report in `details.deltaRollback` (with
   * `mirrored` saying whether the settled records reached the session record)
   * and `details.activePlanVersion` only when the session provably stands at
   * version n again. A plan row stored without the session record accounting
   * for it adds `details.planStored: true` and `recordMirrored: false`. A
   * `recordPlan` failure after both were stored is not a failure: the run
   * completes with the recorded plan.
   *
   * @param context The run's stage context.
   * @param input The follow-up question and the run's seams and options.
   * @returns The path's outcome, or the failure.
   */
  run(
    context: PipelineStageContext,
    input: FollowUpStageInput,
  ): Promise<Result<FollowUpStageResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Log records — fields are ids, versions, counts, codes and reasons; never content
 * ---------------------------------------------------------------------------------------------- */

/** Info record of a decided follow-up. Fields: path, counts, reason codes, repairs, versions. */
const DECIDED_LOG = 'Follow-up decided.';

/** Info record of a completed run. Fields: path, versions, counts, timing. */
const COMPLETED_LOG = 'Follow-up stage completed.';

/** Warn record of a failed run. Fields: stage, error code, enumerated reason. */
const FAILED_LOG = 'Follow-up stage failed.';

/** Debug record of a run whose signal was aborted before it began. */
const CANCELLED_LOG = 'Follow-up stage cancelled.';

/**
 * Error record of a plan version n + 1 that passed the authoring schema but
 * failed normalisation, internal validation or the installed-action check — a
 * product defect (AAP §0.5.3). Fields: stage, step, error code, plan version,
 * the authoring input's closed shape (`authoredPlanShape` of `./plan.ts`:
 * counts and action types) and where the defect is — the normaliser's
 * structural field path, the internal issues' paths and codes, or the altered
 * action's index. Never the input itself: its objective, hypotheses and
 * rationales are model prose that the service logger's key-based redaction
 * cannot recognise (CWE-532).
 */
const PRODUCT_DEFECT_LOG =
  'A follow-up plan version failed deterministic normalisation or validation; it was rejected without a re-prompt and nothing was installed.';

/**
 * Error record of a delta that was installed but whose plan version could not
 * be recorded. Fields: stage, plan version, error code, whether the plan row
 * was found stored (`planStored`: `true`, `false` or `'unknown'`) and, when it
 * was, why it could not be kept (`planCheck`, a {@link PlanCheck}).
 */
const UNRECORDED_PLAN_LOG =
  'A follow-up delta was installed but recording its plan version failed.';

/**
 * Warn record of a plan version that the ladder and the session record both
 * hold although recording it reported a failure — a failure after the commit,
 * such as a broadcast — so the run completes with it. Fields: plan version,
 * error code.
 */
const PLAN_RECORDED_DESPITE_REPORT_LOG =
  'The follow-up plan version was recorded on the plan ladder and the session record although recording it reported a failure; the run continues with it.';

/**
 * Warn record of a compensation whose settled record states could not be
 * mirrored onto the session record. Fields: step (`read` or `patch`), error
 * code.
 */
const DELTA_MIRROR_FAILED_LOG =
  'The records a follow-up compensation settled could not be mirrored onto the session record; clients keep the states they were last sent.';

/**
 * Info record of an installed delta that could not be kept and was undone in
 * full: every file modification of plan version n + 1 restored and the arming
 * state back at version n. Fields: trigger, versions, error code, counts and
 * record ids.
 */
const DELTA_ROLLED_BACK_LOG =
  'An installed follow-up delta could not be kept and was reverse-restored; the session stays at its previous plan version.';

/**
 * Error record of a compensation that could not undo everything: a conflict, a
 * restore failure, an unreadable journal or arming state that could not be
 * returned. Fields as {@link DELTA_ROLLED_BACK_LOG}, plus the failure codes.
 */
const DELTA_ROLLBACK_INCOMPLETE_LOG =
  'An installed follow-up delta could not be kept and was only partly reverse-restored; the remaining modifications stay for cleanup.';

/** Warn record of an outcome link that could not be stamped. Fields: path, error code. */
const OUTCOME_UNRECORDED_LOG =
  'The follow-up outcome links could not be recorded; the stored artifacts stand.';

/** Warn record of a progress row that could not be emitted. Fields: stage, row, error code. */
const PROGRESS_FAILED_LOG =
  'A progress row of the follow-up stage could not be emitted; the stage continues.';

/** Which progress row a {@link PROGRESS_FAILED_LOG} record is about. */
type ProgressRowKind = 'started' | 'completed' | 'failed';

/** The most validation issues an internal-validation error lists (paths and codes only). */
const MAX_REPORTED_ISSUES = 20;

/* -------------------------------------------------------------------------------------------------
 * Failures this stage raises itself — codes, enumerated reasons, counts and product-minted ids only
 * ---------------------------------------------------------------------------------------------- */

/** The run was abandoned through the context's signal. */
function cancelledError(stage: ProgressStage): DebuggenError {
  return new DebuggenError('INTERNAL', 'The follow-up was cancelled before it finished.', {
    hint: 'Nothing further was changed by the cancelled run. Ask the follow-up again when ready.',
    details: { stage, reason: 'aborted' },
  });
}

/** The stage was configured with a repair budget the structured-output loop does not accept. */
function repairBudgetError(value: number): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The follow-up stage was configured with a repair budget outside 0 to ${String(DEFAULT_MAX_REPAIRS)}, so no request was sent.`,
    {
      hint: 'Construct the stage without maxRepairs to use the default budget, or pass an integer within the permitted range.',
      details: {
        stage: FOLLOW_UP_STAGE,
        reason: 'repair-budget',
        maxRepairs: Number.isFinite(value) ? value : String(value),
      },
    },
  );
}

/** A follow-up without a question to answer. */
function missingQuestionError(): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'A follow-up was requested without a question to answer.',
    {
      hint: 'Type the follow-up question and ask again.',
      details: { stage: FOLLOW_UP_STAGE, reason: 'missing-follow-up-question' },
    },
  );
}

/** A precondition artifact the follow-up is decided against does not exist. */
function missingArtifactError(
  reason: 'no-plan' | 'no-analysis' | 'no-panel' | 'no-understanding',
): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'A follow-up can only be answered for a session that has been instrumented, captured, analysed and shown a panel.',
    {
      hint: 'Capture the issue and let the session generate its panel before asking a follow-up.',
      details: { stage: FOLLOW_UP_STAGE, reason },
    },
  );
}

/** The store's history answers disagree about which analysis or panel is the latest. */
function historyInconsistentError(): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The session store answered inconsistently about the latest analysis and panel, so the follow-up was not decided.',
    {
      hint: 'Ask the follow-up again once the session is no longer changing.',
      details: { stage: FOLLOW_UP_STAGE, reason: 'history-inconsistent' },
    },
  );
}

/** The plan ladder moved between reading the installed version and numbering the next one. */
function planLadderMovedError(previousPlanVersion: number, nextPlanVersion: number): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    "The session's plan ladder changed while the follow-up was being planned, so nothing was installed.",
    {
      hint: 'Ask the follow-up again; it builds on the latest installed plan version.',
      details: {
        stage: PLAN_STAGE,
        reason: 'plan-ladder-moved',
        previousPlanVersion,
        nextPlanVersion,
      },
    },
  );
}

/** Normalisation changed an installed action or produced an addition with an installed id. */
function installedActionAlteredError(index: number, planVersion: number): DebuggenError {
  return new DebuggenError(
    'PLAN_INVALID',
    'The follow-up plan version would have altered an action that is already installed, so nothing was installed.',
    {
      hint: 'This is a defect in plan normalisation or adapter resolution rather than in the follow-up, so it was not re-prompted; report the logged action index.',
      details: { stage: PLAN_STAGE, reason: 'installed-action-altered', index, planVersion },
    },
  );
}

/** Every addition the delta asked for was refused by the feasibility gate. */
function deltaInfeasibleError(
  feasibility: FeasibilityReport,
  deltaIds: ReadonlySet<string>,
): DebuggenError {
  const refused = feasibility.rejected.filter((refusal) => deltaIds.has(refusal.action.id));
  const hint = refused[0]?.hint;
  return new DebuggenError(
    'INSTRUMENTATION_UNAVAILABLE',
    'None of the additional instrumentation the follow-up needs can be installed on this project, so no new capture was requested.',
    {
      ...(hint !== undefined ? { hint } : {}),
      details: {
        stage: PLAN_STAGE,
        reason: 'delta-infeasible',
        rejected: refused.length,
        codes: [...new Set(refused.map((refusal) => refusal.code))].sort(),
      },
    },
  );
}

/** A regenerated analysis did not append to the ladder as a new version superseding the previous one. */
function analysisLadderError(): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The regenerated analysis was not stored as the next version superseding the previous analysis.',
    {
      hint: 'Ask the follow-up again once the session is no longer changing.',
      details: { stage: ANALYZE_STAGE, reason: 'analysis-ladder-inconsistent' },
    },
  );
}

/**
 * The panel the follow-up was decided against is no longer the session's
 * latest panel — the shape of the panel subsystem's own stale-predecessor
 * refusal: `SESSION_INVALID_STATE`, the `generate-panel` stage and
 * `reason: 'supersedes-stale'`, with the version of the panel the session holds
 * now when there is one.
 */
function panelPredecessorMovedError(latestPanelVersion: number | undefined): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'The panel this follow-up was decided against is no longer the latest panel of the session, so nothing was regenerated.',
    {
      hint: "The session's panel changed while this answer was being prepared. Ask the follow-up again; it is then decided against the panel the session now holds.",
      details: {
        stage: GENERATE_PANEL_STAGE,
        reason: 'supersedes-stale',
        ...(latestPanelVersion === undefined ? {} : { latestPanelVersion }),
      },
    },
  );
}

/**
 * A regenerated panel does not supersede the panel the follow-up was decided
 * against. Carries both versions — never an id or any content — so the broken
 * rung can be located.
 */
function panelLadderError(panelVersion: number, previousPanelVersion: number): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The regenerated panel was not stored as the next version superseding the panel the follow-up was decided against.',
    {
      hint: 'Ask the follow-up again once the session is no longer changing.',
      details: {
        stage: GENERATE_PANEL_STAGE,
        reason: 'panel-ladder-inconsistent',
        panelVersion,
        previousPanelVersion,
      },
    },
  );
}

/**
 * The instrumentation service reported a different active plan version than
 * the one installed. The delta is compensated before this error is returned,
 * so its hint is the one shown when that compensation left the project intact
 * — product text, registered as it is built so a failed row may show it
 * ({@link compensatedHint}).
 */
function activeVersionMismatchError(planVersion: number, activePlanVersion: number): DebuggenError {
  return new DebuggenError(
    'INSTRUMENTATION_INSTALL_FAILED',
    'The follow-up delta install did not leave the new plan version active, so it was not recorded.',
    {
      hint: authorProductText(
        'Ask the follow-up again to install its instrumentation afresh; if the service keeps reporting another active plan version, restart the Debug Generator service first.',
      ),
      details: {
        stage: INSTRUMENT_STAGE,
        reason: 'active-version-mismatch',
        planVersion,
        activePlanVersion,
      },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** An enumerated reason: a short kebab-case identifier, the only `details.reason` shape logged. */
const REASON_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

/** The enumerated `details.reason` of an error, when it carries one. */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && REASON_PATTERN.test(reason) ? reason : undefined;
}

/**
 * Whether the run's signal has fired. A function rather than an inline test so
 * each check reads the signal afresh after an `await`.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Whether a repair budget is one `generateStructuredWithRepair` accepts. */
function isValidRepairBudget(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= DEFAULT_MAX_REPAIRS;
}

/**
 * The same error, re-issued with extra `details` merged over its own. Code,
 * message and hint are preserved verbatim — the failing subsystem's sentence is
 * the developer's sentence — and the original is kept as the cause.
 */
function annotate(error: DebuggenError, extra: Readonly<Record<string, unknown>>): DebuggenError {
  const alreadyCarried = Object.entries(extra).every(
    ([key, value]) => error.details?.[key] === value,
  );
  if (alreadyCarried) {
    return error;
  }
  return new DebuggenError(error.code, error.message, {
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    details: { ...(error.details ?? {}), ...extra },
    cause: error,
  });
}

/** The {@link SessionFailure} a `failed` progress row is built from. */
function sessionFailureOf(error: DebuggenError, stage: ProgressStage): SessionFailure {
  return error.hint === undefined
    ? { stage, code: error.code, message: error.message }
    : { stage, code: error.code, message: error.message, hint: error.hint };
}

/**
 * The decision gate's failure as this stage reports it:
 *
 * - A transport failure (`details.reason === 'provider'` with
 *   `MODEL_UNAVAILABLE`) that was not a cancellation carries AAP §0.5.5's
 *   sentence, built by `modelUnavailableMessage` — its one definition.
 * - An output that never satisfied the decision schema keeps its code, message
 *   and details, and its hint states the recovery that exists here
 *   ({@link DECISION_REJECTION_HINT}) instead of a substitute artifact that
 *   does not.
 * - Everything else is passed through unchanged.
 */
function shapeDecisionFailure(
  error: DebuggenError,
  signal: AbortSignal | undefined,
): DebuggenError {
  const reason = reasonOf(error);
  if (reason === 'provider') {
    if (error.code !== 'MODEL_UNAVAILABLE' || isAborted(signal)) {
      return error;
    }
    const message = modelUnavailableMessage(error.code);
    if (error.message === message) {
      return error;
    }
    return new DebuggenError(error.code, message, {
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
      cause: error,
    });
  }
  if (reason === 'schema' && error.code === 'MODEL_OUTPUT_INVALID') {
    return new DebuggenError(error.code, error.message, {
      hint: DECISION_REJECTION_HINT,
      ...(error.details !== undefined ? { details: error.details } : {}),
      cause: error,
    });
  }
  return error;
}

/** A synchronous collaborator's `Result`; a throw becomes an `Err` with `code`. */
function callSync<T>(
  call: () => Result<T, DebuggenError>,
  code: DebuggenErrorCode,
): Result<T, DebuggenError> {
  const outer = tryCatch(call, code);
  return outer.ok ? outer.value : outer;
}

/** Awaits a collaborator's `Result`; a rejected promise or a throw becomes an `Err` with `code`. */
async function settle<T>(
  call: () => Promise<Result<T, DebuggenError>>,
  code: DebuggenErrorCode,
): Promise<Result<T, DebuggenError>> {
  try {
    return await call();
  } catch (thrown) {
    return err(DebuggenError.from(thrown, code));
  }
}

/** Orders strings by UTF-16 code unit: locale-free, so log fields are byte-stable. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** Action counts keyed `type/mode`, keys sorted — the only shape of a plan this module logs. */
function countsByTypeAndMode(actions: readonly InstrumentationAction[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const action of actions) {
    const key = `${action.type}/${action.mode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted: Record<string, number> = {};
  for (const key of [...counts.keys()].sort(compareCodeUnits)) {
    sorted[key] = counts.get(key) ?? 0;
  }
  return sorted;
}

/** Rejection counts keyed by reason code, in vocabulary order — how a delta's refusals are logged. */
function countsByReason(rejected: readonly FollowUpDeltaRejection[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of FOLLOW_UP_DELTA_REJECTION_REASONS) {
    const count = rejected.filter((rejection) => rejection.reason === reason).length;
    if (count > 0) {
      counts[reason] = count;
    }
  }
  return counts;
}

/** The issue paths and codes of a failed schema parse — never the rejected values (AAP §0.5.2). */
function describeIssues(
  issues: readonly { readonly code: string; readonly path: readonly PropertyKey[] }[],
): string[] {
  return issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map(
      (issue) =>
        `${issue.path.map((segment) => String(segment)).join('.') || '(root)'}: ${issue.code}`,
    );
}

/** The code-analysis handles in the shape the instrumentation service names them. */
function codeHandlesOf(context: PipelineStageContext): CodeAnalysisHandles {
  const { graph, queries, routeMap, projectSummary, loaded } = context.code;
  return { graph, queries, routeMap, summary: projectSummary, project: loaded };
}

/**
 * The resolver normalisation and feasibility are given: the live registry,
 * bound to this project's adapter context, so both — and the installer — agree
 * on one adapter and mode per action type (AAP §0.4.2). A registry that throws
 * is treated as claiming nothing rather than taking the stage down.
 */
function contextBoundResolver(
  registry: AdapterRegistry,
  context: InstrumentationContext,
): PlanAdapterResolver {
  return Object.freeze({
    resolveActionType: (type: InstrumentationActionType) => {
      try {
        return registry.resolveActionType(type, context);
      } catch {
        return undefined;
      }
    },
  });
}

/** Reads a clock, answering `undefined` for a clock that throws or is not finite. */
function readClock(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The `durationMs` log field of a run, when both clock readings are usable. */
function durationFields(now: () => number, startedAt: number | undefined): LogFields {
  if (startedAt === undefined) {
    return {};
  }
  const endedAt = readClock(now);
  return endedAt === undefined ? {} : { durationMs: Math.max(0, Math.round(endedAt - startedAt)) };
}

/**
 * Ends a message the way a sentence appended after it needs: trimmed, with a
 * full stop when it had no terminal punctuation.
 */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/* -------------------------------------------------------------------------------------------------
 * Delta compensation — undoing an installed delta that cannot be kept (AAP §0.4.2, Follow-up row)
 *
 * The installer reverse-restores a delta that fails inside its own call. What it cannot see is a
 * failure after it returned with the delta on disk, and its own unwind can leave records open, so
 * this stage compensates both: the journal records of plan version n + 1 are restored newest first,
 * the arming state is returned to n, and the records' final states are mirrored onto the session
 * record. Everything here reports ids, counts and codes — never a path, a digest, a diff or file
 * content.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which post-install failure a compensation answers:
 *
 * - `install-failed` — the install returned `Err` without saying it unwound
 *   the call itself: the service's "installed, but reporting it failed", a
 *   readiness evaluation that failed after the apply, or an error naming no
 *   active version at all (an unexpected throw).
 * - `install-unwind-incomplete` — the install returned `Err` naming version n
 *   active, but the journal still holds a record of n + 1 that is open (or
 *   could not be read to prove otherwise): the installer's own rollback left a
 *   conflict, a failure or an unread journal behind. The service stamps n on
 *   every failed install, so the stamp alone proves nothing.
 * - `active-version-mismatch` — the install returned `Ok` but left another
 *   plan version active.
 * - `plan-unrecorded` — the install succeeded, recording plan version n + 1
 *   failed, and the ladder is — or may still be — at version n, or holds n + 1
 *   without the session record accounting for it.
 */
type DeltaRollbackTrigger =
  'install-failed' | 'install-unwind-incomplete' | 'active-version-mismatch' | 'plan-unrecorded';

/** The journal status of a record there is nothing left to undo for. */
const REVERTED_STATUS = 'reverted' as const satisfies ModificationStatus;

/** The journal status of a record whose file no longer holds this product's bytes. */
const CONFLICT_STATUS = 'conflict' as const satisfies ModificationStatus;

/**
 * The statuses of a plan version n + 1 record a compensation has to account
 * for — every status but `reverted`, which is already undone:
 *
 * - `pending`, `applied` and `failed` are reverse-restored, each settled by the
 *   reconciliation table `restoreModification` applies (AAP §0.5.1);
 * - `conflict` is reported as a conflict and never handed to a restore: the
 *   file is no longer what this product wrote, closing the conflict is the
 *   developer's decision, and cleanup re-reports it. Its presence means the
 *   delta is **not** undone, so it can never be counted as a clean rollback.
 */
const OPEN_DELTA_STATUSES: ReadonlySet<ModificationStatus> = new Set<ModificationStatus>([
  'pending',
  'applied',
  'failed',
  CONFLICT_STATUS,
]);

/** The error detail naming the plan version the session is left at; claimed only when proven. */
const ACTIVE_PLAN_VERSION_KEY = 'activePlanVersion';

/** The code a compensation's mirror reports when the session record it would patch is gone. */
const SESSION_NOT_FOUND_CODE = 'SESSION_NOT_FOUND' as const satisfies DebuggenErrorCode;

/** The most record ids one list of a compensation report carries; the counts are always complete. */
const MAX_REPORTED_RECORDS = 20;

/**
 * The hint of a compensated failure that left nothing behind, when the original
 * error had none — or had one describing what an unwind left, which the
 * compensation has since undone.
 */
const DELTA_REASK_HINT =
  'Nothing from this follow-up remains in the project; ask the follow-up again to install its instrumentation afresh.';

/** A record a compensation could not restore, with the code of the error that stopped it. */
interface DeltaRollbackFailure {
  readonly recordId: string;
  readonly code: DebuggenErrorCode;
}

/** What reverse-restoring the file modifications of plan version n + 1 did. */
interface DeltaFilesReport {
  /** How many records of plan version n + 1 were open: to be reversed, or found in conflict. */
  readonly attempted: number;
  /** The records restored — or found already holding their original and closed. */
  readonly restored: readonly string[];
  /**
   * The records whose files no longer held this product's bytes — found so by
   * a restore, or already in `conflict` — left exactly as they stand.
   */
  readonly conflicts: readonly string[];
  /** The records after a conflict or a failure in the same file's chain: not attempted. */
  readonly skipped: readonly string[];
  /** The records a restore could not finish. */
  readonly failures: readonly DeltaRollbackFailure[];
  /**
   * `listed` when the journal answered and the set is the records of plan
   * version n + 1 it holds; `unreadable` when it did not, and the set fell back
   * to the records the install reported.
   */
  readonly journal: 'listed' | 'unreadable';
  /** The code of the error that kept the journal from answering. */
  readonly journalCode?: DebuggenErrorCode | undefined;
  /**
   * The last known state of every plan version n + 1 record — the journal
   * listed again after the restores, or, when it cannot be, what the restores
   * returned over what was listed before. What the session record is patched
   * with; never logged and never placed in an error.
   */
  readonly records: readonly ModificationRecord[];
}

/** What one compensation did: the file restores, the trigger, the arming state and the mirror. */
interface DeltaRollbackReport extends DeltaFilesReport {
  readonly trigger: DeltaRollbackTrigger;
  /** Whether `restoreArming` returned the service's arming state to plan version n. */
  readonly arming: 'restored' | 'failed';
  /** The code of the error that kept the arming state from being restored. */
  readonly armingCode?: DebuggenErrorCode | undefined;
  /**
   * Whether the records' final states reached `SessionRecord.modifications`;
   * absent when no record was open, so there was nothing to mirror. A mirror
   * that fails never changes the failure's code.
   */
  readonly mirrored?: boolean | undefined;
}

/**
 * The session's journal as one compensation reads it: a restore context built
 * for plan version n + 1 without the run's signal, and the listing through it.
 * Opened once, so the check of an installer's unwind and the compensation it
 * may lead to read the same listing.
 */
interface DeltaJournal {
  /** The restore context, or the error that kept it from being built. */
  readonly context: Result<InstrumentationContext, DebuggenError>;
  /** The session's records as the journal listed them, or why it could not. */
  readonly listed: Result<readonly ModificationRecord[], DebuggenError>;
}

/** How one compensation is carried out and worded, beyond its trigger and its failure. */
interface CompensationOptions {
  /** The journal as the caller already opened it for this compensation; absent, it is opened afresh. */
  readonly journal?: DeltaJournal | undefined;
  /** The recovery when nothing is left behind; absent, the original error's own — or the re-ask. */
  readonly settledHint?: string | undefined;
  /** A condition the compensation cannot change; it leads whatever recovery the hint names. */
  readonly standingHint?: string | undefined;
}

/**
 * The records of plan version n + 1 a compensation has to account for: the
 * session's own, at that version, in an {@link OPEN_DELTA_STATUSES} status.
 */
function openDeltaRecords(
  records: readonly ModificationRecord[],
  sessionId: string,
  planVersion: number,
): ModificationRecord[] {
  return records.filter(
    (record) =>
      record.sessionId === sessionId &&
      record.planVersion === planVersion &&
      OPEN_DELTA_STATUSES.has(record.status),
  );
}

/**
 * The session record's modifications with `settled` upserted by id: a record
 * already listed is replaced in place, a new one appended, in order — the
 * merge the orchestrator applies to an install's records, so both user
 * interfaces keep one row per record.
 */
function mergeModificationRecords(
  current: readonly ModificationRecord[],
  settled: readonly ModificationRecord[],
): ModificationRecord[] {
  const byId = new Map(settled.map((record) => [record.id, record]));
  const merged = current.map((record) => byId.get(record.id) ?? record);
  const known = new Set(current.map((record) => record.id));
  for (const record of settled) {
    if (!known.has(record.id)) {
      merged.push(record);
      known.add(record.id);
    }
  }
  return merged;
}

/**
 * Whether every file modification of plan version n + 1 is undone: the
 * journal answered, and nothing conflicted, failed or was skipped.
 */
function isFilesIntact(report: DeltaFilesReport): boolean {
  return (
    report.journal === 'listed' &&
    report.conflicts.length === 0 &&
    report.skipped.length === 0 &&
    report.failures.length === 0
  );
}

/** Whether a compensation left the session exactly at plan version n: its files and its arming. */
function isRollbackIntact(report: DeltaRollbackReport): boolean {
  return isFilesIntact(report) && report.arming === 'restored';
}

/**
 * The sentence — two when the arming state could not be restored — appended to
 * a compensated failure's message, stating what the project now holds.
 *
 * @example
 * `All 2 file modification(s) of plan version 3 were restored, so the project
 * holds exactly what plan version 2 installed.`
 */
function describeDeltaRollback(
  report: DeltaRollbackReport,
  planVersion: number,
  previousPlanVersion: number,
): string {
  const next = String(planVersion);
  const previous = String(previousPlanVersion);
  const restored = String(report.restored.length);
  const attempted = String(report.attempted);
  const leftAsTheyStand = String(report.conflicts.length + report.skipped.length);
  const failed = String(report.failures.length);
  let files: string;
  if (report.journal === 'unreadable') {
    files =
      report.attempted === 0
        ? `The modification journal could not be read, so no file modification of plan version ${next} could be looked up or restored.`
        : `The modification journal could not be read; of the ${attempted} file modification(s) of plan version ${next} the install reported, ${restored} were restored, ${leftAsTheyStand} were left exactly as they stand and ${failed} could not be restored.`;
  } else if (isFilesIntact(report)) {
    files =
      report.attempted === 0
        ? `No file modification of plan version ${next} remained in the project, so it holds exactly what plan version ${previous} installed.`
        : `All ${attempted} file modification(s) of plan version ${next} were restored, so the project holds exactly what plan version ${previous} installed.`;
  } else {
    files = `${restored} of ${attempted} file modification(s) of plan version ${next} were restored; ${leftAsTheyStand} were left exactly as they stand and ${failed} could not be restored.`;
  }
  return report.arming === 'restored'
    ? files
    : `${files} The capture configuration could not be returned to plan version ${previous}.`;
}

/**
 * The recovery a compensated failure's hint names, after the statement of
 * what the project holds ({@link compensatedHint}): `settledHint` when the
 * compensation left nothing behind — normally the original error's own, which
 * names the recovery for the cause — and otherwise the recovery for what was
 * left: an unreadable journal, files left as they stand (a conflict among them), or
 * arming state still at the new version. A `standingHint` — a condition the
 * compensation cannot change, such as a plan row the session record does not
 * account for — leads that recovery, so it is never lost behind it.
 */
function deltaRollbackHint(
  report: DeltaRollbackReport,
  previousPlanVersion: number,
  settledHint: string,
  standingHint?: string,
): string {
  let recovery: string;
  if (report.journal === 'unreadable') {
    recovery =
      'The modification journal did not answer, so this follow-up’s instrumentation could not be confirmed restored: check the session store, then end the session to restore every file it instrumented.';
  } else if (!isFilesIntact(report)) {
    recovery =
      report.conflicts.length > 0
        ? 'Nothing was overwritten: a file edited after it was instrumented is reported as a conflict and keeps its original bytes in this session’s backup directory, as does every other file left as it stands. Review the session’s modifications, then end the session to restore what remains.'
        : 'Nothing was overwritten: every file left as it stands keeps its original bytes in this session’s backup directory. Review the session’s modifications, then end the session to restore what remains.';
  } else if (report.arming !== 'restored') {
    recovery = `Restart the Debug Generator service before capturing again, so the next capture arms only what plan version ${String(previousPlanVersion)} installed.`;
  } else {
    return settledHint;
  }
  return standingHint === undefined ? recovery : `${asSentence(standingHint)} ${recovery}`;
}

/** The hint a compensation that left nothing behind carries: `hint` when it has text, else the re-ask. */
function settledHintOf(hint: string | undefined): string {
  return hint !== undefined && hint.trim().length > 0 ? hint : DELTA_REASK_HINT;
}

/**
 * Whether the recovery {@link deltaRollbackHint} chose for `report` is text the
 * product wrote.
 *
 * A compensation that left something behind names one of its own recovery
 * templates — proven, unless a `standingHint` no product builder registered
 * leads it. One that left nothing names `settledHint`: the re-ask
 * ({@link DELTA_REASK_HINT}) is the product's, and a hint carried over from
 * the original failure is proven only when `isProductAuthoredText` recognises
 * it — an adapter's, a dependency's or a thrown exception's words never are.
 *
 * @param report The compensation's report.
 * @param settledHint The recovery of a compensation that left nothing behind.
 * @param standingHint The condition that leads any other recovery, if any.
 * @returns `true` when the recovery may be shown as the product's own.
 */
function isRecoveryProven(
  report: DeltaRollbackReport,
  settledHint: string,
  standingHint: string | undefined,
): boolean {
  if (isRollbackIntact(report)) {
    return settledHint === DELTA_REASK_HINT || isProductAuthoredText(settledHint);
  }
  return standingHint === undefined || isProductAuthoredText(standingHint);
}

/**
 * The hint a compensated failure carries: the statement of what the project
 * now holds ({@link describeDeltaRollback}), then the recovery
 * ({@link deltaRollbackHint}).
 *
 * The run's `failed` progress row never shows a failure's message, and shows
 * its hint only when that hint is proven product text
 * (`../../sessions/progress.ts`, CWE-209), so this hint is where the developer
 * reads what the compensation left. The statement is composed from the
 * product's templates, plan versions and counts. A recovery that is not
 * proven ({@link isRecoveryProven}) is replaced by the fixed hint of the
 * failure's code — the words the row would have shown in its place — so what
 * the hint says is wholly the product's and is registered with
 * `authorProductText` as it is built. The original failure, with its own
 * hint, stays the compensated error's `cause`.
 *
 * @param description What the project now holds.
 * @param recovery The recovery for the cause, or for what was left behind.
 * @param proven Whether `recovery` is product text.
 * @param code The failure's code, whose fixed hint stands in for an unproven recovery.
 * @returns The registered hint.
 *
 * @example
 * `All 1 file modification(s) of plan version 3 were restored, so the project
 * holds exactly what plan version 2 installed. Check the free space and
 * permissions of DEBUGGEN_HOME, then retry.`
 */
function compensatedHint(
  description: string,
  recovery: string,
  proven: boolean,
  code: DebuggenErrorCode,
): string {
  const fixed = Object.hasOwn(FAILURE_COPY_BY_CODE, code)
    ? FAILURE_COPY_BY_CODE[code].hint
    : FAILURE_COPY_BY_CODE.INTERNAL.hint;
  return authorProductText(`${description} ${proven ? recovery : fixed}`);
}

/** A compensation report as `details.deltaRollback` and its log record carry it: ids capped, counts complete. */
function deltaRollbackDetails(report: DeltaRollbackReport): Record<string, unknown> {
  return {
    trigger: report.trigger,
    attempted: report.attempted,
    restored: report.restored.length,
    conflicts: report.conflicts.slice(0, MAX_REPORTED_RECORDS),
    conflictCount: report.conflicts.length,
    skipped: report.skipped.slice(0, MAX_REPORTED_RECORDS),
    skippedCount: report.skipped.length,
    failures: report.failures.slice(0, MAX_REPORTED_RECORDS).map((failure) => ({ ...failure })),
    failureCount: report.failures.length,
    journal: report.journal,
    ...(report.journalCode !== undefined ? { journalCode: report.journalCode } : {}),
    arming: report.arming,
    ...(report.armingCode !== undefined ? { armingCode: report.armingCode } : {}),
    ...(report.mirrored !== undefined ? { mirrored: report.mirrored } : {}),
  };
}

/**
 * The error detail values a compensated failure carries over from the
 * original: everything but its claim about the active plan version, which the
 * compensation re-derives — `n` only once it proved the session stands there.
 */
function carriedDetails(error: DebuggenError): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(error.details ?? {}).filter(([key]) => key !== ACTIVE_PLAN_VERSION_KEY),
  );
}

/**
 * The records of a delta grouped by file, the files ordered **latest-touched
 * first** — by their newest `appliedAt`, then by file descending so the order
 * never depends on the journal's — exactly as `cleanupSession` takes them. The
 * order within one file is `orderRestorationChain`'s, applied by the caller.
 */
function groupByFileLatestFirst(records: readonly ModificationRecord[]): ModificationRecord[][] {
  const byFile = new Map<string, ModificationRecord[]>();
  for (const record of records) {
    const group = byFile.get(record.file);
    if (group === undefined) {
      byFile.set(record.file, [record]);
    } else {
      group.push(record);
    }
  }
  const newest = (group: readonly ModificationRecord[]): number =>
    group.reduce((latest, record) => Math.max(latest, record.appliedAt), 0);
  return [...byFile.entries()]
    .sort(
      ([leftFile, left], [rightFile, right]) =>
        newest(right) - newest(left) || compareCodeUnits(rightFile, leftFile),
    )
    .map(([, group]) => group);
}

/**
 * Lists one session's journal through a restore context. A throw, a rejection
 * or an answer that is not a `Result` of a list becomes an `Err`, so a journal
 * that breaks its contract costs the compensation its listing and nothing else.
 */
async function listSessionJournal(
  context: InstrumentationContext,
  sessionId: string,
): Promise<Result<readonly ModificationRecord[], DebuggenError>> {
  let answered: unknown;
  try {
    answered = await context.journal.listBySession(sessionId);
  } catch (thrown) {
    return err(DebuggenError.from(thrown, 'STORE_ERROR'));
  }
  if (typeof answered === 'object' && answered !== null && 'ok' in answered) {
    if (answered.ok === true && 'value' in answered && Array.isArray(answered.value)) {
      return ok(answered.value as readonly ModificationRecord[]);
    }
    if (answered.ok === false && 'error' in answered) {
      return err(DebuggenError.from(answered.error, 'STORE_ERROR'));
    }
  }
  return err(
    new DebuggenError(
      'STORE_ERROR',
      'The modification journal answered a listing with something other than a list of records.',
      { details: { reason: 'journal-listing-invalid' } },
    ),
  );
}

/**
 * Why a plan row found at version n + 1 after a failed `recordPlan` could not
 * be kept — the `details.planCheck` and log field of that failure:
 *
 * - `plan-unreadable` — the stored plan could not be read back;
 * - `plan-missing` — the ladder named n + 1 but the row was gone on reading;
 * - `plan-differs` — the stored plan is not this run's: another version or
 *   other actions;
 * - `record-unreadable` — the session record could not be read;
 * - `record-lacks-plan` — the session record's `plans` do not hold n + 1, so
 *   the capture stage would arm version n while the ladder says n + 1.
 */
type PlanCheck =
  'plan-unreadable' | 'plan-missing' | 'plan-differs' | 'record-unreadable' | 'record-lacks-plan';

/**
 * Whether a stored plan version is the one this run recorded: the same
 * version, and the same actions by id in the same order — the identity every
 * later delta and every modification chain is computed against.
 */
function isSamePlanVersion(stored: InstrumentationPlan, expected: InstrumentationPlan): boolean {
  const storedActions = stored.instrumentationTargets;
  const expectedActions = expected.instrumentationTargets;
  return (
    stored.planVersion === expected.planVersion &&
    storedActions.length === expectedActions.length &&
    storedActions.every((action, index) => action.id === expectedActions[index]?.id)
  );
}

/**
 * The error of a plan row stored at version n + 1 that the session record does
 * not account for (or that could not be confirmed as this run's), before the
 * compensation appends what it left in the project. `recordPlan` writes both
 * in one transaction, so this is a store that no longer agrees with itself:
 * the files and the arming state are returned to version n, which is what
 * the record — the capture stage's source — holds, and the hint names the plan
 * row that remains. The hint is product text composed from the two versions,
 * registered as it is built so a failed row may show it ({@link compensatedHint}).
 */
function planSplitError(
  error: DebuggenError,
  planVersion: number,
  previousPlanVersion: number,
  check: PlanCheck,
): DebuggenError {
  const version = String(planVersion);
  return new DebuggenError(
    error.code,
    `${asSentence(error.message)} Plan version ${version} was stored, but the session record does not account for it.`,
    {
      hint: authorProductText(
        `The session store holds plan version ${version} although the session record stands at plan version ${String(previousPlanVersion)}, so a later follow-up in this session would build on instrumentation that is no longer installed: end this session to restore every file it instrumented, then start a new one.`,
      ),
      details: {
        ...(error.details ?? {}),
        planVersion,
        planStored: true,
        recordMirrored: false,
        planCheck: check,
      },
      cause: error,
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------------------------------- */

/** The install mode that edits a developer's file (AAP §0.5.1); only its files can carry a chain. */
const PATCH_MODE = 'patch' as const satisfies (typeof INSTRUMENTATION_MODES)[number];

/** The stored artifacts a follow-up is decided against, loaded through the repositories. */
interface StoredArtifacts {
  /** The installed plan version: the latest on the session's plan ladder. */
  readonly plan: InstrumentationPlan;
  /** The latest stored analysis. */
  readonly analysis: AnalysisResult;
  /** The latest stored panel. */
  readonly panel: PanelSpec;
  /** The summary of the capture the latest analysis was drawn from. */
  readonly summary: CaptureSummary;
  /** The session's stored understanding, when it has one. */
  readonly understanding: ProblemUnderstanding | undefined;
  /** The bounded previous-version context from the summarizer. */
  readonly history: AnalysisFollowUpContext;
}

/** A validated decision, the additive-only verdict on it and the path it takes. */
interface DecidedFollowUp {
  readonly delta: FollowUpActionDelta;
  readonly path: FollowUpPath;
  readonly summary: FollowUpDecisionSummary;
  readonly build: StageRequestBuild;
}

/** Plan version n + 1 after the deterministic gate, not yet installed or recorded. */
interface GatedPlan {
  readonly plan: InstrumentationPlan;
  readonly delta: readonly InstrumentationAction[];
  readonly feasibility: FeasibilityReport;
  /** How many of the delta's actions the feasibility gate refused (reported, then installed as validated). */
  readonly refusedDelta: number;
  readonly chainedFiles: number;
}

/**
 * The progress group a run currently reports under: the stage a failure is
 * filed under, and whether this stage opened that group (and so owes it a
 * `failed` row) or another module owns its rows.
 */
interface RunState {
  stage: ProgressStage;
  open: boolean;
}

/** The session record a run last stored, with whether the outcome links were stamped. */
interface OutcomeRecord {
  readonly session: SessionRecord;
  readonly recorded: boolean;
}

/**
 * Creates the follow-up stage (AAP §0.4.2 Follow-up row; §0.5.1, §0.5.3,
 * §0.5.4, §0.5.5).
 *
 * One run, in order:
 *
 * 1. The repair budget, the cancellation signal and the question are checked;
 *    then the `followup` group header.
 * 2. The stored artifacts are loaded — the installed plan (`latestPlanVersion`
 *    → `getPlan`), the latest analysis and panel, the summarizer's follow-up
 *    context (whose ids must agree with them) and the summary of the capture
 *    the analysis was drawn from — and the question is recorded with
 *    `SessionManager.appendFollowUp` under the input's `attemptId`: appended
 *    as a new follow-up, or recorded in place of the failed attempt it
 *    retries.
 * 3. `ContextBuilder.buildFollowUpRequest` with the prompt's seven
 *    placeholders and the session's recorded prompt version; a builder `Err`
 *    (the outbound guard, a prompt that cannot load) means the provider is
 *    never called.
 * 4. `generateStructuredWithRepair` against {@link followUpDecisionSchema},
 *    exactly once; then {@link diffAdditionalActions} and
 *    {@link followUpPathFor}. The `followup` group closes.
 * 5. **Existing evidence**: the `onPathChosen` seam; one indexed read of the
 *    session's latest panel (`PanelsRepo.getLatestPanel`), which must still be
 *    the panel the follow-up was decided against — otherwise the run fails in
 *    the `generate-panel` group as `supersedes-stale` and nothing is
 *    regenerated; the analysis port with `regenerate: true` and the previous
 *    analysis as `supersedes`, checked against the analysis ladder with two
 *    indexed single-row reads — the superseded analysis by id
 *    (`PanelsRepo.getAnalysis`) must be unchanged and the session's newest
 *    (`getLatestAnalysis`) must be the new one; the `generate-panel` group
 *    around the panel port's `regenerate` with the previous panel as
 *    `expectedPredecessor`, whose answer must supersede exactly that panel.
 * 6. **New capture**: the `plan` group around `nextPlanVersion`, the adapter
 *    context, {@link buildFollowUpPlanInput}, `normalizePlan` with the previous
 *    actions, `instrumentationPlanSchema`, the installed-action check,
 *    `checkPlanFeasibility` and the chain-head read; then the `onPathChosen`
 *    and `beforeInstall` seams, the delta install, and — only once it has
 *    succeeded — `SessionManager.recordPlan`, which stores the plan row and
 *    the session record together. A failure after the delta is on disk is
 *    compensated before the run fails: an install `Err` that does not name
 *    the previous version as active; one that does while the journal — listed
 *    read-only to check the claim — still holds an open record of n + 1; an
 *    `Ok` that leaves another version active; and a `recordPlan` failure
 *    unless the ladder, the stored plan and the session record all hold this
 *    run's n + 1 (then the run rolls forward). Each compensation walks plan
 *    version n + 1's open records newest first — `orderRestorationChain` per
 *    file, files latest-touched first, `restoreModification` per record, a
 *    record already in `conflict` stopping its file untouched — then puts
 *    `restoreArming` back to plan version n and patches the records' final
 *    states onto `SessionRecord.modifications`.
 * 7. The outcome links through `SessionManager.recordFollowUpOutcome`.
 *
 * The factory holds no state beyond its collaborators; one instance serves
 * every session of the process.
 *
 * @param deps The collaborators and options; see {@link FollowUpStageDeps}.
 * @returns The stage.
 *
 * @example
 * ```ts
 * const followUp = createFollowUpStage({
 *   contextBuilder, provider, summarizer, analysisRegeneration: analyzeStage,
 *   panelRegeneration: panelGenerator, instrumentation, registry, sessions, panels,
 *   modifications, sessionManager, progress, logger,
 * });
 * const outcome = await followUp.run(context, {
 *   followUpQuestion,
 *   attemptId,
 *   onPathChosen: (path) =>
 *     manager.transitionTo(sessionId, path === 'new-capture' ? 'planning' : 'analyzing'),
 *   beforeInstall: () => manager.transitionTo(sessionId, 'instrumenting'),
 * });
 * ```
 */
export function createFollowUpStage(deps: FollowUpStageDeps): FollowUpStage {
  const maxRepairs = deps.maxRepairs ?? DEFAULT_MAX_REPAIRS;

  /** The run's logger: session-bound, then bound to the pipeline subsystem and this stage. */
  const loggerFor = (context: PipelineStageContext): Logger => {
    const base =
      deps.logger === undefined
        ? context.logger
        : sessionLogger(deps.logger, context.sessionId, context.captureId);
    return subsystemLogger(base, PIPELINE_SUBSYSTEM).child({ stage: FOLLOW_UP_STAGE });
  };

  /** Sends one progress row; a failure is logged at `warn`, without payload values, and never fails the stage. */
  const sendRow = (
    log: Logger,
    stage: ProgressStage,
    row: ProgressRowKind,
    send: () => Result<unknown, DebuggenError>,
  ): void => {
    const sent = tryCatch(send, 'INTERNAL');
    const failure = sent.ok ? (sent.value.ok ? undefined : sent.value.error) : sent.error;
    if (failure !== undefined) {
      log.warn(PROGRESS_FAILED_LOG, { stage, row, code: failure.code });
    }
  };

  /** Opens a progress group this stage owns: its header row. */
  const openGroup = (
    context: PipelineStageContext,
    log: Logger,
    state: RunState,
    stage: ProgressStage,
  ): void => {
    state.stage = stage;
    state.open = true;
    sendRow(log, stage, 'started', () => deps.progress.stageStarted(context.sessionId, stage));
  };

  /** Closes the open progress group with its `done` row. */
  const closeGroup = (context: PipelineStageContext, log: Logger, state: RunState): void => {
    if (!state.open) {
      return;
    }
    state.open = false;
    const { stage } = state;
    sendRow(log, stage, 'completed', () => deps.progress.stageCompleted(context.sessionId, stage));
  };

  /** Enters a step whose progress rows another module owns; a failure there gets no row from here. */
  const enterDelegated = (state: RunState, stage: ProgressStage): void => {
    state.stage = stage;
    state.open = false;
  };

  /**
   * The single failure path: tags the error with the stage it belongs to, logs
   * the code and enumerated reason, closes an open group with its `failed`
   * row, and returns the error. Nothing about the failed payload is logged.
   */
  const fail = (
    context: PipelineStageContext,
    log: Logger,
    state: RunState,
    error: DebuggenError,
    startedAt: number | undefined,
  ): Result<never, DebuggenError> => {
    const { stage } = state;
    const tagged = annotate(error, { stage });
    const reason = reasonOf(tagged);
    log.warn(FAILED_LOG, {
      stage,
      code: tagged.code,
      ...(reason !== undefined ? { reason } : {}),
      ...durationFields(context.now, startedAt),
    });
    if (state.open) {
      state.open = false;
      sendRow(log, stage, 'failed', () =>
        deps.progress.stageFailed(context.sessionId, sessionFailureOf(tagged, stage)),
      );
    }
    return err(tagged);
  };

  /** Runs an orchestrator seam when one was given; a throw becomes an `Err`. */
  const handOff = async (
    seam: (() => Promise<Result<unknown, DebuggenError>>) | undefined,
  ): Promise<Result<undefined, DebuggenError>> => {
    if (seam === undefined) {
      return ok(undefined);
    }
    const handed = await settle(seam, 'INTERNAL');
    return handed.ok ? ok(undefined) : handed;
  };

  /** Stamps the outcome links; a store failure is logged and reported, never raised. */
  const recordOutcome = async (
    context: PipelineStageContext,
    log: Logger,
    path: FollowUpPath,
    outcome: FollowUpOutcome,
    current: SessionRecord,
  ): Promise<OutcomeRecord> => {
    const stamped = await settle(
      () => deps.sessionManager.recordFollowUpOutcome(context.sessionId, outcome),
      'STORE_ERROR',
    );
    if (stamped.ok) {
      return { session: stamped.value, recorded: true };
    }
    log.warn(OUTCOME_UNRECORDED_LOG, { path, code: stamped.error.code });
    return { session: current, recorded: false };
  };

  /**
   * Loads what the follow-up is decided against. Every read goes through a
   * repository or the summarizer; the summarizer's previous-version ids must
   * name the same analysis and panel the repositories report as latest.
   */
  const loadArtifacts = async (
    context: PipelineStageContext,
  ): Promise<Result<StoredArtifacts, DebuggenError>> => {
    const { sessionId } = context;

    const latestVersion = callSync(() => deps.sessions.latestPlanVersion(sessionId), 'STORE_ERROR');
    if (!latestVersion.ok) {
      return latestVersion;
    }
    const installedVersion = latestVersion.value;
    if (installedVersion === undefined) {
      return err(missingArtifactError('no-plan'));
    }
    const plan = callSync(() => deps.sessions.getPlan(sessionId, installedVersion), 'STORE_ERROR');
    if (!plan.ok) {
      return plan;
    }
    if (plan.value === undefined) {
      return err(missingArtifactError('no-plan'));
    }

    const analysis = callSync(() => deps.panels.getLatestAnalysis(sessionId), 'STORE_ERROR');
    if (!analysis.ok) {
      return analysis;
    }
    if (analysis.value === undefined) {
      return err(missingArtifactError('no-analysis'));
    }
    const panel = callSync(() => deps.panels.getLatestPanel(sessionId), 'STORE_ERROR');
    if (!panel.ok) {
      return panel;
    }
    if (panel.value === undefined) {
      return err(missingArtifactError('no-panel'));
    }

    const history = await settle(
      () => deps.summarizer.buildFollowUpContext(sessionId),
      'STORE_ERROR',
    );
    if (!history.ok) {
      return history;
    }
    if (
      history.value.previousAnalysisId !== analysis.value.id ||
      history.value.previousPanelId !== panel.value.id
    ) {
      return err(historyInconsistentError());
    }

    const captureId = analysis.value.captureId;
    const summary = await settle(
      () => deps.summarizer.loadCaptureSummary(sessionId, captureId),
      'STORE_ERROR',
    );
    if (!summary.ok) {
      return summary;
    }

    return ok({
      plan: plan.value,
      analysis: analysis.value,
      panel: panel.value,
      summary: summary.value,
      understanding: context.session.understanding,
      history: history.value,
    });
  };

  /**
   * The model half: the request through the context builder, the one gate,
   * then the additive-only verdict and the path. No second loop, no retry and
   * no fallback decision.
   */
  const decide = async (
    stageContext: PipelineStageContext,
    log: Logger,
    artifacts: StoredArtifacts,
    input: FollowUpStageInput,
  ): Promise<Result<DecidedFollowUp, DebuggenError>> => {
    // The builder has already run the outbound guard: an `Err` here means the
    // payload must not leave the machine, so the provider is never called.
    const built = callSync(
      () =>
        deps.contextBuilder.buildFollowUpRequest({
          context: stageContext,
          followUpQuestion: input.followUpQuestion,
          understanding: artifacts.understanding,
          plan: artifacts.plan,
          captureSummary: artifacts.summary,
          analysis: artifacts.analysis,
          panel: artifacts.panel,
          promptVersion: input.promptVersion ?? stageContext.promptVersions[FOLLOW_UP_STAGE],
          signal: stageContext.signal,
        }),
      'INTERNAL',
    );
    if (!built.ok) {
      return built;
    }
    const { request, promptVersion } = built.value;

    const answered = await settle(
      () =>
        generateStructuredWithRepair(deps.provider, followUpDecisionSchema, request, {
          maxRepairs,
          schemaName: FOLLOW_UP_DECISION_SCHEMA_NAME,
          logger: log,
        }),
      'INTERNAL',
    );
    if (!answered.ok) {
      return err(shapeDecisionFailure(answered.error, stageContext.signal));
    }
    const { value: decision, repairs, attempts, providerId, model } = answered.value;
    if (isAborted(stageContext.signal)) {
      return err(cancelledError(FOLLOW_UP_STAGE));
    }

    const delta = diffAdditionalActions(
      artifacts.plan.instrumentationTargets,
      decision.additionalActions,
    );
    const path = followUpPathFor(decision.needsNewCapture, delta);
    const summary: FollowUpDecisionSummary = Object.freeze({
      needsNewCapture: decision.needsNewCapture,
      proposedActions: decision.additionalActions.length,
      acceptedActions: delta.accepted,
      rejectedActions: delta.rejected,
      promptVersion,
      repairs,
      attempts,
      providerId,
      model,
    });

    log.info(DECIDED_LOG, {
      stage: FOLLOW_UP_STAGE,
      path,
      needsNewCapture: decision.needsNewCapture,
      proposed: decision.additionalActions.length,
      accepted: delta.accepted.length,
      rejected: countsByReason(delta.rejected),
      repairs,
      attempts,
      promptVersion,
      planVersion: artifacts.plan.planVersion,
      analysisVersion: artifacts.analysis.analysisVersion,
      panelVersion: artifacts.panel.panelVersion,
      previousObserved: artifacts.history.previousObserved,
      previousLikelyCauses: artifacts.history.previousLikelyCauses,
      bytes: built.value.bytes,
      truncatedSections: built.value.truncated.length,
    } satisfies LogFields);

    return ok({ delta, path, summary, build: built.value });
  };

  /**
   * The existing-evidence path (`generated → analyzing → generated`): the
   * analysis and then the panel are regenerated from the **stored** capture as
   * new versions superseding exactly the analysis and panel the follow-up was
   * decided against. A panel that moved on since the decision stops the run
   * before either is regenerated; a regeneration refused as stale, or answered
   * with an artifact that names another predecessor, fails the run with no
   * outcome recorded. Nothing touches a file and no row is updated in place.
   */
  const runExistingEvidence = async (
    context: PipelineStageContext,
    log: Logger,
    state: RunState,
    input: FollowUpStageInput,
    artifacts: StoredArtifacts,
    understanding: ProblemUnderstanding,
    decided: DecidedFollowUp,
    current: SessionRecord,
    startedAt: number | undefined,
  ): Promise<Result<FollowUpExistingEvidenceResult, DebuggenError>> => {
    const { sessionId } = context;
    const previousAnalysis = artifacts.analysis;
    const previousPanel = artifacts.panel;
    const captureId = previousAnalysis.captureId;

    // The orchestrator's `generated → analyzing` transition.
    const onPathChosen = input.onPathChosen;
    const chosen = await handOff(
      onPathChosen === undefined ? undefined : () => onPathChosen('existing-evidence'),
    );
    if (!chosen.ok) {
      return fail(context, log, state, chosen.error, startedAt);
    }
    if (isAborted(context.signal)) {
      return fail(context, log, state, cancelledError(FOLLOW_UP_STAGE), startedAt);
    }

    // The decision answered the panel loaded before it was made. A panel stored since — another
    // follow-up, a capture — means the developer no longer sees that panel, so nothing is
    // regenerated: refused here, before the analysis port stores a version, in the group of the
    // step whose predecessor moved. One indexed read, the same the decision was loaded with.
    const latestPanel = callSync(() => deps.panels.getLatestPanel(sessionId), 'STORE_ERROR');
    if (!latestPanel.ok || latestPanel.value?.id !== previousPanel.id) {
      openGroup(context, log, state, GENERATE_PANEL_STAGE);
      return fail(
        context,
        log,
        state,
        latestPanel.ok
          ? panelPredecessorMovedError(latestPanel.value?.panelVersion)
          : latestPanel.error,
        startedAt,
      );
    }

    // The analysis: re-derived from the stored capture as the next version. The
    // analysis port owns the `analyze` rows, the gate, the evidence check and the store write.
    enterDelegated(state, ANALYZE_STAGE);
    const regenerationContext: PipelineStageContext = {
      ...context,
      followUpQuestion: input.followUpQuestion,
      captureId,
    };
    const analysed = await settle(
      () =>
        deps.analysisRegeneration.run(regenerationContext, {
          captureId,
          understanding,
          promptVersion: context.promptVersions[ANALYZE_STAGE],
          regenerate: true,
          supersedes: previousAnalysis.id,
        }),
      'INTERNAL',
    );
    if (!analysed.ok) {
      return fail(context, log, state, analysed.error, startedAt);
    }
    const analysis = analysed.value.analysis;
    if (
      analysis.id === previousAnalysis.id ||
      analysis.captureId !== captureId ||
      analysis.supersedes !== previousAnalysis.id
    ) {
      return fail(context, log, state, analysisLadderError(), startedAt);
    }
    // Versioned, never mutated: the previous version is still on the ladder, unchanged, and the
    // new one is the newest entry. Two indexed single-row reads — the predecessor by its primary
    // key, the newest by one seek on UNIQUE (session_id, version) — rather than the whole ladder,
    // so a follow-up costs the same however many analyses the session already holds.
    const predecessor = callSync(() => deps.panels.getAnalysis(previousAnalysis.id), 'STORE_ERROR');
    if (!predecessor.ok) {
      return fail(context, log, state, predecessor.error, startedAt);
    }
    const newest = callSync(() => deps.panels.getLatestAnalysis(sessionId), 'STORE_ERROR');
    if (!newest.ok) {
      return fail(context, log, state, newest.error, startedAt);
    }
    const kept =
      predecessor.value !== undefined &&
      predecessor.value.id === previousAnalysis.id &&
      predecessor.value.sessionId === sessionId &&
      predecessor.value.analysisVersion === previousAnalysis.analysisVersion;
    if (!kept || newest.value?.id !== analysis.id) {
      return fail(context, log, state, analysisLadderError(), startedAt);
    }
    if (isAborted(context.signal)) {
      return fail(context, log, state, cancelledError(ANALYZE_STAGE), startedAt);
    }

    // The panel: regenerated from the same stored capture, answering the follow-up question, as
    // the version superseding exactly the panel the follow-up was decided against. The port
    // refuses — before its model call and inside the store's insert transaction — a session whose
    // latest panel moved on meanwhile, so a stale refusal arrives here as its error.
    openGroup(context, log, state, GENERATE_PANEL_STAGE);
    const generated = await settle(
      () =>
        deps.panelRegeneration.regenerate({
          sessionId,
          captureId,
          question: context.question,
          followUpQuestion: input.followUpQuestion,
          analysis,
          summary: analysed.value.summary,
          promptVersion: context.promptVersions[GENERATE_PANEL_STAGE],
          expectedPredecessor: previousPanel.id,
          signal: context.signal,
        }),
      'INTERNAL',
    );
    if (!generated.ok) {
      return fail(context, log, state, generated.error, startedAt);
    }
    const { panel } = generated.value;
    // A panel naming any other predecessor means the port broke that contract: it describes a
    // different question's version chain, so the run fails rather than deliver it as the answer.
    if (panel.supersedes !== previousPanel.id) {
      return fail(
        context,
        log,
        state,
        panelLadderError(panel.panelVersion, previousPanel.panelVersion),
        startedAt,
      );
    }
    closeGroup(context, log, state);

    const outcome = await recordOutcome(
      context,
      log,
      'existing-evidence',
      { needsNewCapture: false, captureId, analysisId: analysis.id, panelId: panel.id },
      current,
    );

    log.info(COMPLETED_LOG, {
      stage: FOLLOW_UP_STAGE,
      path: 'existing-evidence',
      analysisVersion: analysis.analysisVersion,
      panelVersion: panel.panelVersion,
      fallbackPanel: generated.value.fallback,
      outcomeRecorded: outcome.recorded,
      ...durationFields(context.now, startedAt),
    });

    return ok(
      Object.freeze({
        path: 'existing-evidence',
        decision: decided.summary,
        session: outcome.session,
        outcomeRecorded: outcome.recorded,
        captureId,
        analysis,
        analysisVersion: analysis.analysisVersion,
        supersededAnalysisId: previousAnalysis.id,
        panel,
        panelVersion: panel.panelVersion,
        supersededPanelId: previousPanel.id,
        fallbackPanel: generated.value.fallback,
        analysisPromptVersion: analysed.value.promptVersion,
        panelPromptVersion: generated.value.promptVersion,
      } satisfies FollowUpExistingEvidenceResult),
    );
  };

  /**
   * How many distinct files the given (feasible) delta actions patch that
   * already carry a live modification chain head. Read-only: the chain itself
   * is the installer's and the journal's to extend.
   */
  const countChainedFiles = async (
    sessionId: string,
    delta: readonly InstrumentationAction[],
  ): Promise<Result<number, DebuggenError>> => {
    const files = [
      ...new Set(delta.filter((action) => action.mode === PATCH_MODE).map((action) => action.file)),
    ].sort(compareCodeUnits);
    const heads = await Promise.all(
      files.map((file) =>
        settle(() => deps.modifications.latestRecordForFile(sessionId, file), 'STORE_ERROR'),
      ),
    );
    let chained = 0;
    for (const head of heads) {
      if (!head.ok) {
        return head;
      }
      if (head.value !== undefined && head.value.status !== 'reverted') {
        chained += 1;
      }
    }
    return ok(chained);
  };

  /**
   * Plan version n + 1 through the same deterministic gate Stage 3 uses —
   * `normalizePlan` (with the previous actions, so installed actions keep their
   * ids) → `instrumentationPlanSchema` → `checkPlanFeasibility` — plus the
   * check only a follow-up needs: every installed action survives unchanged.
   * A normalisation or validation failure is a product defect, logged with the
   * authoring input's closed shape — never its prose — and rejected without a
   * re-prompt. Nothing is written.
   */
  const gateNextPlan = async (
    context: PipelineStageContext,
    log: Logger,
    input: FollowUpStageInput,
    previous: InstrumentationPlan,
    accepted: readonly InstrumentationTargetInput[],
  ): Promise<Result<GatedPlan, DebuggenError>> => {
    const { sessionId } = context;

    const next = callSync(() => deps.sessions.nextPlanVersion(sessionId), 'STORE_ERROR');
    if (!next.ok) {
      return next;
    }
    const planVersion = next.value;
    if (planVersion !== previous.planVersion + 1) {
      return err(planLadderMovedError(previous.planVersion, planVersion));
    }

    const built = callSync(
      () =>
        deps.instrumentation.buildContext({
          sessionId,
          projectRoot: context.projectRoot,
          plan: { planVersion },
          code: codeHandlesOf(context),
          readiness: input.readiness ?? {},
          signal: context.signal,
        }),
      'INTERNAL',
    );
    if (!built.ok) {
      return built;
    }
    const instrumentationContext = built.value;
    const resolver = contextBoundResolver(deps.registry, instrumentationContext);

    const authored = buildFollowUpPlanInput(previous, accepted);
    const normalized = normalizePlan(authored, {
      sessionId,
      planVersion,
      resolver,
      previousActions: previous.instrumentationTargets,
      newActionId: deps.newActionId,
    });
    if (!normalized.ok) {
      const field = refusedFieldPath(normalized.error);
      log.error(PRODUCT_DEFECT_LOG, {
        stage: PLAN_STAGE,
        step: 'normalize',
        code: normalized.error.code,
        planVersion,
        ...(field !== undefined ? { field } : {}),
        ...authoredPlanShape(authored),
      });
      return err(normalized.error);
    }

    const internal = instrumentationPlanSchema.safeParse(normalized.value);
    if (!internal.success) {
      const issues = describeIssues(internal.error.issues);
      log.error(PRODUCT_DEFECT_LOG, {
        stage: PLAN_STAGE,
        step: 'internal-validation',
        code: 'PLAN_INVALID',
        planVersion,
        issues,
        issueCount: internal.error.issues.length,
        ...authoredPlanShape(authored),
      });
      return err(
        new DebuggenError(
          'PLAN_INVALID',
          'The follow-up plan version failed its internal schema, so nothing was installed.',
          {
            hint: 'This is a defect in plan normalisation rather than in the follow-up, so it was not re-prompted; report the logged field paths.',
            details: {
              stage: PLAN_STAGE,
              reason: 'internal-validation',
              issues,
              issueCount: internal.error.issues.length,
            },
          },
        ),
      );
    }
    const plan = internal.data;

    const altered = findAlteredInstalledAction(
      previous.instrumentationTargets,
      plan.instrumentationTargets,
      accepted.length,
    );
    if (altered !== undefined) {
      log.error(PRODUCT_DEFECT_LOG, {
        stage: PLAN_STAGE,
        step: 'installed-actions',
        code: 'PLAN_INVALID',
        planVersion,
        index: altered,
        ...authoredPlanShape(authored),
      });
      return err(installedActionAlteredError(altered, planVersion));
    }
    const delta = plan.instrumentationTargets.slice(previous.instrumentationTargets.length);

    // Feasibility is a report: partially infeasible deltas are installed as validated and the
    // installer reports every refusal as an unavailable signal (AAP §0.5.5). A delta none of whose
    // additions can be installed would ask the developer to reproduce for nothing, so it is refused.
    const checked = tryCatch(
      () => checkPlanFeasibility(plan, instrumentationContext, { resolver }),
      'INTERNAL',
    );
    if (!checked.ok) {
      return checked;
    }
    const feasibility = checked.value;
    const deltaIds: ReadonlySet<string> = new Set(delta.map((action) => action.id));
    const refused = feasibility.rejected.filter((refusal) => deltaIds.has(refusal.action.id));
    if (delta.length > 0 && refused.length === delta.length) {
      return err(deltaInfeasibleError(feasibility, deltaIds));
    }

    // Only a feasible patch-mode addition patches anything: the installer turns every refusal
    // into an unavailable signal instead of a write.
    const refusedIds: ReadonlySet<string> = new Set(refused.map((refusal) => refusal.action.id));
    const chained = await countChainedFiles(
      sessionId,
      delta.filter((action) => !refusedIds.has(action.id)),
    );
    if (!chained.ok) {
      return chained;
    }

    return ok({
      plan,
      delta,
      feasibility,
      refusedDelta: refused.length,
      chainedFiles: chained.value,
    });
  };

  /**
   * Builds the restore context for plan version n + 1 — without the run's
   * signal, so a cancelled run still reads and unwinds — and lists the
   * session's journal through it, so `restoreModification` later sees the
   * session's own journal and backup store. Read only: nothing is written, and
   * the one listing serves both the check of an installer's unwind and the
   * compensation it may lead to. Never rejects.
   */
  const openDeltaJournal = async (
    context: PipelineStageContext,
    input: FollowUpStageInput,
    plan: InstrumentationPlan,
  ): Promise<DeltaJournal> => {
    const built = callSync(
      () =>
        deps.instrumentation.buildContext({
          sessionId: context.sessionId,
          projectRoot: context.projectRoot,
          plan: { planVersion: plan.planVersion },
          code: codeHandlesOf(context),
          readiness: input.readiness ?? {},
        }),
      'INTERNAL',
    );
    if (!built.ok) {
      return { context: built, listed: err(built.error) };
    }
    return { context: built, listed: await listSessionJournal(built.value, context.sessionId) };
  };

  /**
   * Reverse-restores the file modifications of plan version n + 1 — and only
   * those — strictly newest first.
   *
   * - **The set comes from the journal.** Every record of the session whose
   *   `planVersion` is n + 1 and whose status is one
   *   {@link OPEN_DELTA_STATUSES} names. Earlier versions' records are
   *   never touched, so a chained file returns to the bytes plan version n
   *   wrote rather than to its pristine ones. When the journal does not
   *   answer, the records the install reported are used instead and the report
   *   says so (`journal: 'unreadable'`).
   * - **The order is cleanup's.** Files are taken latest-touched first
   *   ({@link groupByFileLatestFirst}); within a file `orderRestorationChain`
   *   orders the records last-applied first, and the walk stops at the first
   *   conflict or failure, because every earlier record's expectation of the
   *   file is then unsatisfiable. The rest of that file is reported skipped.
   * - **A conflict is never touched.** A record already in `conflict` is
   *   reported as a conflict without a call to `restoreModification` and stops
   *   its file exactly like a conflict a restore finds, so the rollback can
   *   never be reported complete while one stands. Its backup stays.
   * - **A shared backup survives.** Backups are content-addressed, so a record
   *   keeps its backup (`retainBackup`) while any other record of the session
   *   that is not reverted — an earlier version's, a conflict's, or a delta
   *   record still to come — is filed under the same path. Without a journal
   *   listing every backup is kept: deleting one another record still needs
   *   is the one irreversible outcome.
   * - **It runs without the run's signal**, over the context
   *   {@link openDeltaJournal} built — or the one `opened` carries.
   * - **It reports where the records ended up.** Once any record was handed to
   *   a restore, the journal is listed again and plan version n + 1's records
   *   are reported as it holds them; failing that, as the restores returned
   *   them over the first listing.
   *
   * @param opened The journal as the caller already listed it; absent, it is
   * opened here.
   * @returns The report. Never rejects: every record's fate lands in one list.
   */
  const reverseRestoreDelta = async (
    context: PipelineStageContext,
    input: FollowUpStageInput,
    plan: InstrumentationPlan,
    installation: InstrumentationOutcome | undefined,
    opened?: DeltaJournal,
  ): Promise<DeltaFilesReport> => {
    const { sessionId } = context;
    const reported = openDeltaRecords(installation?.applied ?? [], sessionId, plan.planVersion);

    const opening = opened ?? (await openDeltaJournal(context, input, plan));
    if (!opening.context.ok) {
      const { code } = opening.context.error;
      return {
        attempted: reported.length,
        restored: [],
        conflicts: [],
        skipped: [],
        failures: reported.map((record) => ({ recordId: record.id, code })),
        journal: 'unreadable',
        journalCode: code,
        records: reported,
      };
    }
    const restoreContext = opening.context.value;
    const { listed } = opening;

    const journal = listed.ok
      ? listed.value.filter((record) => record.sessionId === sessionId)
      : undefined;
    const delta =
      journal === undefined ? reported : openDeltaRecords(journal, sessionId, plan.planVersion);
    const holders = journal?.filter((record) => record.status !== REVERTED_STATUS);

    const restored: string[] = [];
    const conflicts: string[] = [];
    const skipped: string[] = [];
    const failures: DeltaRollbackFailure[] = [];
    const undone = new Set<string>();
    // Each record's last known state: as listed, then as its restore returned it.
    const latest = new Map<string, ModificationRecord>(delta.map((record) => [record.id, record]));
    let handedToRestore = false;
    const backupStillNeeded = (record: ModificationRecord): boolean =>
      holders === undefined ||
      holders.some(
        (other) =>
          other.id !== record.id && other.backupPath === record.backupPath && !undone.has(other.id),
      );

    for (const group of groupByFileLatestFirst(delta)) {
      const ordered = callSync(() => orderRestorationChain(group), 'INTERNAL');
      if (!ordered.ok) {
        // No reverse order exists for this file's records, so none of them is read or written.
        const { code } = ordered.error;
        failures.push(...group.map((record) => ({ recordId: record.id, code })));
        continue;
      }
      let stopped = false;
      for (const record of ordered.value) {
        if (stopped) {
          skipped.push(record.id);
          continue;
        }
        if (record.status === CONFLICT_STATUS) {
          // Already a conflict: the file no longer holds this product's bytes, so nothing is
          // written, the backup stays, and every earlier link of this file is unsatisfiable.
          conflicts.push(record.id);
          stopped = true;
          continue;
        }
        const retainBackup = backupStillNeeded(record);
        handedToRestore = true;
        const outcome: Result<RestoreOutcome, DebuggenError> = await settle(
          () => restoreModification(record, restoreContext, { retainBackup }),
          'CLEANUP_PARTIAL',
        );
        if (!outcome.ok) {
          failures.push({ recordId: record.id, code: outcome.error.code });
          stopped = true;
          continue;
        }
        latest.set(record.id, outcome.value.record);
        const { kind } = outcome.value;
        if (
          kind === 'restored' ||
          kind === 'already-original' ||
          (kind === 'skipped' && outcome.value.record.status === REVERTED_STATUS)
        ) {
          restored.push(record.id);
          undone.add(record.id);
        } else if (kind === 'conflict') {
          conflicts.push(record.id);
          stopped = true;
        } else {
          skipped.push(record.id);
          stopped = true;
        }
      }
    }

    // Where plan version n + 1's records ended up: the journal's own word once a restore may have
    // moved one, and otherwise the first listing with each restore's returned record over it.
    const known =
      journal === undefined
        ? [...latest.values()]
        : journal
            .filter((record) => record.planVersion === plan.planVersion)
            .map((record) => latest.get(record.id) ?? record);
    let records: readonly ModificationRecord[] = known;
    if (handedToRestore) {
      const relisted = await listSessionJournal(restoreContext, sessionId);
      if (relisted.ok) {
        records = relisted.value.filter(
          (record) => record.sessionId === sessionId && record.planVersion === plan.planVersion,
        );
      }
    }

    return {
      attempted: delta.length,
      restored,
      conflicts,
      skipped,
      failures,
      journal: listed.ok ? 'listed' : 'unreadable',
      ...(listed.ok ? {} : { journalCode: listed.error.code }),
      records,
    };
  };

  /**
   * Mirrors the final states of plan version n + 1's records onto
   * `SessionRecord.modifications` through `SessionManager.patch`, which
   * broadcasts `session.updated` — the correction to the `instrumentation.ready`
   * the service sent for them before the failure, since both user interfaces
   * treat the record's modifications as the live journal. The records are
   * upserted by id over a fresh read of the record
   * ({@link mergeModificationRecords}); the patch writes no status.
   *
   * @returns Whether the patch landed. Never rejects: a failure is logged with
   * its step and code only.
   */
  const mirrorDeltaRecords = async (
    context: PipelineStageContext,
    log: Logger,
    records: readonly ModificationRecord[],
  ): Promise<boolean> => {
    const read = callSync(() => deps.sessions.get(context.sessionId), 'STORE_ERROR');
    if (!read.ok || read.value === undefined) {
      log.warn(DELTA_MIRROR_FAILED_LOG, {
        step: 'read',
        code: read.ok ? SESSION_NOT_FOUND_CODE : read.error.code,
      });
      return false;
    }
    const modifications = mergeModificationRecords(read.value.modifications, records);
    const patched = await settle(
      () => deps.sessionManager.patch(context.sessionId, { modifications }),
      'STORE_ERROR',
    );
    if (!patched.ok) {
      log.warn(DELTA_MIRROR_FAILED_LOG, { step: 'patch', code: patched.error.code });
      return false;
    }
    return true;
  };

  /**
   * Undoes an installed delta that cannot be kept, and composes the error the
   * run fails with (AAP §0.4.2, Follow-up row: "reverse-restores the delta
   * records applied so far and leaves the session at its previous plan
   * version").
   *
   * The files first ({@link reverseRestoreDelta}), then — always, whatever the
   * files did — `restoreArming` with plan version n, because the service
   * already holds n + 1's widened hooks after an install that returned, and
   * the next capture would otherwise arm them (or be refused for a version the
   * ladder does not hold). Then, when any record of n + 1 was open, their final
   * states are mirrored onto the session record ({@link mirrorDeltaRecords}).
   * One log record states the outcome: `info` when the session stands exactly
   * at version n again, `error` otherwise.
   *
   * @param context The run's stage context.
   * @param log The run's logger.
   * @param input The run's input; its readiness facts go on the restore context.
   * @param previous Plan version n: the stored plan the session returns to.
   * @param plan Plan version n + 1: the installed, unrecorded plan.
   * @param installation The install's outcome, when it returned `Ok`: the
   * fallback record set when the journal does not answer.
   * @param trigger Which post-install failure is being compensated.
   * @param original The failure itself.
   * @param options A journal already opened for this compensation, and hint
   * overrides; see {@link CompensationOptions}.
   * @returns `original`'s code with its message plus one sentence stating what
   * the project now holds ({@link describeDeltaRollback}), a registered hint
   * repeating that sentence before the recovery for what remains
   * ({@link compensatedHint}), `original`'s details with
   * `deltaRollback` — and `activePlanVersion: n` only when nothing remains,
   * any claim `original` made about the active version dropped otherwise —
   * and `original` as the cause. Never rejects.
   */
  const compensateDelta = async (
    context: PipelineStageContext,
    log: Logger,
    input: FollowUpStageInput,
    previous: InstrumentationPlan,
    plan: InstrumentationPlan,
    installation: InstrumentationOutcome | undefined,
    trigger: DeltaRollbackTrigger,
    original: DebuggenError,
    options: CompensationOptions = {},
  ): Promise<DebuggenError> => {
    let files: DeltaFilesReport;
    try {
      files = await reverseRestoreDelta(context, input, plan, installation, options.journal);
    } catch (thrown) {
      // A collaborator broke its never-throw contract mid-walk: nothing can be claimed restored.
      const { code } = DebuggenError.from(thrown, 'INTERNAL');
      const reported = openDeltaRecords(
        installation?.applied ?? [],
        context.sessionId,
        plan.planVersion,
      );
      files = {
        attempted: reported.length,
        restored: [],
        conflicts: [],
        skipped: [],
        failures: reported.map((record) => ({ recordId: record.id, code })),
        journal: 'unreadable',
        journalCode: code,
        records: reported,
      };
    }

    const armed = callSync(
      () =>
        deps.instrumentation.restoreArming({
          sessionId: context.sessionId,
          projectRoot: context.projectRoot,
          plan: previous,
        }),
      'INTERNAL',
    );

    // The service announced n + 1's records as applied; the clients are told what became of them.
    const mirrored =
      files.records.length > 0 && (files.attempted > 0 || files.conflicts.length > 0)
        ? await mirrorDeltaRecords(context, log, files.records)
        : undefined;

    const report: DeltaRollbackReport = {
      ...files,
      trigger,
      arming: armed.ok ? 'restored' : 'failed',
      ...(armed.ok ? {} : { armingCode: armed.error.code }),
      ...(mirrored === undefined ? {} : { mirrored }),
    };
    const intact = isRollbackIntact(report);
    const details = deltaRollbackDetails(report);

    const fields: LogFields = {
      planVersion: plan.planVersion,
      previousPlanVersion: previous.planVersion,
      code: original.code,
      ...details,
    };
    if (intact) {
      log.info(DELTA_ROLLED_BACK_LOG, fields);
    } else {
      log.error(DELTA_ROLLBACK_INCOMPLETE_LOG, fields);
    }

    const description = describeDeltaRollback(report, plan.planVersion, previous.planVersion);
    const settledHint = options.settledHint ?? settledHintOf(original.hint);
    const recovery = deltaRollbackHint(
      report,
      previous.planVersion,
      settledHint,
      options.standingHint,
    );
    return new DebuggenError(original.code, `${asSentence(original.message)} ${description}`, {
      hint: compensatedHint(
        description,
        recovery,
        isRecoveryProven(report, settledHint, options.standingHint),
        original.code,
      ),
      details: {
        ...carriedDetails(original),
        ...(intact ? { [ACTIVE_PLAN_VERSION_KEY]: previous.planVersion } : {}),
        deltaRollback: details,
      },
      cause: original,
    });
  };

  /**
   * Whether the plan version a failed `recordPlan` left on the ladder is this
   * run's, recorded in full: the stored plan equals `plan`
   * ({@link isSamePlanVersion}) and the session record's `plans` hold its
   * version. Read only.
   *
   * @returns The stored record and plan, or the first {@link PlanCheck} that
   * failed.
   */
  const confirmRecordedPlan = (
    sessionId: string,
    plan: InstrumentationPlan,
  ): { readonly recorded: RecordedPlan } | { readonly check: PlanCheck } => {
    const stored = callSync(
      () => deps.sessions.getPlan(sessionId, plan.planVersion),
      'STORE_ERROR',
    );
    if (!stored.ok) {
      return { check: 'plan-unreadable' };
    }
    if (stored.value === undefined) {
      return { check: 'plan-missing' };
    }
    if (!isSamePlanVersion(stored.value, plan)) {
      return { check: 'plan-differs' };
    }
    const record = callSync(() => deps.sessions.get(sessionId), 'STORE_ERROR');
    if (!record.ok || record.value === undefined) {
      return { check: 'record-unreadable' };
    }
    if (!record.value.plans.some((entry) => entry.planVersion === plan.planVersion)) {
      return { check: 'record-lacks-plan' };
    }
    return { recorded: { session: record.value, plan: stored.value } };
  };

  /**
   * Settles a `recordPlan` failure after the delta was installed. The ladder is
   * read again to learn whether the plan row landed:
   *
   * - **at n + 1, and recorded in full** — the stored plan is this run's and
   *   the session record holds it ({@link confirmRecordedPlan}). `recordPlan`
   *   writes both in one transaction, so only a failure after its commit (a
   *   broadcast, say) gets here: the run rolls forward, logged at `warn`, and
   *   completes with that record and plan;
   * - **at n + 1 otherwise** — the record lacks it, a read fails, the plan
   *   differs — the store disagrees with itself. The files and the arming state
   *   are returned to n, which is what the record the capture stage arms from
   *   holds, and the failure says a plan row remains ({@link planSplitError},
   *   `details.planStored: true`, `recordMirrored: false`);
   * - **at n, or unreadable** — the delta is compensated
   *   ({@link compensateDelta}): when the ladder cannot be read, restoring the
   *   files is the side that can never leave instrumentation the ladder does
   *   not account for.
   *
   * A failed operation is never left at n + 1.
   *
   * @returns The recorded session and plan when the run rolls forward, or the
   * compensated failure. Never rejects.
   */
  const settleUnrecordedPlan = async (
    context: PipelineStageContext,
    log: Logger,
    input: FollowUpStageInput,
    previous: InstrumentationPlan,
    plan: InstrumentationPlan,
    installation: InstrumentationOutcome,
    error: DebuggenError,
  ): Promise<Result<RecordedPlan, DebuggenError>> => {
    const { sessionId } = context;
    const reread = callSync(() => deps.sessions.latestPlanVersion(sessionId), 'STORE_ERROR');
    const planStored: boolean | 'unknown' = !reread.ok
      ? 'unknown'
      : reread.value === plan.planVersion
        ? true
        : reread.value === previous.planVersion
          ? false
          : 'unknown';

    let check: PlanCheck | undefined;
    if (planStored === true) {
      const confirmed = confirmRecordedPlan(sessionId, plan);
      if ('recorded' in confirmed) {
        log.warn(PLAN_RECORDED_DESPITE_REPORT_LOG, {
          planVersion: plan.planVersion,
          code: error.code,
        });
        return ok(confirmed.recorded);
      }
      check = confirmed.check;
    }

    log.error(UNRECORDED_PLAN_LOG, {
      stage: PLAN_STAGE,
      planVersion: plan.planVersion,
      code: error.code,
      planStored,
      ...(check === undefined ? {} : { planCheck: check }),
      ...(reread.ok ? {} : { rereadCode: reread.error.code }),
    });

    if (check !== undefined) {
      const split = planSplitError(error, plan.planVersion, previous.planVersion, check);
      return err(
        await compensateDelta(
          context,
          log,
          input,
          previous,
          plan,
          installation,
          'plan-unrecorded',
          split,
          { standingHint: split.hint },
        ),
      );
    }
    return err(
      await compensateDelta(
        context,
        log,
        input,
        previous,
        plan,
        installation,
        'plan-unrecorded',
        annotate(error, { planStored }),
      ),
    );
  };

  /**
   * The new-capture path (`generated → planning → instrumenting → ready`):
   * plan version n + 1 is gated, the delta — and only the delta — is installed
   * by the instrumentation service, and the version is recorded once the
   * install has succeeded. A delta that fails part-way is reverse-restored by
   * the installer itself, which says so by naming version n as active — a claim
   * the journal is listed to confirm; every other failure once the install was
   * attempted — an unwind that left a record of n + 1 open, an install `Err`
   * that names no version n, an `Ok` that left another version active, a plan
   * version that could not be recorded — is compensated here
   * ({@link compensateDelta}), so the files, the arming state and the ladder
   * all stand at version n again. A `recordPlan` failure after both the plan
   * row and the session record were stored rolls forward instead
   * ({@link settleUnrecordedPlan}).
   */
  const runNewCapture = async (
    context: PipelineStageContext,
    log: Logger,
    state: RunState,
    input: FollowUpStageInput,
    artifacts: StoredArtifacts,
    decided: DecidedFollowUp,
    startedAt: number | undefined,
  ): Promise<Result<FollowUpNewCaptureResult, DebuggenError>> => {
    const { sessionId } = context;
    const previous = artifacts.plan;

    openGroup(context, log, state, PLAN_STAGE);
    const gated = await gateNextPlan(context, log, input, previous, decided.delta.accepted);
    if (!gated.ok) {
      return fail(context, log, state, gated.error, startedAt);
    }
    const { plan, delta, feasibility, refusedDelta, chainedFiles } = gated.value;
    closeGroup(context, log, state);

    // The orchestrator's `generated → planning` transition, then `planning → instrumenting`.
    const onPathChosen = input.onPathChosen;
    const chosen = await handOff(
      onPathChosen === undefined ? undefined : () => onPathChosen('new-capture'),
    );
    if (!chosen.ok) {
      return fail(context, log, state, chosen.error, startedAt);
    }
    const beforeInstall = input.beforeInstall;
    const handed = await handOff(
      beforeInstall === undefined ? undefined : () => beforeInstall(plan),
    );
    if (!handed.ok) {
      return fail(context, log, state, handed.error, startedAt);
    }
    if (isAborted(context.signal)) {
      return fail(context, log, state, cancelledError(INSTRUMENT_STAGE), startedAt);
    }

    // The install — the only path that may write to the developer's project. The service
    // computes the delta against the previous actions by identity and installs only it; its
    // rows (header, Step-8 ✓ rows, degradations, "Ready to capture", failure) are its own.
    enterDelegated(state, INSTRUMENT_STAGE);
    const request: InstallRequest = {
      sessionId,
      projectRoot: context.projectRoot,
      plan,
      code: codeHandlesOf(context),
      boundTab: context.session.boundTab,
      devServerUrl: context.session.devServerUrl,
      previousPlanVersion: previous.planVersion,
      previousActions: previous.instrumentationTargets,
      signal: context.signal,
    };
    const installed = await settle(() => deps.instrumentation.install(request), 'INTERNAL');
    if (!installed.ok) {
      // The installer's own unwind names the previous version as the one left active — but the
      // service stamps it on every failed install, even one whose rollback left a conflict, a
      // failure or an unread journal. So the claim is checked: the journal is listed, read only and
      // without the run's signal, and passed through unchanged only when no record of n + 1 is
      // still open. Any other install error — one raised after the apply, or one naming no
      // version — may have left the delta on disk. (No second install of this session can be
      // running: the orchestrator serialises a session's operations.)
      if (installed.error.details?.[ACTIVE_PLAN_VERSION_KEY] === previous.planVersion) {
        const journal = await openDeltaJournal(context, input, plan);
        const left = journal.listed.ok
          ? openDeltaRecords(journal.listed.value, sessionId, plan.planVersion)
          : undefined;
        if (left !== undefined && left.length === 0) {
          return fail(context, log, state, installed.error, startedAt);
        }
        // The installer's hint described what its unwind left; the compensation changes that, so
        // a compensation that leaves nothing names the re-ask instead.
        const unwound = await compensateDelta(
          context,
          log,
          input,
          previous,
          plan,
          undefined,
          'install-unwind-incomplete',
          installed.error,
          { journal, settledHint: DELTA_REASK_HINT },
        );
        return fail(context, log, state, unwound, startedAt);
      }
      const compensated = await compensateDelta(
        context,
        log,
        input,
        previous,
        plan,
        undefined,
        'install-failed',
        installed.error,
      );
      return fail(context, log, state, compensated, startedAt);
    }
    const installation = installed.value;
    if (installation.activePlanVersion !== plan.planVersion) {
      const compensated = await compensateDelta(
        context,
        log,
        input,
        previous,
        plan,
        installation,
        'active-version-mismatch',
        activeVersionMismatchError(plan.planVersion, installation.activePlanVersion),
      );
      return fail(context, log, state, compensated, startedAt);
    }

    // Recorded only now: a failed delta never advances the ladder the next follow-up builds on.
    // The plan row and the session record are one transaction; a failure is settled — rolled
    // forward when both hold this run's n + 1, compensated otherwise.
    enterDelegated(state, PLAN_STAGE);
    const recording = await settle(
      () => deps.sessionManager.recordPlan(sessionId, plan),
      'STORE_ERROR',
    );
    const recorded = recording.ok
      ? recording
      : await settleUnrecordedPlan(
          context,
          log,
          input,
          previous,
          plan,
          installation,
          recording.error,
        );
    if (!recorded.ok) {
      return fail(context, log, state, recorded.error, startedAt);
    }
    const recordedPlan = recorded.value.plan;

    const outcome = await recordOutcome(
      context,
      log,
      'new-capture',
      { needsNewCapture: true, planVersion: recordedPlan.planVersion },
      recorded.value.session,
    );

    log.info(COMPLETED_LOG, {
      stage: FOLLOW_UP_STAGE,
      path: 'new-capture',
      planVersion: recordedPlan.planVersion,
      previousPlanVersion: previous.planVersion,
      delta: countsByTypeAndMode(delta),
      refusedDelta,
      chainedFiles,
      applied: installation.applied.length,
      unavailableSignals: installation.unavailable.length,
      readinessSatisfied: installation.readiness.satisfied,
      outcomeRecorded: outcome.recorded,
      ...durationFields(context.now, startedAt),
    });

    return ok(
      Object.freeze({
        path: 'new-capture',
        decision: decided.summary,
        session: outcome.session,
        outcomeRecorded: outcome.recorded,
        plan: recordedPlan,
        planVersion: recordedPlan.planVersion,
        previousPlanVersion: previous.planVersion,
        delta: Object.freeze([...delta]),
        feasibility,
        chainedFiles,
        installation,
      } satisfies FollowUpNewCaptureResult),
    );
  };

  /** One run, in the order of this factory's documentation. */
  const execute = async (
    context: PipelineStageContext,
    input: FollowUpStageInput,
    state: RunState,
    log: Logger,
    startedAt: number | undefined,
  ): Promise<Result<FollowUpStageResult, DebuggenError>> => {
    if (!isValidRepairBudget(maxRepairs)) {
      // A programmer error, reported before any progress row, record or provider call.
      const error = repairBudgetError(maxRepairs);
      log.error(FAILED_LOG, { stage: FOLLOW_UP_STAGE, code: error.code, reason: 'repair-budget' });
      return err(error);
    }
    if (isAborted(context.signal)) {
      log.debug(CANCELLED_LOG, { stage: FOLLOW_UP_STAGE });
      return err(cancelledError(FOLLOW_UP_STAGE));
    }
    if (!isNonBlankString(input.followUpQuestion)) {
      return fail(context, log, state, missingQuestionError(), startedAt);
    }

    openGroup(context, log, state, FOLLOW_UP_STAGE);

    const loaded = await loadArtifacts(context);
    if (!loaded.ok) {
      return fail(context, log, state, loaded.error, startedAt);
    }
    const artifacts = loaded.value;

    // Recorded when asked, before any outcome exists; stored, never inspected.
    // The attempt id decides whether this is a new follow-up or a retry of the
    // failed one, recorded in its place.
    const asked = await settle(
      () =>
        deps.sessionManager.appendFollowUp(
          context.sessionId,
          input.followUpQuestion,
          input.attemptId,
        ),
      'STORE_ERROR',
    );
    if (!asked.ok) {
      return fail(context, log, state, asked.error, startedAt);
    }

    const stageContext: PipelineStageContext = {
      ...context,
      followUpQuestion: input.followUpQuestion,
    };
    const decided = await decide(stageContext, log, artifacts, input);
    if (!decided.ok) {
      return fail(context, log, state, decided.error, startedAt);
    }

    if (decided.value.path === 'existing-evidence') {
      const { understanding } = artifacts;
      if (understanding === undefined) {
        return fail(context, log, state, missingArtifactError('no-understanding'), startedAt);
      }
      closeGroup(context, log, state);
      return runExistingEvidence(
        stageContext,
        log,
        state,
        input,
        artifacts,
        understanding,
        decided.value,
        asked.value,
        startedAt,
      );
    }

    closeGroup(context, log, state);
    return runNewCapture(stageContext, log, state, input, artifacts, decided.value, startedAt);
  };

  const run = async (
    context: PipelineStageContext,
    input: FollowUpStageInput,
  ): Promise<Result<FollowUpStageResult, DebuggenError>> => {
    const state: RunState = { stage: FOLLOW_UP_STAGE, open: false };
    let startedAt: number | undefined;
    let log: Logger = noopLogger;
    try {
      startedAt = readClock(context.now);
      log = loggerFor(context);
      return await execute(context, input, state, log, startedAt);
    } catch (thrown) {
      // A collaborator broke its never-throw contract. The run still ends as a typed failure,
      // filed under the stage that was running, so the orchestrator can route the session.
      return fail(context, log, state, DebuggenError.from(thrown, 'INTERNAL'), startedAt);
    }
  };

  return Object.freeze({ run });
}
