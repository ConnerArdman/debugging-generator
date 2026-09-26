/**
 * Stage 2 of the local service's reasoning pipeline: **code investigation**
 * (AAP §0.4.2, "AI stage boundaries", Code-investigation row — "model proposes
 * queries, deterministic code executes them; no repository dump").
 *
 * The stage turns the validated Stage 1 {@link ProblemUnderstanding} into a
 * validated {@link CodeInvestigation} — a scored shortlist of relevant files
 * (`SessionRecord.relevantFiles`) and the flows that connect them — which
 * Stage 3 plans instrumentation against.
 *
 * ## The invariant: no source text the model did not ask for
 *
 * The model never receives a listing, a directory walk or a whole file. It
 * receives the generated tool catalog (`describeCodeTools`), the results of the
 * read-only code-graph queries executed so far, and how many further queries it
 * may ask for. Every query it proposes is validated by `parseCodeToolRequest`
 * and executed only through the stage's `CodeTools` executor, whose `excerpt`
 * tool is the single, bounded source of code text and refuses environment
 * files, absolute paths and traversal. This module holds no filesystem handle,
 * spawns nothing and reaches the network only through the injected provider.
 *
 * ## One run, fixed order
 *
 * 1. **Seed.** Deterministic code proposes the first queries from the validated
 *    understanding alone — each named entity becomes the graph query its kind
 *    maps to, then the search hints become name lookups — so the first model
 *    turn already reasons over evidence. Seeds pass the same parser, cost the
 *    same budget and appear in the same result log as model proposals. They are
 *    derived from the artifact, never from the question's wording.
 * 2. **Turn.** `../context-builder.js` builds the request — it caps the result
 *    log, renders the six placeholders of `prompts/investigate/vNNN.md` and
 *    runs the outbound privacy guard (AAP §0.5.2). A builder `Err` aborts the
 *    stage before any provider call.
 * 3. **Gate.** `generateStructuredWithRepair` validates the reply against
 *    {@link investigateReplySchema} — a query batch or the final
 *    {@link CodeInvestigation}, told apart by shape — with at most
 *    `DEFAULT_MAX_REPAIRS` repairs (AAP §0.5.3). There is no normaliser, no
 *    retry and no fallback.
 * 4. **Execute.** A query batch is capped to the remaining budget; every
 *    proposal is parsed, executed or rejected, and appended to the result log.
 *    A rejection is fed back as evidence **and costs budget**, so a confused
 *    model converges instead of looping for free.
 * 5. **Stop.** On a valid investigation (success), a batch proposed after the
 *    budget is spent, the hard turn cap, a cancelled signal, or any builder,
 *    provider or executor failure. Exhaustion is an `Err`: this stage has no
 *    sanctioned fallback, so it never assembles an investigation from the
 *    results itself.
 * 6. **Ground.** A valid investigation is held to the evidence before it is
 *    returned: a shortlisted file no executed query returned is removed, a
 *    symbol no result placed in its file is stripped, and a flow is removed
 *    when a step names nothing a result returned or when two consecutive steps
 *    are joined by no relationship an executed query returned
 *    (`groundInvestigation`). The schema proves the reply well-formed; only the
 *    results prove it true. Grounding asks the model nothing, so it is neither
 *    a repair nor a retry.
 *
 * ## Two loops that must not be confused
 *
 * The propose→execute loop below is a **budgeted conversation**: each turn is a
 * new request carrying new evidence. It is not a repair mechanism. Repairing a
 * malformed reply is `generateStructuredWithRepair`'s job alone, bounded
 * upstream and pinned by `packages/model-provider/src/structured.test.ts`; this
 * module adds no second repair loop around it.
 *
 * ## Progress, privacy, side effects
 *
 * The stage emits its group header, the finding rows built by
 * `../../sessions/progress.js` from what the executed queries actually resolved
 * (`reportInvestigation`), and one closing row. It authors no display row and
 * writes no session status (`../../sessions/manager.ts` is the only writer). A
 * progress row that cannot be emitted is logged at `warn` and never fails the
 * stage. Log records carry the stage, status, tool names, counts, budget and
 * error codes only — never the question, the prompt, the model's output, an
 * excerpt, a path, a URL, a statement or a token — and errors created here
 * carry no payload value.
 *
 * @module
 */

import type {
  ProblemEntity,
  ProblemEntityKind,
  ProblemUnderstanding,
} from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  generateStructuredWithRepair,
  modelUnavailableMessage,
} from '@debuggen/model-provider';
import type { ModelProvider, PromptStage } from '@debuggen/model-provider';
import {
  isPlainRecord,
  opaqueSchema,
  relevantFileSchema,
  sessionRecordSchema,
} from '@debuggen/protocol';
import type { PROGRESS_STAGES, RelevantFile } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  fromPromise,
  isSafeRelativePath,
  normalizePosix,
  ok,
  tryCatch,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

import { sessionLogger, subsystemLogger } from '../../logging.js';
import { MAX_FINDING_ROWS_PER_STAGE } from '../../sessions/progress.js';
import type { InvestigationFindings, SessionProgress } from '../../sessions/progress.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import { CONTEXT_LIMITS, INVESTIGATE_QUERY_BATCH_FIELD } from '../context-builder.js';
import type {
  ContextBuilder,
  InvestigationContextInput,
  PipelineStageContext,
  StageRequestBuild,
} from '../context-builder.js';
import {
  CODE_TOOL_LIMITS,
  CODE_TOOL_NAMES,
  HTTP_METHOD_NAMES,
  createCodeTools,
  describeCodeTools,
  isCodeToolName,
  parseCodeToolRequest,
  resolveCodeToolLimits,
} from '../tools/code-tools.js';
import type {
  CodeToolLimits,
  CodeToolName,
  CodeToolOutcome,
  CodeToolRequest,
  CodeToolRun,
  CodeTools,
  CodeToolsOptions,
} from '../tools/code-tools.js';
import { buildInvestigateReplySchema } from './reply-schemas.js';

/* -------------------------------------------------------------------------------------------------
 * Stage identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * This stage's name in both vocabularies it reports under: the `investigate`
 * member of protocol's `PROGRESS_STAGES` (progress rows, session failures) and
 * of the model boundary's `PROMPT_STAGES` (prompt loading, request metadata).
 * The `satisfies` clause makes a rename in either tuple a compile error here.
 */
const INVESTIGATE_STAGE = 'investigate' as const satisfies (typeof PROGRESS_STAGES)[number] &
  PromptStage;

/** The logger subsystem binding of every pipeline module, per `../../logging.ts`. */
const PIPELINE_SUBSYSTEM = 'pipeline';

/** The artifact name repair feedback and rejection messages use (`options.schemaName`). */
const INVESTIGATION_SCHEMA_NAME = 'code investigation';

/** The label of {@link codeInvestigationSchema}: the exact exported type name, so a rejection is greppable. */
const CODE_INVESTIGATION_LABEL = 'CodeInvestigation';

/**
 * The label of {@link investigateReplySchema}. Written for the model, which
 * reads it in a repair turn as `(root): expected <label>`: it names the key set
 * of each of the two replies, and stays inside the repair line's length bound.
 */
const INVESTIGATE_REPLY_LABEL = `either a query batch (only key "${INVESTIGATE_QUERY_BATCH_FIELD}", a non-empty list of catalogued queries) or the final investigation (only keys "relevantFiles" and "flows")`;

/**
 * The recovery a schema rejection of this stage states instead of the generic
 * one, which offers a deterministic substitute this stage does not have
 * (AAP §0.5.3 sanctions fallbacks for plans and panels only).
 */
const INVESTIGATION_REJECTION_HINT =
  "Ask the question again. The code investigation has no fallback, so no shortlist was recorded; the validation issues are in this error's details.";

/* -------------------------------------------------------------------------------------------------
 * The CodeInvestigation artifact contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * One flow of an investigation: an ordered, named path through the code — the
 * entry point the developer touched, the request it makes, the handler that
 * serves it, the function behind that and the data access behind that —
 * written as **one line of text** (AAP §0.4.2, Code-investigation row,
 * `flows[]`).
 *
 * The wire form is a string because that is what the stage's `{{outputSchema}}`
 * document states (`../context-builder.ts`, `investigateOutputSchema`: flows
 * are strings of 1 to `CONTEXT_LIMITS.maxStringChars` characters, at most
 * `CONTEXT_LIMITS.maxListItems` of them) and what every provider therefore
 * produces. A structured object here would reject every reply that obeys the
 * document the model is given. The bounds are explicit and enforced by
 * {@link isCodeInvestigation}: non-blank, and no longer than the document
 * allows.
 */
export type CodeFlow = string;

