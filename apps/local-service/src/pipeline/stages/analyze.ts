/**
 * Stage 5 of the reasoning pipeline — **analysis**: a capture's bounded,
 * redacted aggregates in, a validated and evidence-verified
 * {@link AnalysisResult} out, with observed facts and likely causes kept in two
 * structurally separate lists (AAP §0.4.2, "AI stage boundaries", Analysis row;
 * AAP §0.8.4).
 *
 * ## What this stage does, in this fixed order
 *
 * 1. **Build the input — by delegation.** `../../analysis/summarize.js` owns
 *    every read of the capture: it scans the persisted, already-redacted
 *    telemetry — every event of the capture up to the bound the panel data
 *    aggregates under — correlates, aggregates, projects the metrics and
 *    fetches the bounded code excerpts, all under `ANALYSIS_INPUT_LIMITS` with
 *    a `truncated` report (AAP §0.5.2, §0.7.1 Group 2). `../../analysis/facts.js`
 *    turns that input into the deterministic fact candidates the prompt
 *    requires the model to cite, and the summarizer assembles them into a
 *    second, identically bounded input from the same aggregates, in the same
 *    call. The build also carries the capture summary its input was drawn
 *    from; the metrics stored with the analysis are that summary's, so they
 *    and every fact describe one event set. This file reads no telemetry row,
 *    computes no aggregate or metric and fetches no excerpt.
 * 2. **Build the request — by delegation.** `../context-builder.js` renders the
 *    versioned prompt `prompts/analyze/vNNN.md`, derives its five placeholders
 *    ({@link AnalyzePromptPlaceholdersCovered}) from the same capped object that
 *    becomes `ModelRequest.input`, and runs the outbound privacy guard. A
 *    refused build aborts the stage: the payload must not leave the machine,
 *    and nothing about it is logged.
 * 3. **The model-output gate.** One call to `generateStructuredWithRepair`
 *    against protocol's `analysisFindingsSchema`, with at most
 *    `DEFAULT_MAX_REPAIRS` repairs (AAP §0.5.3). There is no normaliser for
 *    this artifact, no second repair loop, no retry and **no fallback
 *    analysis**: a rejection is a stage failure, which the caller turns into
 *    the session's `failed` transition (AAP §0.5.5). A fabricated analysis would
 *    be exactly the failure presented as a result that §0.5.5 forbids.
 * 4. **Evidence integrity — by delegation.** `../../analysis/facts.js` is
 *    checkpoint one of AAP §0.8.4: every cited event, trace and span id must
 *    exist in this capture and every suggested location must lie inside the
 *    project, or the whole analysis is rejected. This file verifies nothing
 *    itself, never drops, moves or rewrites a finding, never promotes a fact
 *    candidate into an observation, and never stores an analysis except through
 *    `acceptFindings`, which takes the next version and the superseded id from
 *    the store (the ladder is the `UNIQUE(session_id, version)` invariant).
 * 5. **Progress.** The `analyze` group's header, count rows built from the
 *    verified result, and its closing or failed row, through
 *    `../../sessions/progress.js`. A row that cannot be sent is logged and never
 *    fails the stage. Session status is never written here: the session manager
 *    is its only writer.
 *
 * ## The follow-up existing-evidence path
 *
 * `regenerate` re-runs this stage against the **stored** capture the latest
 * analysis was drawn from, and the store assigns version *n + 1* with
 * `supersedes` naming version *n*. Nothing is recomputed from the live
 * application and nothing is mutated in place, so a reopened session replays
 * exactly what the developer saw (AAP §0.4.2, Follow-up row).
 *
 * Whenever a follow-up governs the analysis — that regeneration, or a capture
 * taken under the plan version a new-capture follow-up installed — its
 * structured focus (`followUpFocusFor` of `./followup.js`: category hints and
 * graph-resolved declarations, never question text) is handed to the
 * summarizer, and the context builder places it at the top level of the
 * request. An analysis no follow-up governs carries none, so its input is
 * exactly what it was.
 *
 * ## Boundaries
 *
 * - No hardcoded behaviour (AAP §0.5.4): the developer's question is passed
 *   through to the summarizer and the context builder verbatim and is never
 *   compared, searched or switched on here; no finding, statement or hypothesis
 *   is authored in this file.
 * - Privacy (AAP §0.5.2): log records carry the stage, counts, the repair and
 *   attempt counts, the prompt version, durations, error codes and enumerated
 *   reasons only — never the question, a prompt, a model output, a statement,
 *   SQL, a URL, an attribute value, a trace or event id, an excerpt or a token.
 * - The developer's project is never written: no filesystem access, no process
 *   spawn and no network beyond the injected provider.
 * - Every expected failure is a `Result` `Err`; {@link AnalyzeStage.run} never
 *   rejects.
 *
 * @module
 */

