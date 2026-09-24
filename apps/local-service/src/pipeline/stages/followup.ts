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
 * with its input and never re-prompted.
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
 *   `SessionsRepo.nextPlanVersion`; analysis and panel versions and their
 *   `supersedes` links are assigned by the store through the delegated modules.
 *   Nothing here computes a version, and no row is ever updated in place.
 * - **Plan version n+1 is recorded only after its install succeeded**, so a
 *   delta that failed part-way leaves the session's plan ladder — and the
 *   baseline of the next follow-up — at version n.
 * - **Session status is never written.** The orchestrator performs every
 *   transition through the session manager; {@link FollowUpStageInput.onPathChosen}
 *   and {@link FollowUpStageInput.beforeInstall} are its seams. This module
 *   records the follow-up with `SessionManager.appendFollowUp` and its outcome
 *   links with `recordFollowUpOutcome`.
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
 * counts, rejection reason codes, prompt versions and error codes — never the
 * question, a prompt, the model output, a statement, a file's contents, a diff,
 * SQL, a URL or a token. The one sanctioned exception is the product-defect
 * record of a normalisation failure, which carries the authoring input for
 * whoever fixes the defect (AAP §0.5.3), exactly as Stage 3's does. Errors
 * composed here carry codes, product-minted ids, counts and enumerated
 * reasons, never payload values.
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
  ObservedReadinessInputs,
  PlanAdapterResolver,
  ProblemUnderstanding,
} from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  generateStructuredWithRepair,
  modelUnavailableMessage,
} from '@debuggen/model-provider';
import type { ModelProvider, PromptStage } from '@debuggen/model-provider';
import type { PanelSpec } from '@debuggen/panel-schema';
import { isPlainRecord, opaqueSchema } from '@debuggen/protocol';
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

import type { AnalysisFacts } from '../../analysis/facts.js';
import type { AnalysisFollowUpContext, AnalysisSummarizer } from '../../analysis/summarize.js';
import type {
  CodeAnalysisHandles,
  InstallRequest,
  InstrumentationOutcome,
  InstrumentationService,
} from '../../instrumentation/service.js';
import { sessionLogger, subsystemLogger } from '../../logging.js';
import type { PanelGenerationResult, PanelRegenerationRequest } from '../../panels/generate.js';
import type { FollowUpOutcome, SessionManager } from '../../sessions/manager.js';
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
 * in a rejection's `details.schemaName`. An opaque schema yields terse issues,
 * so this label is what tells a repair turn which artifact it is rewriting
 * (AAP §0.5.3, the repair loop of every structured output).
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
 * The FollowUpDecision contract — owned by this stage (the no-zod path)
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
 * stage module, and `zod` is not imported by this workspace, so the runtime
 * check is {@link isFollowUpDecision} behind {@link followUpDecisionSchema}.
 * **If an upstream schema for this shape ever appears, switch to it and delete
 * the local guard**: two definitions of a cross-boundary shape is the defect
 * AAP §0.2.3 names.
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
 * The schema of the {@link FollowUpDecision} artifact, for
 * `generateStructuredWithRepair` (AAP §0.5.3). Built with protocol's
 * `opaqueSchema` over {@link isFollowUpDecision}, so the guard and the schema
 * cannot disagree; a rejection reads `expected FollowUpDecision`, and the
 * stage passes {@link FOLLOW_UP_DECISION_SCHEMA_NAME} so the repair turn names
 * the artifact it is rewriting.
 */
export const followUpDecisionSchema = opaqueSchema<FollowUpDecision>(
  FOLLOW_UP_DECISION_LABEL,
  isFollowUpDecision,
);

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
 */