/**
 * The validated output of Stage 2 (AAP §0.4.2): the scored shortlist of
 * relevant files, most relevant first, and the flows that connect them.
 *
 * The same shape serves twice. As the model's final reply it is only
 * well-formed; as the stage's result it is also **grounded**: every file on the
 * shortlist was returned by an executed query, every symbol was placed in its
 * file by a result, and every flow step names an evidenced node, route or file
 * (`groundInvestigation`). The stage never returns an ungrounded one.
 *
 * Each `relevantFiles` element **is** protocol's `RelevantFile` — the imported
 * type, validated by the imported `relevantFileSchema` — because the
 * orchestrator persists the list verbatim as `SessionRecord.relevantFiles` and
 * the VS Code `RelevantFiles` view renders it. Its fields are never redeclared
 * here (AAP §0.2.3).
 *
 * **Single-definition rule.** No upstream package defines this shape yet, which
 * is the only reason this module owns {@link isCodeInvestigation} and
 * {@link codeInvestigationSchema}. If a schema for it ever appears in
 * `@debuggen/protocol` or `@debuggen/instrumentation`, switch this module to it
 * and **delete the local guard**: two definitions of a cross-boundary shape are
 * a defect (AAP §0.2.3).
 */
export interface CodeInvestigation {
  /** The shortlist, most relevant first; each entry satisfies `relevantFileSchema`. */
  readonly relevantFiles: readonly RelevantFile[];
  /** The flows connecting the shortlist, one line each. */
  readonly flows: readonly CodeFlow[];
}

/**
 * A reply that asks for further queries: the only other shape an
 * investigation turn may answer with (AAP §0.4.2, "model proposes queries").
 *
 * Each proposal is structurally a call of one catalogued tool by the time the
 * reply reaches the stage: {@link investigateReplySchema} types it per tool
 * (its name, its required arguments, each argument's type), so a structurally
 * malformed proposal is a schema rejection repaired by the one repair loop.
 * The element type stays `unknown` because the stage never trusts that
 * structure: each proposal is still validated by `parseCodeToolRequest` before
 * anything runs, and a value-level refusal (a blank name, an unsafe path, an
 * empty selector) becomes a `CodeToolRejection` fed back as evidence rather
 * than a reason to reject the whole reply.
 */
export interface InvestigateQueryBatch {
  /** The proposed queries, in the order the model wants them run. */
  readonly [INVESTIGATE_QUERY_BATCH_FIELD]: readonly unknown[];
}

/** Everything an investigation turn may validly answer with, told apart by shape. */
export type InvestigateReply = CodeInvestigation | InvestigateQueryBatch;

/** Compiles only when `T` is exactly `true`; the repository's type-assertion idiom. */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that a {@link CodeInvestigation} is exactly what the plan
 * stage's request builder accepts (`InvestigationContextInput`), so the
 * artifact this stage returns can be handed to Stage 3 unchanged. Exported so
 * `noUnusedLocals` treats the assertion as used; it has no runtime existence.
 */
export type CodeInvestigationFeedsPlanRequest = AssertTrue<
  [CodeInvestigation] extends [InvestigationContextInput] ? true : false
>;

/* -------------------------------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------------------------- */

/** Anything that renders itself as a JSON Schema document — every upstream schema object does. */
interface JsonSchemaEmitter {
  toJSONSchema(): unknown;
}

/**
 * The `maxItems` an upstream array schema states in its own JSON Schema
 * rendering, so a bound here is the bound the `{{outputSchema}}` document
 * shows the model, read from the one definition rather than restated.
 *
 * @param emitter The upstream array schema.
 * @param fallback The bound to use when the rendering states none.
 * @returns A positive integer.
 */
function renderedMaxItems(emitter: JsonSchemaEmitter, fallback: number): number {
  const rendered = tryCatch(() => emitter.toJSONSchema(), 'INTERNAL');
  if (rendered.ok && isPlainRecord(rendered.value)) {
    const maxItems = rendered.value['maxItems'];
    if (typeof maxItems === 'number' && Number.isInteger(maxItems) && maxItems >= 1) {
      return maxItems;
    }
  }
  return fallback;
}

/**
 * The most relevant files one investigation may list: the bound
 * `SessionRecord.relevantFiles` carries, read from that schema's own rendering
 * (the same schema the `{{outputSchema}}` document embeds), so an artifact this
 * guard accepts is one the session store accepts.
 */
const MAX_RELEVANT_FILES = renderedMaxItems(
  sessionRecordSchema.shape.relevantFiles,
  CONTEXT_LIMITS.maxListItems,
);

/** The most flows one investigation may list, as the `{{outputSchema}}` document states it. */
const MAX_FLOWS = CONTEXT_LIMITS.maxListItems;

/** The longest flow line, as the `{{outputSchema}}` document states it. */
const MAX_FLOW_CHARS = CONTEXT_LIMITS.maxStringChars;

/**
 * The relevance range of `relevantFileSchema`'s `score` (0 for "listed but
 * unranked", 1 for "certainly the place"). Checked explicitly so a rejection is
 * attributable to the score; the imported schema stays authoritative and is
 * consulted after it.
 */
const MIN_RELEVANCE_SCORE = 0;
const MAX_RELEVANCE_SCORE = 1;

/**
 * The most queries one batch may propose: the most a stage can ever run
 * (`CODE_TOOL_LIMITS.maxCallsPerStage`). A longer batch could never be honoured,
 * so it is refused as a malformed reply rather than silently cut.
 */
const MAX_PROPOSED_QUERIES = CODE_TOOL_LIMITS.maxCallsPerStage;

/** The keys of an investigation, exactly. */
const INVESTIGATION_KEYS: ReadonlySet<string> = new Set(['relevantFiles', 'flows']);

/** The keys a relevant-file entry may carry (`symbol` is optional). */
const RELEVANT_FILE_KEYS: ReadonlySet<string> = new Set(['file', 'symbol', 'reason', 'score']);

/** The keys of a query batch, exactly. */
const QUERY_BATCH_KEYS: ReadonlySet<string> = new Set([INVESTIGATE_QUERY_BATCH_FIELD]);

/* -------------------------------------------------------------------------------------------------
 * The total guard
 * ---------------------------------------------------------------------------------------------- */

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
 * Whether a value is a plain JSON object: not `null`, not an array, and created
 * as an object literal (prototype `Object.prototype`) — the only object shape
 * decoded model output takes. A `Date`, a class instance and a null-prototype
 * object are refused.
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

/** Whether a string carries at least one non-whitespace character. */
function hasVisibleText(value: string): boolean {
  return value.trim().length > 0;
}

/** Whether a value is a finite relevance score inside `relevantFileSchema`'s range. */
function isRelevanceScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_RELEVANCE_SCORE &&
    value <= MAX_RELEVANCE_SCORE
  );
}

/**
 * Whether a value is one valid shortlist entry. Every condition is checked on
 * its own — plain object, known keys only, `file` a project-relative POSIX path
 * (`isSafeRelativePath`), `symbol` a string when present, `reason` non-blank,
 * `score` finite and in range — and then the imported `relevantFileSchema`
 * decides everything else (the length bounds, the single-line symbol rule).
 */
function isRelevantFileEntry(value: unknown): value is RelevantFile {
  if (!isJsonObject(value) || !hasOnlyAllowedKeys(value, RELEVANT_FILE_KEYS)) {
    return false;
  }
  const file = dataProperty(value, 'file');
  if (typeof file !== 'string' || !isSafeRelativePath(file)) {
    return false;
  }
  const symbol = dataProperty(value, 'symbol');
  if (symbol !== ABSENT && typeof symbol !== 'string') {
    return false;
  }
  const reason = dataProperty(value, 'reason');
  if (typeof reason !== 'string' || !hasVisibleText(reason)) {
    return false;
  }
  if (!isRelevanceScore(dataProperty(value, 'score'))) {
    return false;
  }
  return relevantFileSchema.safeParse(value).success;
}

/** Whether a value is one valid flow line: a non-blank string within the stated length. */
function isCodeFlow(value: unknown): value is CodeFlow {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_FLOW_CHARS &&
    hasVisibleText(value)
  );
}

/**
 * Whether a value is a dense array of at most `max` elements that each pass
 * `isElement`. A hole, an accessor element or an over-long list is refused, and
 * the length is checked before any element is visited.
 */
function isBoundedList(
  value: unknown,
  max: number,
  isElement: (element: unknown) => boolean,
): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const list: readonly unknown[] = value;
  if (list.length > max) {
    return false;
  }
  for (let index = 0; index < list.length; index += 1) {
    const element = dataProperty(list, index);
    if (element === ABSENT || !isElement(element)) {
      return false;
    }
  }
  return true;
}

/** The unguarded body of {@link isCodeInvestigation}; may throw on hostile input. */
function checkInvestigation(value: unknown): boolean {
  if (!isJsonObject(value) || !hasOnlyAllowedKeys(value, INVESTIGATION_KEYS)) {
    return false;
  }
  const relevantFiles = dataProperty(value, 'relevantFiles');
  if (!isBoundedList(relevantFiles, MAX_RELEVANT_FILES, isRelevantFileEntry)) {
    return false;
  }
  const flows = dataProperty(value, 'flows');
  return isBoundedList(flows, MAX_FLOWS, isCodeFlow);
}

