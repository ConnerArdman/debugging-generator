/**
 * Stage 6 of the reasoning pipeline — **panel generation** — as the
 * orchestrator drives it: the same factory-plus-single-`run` port as every
 * other stage in this folder, over a panel subsystem that already owns the
 * whole job (AAP §0.4.2, "AI stage boundaries", Panel-generation row; §0.7.1
 * Group 2; §0.8.1 slice 10).
 *
 * ## This file is thin on purpose — do not "complete" it
 *
 * `../../panels/generate.ts` owns, end to end and in one place:
 *
 * - prompt selection and rendering of `prompts/generate-panel/vNNN.md`, with
 *   its five placeholder values;
 * - the one model call and its bounded repair loop against the **authoring**
 *   schema;
 * - the three-step gate of AAP §0.5.3 — authoring schema, deterministic
 *   normaliser, internal schema — followed by semantic validation against the
 *   capture;
 * - substitution of the deterministic fallback panel of `../../panels/fallback.ts`
 *   when a generated panel is rejected, flagged through the normaliser's
 *   context and never by hand;
 * - the panel version ladder (`panelVersion n + 1`, `supersedes`), persistence,
 *   and the broadcast of the stored panel to both user interfaces.
 *
 * Re-implementing any of that here would create a second definition that
 * silently drifts from the first. This stage therefore does exactly three
 * things:
 *
 * 1. **Translate in.** A {@link PipelineStageContext} plus a
 *    {@link GeneratePanelStageInput} become one `PanelGenerationRequest`: the
 *    session id and question from the context (the stored session record is the
 *    single source of truth), the capture, the validated analysis, the optional
 *    summary, the prompt version — the caller's, else the one the session
 *    recorded — and the context's cancellation signal.
 * 2. **Delegate.** `generate` for a new panel; `regenerate` on the follow-up
 *    existing-evidence path (AAP §0.4.2, Follow-up row), which stores the next
 *    panel version superseding the previous one rather than touching a row.
 * 3. **Translate out and report.** The generator's result is projected
 *    field for field onto {@link GeneratePanelStageResult}; its typed `Err` is
 *    returned unchanged, so the developer-facing sentence of the failing
 *    subsystem survives (AAP §0.5.5). The `generate-panel` progress rows are
 *    this file's own responsibility — the panel subsystem deliberately emits
 *    none and writes no session status.
 *
 * ## A fallback panel is a success
 *
 * A fallback panel is a validated panel built from real captured data; the
 * state machine accepts it for the `generated` transition and the renderer
 * draws it under a visible banner (AAP §0.5.3, §0.5.5). The stage reports it as
 * completed, adding one row whose text is `FALLBACK_BANNER_MESSAGE` — imported
 * from its single owner, never re-typed — and carries the boolean out so the
 * caller can pass it on. Reporting it as a failure would make graceful
 * degradation look like breakage.
 *
 * ## Boundaries
 *
 * - The panel is an opaque, validated artifact: only its identity fields (`id`,
 *   `panelVersion`, `supersedes`) are read, to report them; nothing is mutated.
 * - Session status is never written: the orchestrator performs the transition
 *   through the session manager, its only writer.
 * - No hardcoded behaviour (AAP §0.5.4): the question is passed through
 *   verbatim and never compared, searched or switched on; no node type, route,
 *   component or panel content appears in this file.
 * - Privacy (AAP §0.5.2): log records carry the stage, the panel id and
 *   version, the fallback flag, counts, the prompt version and error codes —
 *   never the question, the analysis, a statement, the panel, a trace or event
 *   id or a token.
 * - The developer's project is never touched: no filesystem, process or
 *   network access happens here.
 * - Every expected failure is a `Result` `Err`; {@link GeneratePanelStage.run}
 *   never rejects.
 *
 * @module
 */

import type { PanelSpec } from '@debuggen/panel-schema';
import type { AnalysisResult, ProgressStage } from '@debuggen/protocol';
import { DebuggenError, err, noopLogger, ok } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import { LOG_BINDING_KEYS, sessionLogger, subsystemLogger } from '../../logging.js';
import { FALLBACK_BANNER_MESSAGE } from '../../panels/fallback.js';
import { PANEL_PROMPT_STAGE } from '../../panels/generate.js';
import type {
  PanelGenerationRequest,
  PanelGenerationResult,
  PanelGenerator,
} from '../../panels/generate.js';
import type { SessionProgress } from '../../sessions/progress.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { PipelineStageContext } from '../context-builder.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * This stage's name in protocol's `PROGRESS_STAGES`, taken from the panel
 * subsystem's own stage constant so the stage is spelled in exactly one place.
 * The `satisfies` clause makes a rename in protocol's vocabulary a compile
 * error here rather than rows addressed to a stage nobody renders (AAP §0.4.2).
 */