import type { ProblemUnderstanding } from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  generateStructuredWithRepair,
  modelUnavailableMessage,
} from '@debuggen/model-provider';
import type { ModelProvider, PromptStage } from '@debuggen/model-provider';
import type { Hypothesis } from '@debuggen/panel-schema';
import {
  analysisFindingsSchema,
  createEnvelope,
  parseAnalysisCompletedPayload,
} from '@debuggen/protocol';
import type { AnalysisResult, ClientKind, ProgressStage } from '@debuggen/protocol';
import { DebuggenError, err, fromPromise, noopLogger, ok } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import type {
  AcceptFindingsContext,
  AnalysisFacts,
  FactVerificationContext,
  FactVerificationReport,
} from '../../analysis/facts.js';
import type { AnalysisStageInputBuild, AnalysisSummarizer } from '../../analysis/summarize.js';
import { LOG_BINDING_KEYS, sessionLogger, subsystemLogger } from '../../logging.js';
import { MAX_FINDING_ROWS_PER_STAGE } from '../../sessions/progress.js';
import type { SessionBroadcaster } from '../../sessions/manager.js';
import type { SessionProgress } from '../../sessions/progress.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { PanelsRepo } from '../../store/panels-repo.js';
import type { ContextBuilder, PipelineStageContext, StagePlaceholder } from '../context-builder.js';
import { followUpFocusFor } from './followup.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * This stage's name in both vocabularies it reports under: protocol's
 * `PROGRESS_STAGES` (the `session.progress` rows) and the model boundary's
 * `PROMPT_STAGES` (the prompt file and the recorded prompt version). The
 * `satisfies` clause makes removing or renaming the stage in either tuple a
 * compile error here rather than a row addressed to a stage nobody renders.
 */
export const ANALYZE_STAGE = 'analyze' as const satisfies ProgressStage & PromptStage;

/**
 * The artifact name the structured-output loop reports in its log records and
 * in a rejection's `details.schemaName`.
 */
export const ANALYSIS_FINDINGS_SCHEMA_NAME = 'analysis findings';

/** The `subsystem` binding of this stage's log records, shared by every pipeline module. */
const PIPELINE_SUBSYSTEM = 'pipeline';

/**
 * The recovery step attached to an analysis the model never shaped correctly.
 *
 * Replaces the structured-output loop's generic hint, which offers a
 * deterministic substitute artifact: that is true for a plan or a panel and
 * false here, where no fallback analysis exists by design (AAP §0.5.3, §0.5.5).
 * The developer is told what actually recovers.
 */
const ANALYSIS_REJECTION_HINT =
  'No fallback analysis exists, so nothing was stored. Run the analysis again; if it keeps failing, capture the issue again or check the configured model.';

/* -------------------------------------------------------------------------------------------------
 * Compile-time contract checks
 * ---------------------------------------------------------------------------------------------- */

/** Compiles only when `T` is exactly `true`; the repository's type-assertion idiom. */
type AssertTrue<T extends true> = T;

/** `true` when each of `A` and `B` is assignable to the other; the tuple wrap stops distribution. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The five placeholders `prompts/analyze/v001.md` declares, which the context
 * builder derives from what this stage hands it: `question` from the stage
 * context, `understanding` from {@link AnalyzeStageInput.understanding}, and
 * `captureSummary` and `codeExcerpts` from the summarizer's stage input
 * (AAP §0.4.2). `outputSchema` is rendered from `analysisFindingsSchema`.
 */
type AnalyzeStageSuppliedPlaceholders =
  'question' | 'understanding' | 'captureSummary' | 'codeExcerpts' | 'outputSchema';

/**
 * Compile-time proof that the analyze prompt's placeholder contract
 * (`STAGE_PLACEHOLDERS.analyze`, itself drift-tested against the prompt file by
 * `../context-builder.test.ts`) is exactly what this stage supplies. A sixth
 * placeholder added to the prompt fails `tsc -b` here, at the stage that would
 * have to provide it. Exported so `noUnusedLocals` treats it as used; it has no
 * runtime existence.
 */
export type AnalyzePromptPlaceholdersCovered = AssertTrue<
  MutuallyAssignable<StagePlaceholder<typeof ANALYZE_STAGE>, AnalyzeStageSuppliedPlaceholders>
>;

/* -------------------------------------------------------------------------------------------------
 * Public contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * Collaborators of {@link createAnalyzeStage}; everything is injected (AAP
 * §0.7.1 Group 2). Each member is typed as the narrowest slice of its owning
 * module's interface that this stage calls, so the full service objects — and
 * the fakes an orchestrator test substitutes — are accepted, and the type
 * itself documents that this stage can neither insert an analysis row nor read
 * telemetry directly.
 */