/**
 * The total type guard of the {@link CodeInvestigation} artifact (AAP §0.4.2,
 * §0.5.3): the runtime check behind {@link codeInvestigationSchema}.
 *
 * Accepts exactly a plain object with the two keys `relevantFiles` and `flows`,
 * where `relevantFiles` is a list of at most the `SessionRecord.relevantFiles`
 * bound whose every entry passes the checks above and the imported
 * `relevantFileSchema`, and `flows` is a list of at most
 * `CONTEXT_LIMITS.maxListItems` non-blank lines of at most
 * `CONTEXT_LIMITS.maxStringChars` characters. Unknown keys are refused at both
 * levels. Only own data properties are read, so a getter never runs.
 *
 * Total: it never throws — a cyclic, proxied or otherwise hostile value is
 * simply `false`.
 *
 * @param value Any value, typically decoded model output.
 * @returns `true` only for a valid investigation, narrowing it.
 */
export function isCodeInvestigation(value: unknown): value is CodeInvestigation {
  try {
    return checkInvestigation(value);
  } catch {
    return false;
  }
}

/** The unguarded body of {@link isQueryBatch}; may throw on hostile input. */
function checkQueryBatch(value: unknown): boolean {
  if (!isJsonObject(value) || !hasOnlyAllowedKeys(value, QUERY_BATCH_KEYS)) {
    return false;
  }
  const queries = dataProperty(value, INVESTIGATE_QUERY_BATCH_FIELD);
  if (!Array.isArray(queries)) {
    return false;
  }
  const list: readonly unknown[] = queries;
  return list.length >= 1 && list.length <= MAX_PROPOSED_QUERIES;
}

/**
 * Whether a value is a query batch: a plain object whose only key is
 * `INVESTIGATE_QUERY_BATCH_FIELD`, holding between one and
 * {@link MAX_PROPOSED_QUERIES} proposals. The proposals themselves are not
 * judged here — `parseCodeToolRequest` judges each one. Total.
 *
 * @param value Any value.
 * @returns `true` for a query batch, narrowing it.
 */
export function isQueryBatch(value: unknown): value is InvestigateQueryBatch {
  try {
    return checkQueryBatch(value);
  } catch {
    return false;
  }
}

/**
 * The schema of the {@link CodeInvestigation} artifact, for
 * `generateStructuredWithRepair` and for any consumer that re-validates a
 * stored investigation (AAP §0.5.3). Built with protocol's `opaqueSchema` over
 * {@link isCodeInvestigation}, so the guard and the schema cannot disagree; a
 * rejection reads `expected CodeInvestigation`.
 */
export const codeInvestigationSchema = opaqueSchema<CodeInvestigation>(
  CODE_INVESTIGATION_LABEL,
  isCodeInvestigation,
);

/**
 * Whether a value is a valid reply of one investigation turn: the final
 * investigation ({@link isCodeInvestigation}) or a query batch
 * ({@link isQueryBatch}). At most one of the two can hold, because their key
 * sets are disjoint. Total.
 *
 * @param value Any value, typically decoded model output.
 * @returns `true` for either reply shape, narrowing it.
 */
export function isInvestigateReply(value: unknown): value is InvestigateReply {
  return isCodeInvestigation(value) || isQueryBatch(value);
}

/**
 * The authoring schema of one investigation turn (AAP §0.4.2, §0.5.3): the
 * final {@link CodeInvestigation} or a query batch, and nothing else —
 * classified by shape afterwards, never by reading prose.
 *
 * Built by the reply-schemas module (`./reply-schemas.ts`) from this module's
 * own guard and bounds, because this is the schema a real provider renders for
 * the model: the schema-constrained route and the forced tool route both need
 * a JSON Schema document with an object root, which an opaque schema cannot
 * produce. Two halves:
 *
 * - {@link isInvestigateReply} decides first. A reply it refuses — the wrong
 *   key set, a bound broken, a hostile value — is one root issue reading
 *   `expected` followed by {@link INVESTIGATE_REPLY_LABEL}, the line a repair
 *   turn shows the model; no key or value of the reply is quoted. The artifact
 *   half of that guard is the same {@link isCodeInvestigation} that
 *   {@link codeInvestigationSchema} is built on, so the two schemas share one
 *   definition of the artifact.
 * - The structural schema then types each proposal of a batch as a call of one
 *   catalogued tool, generated from the tool catalog. A proposal that names no
 *   catalogued tool, lacks a required argument or carries an argument of the
 *   wrong type is refused here, with per-path issues, by the one repair loop.
 *   Value-level checks — blank or over-long strings, unsafe paths, clamped
 *   integers, empty selectors, the excerpt argument rules — stay
 *   `parseCodeToolRequest`'s, and its rejections remain evidence.
 *
 * A parse returns a structurally equal copy of the reply, with any argument key
 * a tool does not declare dropped.
 */
export const investigateReplySchema = buildInvestigateReplySchema({
  label: INVESTIGATE_REPLY_LABEL,
  admits: isInvestigateReply,
  maxQueries: MAX_PROPOSED_QUERIES,
  maxFlows: MAX_FLOWS,
  maxFlowChars: MAX_FLOW_CHARS,
});

/* -------------------------------------------------------------------------------------------------
 * Module contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * The collaborators of the investigate stage, all injected (AAP §0.7.1 Group
 * 2): the stage reads no environment variable, constructs no provider, opens no
 * prompt loader and indexes no project.
 */
export interface InvestigateStageDeps {
  /** Builds, caps, renders and guard-checks each turn's request. */
  readonly contextBuilder: ContextBuilder;
  /** The configured model provider; called only through `generateStructuredWithRepair`. */
  readonly provider: ModelProvider;
  /** Emits the stage's progress rows; owns every title and label. */
  readonly progress: SessionProgress;
  /** A parent logger, bound to the session per run; absent, the context's session-bound logger. */
  readonly logger?: Logger | undefined;
  /**
   * Tighter code-tool limits. Resolved with `resolveCodeToolLimits`, so they can
   * only lower `CODE_TOOL_LIMITS` and the query engine's own ceilings, never
   * raise them.
   */
  readonly limits?: Partial<CodeToolLimits> | undefined;
  /**
   * The repair budget per turn: an integer from `0` to `DEFAULT_MAX_REPAIRS`
   * (AAP §0.5.3, "at most two repairs"), defaulting to the maximum. A value
   * outside that range fails every run with `CONFIG_INVALID` before anything is
   * sent.
   */
  readonly maxRepairs?: number | undefined;
  /**
   * Creates the run's query executor; defaults to `createCodeTools`. The seam
   * exists so a suite can substitute a scripted executor without building a
   * code graph. Whatever it returns is still driven through
   * `parseCodeToolRequest` and `runCodeTool` only.
   */
  readonly createTools?: ((options: CodeToolsOptions) => CodeTools) | undefined;
}

/**
 * What a run needs beyond the {@link PipelineStageContext}, whose `code`
 * handles the orchestrator loaded once for the whole run through its
 * `CodeIndexPort` — this stage never indexes a project itself.
 */
export interface InvestigateStageInput {
  /** The validated Stage 1 artifact the investigation starts from. */
  readonly understanding: ProblemUnderstanding;
  /**
   * The prompt version to use, for a reopened session or a retry that must stay
   * on the version it started with. Absent, the version recorded on the session
   * is reused, and failing that the manifest's current version loads. Every
   * turn of one run uses the version the first turn loaded.
   */
  readonly promptVersion?: string | undefined;
}

/** The validated outcome of a run (AAP §0.4.2, Code-investigation row). */
export interface InvestigateStageResult {
  /** The validated Stage 2 artifact, grounded in the executed queries' results. */
  readonly investigation: CodeInvestigation;
  /** The prompt version every turn used; the orchestrator records it on the session. */
  readonly promptVersion: string;
  /** Repair attempts spent across all turns; `0` when every reply validated first time. */
  readonly repairs: number;
  /** Every query run of the stage — seeds and model proposals, executed or rejected — in order. */
  readonly toolRuns: readonly CodeToolRun[];
}

/**
 * Stage 2 of the pipeline. One method, so the orchestrator's stage overrides
 * can substitute a fake.
 */