export const GENERATE_PANEL_STAGE = PANEL_PROMPT_STAGE satisfies ProgressStage;

/** The `subsystem` binding of this stage's log records, shared by every pipeline module. */
const PIPELINE_SUBSYSTEM = 'pipeline';

/* -------------------------------------------------------------------------------------------------
 * Public contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * Collaborators of {@link createGeneratePanelStage} (AAP §0.7.1 Group 2).
 *
 * Deliberately short: no model provider, prompt loader, context builder,
 * panels repository or broadcaster. Those belong to `../../panels/generate.ts`
 * — prompt, gate, validation, fallback, persistence and broadcast all live
 * there — and needing one here would mean duplicating that module.
 */
export interface GeneratePanelStageDeps {
  /** The panel subsystem (`../../panels/generate.ts`); the only thing this stage calls to make a panel. */
  readonly panelGenerator: Pick<PanelGenerator, 'generate' | 'regenerate'>;
  /** The `session.progress` emitter (`../../sessions/progress.ts`). */
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
   * Whether this stage emits its own group rows — the `running` header, the
   * closing `done` row and the `failed` row. Defaults to `true`.
   *
   * A caller that already emits a stage's header and closing row around every
   * stage, and routes a failure to the `failed` status through the session
   * manager (which writes that stage's `failed` row as part of the transition),
   * passes `false` so no row appears twice. The fallback row is emitted either
   * way: only this stage knows the panel is a fallback.
   */
  readonly reportStageBoundaries?: boolean | undefined;
}

/** What one panel generation is asked to produce (AAP §0.4.2, Panel-generation and Follow-up rows). */
export interface GeneratePanelStageInput {
  /** The capture whose evidence the panel draws. */
  readonly captureId: string;
  /** The validated, stored analysis of that capture: the sole source of the panel's facts and causes. */
  readonly analysis: AnalysisResult;
  /** The capture's summary, when the caller already holds it; otherwise the panel subsystem loads it. */
  readonly summary?: CaptureSummary | undefined;
  /**
   * A generate-panel prompt version to use. Absent, the version recorded on the
   * session is reused, else the manifest's current one is resolved by the
   * panel subsystem.
   */
  readonly promptVersion?: string | undefined;
  /**
   * The follow-up existing-evidence path: regenerate the panel from the stored
   * capture as the session's next panel version, answering the context's
   * `followUpQuestion`. Requires a stored panel to supersede.
   */
  readonly regenerate?: boolean | undefined;
  /**
   * The id of the panel the caller expects the new one to supersede. The stored
   * link is always the one the panel subsystem assigns from the store; a
   * disagreement is logged at `warn`, never turned into a failure of a panel
   * that is already stored and delivered.
   */
  readonly supersedes?: string | undefined;
}

/**
 * The outcome of a successful run: a projection of the panel subsystem's
 * result. Every field is safe to log except `panel`, which holds capture data
 * for in-process use.
 */
export interface GeneratePanelStageResult {
  /** The stored panel's id. */
  readonly panelId: string;
  /** The panel exactly as stored and delivered; what the caller hands the state machine's guard. */
  readonly panel: PanelSpec;
  /** The version the store assigned. */
  readonly panelVersion: number;
  /** The panel this one supersedes, when it is a later version. */
  readonly supersedes?: string | undefined;
  /** The prompt version actually rendered; the orchestrator records it in `promptVersions`. */
  readonly promptVersion: string;
  /** Whether the panel is the deterministic fallback, shown under the visible fallback banner. */
  readonly fallback: boolean;
  /** Why the generated panel was replaced, on the fallback path. */
  readonly fallbackReason?: PanelGenerationResult['fallbackReason'];
  /** Repairs the structured-output loop spent. */
  readonly repairs: number;
  /** Provider attempts in total, the accepted one included. */
  readonly attempts: number;
}

/**
 * Stage 6 of the pipeline: the factory-plus-single-`run` shape the
 * orchestrator's `StageOverrides` port substitutes in tests.
 */
export interface GeneratePanelStage {
  /**
   * Produces the panel of one capture of the context's session by delegating
   * to `../../panels/generate.ts`, which owns the gate, validation, fallback,
   * persistence and broadcast.
   *
   * @param context The pipeline run's stage context (session, question,
   * follow-up question, recorded prompt versions, logger, clock and signal).
   * @param input The capture, its validated analysis and the follow-up options.
   * @returns `Ok` with the stored panel — a fallback panel included — or `Err`
   * with the failing subsystem's typed error, unchanged. Never rejects.
   */
  run(
    context: PipelineStageContext,
    input: GeneratePanelStageInput,
  ): Promise<Result<GeneratePanelStageResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Failures this stage raises itself — preconditions only, before the generator is called. Every
 * other failure is the panel subsystem's error, passed through unchanged. Details carry the stage
 * and an enumerated reason, never a payload value (AAP §0.5.2).
 * ---------------------------------------------------------------------------------------------- */

/** The capture named by the input is not the capture the pipeline run was started for. */
function captureMismatchError(): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'The capture to build a panel for is not the capture this pipeline run was started for.',
    {
      hint: 'Stop the capture again; the panel is built from the capture that was just analysed.',
      details: { stage: GENERATE_PANEL_STAGE, reason: 'capture-mismatch' },
    },
  );
}