export interface AnalyzeStageDeps {
  /** Renders the versioned analyze prompt and runs the outbound guard (`../context-builder.js`). */
  readonly contextBuilder: Pick<ContextBuilder, 'buildAnalyzeRequest'>;
  /** The configured model boundary; the only network this stage can reach. */
  readonly provider: ModelProvider;
  /**
   * The owner of the bounded, redacted analysis input (`../../analysis/summarize.js`).
   * Only `buildStageInput` is read: the build carries the capture summary its
   * input was drawn from, so the stage never loads a second one that could
   * describe a different set of events.
   */
  readonly summarizer: Pick<AnalysisSummarizer, 'buildStageInput'>;
  /** The owner of fact candidates, evidence verification and versioned persistence (`../../analysis/facts.js`). */
  readonly facts: Pick<
    AnalysisFacts,
    'candidatesFor' | 'verifyFindings' | 'verificationReportFor' | 'acceptFindings'
  >;
  /**
   * The analysis history, read only to check the follow-up preconditions of
   * {@link AnalyzeStageInput.regenerate} and {@link AnalyzeStageInput.supersedes}
   * before a model call is spent. Writes go through `facts.acceptFindings`.
   */
  readonly panels: Pick<PanelsRepo, 'getLatestAnalysis'>;
  /** The `session.progress` emitter (`../../sessions/progress.js`). */
  readonly progress: Pick<
    SessionProgress,
    'stageStarted' | 'stageCompleted' | 'stageFailed' | 'finding'
  >;
  /**
   * A parent logger. Absent, each run logs through the stage context's
   * session-bound logger; either way records are bound to the `pipeline`
   * subsystem, this stage, the session and the capture.
   */
  readonly logger?: Logger | undefined;
  /**
   * The repair budget of the structured-output loop: an integer from `0` to
   * `DEFAULT_MAX_REPAIRS` (the AAP §0.5.3 ceiling of two). Defaults to the
   * ceiling.
   */
  readonly maxRepairs?: number | undefined;
  /**
   * Whether this stage emits its own group rows — the `running` header, the
   * closing `done` row and the `failed` row. Defaults to `true`.
   *
   * A caller that already emits a stage's header and closing row around every
   * stage, and that routes a failure to the `failed` status through the session
   * manager (which writes that stage's `failed` row as part of the transition),
   * passes `false` so no row appears twice. The count rows built from the
   * verified findings are emitted either way: only this stage has them.
   */
  readonly reportStageBoundaries?: boolean | undefined;
  /**
   * Delivers `analysis.completed` once an analysis is stored (AAP §0.4.2:
   * service → VS Code, DevTools). The client registry in production; absent in
   * unit contexts, where nothing is sent.
   */
  readonly broadcaster?: Pick<SessionBroadcaster, 'broadcastToKinds'> | undefined;
}

/**
 * The user-interface kinds `analysis.completed` is delivered to: the editor
 * view, whose analysis summary renders it, and the DevTools panel (AAP §0.4.2).
 * The same audience as `panel.generated`, which follows it.
 */
export const ANALYSIS_BROADCAST_KINDS: readonly ClientKind[] = Object.freeze([
  'devtools',
  'vscode',
]);

/** What one analysis run is asked to analyse (AAP §0.4.2, Analysis and Follow-up rows). */
export interface AnalyzeStageInput {
  /** The capture whose persisted evidence is analysed. */
  readonly captureId: string;
  /** The validated Stage 1 understanding the session was built on. */
  readonly understanding: ProblemUnderstanding;
  /**
   * A prompt version to use. Absent, the version recorded on the session is
   * reused, else the manifest's current one — resolved by the context builder.
   */
  readonly promptVersion?: string | undefined;
  /**
   * The follow-up existing-evidence path: re-derive the analysis from the
   * **stored** capture as the session's next version. Requires a stored
   * analysis drawn from this same capture.
   */
  readonly regenerate?: boolean | undefined;
  /**
   * The id of the analysis the new one must supersede. Checked against the
   * session's latest stored analysis before the model is called; the stored
   * link itself is always taken from the store by `facts.acceptFindings`.
   */
  readonly supersedes?: string | undefined;
}

/**
 * The outcome of a successful run: the stored analysis and what producing it
 * cost. Every field is safe to log or broadcast except `summary` and
 * `verification`, which hold capture data and cited ids for in-process use —
 * log their counts, never their contents.
 */