export interface InvestigateStage {
  /**
   * Produces the validated code investigation for one pipeline run, grounded
   * in what the run's executed queries returned: files, symbols and flows the
   * results do not bear out are removed before the result is returned, and an
   * investigation grounded down to an empty shortlist is still a success.
   *
   * Never throws. Every failure is an `Err` carrying a `DebuggenError`: the
   * context builder's (a cancelled build, a prompt that cannot load, a payload
   * the outbound guard refused), the structured-output gate's
   * (`MODEL_OUTPUT_INVALID` after the permitted repairs), the provider's
   * (`MODEL_UNAVAILABLE` with the shared sentence of AAP §0.5.5), or this
   * stage's own (`MODEL_OUTPUT_INVALID` when the query budget ran out without an
   * investigation, `INTERNAL` for a cancellation or an executor failure,
   * `CONFIG_INVALID` for a repair budget out of range). The stage writes no
   * session status and applies no fallback.
   *
   * @param context The run's stage context.
   * @param input The Stage 1 understanding and the prompt version to reuse.
   * @returns The investigation with its prompt version, repair count and query runs, or the failure.
   */
  run(
    context: PipelineStageContext,
    input: InvestigateStageInput,
  ): Promise<Result<InvestigateStageResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Seeding from the understanding
 * ---------------------------------------------------------------------------------------------- */

/**
 * The most seed queries a run proposes on the model's behalf: enough to resolve
 * the understanding's leading entities before the first turn, few enough that
 * the model keeps most of the budget. Also bounded by half the run's allowance.
 */
const MAX_SEED_QUERIES = 4;

/** How one entity kind seeds a query: which graph query resolves that kind of thing. */
type SeedStrategy = 'declaration' | 'route' | 'name' | 'none';

/**
 * The query each entity kind seeds, per `ProblemEntityKind`'s own contract
 * (`packages/instrumentation/src/schema/target.ts`): a named declaration is
 * resolved by `findSymbol` when its file is known and `findByName` otherwise, a
 * route or URL by `routeForUrl`, a file or data-layer operation by name. A DOM
 * selector has no graph node to resolve and `other` only contributes a search
 * hint, so neither seeds a query. Total over the vocabulary by its type.
 */
const ENTITY_SEED_STRATEGIES: Readonly<Record<ProblemEntityKind, SeedStrategy>> = Object.freeze({
  component: 'declaration',
  function: 'declaration',
  hook: 'declaration',
  symbol: 'declaration',
  route: 'route',
  url: 'route',
  file: 'name',
  query: 'name',
  selector: 'none',
  other: 'none',
});

/** The unvalidated seed query one entity maps to, or `undefined` when its kind seeds none. */
function entitySeed(entity: ProblemEntity): unknown {
  switch (ENTITY_SEED_STRATEGIES[entity.kind]) {
    case 'declaration':
      return entity.file !== undefined
        ? { tool: 'findSymbol', file: normalizePosix(entity.file), symbol: entity.name }
        : { tool: 'findByName', name: entity.name };
    case 'route':
      return { tool: 'routeForUrl', url: entity.name };
    case 'name':
      return { tool: 'findByName', name: entity.name };
    case 'none':
      return undefined;
  }
}

/**
 * The seed queries of a run, derived from the validated understanding alone:
 * the entities in the producer's order (most relevant first), then the search
 * hints as name lookups. Each candidate is validated with
 * `parseCodeToolRequest`; one that does not parse is simply not proposed (a
 * seed is the stage's own suggestion, so dropping it costs the model nothing),
 * and duplicates of an already-proposed normalised request are skipped.
 *
 * Wording-invariant by construction (AAP §0.5.4): nothing here reads the
 * question, only the schema-validated artifact.
 *
 * @param understanding The Stage 1 artifact.
 * @param limits The effective tool limits, for normalisation.
 * @param max The most seeds to return.
 * @returns The normalised seed requests.
 */
function seedRequests(
  understanding: ProblemUnderstanding,
  limits: CodeToolLimits,
  max: number,
): readonly CodeToolRequest[] {
  const candidates: unknown[] = [
    ...understanding.entities.map(entitySeed),
    ...understanding.searchHints.map((hint) => ({ tool: 'findByName', name: hint })),
  ];
  const seeds: CodeToolRequest[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seeds.length >= max) {
      break;
    }
    if (candidate === undefined) {
      continue;
    }
    const parsed = parseCodeToolRequest(candidate, limits);
    if (!parsed.ok) {
      continue;
    }
    const identity = JSON.stringify(parsed.value);
    if (!seen.has(identity)) {
      seen.add(identity);
      seeds.push(parsed.value);
    }
  }
  return seeds;
}

/* -------------------------------------------------------------------------------------------------
 * Evidence: what the executed queries actually resolved
 * ---------------------------------------------------------------------------------------------- */

/** One code-graph node a query result named. */
interface EvidenceNode {
  readonly kind: string;
  readonly name: string;
  readonly file: string;
}

/** One route a `routeForUrl` result resolved. */
interface EvidenceRoute {
  readonly routePath: string;
  readonly file: string;
}

/**
 * Everything the executed queries showed, collected structurally from the
 * successful outcomes alone: what they named (nodes, routes, files, the
 * declared names placed in each file) and how they related those names
 * (`links`). Grounding reads the first to decide whether a step exists and the
 * second to decide whether two consecutive steps are connected.
 */
interface Evidence {
  readonly nodes: EvidenceNode[];
  readonly routes: EvidenceRoute[];
  readonly files: Set<string>;
  /**
   * The declared names a result placed in each file: every node's `name`, the
   * `symbol` of every located declaration a result carries (a source location,
   * a symbol match), and the `symbol` a `handlersFor` handler reports for its
   * location's file. What a shortlist entry's `symbol` is grounded against.
   */
  readonly symbols: Map<string, Set<string>>;
  /**
   * The unordered pairs of identifiers (node names, route paths, files) that a
   * successful query result **related** to each other, keyed by
   * {@link linkKey}. Unordered, because a path found by an undirected search
   * may traverse an edge against its direction and a flow may be written either
   * way round; what is asserted is a connection, never its direction. The
   * sources, each taken only from what a result returned:
   *
   * - `pathBetween`: each two consecutive nodes of the returned path, in the
   *   path's own traversal order;
   * - `whoCalls`: each caller's name and the called `symbol` of the executed
   *   request;
   * - `componentsRendering`: each rendering parent's name and the rendered
   *   `component` of the executed request;
   * - `routeForUrl`: the resolved route path and its route node's name, and the
   *   route path and its module file;
   * - every recorded node: its file and its name (the containment the result
   *   showed).
   *
   * `handlersFor` contributes no link: its handlers carry a method, a symbol
   * and a location, and its request a URL, so neither names the route path a
   * handler serves, and a link to it would be inferred rather than returned.
   */
  readonly links: Set<string>;
}

/** Records a declared name a result placed in `file`. */
function addSymbol(evidence: Evidence, file: string, name: string | undefined): void {
  if (name === undefined || name.length === 0) {
    return;
  }
  const names = evidence.symbols.get(file) ?? new Set<string>();
  names.add(name);
  evidence.symbols.set(file, names);
}

/**
 * Separates the two identifiers of a {@link Evidence.links} key. NUL is never
 * part of an identifier that is keyed — {@link linkKey} refuses one holding
 * it — so every key names exactly one pair and two different pairs can never
 * collide.
 */
const LINK_KEY_SEPARATOR = '\u0000';

/**
 * The key of the unordered pair `{left, right}`: the two identifiers in code
 * unit order, joined by {@link LINK_KEY_SEPARATOR}. `undefined` for an empty
 * identifier or one containing the separator, which is then never linked.
 */
function linkKey(left: string, right: string): string | undefined {
  if (
    left.length === 0 ||
    right.length === 0 ||
    left.includes(LINK_KEY_SEPARATOR) ||
    right.includes(LINK_KEY_SEPARATOR)
  ) {
    return undefined;
  }
  return left <= right
    ? `${left}${LINK_KEY_SEPARATOR}${right}`
    : `${right}${LINK_KEY_SEPARATOR}${left}`;
}

/** Records that a result related `left` and `right`; an absent or unkeyable identifier records nothing. */
function addLink(evidence: Evidence, left: string | undefined, right: string | undefined): void {
  if (left === undefined || right === undefined) {
    return;
  }
  const key = linkKey(left, right);
  if (key !== undefined) {
    evidence.links.add(key);
  }
}

/** Whether a result related `left` and `right`, in either order. */
function isLinked(evidence: Evidence, left: string, right: string): boolean {
  const key = linkKey(left, right);
  return key !== undefined && evidence.links.has(key);
}

/** Reads one string field of an unknown value, or `undefined`. */
function stringField(value: unknown, key: string): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const field = dataProperty(value, key);
  return typeof field === 'string' ? field : undefined;
}

/** Reads one field of an unknown value as `unknown`, or `undefined`. */
function anyField(value: unknown, key: string): unknown {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const field = dataProperty(value, key);
  return field === ABSENT ? undefined : field;
}

/**
 * The data elements of an unknown list, or none. Holes and accessor elements
 * are skipped, so reading a result never runs a getter.
 */
function listItems(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const list: readonly unknown[] = value;
  const items: unknown[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = dataProperty(list, index);
    if (item !== ABSENT) {
      items.push(item);
    }
  }
  return items;
}