/** The existing-evidence path was asked to regenerate without the follow-up question it answers. */
function missingFollowUpError(): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'A panel regeneration was requested without the follow-up question it should answer.',
    {
      hint: 'Ask the follow-up question again; the panel is regenerated to answer it.',
      details: { stage: GENERATE_PANEL_STAGE, reason: 'missing-follow-up-question' },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** Whether this run opened its progress group, so a `failed` row only ever closes an open one. */
interface RunGroup {
  opened: boolean;
}

/** Whether the run's signal has fired; read afresh on every call. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Reads the stage context's clock, answering `undefined` for a clock that
 * throws or returns a non-finite number. Durations are log detail only.
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

/** The panel subsystem's request, built from the stage context and the stage input. */
function toRequest(
  context: PipelineStageContext,
  input: GeneratePanelStageInput,
): PanelGenerationRequest {
  return {
    sessionId: context.sessionId,
    captureId: input.captureId,
    question: context.question,
    analysis: input.analysis,
    summary: input.summary,
    promptVersion: input.promptVersion ?? context.promptVersions[GENERATE_PANEL_STAGE],
    signal: context.signal,
  };
}

/** The generator's result as this stage reports it: identity from the stored panel, the rest as is. */
function toStageResult(result: PanelGenerationResult): GeneratePanelStageResult {
  const { panel } = result;
  return {
    panelId: panel.id,
    panel,
    panelVersion: panel.panelVersion,
    ...(panel.supersedes === undefined ? {} : { supersedes: panel.supersedes }),
    promptVersion: result.promptVersion,
    fallback: result.fallback,
    ...(result.fallbackReason === undefined ? {} : { fallbackReason: result.fallbackReason }),
    repairs: result.repairs,
    attempts: result.attempts,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates Stage 6 of the pipeline (AAP §0.4.2 Panel-generation row, §0.5.3,
 * §0.5.5). The three-step gate, validation, fallback substitution,
 * persistence and broadcast all live in `../../panels/generate.ts`; this stage
 * translates, delegates and reports progress.
 *
 * The stage holds no state between runs beyond its injected collaborators, so
 * one instance serves every session of the service process.
 *
 * @param deps The panel generator, the progress emitter, and optionally a
 * logger and the boundary-row switch.
 * @returns The stage.
 *
 * @example
 * ```ts
 * const generatePanel = createGeneratePanelStage({ panelGenerator, progress, logger });
 * const outcome = await generatePanel.run(context, { captureId, analysis });
 * if (outcome.ok) {
 *   promptVersions['generate-panel'] = outcome.value.promptVersion;
 *   // outcome.value.panel satisfies the `generated` guard, a fallback panel included.
 * }
 * ```
 */
export function createGeneratePanelStage(deps: GeneratePanelStageDeps): GeneratePanelStage {
  const reportBoundaries = deps.reportStageBoundaries ?? true;

  /** The run's logger: bound to the pipeline subsystem, this stage, the session and the capture. */
  const loggerFor = (context: PipelineStageContext, captureId: string): Logger => {
    const parent =
      deps.logger === undefined
        ? context.logger
        : sessionLogger(deps.logger, context.sessionId, captureId);
    return subsystemLogger(parent, PIPELINE_SUBSYSTEM).child({
      stage: GENERATE_PANEL_STAGE,
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
    row: 'started' | 'fallback' | 'completed' | 'failed',
    send: () => Result<unknown, DebuggenError>,
  ): void => {
    let sent: Result<unknown, DebuggenError>;
    try {
      sent = send();
    } catch (thrown) {
      sent = err(DebuggenError.from(thrown, 'INTERNAL'));
    }
    if (!sent.ok) {
      log.warn(
        'A progress row of the generate-panel stage could not be sent; the stage continues.',
        {
          row,
          code: sent.error.code,
        },
      );
    }
  };

  /**
   * The single failure path: log the code, close the group this run opened
   * with the stage's `failed` row, and return the error unchanged. The row
   * carries the failing subsystem's own sentence and hint; nothing about the
   * failed payload is logged.
   */
  const fail = (
    context: PipelineStageContext,
    log: Logger,
    error: DebuggenError,
    startedAt: number | undefined,
    groupOpened: boolean,
  ): Result<never, DebuggenError> => {
    log.warn('The generate-panel stage failed.', {
      code: error.code,
      ...durationFields(context.now, startedAt),
    });
    if (groupOpened) {
      const failure: SessionFailure = {
        stage: GENERATE_PANEL_STAGE,
        code: error.code,
        message: error.message,
        ...(error.hint !== undefined ? { hint: error.hint } : {}),
      };
      sendRow(log, 'failed', () => deps.progress.stageFailed(context.sessionId, failure));
    }
    return err(error);
  };

  /**
   * The delegation: `regenerate` on the existing-evidence follow-up path, which
   * needs the follow-up question the context carries, `generate` otherwise.
   */
  const delegate = (
    context: PipelineStageContext,
    input: GeneratePanelStageInput,
  ): Promise<Result<PanelGenerationResult, DebuggenError>> => {
    const request = toRequest(context, input);
    if (input.regenerate !== true) {
      return deps.panelGenerator.generate(request);
    }
    const { followUpQuestion } = context;
    if (followUpQuestion === undefined) {
      return Promise.resolve(err(missingFollowUpError()));
    }
    return deps.panelGenerator.regenerate({ ...request, followUpQuestion });
  };

  /** One run: header, preconditions, delegation, then the fallback and closing rows. */
  const execute = async (
    context: PipelineStageContext,
    input: GeneratePanelStageInput,
    log: Logger,
    startedAt: number | undefined,
    group: RunGroup,
  ): Promise<Result<GeneratePanelStageResult, DebuggenError>> => {
    // A run cancelled before it began opens no group; the generator still answers it with its own
    // typed cancellation, storing and delivering nothing.
    if (reportBoundaries && !isAborted(context.signal)) {
      group.opened = true;
      sendRow(log, 'started', () =>
        deps.progress.stageStarted(context.sessionId, GENERATE_PANEL_STAGE),
      );
    }

    if (context.captureId !== undefined && context.captureId !== input.captureId) {
      return fail(context, log, captureMismatchError(), startedAt, group.opened);
    }

    const generated = await delegate(context, input);
    if (!generated.ok) {
      return fail(context, log, generated.error, startedAt, group.opened);
    }
    const result = toStageResult(generated.value);

    if (input.supersedes !== undefined && input.supersedes !== result.supersedes) {
      log.warn('The stored panel supersedes a different panel than the caller expected.', {
        panelId: result.panelId,
        expectedSupersedes: input.supersedes,
        supersedes: result.supersedes ?? null,
      });
    }

    // Completed with degradation, never failed: the banner sentence comes from its one owner.
    if (result.fallback) {
      sendRow(log, 'fallback', () =>
        deps.progress.finding(context.sessionId, GENERATE_PANEL_STAGE, FALLBACK_BANNER_MESSAGE),
      );
    }
    if (group.opened) {
      sendRow(log, 'completed', () =>
        deps.progress.stageCompleted(context.sessionId, GENERATE_PANEL_STAGE),
      );
    }

    log.info('The generate-panel stage produced a panel.', {
      panelId: result.panelId,
      panelVersion: result.panelVersion,
      superseding: result.supersedes !== undefined,
      regenerated: input.regenerate === true,
      fallback: result.fallback,
      ...(result.fallbackReason === undefined ? {} : { fallbackReason: result.fallbackReason }),
      promptVersion: result.promptVersion,
      repairs: result.repairs,
      attempts: result.attempts,
      ...durationFields(context.now, startedAt),
    });

    return ok(result);
  };

  const run = async (
    context: PipelineStageContext,
    input: GeneratePanelStageInput,
  ): Promise<Result<GeneratePanelStageResult, DebuggenError>> => {
    const startedAt = readClock(context.now);
    const group: RunGroup = { opened: false };
    let log: Logger = noopLogger;
    try {
      log = loggerFor(context, input.captureId);
      return await execute(context, input, log, startedAt, group);
    } catch (thrown) {
      // A collaborator broke its never-throw contract. The run still ends as a typed failure, so
      // the caller can route the session to `failed` rather than lose the stage to a rejection.
      return fail(context, log, DebuggenError.from(thrown, 'INTERNAL'), startedAt, group.opened);
    }
  };

  return Object.freeze({ run });
}