export interface AnalyzeStageResult {
  /** The validated, verified and stored analysis. */
  readonly analysis: AnalysisResult;
  /** The version the store assigned, equal to `analysis.analysisVersion`. */
  readonly analysisVersion: number;
  /** The prompt version actually rendered; the orchestrator records it in `promptVersions`. */
  readonly promptVersion: string;
  /** Repairs the structured-output loop spent (at most `DEFAULT_MAX_REPAIRS`). */
  readonly repairs: number;
  /** Provider attempts in total, the accepted one included. */
  readonly attempts: number;
  /** The provider implementation that answered, as it reports itself. */
  readonly providerId: string;
  /** The model that produced the accepted answer, as the provider reports it. */
  readonly model: string;
  /** What checkpoint one checked: every cited id and location, and that all of them resolved. */
  readonly verification: FactVerificationReport;
  /**
   * The capture summary the analysis was drawn from — the build's
   * `AnalysisStageInputBuild.summary`, describing exactly the events the input
   * aggregated. The metrics stored with the analysis come from here.
   */
  readonly summary: CaptureSummary;
  /** Names of the input and request sections that were capped, trimmed or dropped — names only. */
  readonly truncated: readonly string[];
}

/**
 * Stage 5 of the pipeline: the factory-plus-single-`run` shape the
 * orchestrator's `StageOverrides` port substitutes in tests.
 */
export interface AnalyzeStage {
  /**
   * Analyses one capture of the context's session.
   *
   * @param context The pipeline run's stage context (session, project root,
   * question, code handles, logger, clock and cancellation signal).
   * @param input The capture, the validated understanding and the follow-up
   * options.
   * @returns `Ok` with the stored analysis, or `Err` with the failing
   * subsystem's typed error — a refused request build, a provider failure, a
   * rejected model output, an evidence rejection, an empty capture, a store
   * failure or a cancellation — passed through unchanged except where a
   * transport failure is re-worded to AAP §0.5.5's sentence. Never rejects.
   */
  run(
    context: PipelineStageContext,
    input: AnalyzeStageInput,
  ): Promise<Result<AnalyzeStageResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Failures this stage raises itself
 *
 * Every other failure is the owning subsystem's error, passed through unchanged. These carry
 * codes, product-minted ids and enumerated reasons only (AAP §0.5.2).
 * ---------------------------------------------------------------------------------------------- */

/** Identifies a run in an error's details. */
interface RunScope {
  readonly sessionId: string;
  readonly captureId: string;
}

/** The run was abandoned through the context's signal. */
function cancelledError(scope: RunScope): DebuggenError {
  return new DebuggenError('INTERNAL', 'The analyze stage was cancelled before it finished.', {
    hint: 'Nothing was stored. Start the analysis again if the answer is still wanted.',
    details: { stage: ANALYZE_STAGE, reason: 'aborted', ...scope },
  });
}

/** The capture named by the input is not the capture the pipeline run was started for. */
function captureMismatchError(scope: RunScope): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'The capture to analyse is not the capture this pipeline run was started for.',
    {
      hint: 'Stop the capture again; the analysis runs on the capture that was just stopped.',
      details: { stage: ANALYZE_STAGE, reason: 'capture-mismatch', ...scope },
    },
  );
}

/** The existing-evidence path was asked to regenerate an analysis that does not exist. */
function nothingToRegenerateError(scope: RunScope): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'There is no stored analysis to regenerate for this session.',
    {
      hint: 'Capture the issue and let it be analysed before asking a follow-up about that evidence.',
      details: { stage: ANALYZE_STAGE, reason: 'nothing-to-regenerate', ...scope },
    },
  );
}

/** A regenerated analysis must come from the capture its predecessor was drawn from. */
function regenerateCaptureMismatchError(scope: RunScope, latestCaptureId: string): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'A regenerated analysis must be drawn from the same capture as the analysis it replaces.',
    {
      hint: 'Ask the follow-up again; it regenerates from the capture behind the latest analysis.',
      details: {
        stage: ANALYZE_STAGE,
        reason: 'regenerate-capture-mismatch',
        ...scope,
        latestCaptureId,
      },
    },
  );
}

/** The analysis the caller wants superseded is no longer the session's latest. */
function supersedesStaleError(scope: RunScope): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'The analysis this run was asked to supersede is no longer the latest analysis of the session.',
    {
      hint: 'Ask the follow-up again; it builds on the latest stored analysis.',
      details: { stage: ANALYZE_STAGE, reason: 'supersedes-stale', ...scope },
    },
  );
}