/** Records a file a result showed, when it is a safe project-relative path. */
function addFile(evidence: Evidence, file: string | undefined): void {
  if (file !== undefined && isSafeRelativePath(file)) {
    evidence.files.add(file);
  }
}

/**
 * Records a code match (`{ kind, name, file }`) a result named, together with
 * the containment link between its file and its name.
 *
 * @returns The recorded node, or `undefined` when the match is malformed and
 * contributed nothing — so a caller links only what was actually recorded.
 */
function addNode(evidence: Evidence, match: unknown): EvidenceNode | undefined {
  const kind = stringField(match, 'kind');
  const name = stringField(match, 'name');
  const file = stringField(match, 'file');
  if (kind === undefined || name === undefined || file === undefined || !isSafeRelativePath(file)) {
    return undefined;
  }
  const node: EvidenceNode = { kind, name, file };
  evidence.nodes.push(node);
  evidence.files.add(file);
  addSymbol(evidence, file, name);
  addLink(evidence, file, name);
  return node;
}

/**
 * Reads one tool's successful outcome for evidence: its `payload`, and the
 * executed, parser-normalised `request` that produced it (the called symbol of
 * a `whoCalls`, the rendered component of a `componentsRendering`). Both are
 * read as `unknown`.
 */
type EvidenceReader = (payload: unknown, request: unknown, into: Evidence) => void;

/**
 * How each tool's outcome is read for evidence, total over the tool vocabulary
 * by its type. Payloads and requests are read as `unknown` and checked field by
 * field through own data properties only, so a malformed answer contributes
 * nothing rather than failing the stage, and no getter ever runs. What each
 * reader links is listed on {@link Evidence.links}.
 */
const EVIDENCE_READERS: Readonly<Record<CodeToolName, EvidenceReader>> = Object.freeze({
  findByName: (payload, _request, into) => {
    for (const match of listItems(payload)) {
      addNode(into, match);
    }
  },
  findSymbol: (payload, _request, into) => {
    addNode(into, payload);
  },
  whoCalls: (payload, request, into) => {
    const called = stringField(request, 'symbol');
    for (const caller of listItems(payload)) {
      const node = addNode(into, anyField(caller, 'caller'));
      if (node !== undefined) {
        addLink(into, node.name, called);
      }
    }
  },
  routeForUrl: (payload, _request, into) => {
    const routePath = stringField(payload, 'routePath');
    const file = stringField(payload, 'file');
    if (routePath !== undefined && file !== undefined && isSafeRelativePath(file)) {
      into.routes.push({ routePath, file });
      into.files.add(file);
      addLink(into, routePath, file);
    }
    const node = addNode(into, anyField(payload, 'node'));
    if (node !== undefined) {
      addLink(into, routePath, node.name);
    }
  },
  handlersFor: (payload, _request, into) => {
    for (const handler of listItems(payload)) {
      const file = stringField(anyField(handler, 'location'), 'file');
      addFile(into, file);
      if (file !== undefined && into.files.has(file)) {
        addSymbol(into, file, stringField(handler, 'symbol'));
      }
    }
  },
  componentsRendering: (payload, request, into) => {
    const rendered = stringField(request, 'component');
    for (const parent of listItems(payload)) {
      const node = addNode(into, anyField(parent, 'component'));
      if (node !== undefined) {
        addLink(into, node.name, rendered);
      }
    }
  },
  pathBetween: (payload, _request, into) => {
    // Index by index rather than through `listItems`, which compacts: a hole or
    // a malformed node breaks the chain there, so the nodes either side of it —
    // which the path never joined directly — are not linked.
    const nodes = anyField(payload, 'nodes');
    if (!Array.isArray(nodes)) {
      return;
    }
    const list: readonly unknown[] = nodes;
    let previous: EvidenceNode | undefined;
    for (let index = 0; index < list.length; index += 1) {
      const item = dataProperty(list, index);
      const node = item === ABSENT ? undefined : addNode(into, item);
      if (node !== undefined && previous !== undefined) {
        addLink(into, previous.name, node.name);
      }
      previous = node;
    }
  },
  excerpt: (payload, _request, into) => {
    addFile(into, stringField(payload, 'file'));
  },
});

/**
 * How deep {@link addLocatedSymbols} descends into one result payload. A query
 * result nests a declaration's location at most a few levels down (a route's
 * `methodLocations.GET`, a path's `nodes[i].location`); the bound keeps the walk
 * linear in the payload however it is shaped.
 */
const MAX_EVIDENCE_DEPTH = 8;

/**
 * Records every file a result payload returns, and every declared name it
 * places in one: each object, at any depth, that carries a safe
 * project-relative `file` contributes that file, and with it its `symbol` when
 * it names one — a source location's enclosing declaration (`GET` in a route
 * file), a symbol match. Own data properties only, so no getter runs; a
 * `request` echo is skipped, so a name that was merely asked for is never
 * evidence.
 */