export interface PanelRegenerationPort {
  /**
   * Regenerates, validates, stores and broadcasts the next panel version of a
   * capture, answering the follow-up question.
   *
   * @param request The session, the stored capture, both questions, the
   * regenerated analysis, the capture summary, the recorded prompt version and
   * the cancellation signal.
   * @returns The stored panel — a fallback panel included — or the subsystem's
   * typed error. Never rejects.
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
 * status, no analysis row, no panel row and no modification record.
 */
export interface FollowUpStageDeps {
  /** Renders the versioned follow-up prompt and runs the outbound guard. */
  readonly contextBuilder: Pick<ContextBuilder, 'buildFollowUpRequest'>;
  /** The configured model provider; called only through `generateStructuredWithRepair`. */
  readonly provider: ModelProvider;
  /** The bounded follow-up context (previous analysis and panel ids) and the stored capture summary. */
  readonly summarizer: Pick<AnalysisSummarizer, 'buildFollowUpContext' | 'loadCaptureSummary'>;
  /** The analysis ladder, read to prove a regeneration appended a version rather than mutating one. */
  readonly facts: Pick<AnalysisFacts, 'history'>;
  /** Regenerates the analysis on the existing-evidence path (normally the analyze stage). */
  readonly analysisRegeneration: AnalysisRegenerationPort;
  /** Regenerates the panel on the existing-evidence path (normally the panel generator). */
  readonly panelRegeneration: PanelRegenerationPort;
  /** Builds the adapter context and installs the delta — the only writer to the project. */
  readonly instrumentation: Pick<InstrumentationService, 'buildContext' | 'install'>;
  /** The live adapter registry: the only source of adapter identity and install mode. */
  readonly registry: AdapterRegistry;
  /** The plan ladder: the installed version and the next version's number. */
  readonly sessions: Pick<SessionsRepo, 'latestPlanVersion' | 'getPlan' | 'nextPlanVersion'>;
  /** The analysis and panel history: the latest version of each. */
  readonly panels: Pick<PanelsRepo, 'getLatestAnalysis' | 'getLatestPanel'>;
  /** The modification journal, read only: the chain head of each file the delta patches. */
  readonly modifications: Pick<ModificationsRepo, 'latestRecordForFile'>;
  /** Records the follow-up, its outcome links and plan version n + 1; never a status. */
  readonly sessionManager: Pick<
    SessionManager,
    'appendFollowUp' | 'recordFollowUpOutcome' | 'recordPlan'
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
   * it. The stage writes no session status.
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
 * product defect (AAP §0.5.3). The one record in this module that carries a
 * value: the authoring input, which whoever fixes the defect needs, routed
 * through the service logger's redaction layers.
 */
const PRODUCT_DEFECT_LOG =
  'A follow-up plan version failed deterministic normalisation or validation; it was rejected without a re-prompt and nothing was installed.';

/** Error record of a delta that was installed but whose plan version could not be recorded. */
const UNRECORDED_PLAN_LOG =
  'A follow-up delta was installed but its plan version could not be recorded; the session must not continue on it.';

/** Warn record of an outcome link that could not be stamped. Fields: path, error code. */
const OUTCOME_UNRECORDED_LOG =
  'The follow-up outcome links could not be recorded; the stored artifacts stand.';

/** Warn record of a regenerated panel whose stored predecessor link differs from the expected one. */
const PANEL_SUPERSEDES_LOG =
  'The regenerated panel supersedes a different panel than the one the follow-up was decided against.';

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

/** The instrumentation service reported a different active plan version than the one installed. */
function activeVersionMismatchError(planVersion: number, activePlanVersion: number): DebuggenError {
  return new DebuggenError(
    'INSTRUMENTATION_INSTALL_FAILED',
    'The follow-up delta install did not leave the new plan version active, so it was not recorded.',
    {
      hint: 'End the session to restore every instrumented file, then start again.',
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
 *    `SessionManager.appendFollowUp`.
 * 3. `ContextBuilder.buildFollowUpRequest` with the prompt's seven
 *    placeholders and the session's recorded prompt version; a builder `Err`
 *    (the outbound guard, a prompt that cannot load) means the provider is
 *    never called.
 * 4. `generateStructuredWithRepair` against {@link followUpDecisionSchema},
 *    exactly once; then {@link diffAdditionalActions} and
 *    {@link followUpPathFor}. The `followup` group closes.
 * 5. **Existing evidence**: the `onPathChosen` seam; the analysis port with
 *    `regenerate: true` and the previous analysis as `supersedes`, checked
 *    against the analysis ladder; the `generate-panel` group around the panel
 *    port's `regenerate`.
 * 6. **New capture**: the `plan` group around `nextPlanVersion`, the adapter
 *    context, {@link buildFollowUpPlanInput}, `normalizePlan` with the previous
 *    actions, `instrumentationPlanSchema`, the installed-action check,
 *    `checkPlanFeasibility` and the chain-head read; then the `onPathChosen`
 *    and `beforeInstall` seams, the delta install, and — only once it has
 *    succeeded — `SessionManager.recordPlan`.
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
 *   contextBuilder, provider, summarizer, facts, analysisRegeneration: analyzeStage,
 *   panelRegeneration: panelGenerator, instrumentation, registry, sessions, panels,
 *   modifications, sessionManager, progress, logger,
 * });
 * const outcome = await followUp.run(context, {
 *   followUpQuestion,
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
   * new versions superseding their predecessors. Nothing touches a file and no
   * row is updated in place.
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
    // new one is the newest entry.
    const ladder = callSync(() => deps.facts.history(sessionId), 'STORE_ERROR');
    if (!ladder.ok) {
      return fail(context, log, state, ladder.error, startedAt);
    }
    const kept = ladder.value.some(
      (entry) =>
        entry.id === previousAnalysis.id &&
        entry.analysisVersion === previousAnalysis.analysisVersion,
    );
    if (!kept || ladder.value.at(-1)?.id !== analysis.id) {
      return fail(context, log, state, analysisLadderError(), startedAt);
    }
    if (isAborted(context.signal)) {
      return fail(context, log, state, cancelledError(ANALYZE_STAGE), startedAt);
    }

    // The panel: regenerated from the same stored capture, answering the follow-up question.
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
          signal: context.signal,
        }),
      'INTERNAL',
    );
    if (!generated.ok) {
      return fail(context, log, state, generated.error, startedAt);
    }
    const { panel } = generated.value;
    // The stored link is the panel subsystem's, taken from the store. A disagreement is logged,
    // never turned into a failure of a panel that is already stored and delivered.
    if (panel.supersedes !== previousPanel.id) {
      log.warn(PANEL_SUPERSEDES_LOG, {
        panelVersion: panel.panelVersion,
        previousPanelVersion: previousPanel.panelVersion,
      });
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
        supersededPanelId: panel.supersedes ?? previousPanel.id,
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
   * authoring input and rejected without a re-prompt. Nothing is written.
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
      log.error(PRODUCT_DEFECT_LOG, {
        stage: PLAN_STAGE,
        step: 'normalize',
        code: normalized.error.code,
        planVersion,
        input: authored,
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
        input: authored,
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
        input: authored,
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
   * The new-capture path (`generated → planning → instrumenting → ready`):
   * plan version n + 1 is gated, the delta — and only the delta — is installed
   * by the instrumentation service, and the version is recorded once the
   * install has succeeded. A delta that fails part-way is reverse-restored by
   * the installer itself and leaves the session at version n; nothing is
   * rolled back here and nothing is recorded.
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
      return fail(context, log, state, installed.error, startedAt);
    }
    const installation = installed.value;
    if (installation.activePlanVersion !== plan.planVersion) {
      return fail(
        context,
        log,
        state,
        activeVersionMismatchError(plan.planVersion, installation.activePlanVersion),
        startedAt,
      );
    }

    // Recorded only now: a failed delta never advances the ladder the next follow-up builds on.
    enterDelegated(state, PLAN_STAGE);
    const recorded = await settle(
      () => deps.sessionManager.recordPlan(sessionId, plan),
      'STORE_ERROR',
    );
    if (!recorded.ok) {
      log.error(UNRECORDED_PLAN_LOG, {
        stage: PLAN_STAGE,
        planVersion: plan.planVersion,
        code: recorded.error.code,
      });
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
    const asked = await settle(
      () => deps.sessionManager.appendFollowUp(context.sessionId, input.followUpQuestion),
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