/** Verification accepted the findings, but the detailed report disagreed: nothing is stored. */
function verificationInconsistentError(scope: RunScope): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The evidence store answered inconsistently while the analysis was being verified, so nothing was stored.',
    {
      hint: 'Run the analysis again once the capture is no longer changing.',
      details: { stage: ANALYZE_STAGE, reason: 'verification-inconsistent', ...scope },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** An enumerated reason: a short kebab-case identifier, the only `details.reason` shape logged. */
const REASON_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

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
 * test so each call reads the signal afresh: cancellation arrives while the
 * stage awaits its collaborators, which a narrowed property read would not see.
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
 *   provider normally already uses it; a provider that did not is re-worded,
 *   keeping its code, hint and details and chaining the original as `cause`.
 * - An output that never satisfied the findings schema keeps its code, message
 *   and details, and its hint states the recovery that exists for an analysis
 *   ({@link ANALYSIS_REJECTION_HINT}) instead of a substitute artifact that does
 *   not.
 * - Everything else — a cancellation, an empty answer, a provider's own
 *   non-availability condition — is passed through unchanged.
 */
function shapeModelFailure(error: DebuggenError, signal: AbortSignal | undefined): DebuggenError {
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
      hint: ANALYSIS_REJECTION_HINT,
      ...(error.details !== undefined ? { details: error.details } : {}),
      cause: error,
    });
  }
  return error;
}