function addLocatedSymbols(evidence: Evidence, value: unknown, depth: number): void {
  if (depth > MAX_EVIDENCE_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of listItems(value)) {
      addLocatedSymbols(evidence, item, depth + 1);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  const file = stringField(value, 'file');
  if (file !== undefined && isSafeRelativePath(file)) {
    evidence.files.add(file);
    addSymbol(evidence, file, stringField(value, 'symbol'));
  }
  for (const key of Object.keys(value)) {
    if (key !== 'request') {
      const entry = anyField(value, key);
      if (entry !== undefined) {
        addLocatedSymbols(evidence, entry, depth + 1);
      }
    }
  }
}

/**
 * Collects the evidence of every successful run: the graph nodes, routes and
 * files the results named, the declared names they placed in each file, and
 * the pairs of identifiers they related ({@link Evidence.links}). Each reader
 * is handed the outcome's own executed request — the parser-normalised request
 * the executor echoes — never the proposal as the model wrote it. Rejections
 * carry no evidence.
 */
function collectEvidence(runs: readonly CodeToolRun[]): Evidence {
  const evidence: Evidence = {
    nodes: [],
    routes: [],
    files: new Set<string>(),
    symbols: new Map<string, Set<string>>(),
    links: new Set<string>(),
  };
  for (const run of runs) {
    const outcome: CodeToolOutcome = run.outcome;
    if (!outcome.ok) {
      continue;
    }
    const tool: unknown = outcome.value.tool;
    if (!isCodeToolName(tool)) {
      continue;
    }
    const payload: unknown = outcome.value.payload;
    const request: unknown = outcome.value.request;
    EVIDENCE_READERS[tool](payload, request, evidence);
    addLocatedSymbols(evidence, payload, 0);
  }
  return evidence;
}

/* -------------------------------------------------------------------------------------------------
 * Grounding: the investigation keeps only what the executed queries showed
 * ---------------------------------------------------------------------------------------------- */

/** Splits a flow into its steps at the arrow the prompt and the rules provider write, in either spelling. */
const FLOW_STEP_SEPARATOR = /\s*(?:→|->)\s*/u;

/** A flow step that names a route by method: `<HTTP method> <route path>`. */
const METHOD_ROUTE_STEP = /^(\S+)\s+(\S.*)$/u;

/** The methods a method-qualified route step may name: the upstream vocabulary, never restated. */
const HTTP_METHODS: ReadonlySet<string> = new Set<string>(HTTP_METHOD_NAMES);

/** An investigation held to the evidence, and what holding it there removed — counts only. */
interface GroundedInvestigation {
  /** The grounded investigation, frozen and detached from the model's reply. */
  readonly investigation: CodeInvestigation;
  /** Shortlist entries dropped because no executed query returned their file. */
  readonly removedFileCount: number;
  /** Kept entries whose symbol no executed query placed in their file; the symbol alone was dropped. */
  readonly strippedSymbolCount: number;
  /**
   * Flows dropped because a step named nothing an executed query returned, or
   * because two consecutive steps were joined by no relationship one returned.
   */
  readonly removedFlowCount: number;
}

/** A shortlist entry under its evidenced file spelling, without its symbol; reason and score kept. */
function withoutSymbol(entry: RelevantFile, file: string): RelevantFile {
  const copy: { -readonly [Key in keyof RelevantFile]: RelevantFile[Key] } = { ...entry, file };
  delete copy.symbol;
  return copy;
}

/**
 * Holds a validated investigation to what the run's executed queries actually
 * returned (AAP §0.4.2: "model proposes queries, deterministic code executes
 * them"). The reply schema proves the investigation well-formed; only the
 * evidence can prove it true, so nothing the model merely asserted reaches
 * Stage 3, the stored session or the editor's relevant-files view.
 *
 * - **Files.** An entry is kept only when a successful query result named its
 *   file (compared in normal POSIX form, which is also the spelling kept).
 * - **Symbols.** A kept entry whose `symbol` no result placed in that same file
 *   loses the symbol and keeps its grounded file, reason and score: the file is
 *   still evidenced, the declaration is not.
 * - **Flows.** A flow is a claim that its steps are connected, so both halves
 *   of the claim must be evidenced:
 *   1. every step between its arrows (`→` or `->`) is non-empty and is an
 *      evidenced node or symbol name, an evidenced route path (a `routeForUrl`
 *      result or an `api-route` node), an evidenced file, or
 *      `<HTTP method> <evidenced route path>` — prose steps are not evidence;
 *   2. every two consecutive steps are **linked**: a successful executed query
 *      returned a relationship between them ({@link Evidence.links} lists the
 *      sources). A method-qualified route step is compared as its route path.
 *      Two names that separate lookups each found — two unrelated
 *      `findByName` hits — are not linked, so the model cannot connect them by
 *      writing an arrow between them.
 *
 *   A single-step flow asserts no connection and needs its step evidenced only.
 *   A flow the rules-based provider writes — the node names of a `pathBetween`
 *   result joined by arrows, in the path's order — is grounded by
 *   construction, because each two consecutive names of it are a link.
 *
 * Pure and total. Grounding is not a repair: it never asks the model again,
 * never retries and never substitutes anything, and an investigation grounded
 * down to an empty shortlist is still a valid result (Stage 3 then plans from
 * the runtime signals alone). What it removed is reported as counts only.
 *
 * @param investigation The investigation the reply schema accepted.
 * @param evidence What the run's executed queries returned.
 * @returns The grounded investigation and the counts of what was removed.
 */
function groundInvestigation(
  investigation: CodeInvestigation,
  evidence: Evidence,
): GroundedInvestigation {
  let removedFileCount = 0;
  let strippedSymbolCount = 0;
  const relevantFiles: RelevantFile[] = [];
  for (const entry of investigation.relevantFiles) {
    const file = normalizePosix(entry.file);
    if (!evidence.files.has(file)) {
      removedFileCount += 1;
      continue;
    }
    if (entry.symbol !== undefined && evidence.symbols.get(file)?.has(entry.symbol) !== true) {
      strippedSymbolCount += 1;
      relevantFiles.push(withoutSymbol(entry, file));
      continue;
    }
    relevantFiles.push({ ...entry, file });
  }

  const routePaths = new Set<string>([
    ...evidence.routes.map((route) => route.routePath),
    ...evidence.nodes.filter((node) => node.kind === 'api-route').map((node) => node.name),
  ]);
  const names = new Set<string>([...evidence.files, ...routePaths]);
  for (const declared of evidence.symbols.values()) {
    for (const name of declared) {
      names.add(name);
    }
  }
  // The evidenced identifier a step names — the step itself, or the route path
  // of a `<HTTP method> <route path>` step — or `undefined` for a step that
  // names nothing a result returned.
  const stepIdentifier = (step: string): string | undefined => {
    if (step.length === 0) {
      return undefined;
    }
    if (names.has(step)) {
      return step;
    }
    const [, method, routePath] = METHOD_ROUTE_STEP.exec(step) ?? [];
    return method !== undefined &&
      routePath !== undefined &&
      HTTP_METHODS.has(method) &&
      routePaths.has(routePath)
      ? routePath
      : undefined;
  };
  // Every step evidenced, and every two consecutive steps linked.
  const isGroundedFlow = (flow: string): boolean => {
    let previous: string | undefined;
    for (const step of flow.trim().split(FLOW_STEP_SEPARATOR)) {
      const identifier = stepIdentifier(step);
      if (identifier === undefined) {
        return false;
      }
      if (previous !== undefined && !isLinked(evidence, previous, identifier)) {
        return false;
      }
      previous = identifier;
    }
    return true;
  };
  const flows = investigation.flows.filter(isGroundedFlow);

  return {
    investigation: detachInvestigation({ relevantFiles, flows }),
    removedFileCount,
    strippedSymbolCount,
    removedFlowCount: investigation.flows.length - flows.length,
  };
}

/** Up to {@link MAX_FINDING_ROWS_PER_STAGE} distinct names, in first-seen order. */
function distinctHead(names: Iterable<string>): readonly string[] {
  const kept: string[] = [];
  for (const name of names) {
    if (kept.length >= MAX_FINDING_ROWS_PER_STAGE) {
      break;
    }
    if (!kept.includes(name)) {
      kept.push(name);
    }
  }
  return kept;
}

/**
 * The findings the progress rows are built from: what the executed queries
 * resolved **and** the investigation kept (AAP §0.4.2; the Step-8 rows of the
 * prompt's §11 are rendered by `../../sessions/progress.js` from these).
 *
 * - components and event handlers: a `component` / `handler` node a result
 *   named whose file is on the shortlist with that symbol (or with no symbol);
 * - routes: a route a `routeForUrl` result resolved, or an `api-route` node,
 *   whose file is on the shortlist;
 * - database dependencies: a `db-call` node whose file is on the shortlist.
 *
 * Every class is passed explicitly — even empty — because an explicit array is
 * authoritative there, so no row is ever derived from a name the question
 * merely mentioned. The shortlist supplies each row's origin file.
 */
function findingsOf(investigation: CodeInvestigation, evidence: Evidence): InvestigationFindings {
  const shortlist = new Map<string, Set<string>>();
  for (const entry of investigation.relevantFiles) {
    const symbols = shortlist.get(entry.file) ?? new Set<string>();
    symbols.add(entry.symbol ?? '');
    shortlist.set(entry.file, symbols);
  }
  const onShortlist = (node: EvidenceNode): boolean => {
    const symbols = shortlist.get(node.file);
    return symbols !== undefined && (symbols.has('') || symbols.has(node.name));
  };
  const nodesOfKind = (kind: string): readonly EvidenceNode[] =>
    evidence.nodes.filter((node) => node.kind === kind);

  return {
    components: distinctHead(
      nodesOfKind('component')
        .filter(onShortlist)
        .map((node) => node.name),
    ),
    eventHandlers: distinctHead(
      nodesOfKind('handler')
        .filter(onShortlist)
        .map((node) => node.name),
    ),
    routes: distinctHead([
      ...evidence.routes
        .filter((route) => shortlist.has(route.file))
        .map((route) => route.routePath),
      ...nodesOfKind('api-route')
        .filter((node) => shortlist.has(node.file))
        .map((node) => node.name),
    ]),
    databaseDependencies: distinctHead(
      nodesOfKind('db-call')
        .filter((node) => shortlist.has(node.file))
        .map((node) => node.name),
    ),
    relevantFiles: investigation.relevantFiles,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Failures and log records
 * ---------------------------------------------------------------------------------------------- */

/** Debug record at the start of a run. Fields: stage, allowance, seed count. */
const STARTED_LOG = 'Investigate stage started.';

/** Debug record of one executed batch. Fields: stage, turn, counts, tool names, budget. */
const BATCH_LOG = 'Investigate stage executed a query batch.';

/**
 * Info record of a validated investigation. Fields: version, counts, budget,
 * timing, and what grounding removed (file, symbol and flow counts).
 */
const COMPLETED_LOG = 'Investigate stage produced a validated code investigation.';

/** Warn record of a failed run. Fields: stage, error code, rejection reason, counts. */
const FAILED_LOG = 'Investigate stage failed; no code investigation was produced.';

/** Debug record of a run whose signal was aborted before it began. */
const CANCELLED_LOG = 'Investigate stage cancelled before it started.';

/** Warn record of a progress row that could not be emitted. Fields: stage, row, error code. */
const PROGRESS_FAILED_LOG =
  'A progress row of the investigate stage could not be emitted; the stage continues.';

/** Which progress emission a {@link PROGRESS_FAILED_LOG} record is about. */
type ProgressRowKind = 'started' | 'findings' | 'completed' | 'failed';

/** An enumerated reason: a short kebab-case identifier, the only `details.reason` shape logged. */
const REASON_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

/** Whether a repair budget is one `generateStructuredWithRepair` accepts. */
function isValidRepairBudget(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= DEFAULT_MAX_REPAIRS;
}

/** The failure of a run configured with a repair budget outside the permitted range. */
function repairBudgetError(value: number): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The investigate stage was configured with a repair budget outside 0 to ${String(DEFAULT_MAX_REPAIRS)}, so no request was sent.`,
    {
      hint: 'Construct the stage without maxRepairs to use the default budget, or pass an integer within the permitted range.',
      details: {
        stage: INVESTIGATE_STAGE,
        reason: 'repair-budget',
        maxRepairs: Number.isFinite(value) ? value : String(value),
      },
    },
  );
}

/**
 * The failure of a cancelled run. Shaped like the context builder's own
 * cancellation (`INTERNAL`, `details.reason: "aborted"`), so the orchestrator
 * recognises a cancellation the same way whichever layer observed it.
 */
function cancelledError(): DebuggenError {
  return new DebuggenError('INTERNAL', 'The investigate stage was cancelled.', {
    details: { stage: INVESTIGATE_STAGE, reason: 'aborted' },
  });
}

/** The counters a stage failure reports: numbers only, never a payload value. */
interface RunCounters {
  readonly turns: number;
  readonly queriesRun: number;
  readonly queriesRejected: number;
}

/**
 * The failure of a run whose query budget is spent and whose model still asked
 * for queries instead of emitting the investigation. There is no fallback
 * (AAP §0.5.3): an investigation assembled here would claim relevance no model
 * reached.
 */
function budgetExhaustedError(counters: RunCounters): DebuggenError {
  return new DebuggenError(
    'MODEL_OUTPUT_INVALID',
    'The code investigation spent its query budget without producing an investigation, so no shortlist was recorded.',
    {
      hint: 'Ask again, naming the component, handler or route the question is about, or select the element in DevTools first.',
      details: { stage: INVESTIGATE_STAGE, reason: 'query-budget-exhausted', ...counters },
    },
  );
}

/** The failure of a run that reached the hard turn cap without an investigation. */
function turnLimitError(counters: RunCounters): DebuggenError {
  return new DebuggenError(
    'MODEL_OUTPUT_INVALID',
    'The code investigation reached its turn limit without producing an investigation, so no shortlist was recorded.',
    {
      hint: 'Ask again, naming the component, handler or route the question is about, or select the element in DevTools first.',
      details: { stage: INVESTIGATE_STAGE, reason: 'turn-limit', ...counters },
    },
  );
}

/** The failure of a run whose query executor could not be created, read or run. */
function executorError(cause: DebuggenError): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    'The code-query executor of the investigate stage failed, so the investigation stopped.',
    {
      hint: 'This is a product defect rather than a model failure; the service log records the failing step.',
      details: { stage: INVESTIGATE_STAGE, reason: 'tool-executor-failed', causeCode: cause.code },
      cause,
    },
  );
}

/** The failure of a validated reply that is neither shape — unreachable while the schemas agree. */
function unclassifiedReplyError(): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    'An investigation reply passed validation but matched neither reply shape.',
    { details: { stage: INVESTIGATE_STAGE, reason: 'reply-unclassified' } },
  );
}

/**
 * The enumerated `details.reason` of an error, when it has one. Upstream
 * modules put a closed-vocabulary identifier there; anything else is left out
 * of the log record rather than trusted.
 */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && REASON_PATTERN.test(reason) ? reason : undefined;
}

/**
 * Whether the run's signal has fired. A function rather than an inline property
 * test so each call reads the signal afresh while the stage awaits.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The model boundary's failure as this stage reports it.
 *
 * - A transport failure (`details.reason === 'provider'` with
 *   `MODEL_UNAVAILABLE`) that was not a cancellation carries AAP §0.5.5's
 *   sentence, built by `modelUnavailableMessage` — its one definition. The
 *   provider normally already uses it; one that did not is re-worded, keeping
 *   its code, hint and details and chaining the original as `cause`.
 * - A reply that never satisfied the reply schema keeps its code, message and
 *   details, and its hint states the recovery that exists for this stage
 *   ({@link INVESTIGATION_REJECTION_HINT}) instead of a substitute artifact that
 *   does not.
 * - Everything else is passed through unchanged.
 */
function shapeModelFailure(error: DebuggenError, signal: AbortSignal | undefined): DebuggenError {
  const reason = reasonOf(error);
  if (reason === 'schema' && error.code === 'MODEL_OUTPUT_INVALID') {
    return new DebuggenError(error.code, error.message, {
      hint: INVESTIGATION_REJECTION_HINT,
      ...(error.details !== undefined ? { details: error.details } : {}),
      cause: error,
    });
  }
  if (reason !== 'provider' || error.code !== 'MODEL_UNAVAILABLE' || isAborted(signal)) {
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

/**
 * The {@link SessionFailure} the `failed` progress row is built from: this
 * stage, and the failing subsystem's own code, message and hint.
 */
function sessionFailureOf(error: DebuggenError): SessionFailure {
  return error.hint === undefined
    ? { stage: INVESTIGATE_STAGE, code: error.code, message: error.message }
    : { stage: INVESTIGATE_STAGE, code: error.code, message: error.message, hint: error.hint };
}

/** The error a progress emission reported or threw, or `undefined` when it succeeded. */
function progressFailureOf(
  sent: Result<Result<unknown, DebuggenError>, DebuggenError>,
): DebuggenError | undefined {
  if (!sent.ok) {
    return sent.error;
  }
  return sent.value.ok ? undefined : sent.value.error;
}

/** A non-negative integer count, `0` for anything that is not a finite number. */
function toCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * The proposals of a query batch, at most `max` of them, in order. A hole or an
 * accessor element is read as `undefined`, which `parseCodeToolRequest` then
 * rejects like any other malformed proposal.
 */
function proposalsOf(batch: InvestigateQueryBatch, max: number): readonly unknown[] {
  const list = batch[INVESTIGATE_QUERY_BATCH_FIELD];
  const proposals: unknown[] = [];
  for (let index = 0; index < list.length && proposals.length < max; index += 1) {
    const proposal = dataProperty(list, index);
    proposals.push(proposal === ABSENT ? undefined : proposal);
  }
  return proposals;
}

/** A frozen, detached copy of a validated investigation, so the caller owns what it stores. */
function detachInvestigation(investigation: CodeInvestigation): CodeInvestigation {
  return Object.freeze({
    relevantFiles: Object.freeze(
      investigation.relevantFiles.map((entry) => Object.freeze({ ...entry })),
    ),
    flows: Object.freeze([...investigation.flows]),
  });
}

/* -------------------------------------------------------------------------------------------------
 * The stage
 * ---------------------------------------------------------------------------------------------- */

/** The mutable state of one run's budgeted conversation. */
interface ConversationState {
  /** Every query run so far — seeds and proposals, executed or rejected — in order. */
  readonly runs: CodeToolRun[];
  /** Queries the run may still ask for; every processed proposal costs one. */
  remaining: number;
  /** Proposals refused, by the parser or by the executor. */
  rejected: number;
  /** Repair attempts spent across all turns. */
  repairs: number;
  /** Provider turns taken. */
  turns: number;
}

/**
 * Creates Stage 2, code investigation (AAP §0.4.2, §0.5.3, §0.5.4).
 *
 * The factory holds no state beyond its collaborators; each `run` creates its
 * own query executor and budget, so one instance serves every session of the
 * process.
 *
 * @param deps The context builder, provider, progress emitter and options.
 * @returns The stage.
 *
 * @example
 * ```ts
 * const investigate = createInvestigateStage({ contextBuilder, provider, progress, logger });
 * const outcome = await investigate.run(context, { understanding, promptVersion: recorded });
 * if (outcome.ok) {
 *   sessions.patch(sessionId, { relevantFiles: outcome.value.investigation.relevantFiles });
 * }
 * ```
 */
export function createInvestigateStage(deps: InvestigateStageDeps): InvestigateStage {
  const { contextBuilder, provider, progress } = deps;
  const maxRepairs = deps.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const createTools = deps.createTools ?? createCodeTools;
  const requestedLimits = resolveCodeToolLimits(deps.limits);

  /** The run's logger: session-bound, then bound to the pipeline subsystem and this stage. */
  const loggerFor = (context: PipelineStageContext): Logger => {
    const base =
      deps.logger === undefined
        ? context.logger
        : sessionLogger(deps.logger, context.sessionId, context.captureId);
    return subsystemLogger(base, PIPELINE_SUBSYSTEM).child({ stage: INVESTIGATE_STAGE });
  };

  /** Emits one progress row; a failure is logged at `warn` and never fails the stage. */
  const emitProgress = (
    row: ProgressRowKind,
    log: Logger,
    send: () => Result<unknown, DebuggenError>,
  ): void => {
    const failure = progressFailureOf(tryCatch(send, 'INTERNAL'));
    if (failure !== undefined) {
      log.warn(PROGRESS_FAILED_LOG, { stage: INVESTIGATE_STAGE, row, code: failure.code });
    }
  };

  /** Closes the stage's progress group with its `failed` row and returns the failure unchanged. */
  const fail = (
    context: PipelineStageContext,
    log: Logger,
    error: DebuggenError,
    state: ConversationState | undefined,
  ): Result<InvestigateStageResult, DebuggenError> => {
    const reason = reasonOf(error);
    log.warn(FAILED_LOG, {
      stage: INVESTIGATE_STAGE,
      code: error.code,
      ...(reason !== undefined ? { reason } : {}),
      ...(state !== undefined
        ? { turns: state.turns, queriesRun: state.runs.length, queriesRejected: state.rejected }
        : {}),
    });
    emitProgress('failed', log, () =>
      progress.stageFailed(context.sessionId, sessionFailureOf(error)),
    );
    return err(error);
  };

  /** The counters of a run, for a failure's details. */
  const countersOf = (state: ConversationState): RunCounters => ({
    turns: state.turns,
    queriesRun: state.runs.length,
    queriesRejected: state.rejected,
  });

  /** Builds one turn's request through the context builder; an unexpected throw becomes an `Err`. */
  const buildTurn = (
    context: PipelineStageContext,
    understanding: ProblemUnderstanding,
    toolCatalog: string,
    state: ConversationState,
    promptVersion: string | undefined,
  ): Result<StageRequestBuild, DebuggenError> => {
    const built = tryCatch(
      () =>
        contextBuilder.buildInvestigateRequest({
          context,
          understanding,
          toolCatalog,
          queryResults: [...state.runs],
          remainingQueries: state.remaining,
          toolNames: CODE_TOOL_NAMES,
          promptVersion,
        }),
      'INTERNAL',
    );
    return built.ok ? built.value : built;
  };

  /**
   * Validates and executes one list of proposals, in order, appending one run
   * per proposal and charging one unit of budget per proposal — a rejection
   * included. Validation (`parseCodeToolRequest`) always precedes execution
   * (`runCodeTool`), and nothing else ever reaches the executor.
   */
  const execute = async (
    tools: CodeTools,
    proposals: readonly unknown[],
    limits: CodeToolLimits,
    state: ConversationState,
    signal: AbortSignal | undefined,
  ): Promise<Result<void, DebuggenError>> => {
    for (let index = 0; index < proposals.length; index += 1) {
      if (isAborted(signal)) {
        return err(cancelledError());
      }
      const parsed = parseCodeToolRequest(proposals[index], limits);
      if (!parsed.ok) {
        state.runs.push(Object.freeze({ index, outcome: Object.freeze(err(parsed.error)) }));
        state.rejected += 1;
        continue;
      }
      const request = parsed.value;
      const executed = await fromPromise(
        Promise.resolve().then(() => tools.runCodeTool(request)),
        'INTERNAL',
      );
      if (!executed.ok) {
        return err(executorError(executed.error));
      }
      state.runs.push(Object.freeze({ index, request, outcome: executed.value }));
      if (!executed.value.ok) {
        state.rejected += 1;
      }
    }
    state.remaining = Math.max(0, state.remaining - proposals.length);
    return ok(undefined);
  };

  const run = async (
    context: PipelineStageContext,
    input: InvestigateStageInput,
  ): Promise<Result<InvestigateStageResult, DebuggenError>> => {
    const log = loggerFor(context);
    const signal = context.signal;

    if (!isValidRepairBudget(maxRepairs)) {
      // A programmer error, reported before any progress row or provider call.
      const error = repairBudgetError(maxRepairs);
      log.error(FAILED_LOG, {
        stage: INVESTIGATE_STAGE,
        code: error.code,
        reason: 'repair-budget',
      });
      return err(error);
    }
    if (isAborted(signal)) {
      log.debug(CANCELLED_LOG, { stage: INVESTIGATE_STAGE });
      return err(cancelledError());
    }

    const started = context.now();
    emitProgress('started', log, () => progress.stageStarted(context.sessionId, INVESTIGATE_STAGE));

    // The executor of this run. The code handles were loaded once by the
    // orchestrator; nothing here indexes, walks or reads the project.
    const created = tryCatch(
      () => createTools({ handles: context.code, limits: requestedLimits, logger: log, signal }),
      'INTERNAL',
    );
    if (!created.ok) {
      return fail(context, log, executorError(created.error), undefined);
    }
    const tools = created.value;
    const budget = tryCatch(() => tools.budget(), 'INTERNAL');
    if (!budget.ok) {
      return fail(context, log, executorError(budget.error), undefined);
    }

    // The budget can only be tightened here, never raised: the requested
    // limits, the executor's effective limits and its live allowance, whichever
    // is lowest. The catalog states the effective limits and is generated,
    // never written by hand, so it cannot drift from the tools.
    const limits = resolveCodeToolLimits(budget.value.limits);
    const allowance = Math.min(
      requestedLimits.maxCallsPerStage,
      limits.maxCallsPerStage,
      toCount(budget.value.callsRemaining),
    );
    const toolCatalog = describeCodeTools({ limits });
    const state: ConversationState = {
      runs: [],
      remaining: allowance,
      rejected: 0,
      repairs: 0,
      turns: 0,
    };

    // Seeds first: the understanding's own entities and hints, resolved before
    // the model is asked anything. They cost budget like any proposal.
    const seeds = seedRequests(
      input.understanding,
      limits,
      Math.min(MAX_SEED_QUERIES, Math.floor(allowance / 2)),
    );
    log.debug(STARTED_LOG, { stage: INVESTIGATE_STAGE, allowance, seedCount: seeds.length });
    if (seeds.length > 0) {
      const seeded = await execute(tools, seeds, limits, state, signal);
      if (!seeded.ok) {
        return fail(context, log, seeded.error, state);
      }
    }

    // The budgeted conversation. Every turn either returns or runs at least one
    // proposal (a batch holds one or more, and a batch is only executed while
    // budget remains), so after `remaining` query turns the next turn must end
    // the run. `maxTurns` is that bound, enforced independently.
    const maxTurns = state.remaining + 1;
    let promptVersion = input.promptVersion;
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (isAborted(signal)) {
        return fail(context, log, cancelledError(), state);
      }

      // The builder has already run the outbound guard: an `Err` here means the
      // payload must not leave the machine, so the provider is never called.
      const built = buildTurn(context, input.understanding, toolCatalog, state, promptVersion);
      if (!built.ok) {
        return fail(context, log, built.error, state);
      }
      promptVersion = built.value.promptVersion;
      state.turns = turn;

      // The one validation gate (AAP §0.5.3). Its repair budget, its abort
      // check and its typed rejections all live upstream; this is not wrapped
      // in a second repair loop, a retry or a fallback.
      const answered = await fromPromise(
        generateStructuredWithRepair(provider, investigateReplySchema, built.value.request, {
          maxRepairs,
          schemaName: INVESTIGATION_SCHEMA_NAME,
          logger: log,
        }),
        'INTERNAL',
      );
      const answer = answered.ok ? answered.value : answered;
      if (!answer.ok) {
        return fail(context, log, shapeModelFailure(answer.error, signal), state);
      }
      state.repairs += answer.value.repairs;
      const reply: unknown = answer.value.value;

      if (isCodeInvestigation(reply)) {
        // The reply is well-formed; grounding keeps only what the executed
        // queries returned. What it removed is logged as counts, never as the
        // paths, symbols or flow text themselves.
        const evidence = collectEvidence(state.runs);
        const grounded = groundInvestigation(reply, evidence);
        const investigation = grounded.investigation;
        log.info(COMPLETED_LOG, {
          stage: INVESTIGATE_STAGE,
          promptVersion,
          turns: state.turns,
          repairs: state.repairs,
          allowance,
          seedCount: seeds.length,
          queriesRun: state.runs.length,
          queriesRejected: state.rejected,
          remainingQueries: state.remaining,
          relevantFileCount: investigation.relevantFiles.length,
          flowCount: investigation.flows.length,
          removedFileCount: grounded.removedFileCount,
          strippedSymbolCount: grounded.strippedSymbolCount,
          removedFlowCount: grounded.removedFlowCount,
          durationMs: Math.max(0, context.now() - started),
        });
        emitProgress('findings', log, () =>
          progress.reportInvestigation(context.sessionId, findingsOf(investigation, evidence)),
        );
        emitProgress('completed', log, () =>
          progress.stageCompleted(context.sessionId, INVESTIGATE_STAGE),
        );
        return ok(
          Object.freeze({
            investigation,
            promptVersion,
            repairs: state.repairs,
            toolRuns: Object.freeze([...state.runs]),
          }),
        );
      }

      if (!isQueryBatch(reply)) {
        return fail(context, log, unclassifiedReplyError(), state);
      }
      if (state.remaining === 0) {
        return fail(context, log, budgetExhaustedError(countersOf(state)), state);
      }

      const proposals = proposalsOf(reply, state.remaining);
      const proposed = reply[INVESTIGATE_QUERY_BATCH_FIELD].length;
      const before = state.runs.length;
      const executed = await execute(tools, proposals, limits, state, signal);
      if (!executed.ok) {
        return fail(context, log, executed.error, state);
      }
      const batchRuns = state.runs.slice(before);
      log.debug(BATCH_LOG, {
        stage: INVESTIGATE_STAGE,
        turn,
        proposed,
        processed: proposals.length,
        dropped: proposed - proposals.length,
        rejected: batchRuns.filter((entry) => !entry.outcome.ok).length,
        tools: batchRuns.flatMap((entry) =>
          entry.request !== undefined ? [entry.request.tool] : [],
        ),
        remainingQueries: state.remaining,
      });
    }

    return fail(context, log, turnLimitError(countersOf(state)), state);
  };

  return Object.freeze({ run });
}