/** A count with its noun, so a row reads correctly at one. */
function countOf(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** Likely causes that point at a validated source location. */
function locatedCauses(causes: readonly Hypothesis[]): number {
  return causes.filter((cause) => cause.suggestedLocation !== undefined).length;
}

/** One count row of the `analyze` group, before it is addressed to a session. */
interface AnalysisFindingRow {
  readonly message: string;
  readonly detail?: string;
}

/**
 * The count rows of the `analyze` progress group, built from the stored,
 * verified analysis and nothing else.
 *
 * Numbers only — how many observations and likely causes the analysis holds,
 * how many captured events and traces their evidence was verified against, how
 * many causes point at a source location. Never a statement, an id or a
 * location: those are capture-derived and belong to the analysis artifact,
 * which both user interfaces render from the stored record. A class with
 * nothing in it produces no row, and the list is bounded by
 * `MAX_FINDING_ROWS_PER_STAGE`, the progress module's per-stage limit.
 */
function analysisFindingRows(
  analysis: AnalysisResult,
  verification: FactVerificationReport,
): readonly AnalysisFindingRow[] {
  const rows: AnalysisFindingRow[] = [];

  const observed = analysis.observed.length;
  if (observed > 0) {
    const events = verification.checkedEventIds.length;
    const traces = verification.checkedTraceIds.length;
    rows.push({
      message: `${countOf(observed, 'observed fact')} backed by captured evidence`,
      detail: `Evidence verified against ${countOf(events, 'captured event')}${
        traces > 0 ? ` in ${countOf(traces, 'trace')}` : ''
      }`,
    });
  }

  const causes = analysis.likelyCauses.length;
  if (causes > 0) {
    const located = locatedCauses(analysis.likelyCauses);
    rows.push({
      message: `${countOf(causes, 'likely cause')} to check`,
      ...(located > 0
        ? { detail: `Source location suggested for ${String(located)} of ${String(causes)}` }
        : {}),
    });
  }

  return rows.slice(0, MAX_FINDING_ROWS_PER_STAGE);
}

/** The built stage input together with how many fact candidates it offers. */
interface BuiltAnalysisInput {
  readonly build: AnalysisStageInputBuild;
  readonly factCandidates: number;
}

/**
 * Reads the stage context's clock, answering `undefined` for a clock that
 * throws or returns something other than a finite number. Durations are log
 * detail only, so a faulty clock costs a field, never the run.
 */
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

/** Section names in first-seen order, each once. */
function uniqueNames(...lists: readonly (readonly string[])[]): readonly string[] {
  return Object.freeze([...new Set(lists.flat())]);
}

/* -------------------------------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates Stage 5 of the pipeline (AAP §0.4.2 Analysis row, §0.5.3, §0.8.4).
 *
 * The stage holds no state between runs beyond its injected collaborators, so
 * one instance serves every session of the service process.
 *
 * @param deps The context builder, provider, summarizer, facts module,
 * analysis history, progress emitter and optional logger, repair budget and
 * boundary-row switch.
 * @returns The stage.
 * @throws A `DebuggenError` with code `CONFIG_INVALID` when `deps.maxRepairs`
 * is not an integer from `0` to `DEFAULT_MAX_REPAIRS` inclusive. That is a
 * wiring error, reported where the stage is built rather than on the first
 * analysis, and never clamped: AAP §0.5.3's "at most two repairs" bounds what
 * leaves the developer's machine.
 *
 * @example
 * ```ts
 * const analyze = createAnalyzeStage({
 *   contextBuilder,
 *   provider,
 *   summarizer,
 *   facts,
 *   panels: panelsRepo,
 *   progress,
 *   logger,
 * });
 * const outcome = await analyze.run(context, { captureId, understanding });
 * if (outcome.ok) {
 *   promptVersions.analyze = outcome.value.promptVersion;
 * }
 * ```
 */
export function createAnalyzeStage(deps: AnalyzeStageDeps): AnalyzeStage {
  const maxRepairs = deps.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > DEFAULT_MAX_REPAIRS) {
    throw new DebuggenError(
      'CONFIG_INVALID',
      `The analyze stage accepts a repair budget from 0 to ${String(DEFAULT_MAX_REPAIRS)} inclusive.`,
      {
        hint: 'Leave maxRepairs unset to use the permitted maximum.',
        details: { stage: ANALYZE_STAGE, reason: 'invalid-repair-budget' },
      },
    );
  }
  const reportBoundaries = deps.reportStageBoundaries ?? true;

  /** The run's logger: bound to the pipeline subsystem, this stage, the session and the capture. */
  const loggerFor = (context: PipelineStageContext, captureId: string): Logger => {
    const parent =
      deps.logger === undefined
        ? context.logger
        : sessionLogger(deps.logger, context.sessionId, captureId);
    return subsystemLogger(parent, PIPELINE_SUBSYSTEM).child({
      stage: ANALYZE_STAGE,
      [LOG_BINDING_KEYS.captureId]: captureId,
    });
  };

  /**
   * Sends one progress row. Progress is advisory: a rejected or throwing
   * emission is logged with its code and the row kind, never its text, and the
   * stage carries on.
   */
  const sendRow = (
    log: Logger,
    row: 'started' | 'finding' | 'completed' | 'failed',
    send: () => Result<unknown, DebuggenError>,
  ): void => {
    let sent: Result<unknown, DebuggenError>;
    try {
      sent = send();
    } catch (thrown) {
      sent = err(DebuggenError.from(thrown, 'INTERNAL'));
    }
    if (!sent.ok) {
      log.warn('A progress row of the analyze stage could not be sent; the stage continues.', {
        row,
        code: sent.error.code,
      });
    }
  };

  /**
   * Hands `analysis.completed` to the broadcaster: exactly `{ sessionId,
   * analysis }`, validated with protocol's payload parser and enveloped with
   * `createEnvelope`. Delivery is best effort — the analysis is already stored,
   * and a client that missed the frame recovers it through the reopen replay —
   * so a failure is logged by code and never fails the stage.
   *
   * @returns Whether the frame was handed to the broadcaster.
   */
  const announce = (analysis: AnalysisResult, log: Logger): boolean => {
    const broadcaster = deps.broadcaster;
    if (broadcaster === undefined) {
      return false;
    }
    const payload = parseAnalysisCompletedPayload({ sessionId: analysis.sessionId, analysis });
    if (!payload.ok) {
      log.error(
        'A stored analysis failed the analysis.completed payload schema; it was not broadcast.',
        {
          analysisVersion: analysis.analysisVersion,
          code: payload.error.code,
        },
      );
      return false;
    }
    try {
      broadcaster.broadcastToKinds(
        analysis.sessionId,
        ANALYSIS_BROADCAST_KINDS,
        createEnvelope('analysis.completed', payload.value),
      );
    } catch (thrown) {
      log.warn('Broadcasting analysis.completed failed; clients recover the analysis on reopen.', {
        analysisVersion: analysis.analysisVersion,
        code: DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED').code,
      });
      return false;
    }
    return true;
  };

  /**
   * The single failure path: log the code and enumerated reason, report the
   * stage's `failed` row when this stage owns its boundary rows, and return
   * the error unchanged. Nothing about the failed payload is logged.
   */
  const fail = (
    context: PipelineStageContext,
    log: Logger,
    error: DebuggenError,
    startedAt: number | undefined,
  ): Result<never, DebuggenError> => {
    const reason = reasonOf(error);
    log.warn('The analyze stage failed.', {
      code: error.code,
      ...(reason !== undefined ? { reason } : {}),
      ...durationFields(context.now, startedAt),
    });
    if (reportBoundaries) {
      const failure: SessionFailure = {
        stage: ANALYZE_STAGE,
        code: error.code,
        message: error.message,
        ...(error.hint !== undefined ? { hint: error.hint } : {}),
      };
      sendRow(log, 'failed', () => deps.progress.stageFailed(context.sessionId, failure));
    }
    return err(error);
  };

  /**
   * The follow-up preconditions, checked against the store before a model call
   * is spent: a regeneration needs a stored analysis drawn from this capture,
   * and a named predecessor must still be the latest analysis.
   */
  const checkHistory = (
    input: AnalyzeStageInput,
    scope: RunScope,
  ): Result<undefined, DebuggenError> => {
    if (input.regenerate !== true && input.supersedes === undefined) {
      return ok(undefined);
    }
    const latest = deps.panels.getLatestAnalysis(scope.sessionId);
    if (!latest.ok) {
      return err(latest.error);
    }
    const previous = latest.value;
    if (input.regenerate === true) {
      if (previous === undefined) {
        return err(nothingToRegenerateError(scope));
      }
      if (previous.captureId !== input.captureId) {
        return err(regenerateCaptureMismatchError(scope, previous.captureId));
      }
    }
    if (input.supersedes !== undefined && previous?.id !== input.supersedes) {
      return err(supersedesStaleError(scope));
    }
    return ok(undefined);
  };

  /**
   * The analysis input, entirely by delegation: the summarizer builds the
   * bounded, redacted input; the facts module derives the deterministic
   * candidates from it and from the summary it was drawn from; and, when there
   * are any, the summarizer assembles the input again carrying them, so they
   * are projected, capped and held to the byte budget by the module that owns
   * those rules. One build call does all three, so the capture is read and
   * aggregated once. The candidates are evidence the prompt requires the model
   * to cite — never observations.
   */
  const buildInput = async (
    context: PipelineStageContext,
    captureId: string,
    log: Logger,
  ): Promise<Result<BuiltAnalysisInput, DebuggenError>> => {
    // The follow-up this analysis answers, when one governs it — the one the context names, or
    // the one whose plan version the capture ran under — as structured data, so the analysis is
    // drawn for the follow-up rather than for the session's first question. None otherwise.
    const followUpFocus = followUpFocusFor(context, log);
    const built = await deps.summarizer.buildStageInput({
      sessionId: context.sessionId,
      captureId,
      question: context.question,
      followUpQuestion: context.followUpQuestion,
      ...(followUpFocus === undefined ? {} : { followUpFocus }),
      codeQueries: context.code.queries,
      options: {
        signal: context.signal,
        deriveFactCandidates: (evidence) => deps.facts.candidatesFor(evidence),
      },
    });
    if (!built.ok) {
      return err(built.error);
    }
    return ok({ build: built.value, factCandidates: built.value.input.factCandidates.length });
  };

  /** One analysis run, in the fixed order of the module documentation. */
  const execute = async (
    context: PipelineStageContext,
    input: AnalyzeStageInput,
    scope: RunScope,
    log: Logger,
    startedAt: number | undefined,
  ): Promise<Result<AnalyzeStageResult, DebuggenError>> => {
    const { signal } = context;
    if (isAborted(signal)) {
      log.info('The analyze stage was cancelled before it started.');
      return err(cancelledError(scope));
    }
    if (reportBoundaries) {
      sendRow(log, 'started', () => deps.progress.stageStarted(context.sessionId, ANALYZE_STAGE));
    }

    // 1. The capture this run is for, when the run names one.
    if (context.captureId !== undefined && context.captureId !== input.captureId) {
      return fail(context, log, captureMismatchError(scope), startedAt);
    }

    // 2. Follow-up preconditions, before any evidence is read or a model call is spent.
    const history = checkHistory(input, scope);
    if (!history.ok) {
      return fail(context, log, history.error, startedAt);
    }

    // 3. The bounded, redacted stage input, carrying the deterministic fact candidates, and the
    //    capture summary it was drawn from. That summary describes exactly the events the input
    //    aggregated — every event of the capture up to the bound the panel data aggregates
    //    under — so the metrics stored below, the fact candidates and the panel's own aggregates
    //    share one event set. A stored summary covering fewer events (partial coverage) is not
    //    cited: the summarizer replaces it with the summary of the aggregated events.
    const built = await buildInput(context, input.captureId, log);
    if (!built.ok) {
      return fail(context, log, built.error, startedAt);
    }
    const { build, factCandidates } = built.value;
    const { summary } = build;
    log.debug('Analysis input built.', {
      eventsConsidered: build.stats.eventsConsidered,
      eventsExcluded: build.stats.eventsExcluded,
      tracesIncluded: build.stats.tracesIncluded,
      spansIncluded: build.stats.spansIncluded,
      excerptsWithheld: build.stats.excerptsWithheld,
      approxBytes: build.stats.approxBytes,
      sectionsTruncated: build.stats.sectionsTruncated,
      droppedForBudget: build.stats.droppedForBudget,
      factCandidates,
    });

    // 4. The request: rendered from the versioned prompt, capped, and passed by the outbound guard.
    //    A refusal ends the stage here — the payload must not leave the machine.
    const requested = deps.contextBuilder.buildAnalyzeRequest({
      context,
      understanding: input.understanding,
      stageInput: build.input,
      promptVersion: input.promptVersion,
      signal,
    });
    if (!requested.ok) {
      return fail(context, log, requested.error, startedAt);
    }
    const { request, promptVersion } = requested.value;

    // 5. The model-output gate: one validated call, bounded repairs, no normaliser, no fallback.
    const answered = await fromPromise(
      generateStructuredWithRepair(deps.provider, analysisFindingsSchema, request, {
        maxRepairs,
        schemaName: ANALYSIS_FINDINGS_SCHEMA_NAME,
        logger: log,
      }),
    );
    if (!answered.ok) {
      return fail(context, log, answered.error, startedAt);
    }
    const structured = answered.value;
    if (!structured.ok) {
      return fail(context, log, shapeModelFailure(structured.error, signal), startedAt);
    }
    const { value: findings, repairs, attempts, providerId, model } = structured.value;

    // 6. An abandoned run stores nothing, even when the model has already answered.
    if (isAborted(signal)) {
      return fail(context, log, cancelledError(scope), startedAt);
    }

    // 7. Checkpoint one of AAP §0.8.4, owned by ../../analysis/facts.js: every cited id must
    //    resolve in this capture and every suggested location must lie inside the project, or
    //    the whole analysis is rejected — propagated unchanged, never trimmed or downgraded.
    const verificationContext: FactVerificationContext = {
      sessionId: context.sessionId,
      captureId: input.captureId,
      projectRoot: context.projectRoot,
    };
    const verified = await deps.facts.verifyFindings(findings, verificationContext);
    if (!verified.ok) {
      return fail(context, log, verified.error, startedAt);
    }
    const report = await deps.facts.verificationReportFor(verified.value, verificationContext);
    if (!report.ok) {
      return fail(context, log, report.error, startedAt);
    }
    if (!report.value.valid) {
      return fail(context, log, verificationInconsistentError(scope), startedAt);
    }

    // 8. Assemble and store as the session's next version; the store supplies the version and
    //    the superseded id, and acceptFindings verifies once more immediately before writing.
    const acceptance: AcceptFindingsContext = {
      ...verificationContext,
      metrics: summary.metrics,
    };
    const accepted = await deps.facts.acceptFindings(verified.value, acceptance);
    if (!accepted.ok) {
      return fail(context, log, accepted.error, startedAt);
    }
    const analysis = accepted.value;
    const broadcast = announce(analysis, log);

    // 9. Progress: count rows from the stored result, then the closing row.
    for (const row of analysisFindingRows(analysis, report.value)) {
      sendRow(log, 'finding', () =>
        deps.progress.finding(context.sessionId, ANALYZE_STAGE, row.message, row.detail),
      );
    }
    if (reportBoundaries) {
      sendRow(log, 'completed', () =>
        deps.progress.stageCompleted(context.sessionId, ANALYZE_STAGE),
      );
    }

    const truncated = uniqueNames(build.input.truncated.sections, requested.value.truncated);
    log.info('The analyze stage stored an analysis.', {
      analysisVersion: analysis.analysisVersion,
      broadcast,
      superseding: analysis.supersedes !== undefined,
      regenerated: input.regenerate === true,
      observed: analysis.observed.length,
      likelyCauses: analysis.likelyCauses.length,
      checkedEventIds: report.value.checkedEventIds.length,
      checkedTraceIds: report.value.checkedTraceIds.length,
      checkedSpanIds: report.value.checkedSpanIds.length,
      checkedLocations: report.value.checkedLocations,
      factCandidates,
      repairs,
      attempts,
      promptVersion,
      truncatedSections: truncated.length,
      ...durationFields(context.now, startedAt),
    });

    return ok({
      analysis,
      analysisVersion: analysis.analysisVersion,
      promptVersion,
      repairs,
      attempts,
      providerId,
      model,
      verification: report.value,
      summary,
      truncated,
    });
  };

  const run = async (
    context: PipelineStageContext,
    input: AnalyzeStageInput,
  ): Promise<Result<AnalyzeStageResult, DebuggenError>> => {
    const scope: RunScope = { sessionId: context.sessionId, captureId: input.captureId };
    const startedAt = readClock(context.now);
    let log: Logger = noopLogger;
    try {
      log = loggerFor(context, input.captureId);
      return await execute(context, input, scope, log, startedAt);
    } catch (thrown) {
      // A collaborator broke its never-throw contract. The run still ends as a typed failure, so
      // the caller can route the session to `failed` rather than lose the stage to a rejection.
      return fail(context, log, DebuggenError.from(thrown, 'INTERNAL'), startedAt);
    }
  };

  return Object.freeze({ run });
}
