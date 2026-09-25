/**
 * Colocated unit suite for `./orchestrator.ts`, the sequencer of the
 * reasoning pipeline (AAP §0.4.2, §0.5.3, §0.5.5; §0.7.1 Group 2).
 *
 * What it pins:
 *
 * 1. **Order.** `PIPELINE_STAGE_ORDER` is derived from protocol's
 *    `PROGRESS_STAGES`; the stages run in that order, and every stage's
 *    `running` row precedes its `done` row.
 * 2. **Failure is never success.** A stage `Err` produces exactly one `failed`
 *    transition — carrying the failing stage — exactly one `failed` row, and no
 *    `generated`; the error comes back unchanged.
 * 3. **Fallback is success.** A fallback panel still reaches `generated`.
 * 4. **Empty capture.** Analysis is skipped and the session returns to `ready`.
 * 5. **Follow-ups.** Both paths: plan version n + 1 on the new-capture path,
 *    panel version n + 1 with `supersedes` on the existing-evidence path.
 * 6. **Bookkeeping.** `promptVersions` are recorded from what the stages report.
 * 7. **Concurrency and lifecycle.** One operation per session; cancellation
 *    and the caller's signal propagate; dispose is idempotent.
 * 8. **The model boundary.** With fake stages injected, the provider is never
 *    called by the orchestrator itself.
 * 9. **The default code-index loader** over the committed generic fixture app.
 *
 * Everything is in-process and hand-written: fake stages, an in-memory session
 * manager that applies the real state machine, a recording progress emitter and
 * a capturing logger. Two tests use a real default stage (understand with a
 * refusing request builder; generate-panel with a fake panel generator) to pin
 * the default wiring. Fixtures use invented, generic vocabulary only.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  CAPTURE_SIGNALS,
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  PROBLEM_CATEGORIES,
  PROBLEM_ENTITY_KINDS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  instrumentationPlanSchema,
  problemUnderstandingSchema,
  type AdapterRegistry,
  type InstrumentationPlan,
  type ModificationRecord,
  type ProblemUnderstanding,
} from '@debuggen/instrumentation';
import { PROMPT_STAGES, type PromptLoader, type PromptStage } from '@debuggen/model-provider';
import type { PanelSpec } from '@debuggen/panel-schema';
import {
  PROGRESS_STAGES,
  type AnalysisResult,
  type ProgressStage,
  type ProgressStatus,
  type SessionProgressPayload,
  type SessionRecord,
  type SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  createConsoleLogger,
  err,
  ok,
  type LogRecord,
  type Logger,
  type Result,
} from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import type { AnalysisFacts } from '../analysis/facts.js';
import type { AnalysisSummarizer } from '../analysis/summarize.js';
import type { ServiceConfig } from '../config.js';
import type { ReadinessVerdict } from '../instrumentation/readiness.js';
import type { InstrumentationOutcome, InstrumentationService } from '../instrumentation/service.js';
import type { PanelGenerationResult, PanelGenerator } from '../panels/generate.js';
import type { SessionManager, SessionPatch, StopCaptureOptions } from '../sessions/manager.js';
import { PROGRESS_STAGE_TITLES, type SessionProgress } from '../sessions/progress.js';
import {
  statusForStage,
  transition,
  type SessionFailure,
  type SessionTransitionContext,
} from '../sessions/state-machine.js';
import type { PanelsRepo } from '../store/panels-repo.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import type { TelemetryRepo } from '../store/telemetry-repo.js';
import type {
  ContextBuilder,
  PipelineCodeHandles,
  PipelineStageContext,
} from './context-builder.js';
import {
  PIPELINE_STAGE_ORDER,
  createCodeIndexLoader,
  createPipelineOrchestrator,
  type CodeIndexPort,
  type PipelineOrchestrator,
  type PipelineOrchestratorDeps,
  type StageOverrides,
} from './orchestrator.js';
import type { AnalyzeStage, AnalyzeStageResult } from './stages/analyze.js';
import {
  CAPTURE_EMPTY_MESSAGE,
  type CaptureArmResult,
  type CaptureCompleteResult as CaptureStageCompleteResult,
  type CaptureEmptiness,
  type CaptureStage,
} from './stages/capture.js';
import {
  FOLLOW_UP_STAGE,
  type FollowUpDecisionSummary,
  type FollowUpStage,
  type FollowUpStageInput,
  type FollowUpStageResult,
} from './stages/followup.js';
import type { GeneratePanelStage, GeneratePanelStageResult } from './stages/generate-panel.js';
import type { InvestigateStage, InvestigateStageResult } from './stages/investigate.js';
import type { PlanStage, PlanStageInput, PlanStageResult } from './stages/plan.js';
import type { UnderstandStage, UnderstandStageResult } from './stages/understand.js';

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture constants — invented, generic vocabulary
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-orchestrator-suite';
const PROJECT_ROOT = '/workspace/ledger-tool';
const FIXED_EPOCH_MS = 1_767_225_600_000;
const CAPTURE_ID = 'capture-orchestrator-suite';

/** A token planted in both questions; no log record may carry it. */
const SENTINEL = 'quillmarmotsentinel';

/** The versions each fake stage reports: distinct from the manifest's, so their origin is visible. */
const REPORTED = Object.freeze({
  understand: 'v002',
  investigate: 'v003',
  plan: 'v004',
  analyze: 'v005',
  'generate-panel': 'v006',
  followup: 'v007',
} satisfies Record<PromptStage, string>);

/** The manifest's current version of every prompt stage. */
const MANIFEST: Readonly<Record<PromptStage, string>> = Object.freeze(
  Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, 'v001'])) as Record<PromptStage, string>,
);

const UNDERSTANDING: ProblemUnderstanding = problemUnderstandingSchema.parse({
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: [CAPTURE_SIGNALS[0]],
  entities: [{ kind: PROBLEM_ENTITY_KINDS[0], name: 'LedgerTotals' }],
  searchHints: ['ledger totals'],
});

/** A plan version with one targetless runtime action. */
function planVersion(version: number): InstrumentationPlan {
  return instrumentationPlanSchema.parse({
    version: 1,
    planVersion: version,
    sessionId: SESSION_ID,
    objective: 'Determine why the ledger totals refresh slowly.',
    hypotheses: [],
    capture: ['interaction timing'],
    instrumentationTargets: [
      {
        id: `act_${String(version).padStart(16, '0')}`,
        file: TARGETLESS_FILE,
        symbol: TARGETLESS_SYMBOL,
        type: 'interaction-tracking',
        adapter: 'page-probe',
        mode: 'runtime',
        rationale: 'Time the interaction the developer reported.',
      },
    ],
  });
}

const PLAN_V1 = planVersion(1);
const PLAN_V2 = planVersion(2);

/** A modification record stand-in; the orchestrator only mirrors it by id. */
const MODIFICATION = {
  id: 'mod-orchestrator-suite',
  status: 'applied',
} as unknown as ModificationRecord;

const SUMMARY = { captureId: CAPTURE_ID, eventCount: 12 } as unknown as CaptureSummary;

function analysis(version: number): AnalysisResult {
  return {
    id: `analysis-v${String(version)}-suite`,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    analysisVersion: version,
    ...(version > 1 ? { supersedes: `analysis-v${String(version - 1)}-suite` } : {}),
    createdAt: FIXED_EPOCH_MS + version,
    metrics: [],
    observed: [],
    likelyCauses: [],
  };
}

function panel(version: number, fallback = false): PanelSpec {
  return {
    version: 1,
    id: `panel-v${String(version)}-suite`,
    sessionId: SESSION_ID,
    panelVersion: version,
    ...(version > 1 ? { supersedes: `panel-v${String(version - 1)}-suite` } : {}),
    title: 'Ledger totals',
    summary: { observed: [], likelyCauses: [] },
    layout: [],
    ...(fallback ? { meta: { fallback: true } } : {}),
  };
}

function verdict(satisfied: boolean): ReadinessVerdict {
  return {
    satisfied,
    perAdapter: [],
    blocking: [],
    degraded: [],
    remediations: [],
    plannedSignals: [],
    deliverableSignals: [],
    evaluatedAt: FIXED_EPOCH_MS,
    observed: {},
    reloadRequested: false,
  };
}

function installation(plan: InstrumentationPlan, satisfied = true): InstrumentationOutcome {
  return {
    sessionId: SESSION_ID,
    planVersion: plan.planVersion,
    activePlanVersion: plan.planVersion,
    applied: [MODIFICATION],
    runtimeHooks: [],
    unavailable: [],
    agentHooks: DORMANT_AGENT_HOOK_CONFIG,
    serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
    readiness: verdict(satisfied),
    degradations: [],
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: 'ledger-tool',
    devServerUrl: 'http://127.0.0.1:4173/',
    createdAt: FIXED_EPOCH_MS,
    updatedAt: FIXED_EPOCH_MS,
    status: 'created',
    question: `Why do the ledger totals refresh slowly ${SENTINEL}?`,
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
    ...overrides,
  };
}

/** Code handles no stage reads in this suite; identity is what is asserted. */
function fakeCode(): PipelineCodeHandles {
  return {
    graph: {} as unknown as PipelineCodeHandles['graph'],
    queries: {} as unknown as PipelineCodeHandles['queries'],
    routeMap: {} as unknown as PipelineCodeHandles['routeMap'],
    projectSummary: {} as unknown as PipelineCodeHandles['projectSummary'],
  };
}

function decision(needsNewCapture: boolean): FollowUpDecisionSummary {
  return {
    needsNewCapture,
    proposedActions: 0,
    acceptedActions: [],
    rejectedActions: [],
    promptVersion: REPORTED.followup,
    repairs: 0,
    attempts: 1,
    providerId: 'deterministic',
    model: 'rules',
  };
}

// ---------------------------------------------------------------------------
// Doubles: logger, progress, session manager
// ---------------------------------------------------------------------------

interface CapturedLogger {
  readonly logger: Logger;
  readonly records: LogRecord[];
}

function capturedLogger(): CapturedLogger {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  return { logger, records };
}

interface ProgressRowRecord {
  readonly method: string;
  readonly stage: ProgressStage;
  readonly status: ProgressStatus;
  readonly message: string;
}

interface RecordingProgress {
  readonly progress: SessionProgress;
  readonly rows: ProgressRowRecord[];
}

function recordingProgress(): RecordingProgress {
  const rows: ProgressRowRecord[] = [];
  const push = (
    method: string,
    sessionId: string,
    stage: ProgressStage,
    status: ProgressStatus,
    message: string,
  ): Result<SessionProgressPayload, DebuggenError> => {
    rows.push({ method, stage, status, message });
    return ok({ sessionId, stage, status, message });
  };
  const progress: SessionProgress = {
    emit: (sessionId, row) => push('emit', sessionId, row.stage, row.status, row.message),
    stageStarted: (sessionId, stage, message) =>
      push('stageStarted', sessionId, stage, 'running', message ?? PROGRESS_STAGE_TITLES[stage]),
    stageCompleted: (sessionId, stage, message) =>
      push('stageCompleted', sessionId, stage, 'done', message ?? PROGRESS_STAGE_TITLES[stage]),
    stageFailed: (sessionId, failure) =>
      push('stageFailed', sessionId, failure.stage, 'failed', failure.message),
    finding: (sessionId, stage, message) => push('finding', sessionId, stage, 'done', message),
    reportInvestigation: () => ok([]),
    reportInstrumentation: () => ok([]),
    readyToCapture: (sessionId) =>
      push('readyToCapture', sessionId, 'instrument', 'done', 'Ready to capture'),
  };
  return { progress, rows };
}

interface TransitionRecord {
  readonly from: SessionStatus;
  readonly to: SessionStatus;
  readonly context: SessionTransitionContext | undefined;
}

interface FakeManager {
  readonly manager: SessionManager;
  readonly transitions: TransitionRecord[];
  readonly patches: SessionPatch[];
  current(): SessionRecord;
  set(overrides: Partial<SessionRecord>): void;
}

/** Whether the real manager reserves `from → to` for its capture and end lifecycle methods. */
function lifecycleOwned(from: SessionStatus, to: SessionStatus): boolean {
  return (
    to === 'capturing' ||
    to === 'ended' ||
    (from === 'capturing' && (to === 'analyzing' || to === 'ready'))
  );
}

/**
 * An in-memory session manager applying the real state machine. Like the real
 * one it writes the failing stage's `failed` row as part of a transition into
 * `failed`, and refuses the edges its capture lifecycle methods own.
 */
function fakeManager(initial: SessionRecord, progress: SessionProgress): FakeManager {
  let record = initial;
  const transitions: TransitionRecord[] = [];
  const patches: SessionPatch[] = [];

  const move = (
    to: SessionStatus,
    context?: SessionTransitionContext,
  ): Result<SessionRecord, DebuggenError> => {
    const from = record.status;
    const moved = transition(from, to, context);
    if (!moved.ok) {
      return moved;
    }
    record = { ...record, status: to, updatedAt: record.updatedAt + 1 };
    transitions.push({ from, to, context });
    if (to === 'failed' && context?.failure !== undefined) {
      progress.stageFailed(record.id, context.failure);
    }
    return ok(record);
  };

  const manager = {
    get: (sessionId: string): Result<SessionRecord | undefined, DebuggenError> =>
      ok(sessionId === record.id ? record : undefined),
    transitionTo: (
      _sessionId: string,
      to: SessionStatus,
      context?: SessionTransitionContext,
    ): Promise<Result<SessionRecord, DebuggenError>> =>
      Promise.resolve(
        lifecycleOwned(record.status, to)
          ? err(
              new DebuggenError(
                'SESSION_INVALID_STATE',
                'That edge belongs to the capture lifecycle.',
                {
                  details: { reason: 'lifecycle-owned-transition' },
                },
              ),
            )
          : move(to, context),
      ),
    patch: (
      _sessionId: string,
      patch: SessionPatch,
    ): Promise<Result<SessionRecord, DebuggenError>> => {
      patches.push(patch);
      record = { ...record, ...patch } as SessionRecord;
      return Promise.resolve(ok(record));
    },
    startCapture: (): Promise<Result<{ readonly captureId: string }, DebuggenError>> => {
      const moved = move('capturing');
      if (!moved.ok) {
        return Promise.resolve(moved);
      }
      record = {
        ...record,
        captures: [
          ...record.captures,
          { id: CAPTURE_ID, planVersion: 1, startedAt: FIXED_EPOCH_MS },
        ],
      };
      return Promise.resolve(ok({ captureId: CAPTURE_ID }));
    },
    stopCapture: (
      _sessionId: string,
      options: StopCaptureOptions,
    ): Promise<Result<SessionRecord['captures'][number], DebuggenError>> => {
      const moved = move(options.next);
      if (!moved.ok) {
        return Promise.resolve(moved);
      }
      const stopped = {
        id: CAPTURE_ID,
        planVersion: 1,
        startedAt: FIXED_EPOCH_MS,
        stoppedAt: FIXED_EPOCH_MS + 5,
      };
      record = { ...record, captures: [...record.captures.slice(0, -1), stopped] };
      return Promise.resolve(ok(stopped));
    },
  };

  return {
    manager: manager as unknown as SessionManager,
    transitions,
    patches,
    current: () => record,
    set: (overrides) => {
      record = { ...record, ...overrides };
    },
  };
}

// ---------------------------------------------------------------------------
// Doubles: the seven stages, the collaborators and the harness
// ---------------------------------------------------------------------------

interface StageSpies {
  readonly understand: Mock<UnderstandStage['run']>;
  readonly investigate: Mock<InvestigateStage['run']>;
  readonly plan: Mock<PlanStage['run']>;
  readonly arm: Mock<CaptureStage['arm']>;
  readonly complete: Mock<CaptureStage['complete']>;
  readonly analyze: Mock<AnalyzeStage['run']>;
  readonly generatePanel: Mock<GeneratePanelStage['run']>;
  readonly followUp: Mock<FollowUpStage['run']>;
}

interface HarnessOptions {
  readonly session?: Partial<SessionRecord>;
  /** Stages built by the orchestrator's default wiring instead of faked. */
  readonly defaultStages?: readonly (keyof StageOverrides)[];
  readonly contextBuilder?: ContextBuilder;
  readonly panelGenerator?: PanelGenerator;
  readonly installation?: InstrumentationOutcome;
  readonly emptyCapture?: boolean;
  readonly evaluateReadiness?: Mock;
  readonly arming?: unknown;
}

interface Harness {
  readonly orchestrator: PipelineOrchestrator;
  readonly manager: FakeManager;
  readonly progress: RecordingProgress;
  readonly log: CapturedLogger;
  readonly stages: StageSpies;
  readonly provider: {
    readonly generateText: Mock;
    readonly generateStructured: Mock;
    readonly callTools: Mock;
  };
  readonly codeIndex: { readonly load: Mock<CodeIndexPort['load']>; readonly invalidate: Mock };
  readonly code: PipelineCodeHandles;
  readonly versions: Mock;
}

function harness(options: HarnessOptions = {}): Harness {
  const log = capturedLogger();
  const progress = recordingProgress();
  const manager = fakeManager(sessionRecord(options.session), progress.progress);
  const rows = progress.progress;
  const code = fakeCode();

  const stages: StageSpies = {
    understand: vi.fn<UnderstandStage['run']>((context) => {
      rows.stageStarted(context.sessionId, 'understand');
      rows.stageCompleted(context.sessionId, 'understand');
      const result: UnderstandStageResult = {
        understanding: UNDERSTANDING,
        promptVersion: REPORTED.understand,
        repairs: 0,
      };
      return Promise.resolve(ok(result));
    }),
    investigate: vi.fn<InvestigateStage['run']>((context) => {
      rows.stageStarted(context.sessionId, 'investigate');
      rows.stageCompleted(context.sessionId, 'investigate');
      const result: InvestigateStageResult = {
        investigation: {
          relevantFiles: [
            {
              file: 'src/ledger/totals.ts',
              symbol: 'refreshTotals',
              reason: 'Computes the totals.',
              score: 0.9,
            },
          ],
          flows: ['click → refreshTotals'],
        },
        promptVersion: REPORTED.investigate,
        repairs: 0,
        toolRuns: [],
      };
      return Promise.resolve(ok(result));
    }),
    plan: vi.fn<PlanStage['run']>(async (context, input: PlanStageInput) => {
      rows.stageStarted(context.sessionId, 'plan');
      rows.stageCompleted(context.sessionId, 'plan');
      const handed = await input.beforeInstall?.({ session: context.session, plan: PLAN_V1 });
      if (handed !== undefined && !handed.ok) {
        return err(handed.error);
      }
      const installed = options.installation ?? installation(PLAN_V1);
      rows.stageStarted(context.sessionId, 'instrument');
      if (installed.readiness.satisfied) {
        rows.readyToCapture(context.sessionId);
      }
      const result: PlanStageResult = {
        plan: PLAN_V1,
        planVersion: 1,
        promptVersion: REPORTED.plan,
        repairs: 0,
        feasibility: {} as unknown as PlanStageResult['feasibility'],
        fallback: false,
        session: context.session,
        installation: installed,
      };
      return ok(result);
    }),
    arm: vi.fn<CaptureStage['arm']>(async () => {
      const opened = await manager.manager.startCapture(SESSION_ID);
      if (!opened.ok) {
        return opened;
      }
      const armed: CaptureArmResult = {
        captureId: opened.value.captureId,
        planVersion: 1,
        readiness: verdict(true),
        readinessSource: 'supplied',
        agentHooks: DORMANT_AGENT_HOOK_CONFIG,
        serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
        serverAgent: 'not-needed',
        degradations: [],
      };
      return ok(armed);
    }),
    complete: vi.fn<CaptureStage['complete']>(async () => {
      const next = options.emptyCapture === true ? 'ready' : 'analyzing';
      const stopped = await manager.manager.stopCapture(SESSION_ID, { summary: SUMMARY, next });
      if (!stopped.ok) {
        return stopped;
      }
      const emptiness: CaptureEmptiness =
        options.emptyCapture === true
          ? {
              empty: true as const,
              reason: 'no-events' as const,
              message: CAPTURE_EMPTY_MESSAGE,
              eventCount: 0,
              interactionCount: 0,
              interactionRequired: true,
            }
          : {
              empty: false as const,
              eventCount: 12,
              interactionCount: 1,
              interactionRequired: true,
            };
      const result: CaptureStageCompleteResult = {
        captureId: CAPTURE_ID,
        planVersion: 1,
        summary: SUMMARY,
        summarySource: 'computed',
        emptiness,
        next,
        capture: stopped.value,
        stoppedNow: true,
        armed: {
          agentHooks: DORMANT_AGENT_HOOK_CONFIG,
          serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
          source: 'service',
        },
      };
      return ok(result);
    }),
    analyze: vi.fn<AnalyzeStage['run']>(() => {
      const result: AnalyzeStageResult = {
        analysis: analysis(1),
        analysisVersion: 1,
        promptVersion: REPORTED.analyze,
        repairs: 0,
        attempts: 1,
        providerId: 'deterministic',
        model: 'rules',
        verification: {} as unknown as AnalyzeStageResult['verification'],
        summary: SUMMARY,
        truncated: [],
      };
      return Promise.resolve(ok(result));
    }),
    generatePanel: vi.fn<GeneratePanelStage['run']>(() => {
      const result: GeneratePanelStageResult = {
        panelId: panel(1).id,
        panel: panel(1),
        panelVersion: 1,
        promptVersion: REPORTED['generate-panel'],
        fallback: false,
        repairs: 0,
        attempts: 1,
      };
      return Promise.resolve(ok(result));
    }),
    followUp: vi.fn<FollowUpStage['run']>(async (context, input: FollowUpStageInput) => {
      rows.stageStarted(context.sessionId, FOLLOW_UP_STAGE);
      rows.stageCompleted(context.sessionId, FOLLOW_UP_STAGE);
      const chosen = await input.onPathChosen?.('existing-evidence');
      if (chosen !== undefined && !chosen.ok) {
        return err(chosen.error);
      }
      const result: FollowUpStageResult = {
        path: 'existing-evidence',
        decision: decision(false),
        session: context.session,
        outcomeRecorded: true,
        captureId: CAPTURE_ID,
        analysis: analysis(2),
        analysisVersion: 2,
        supersededAnalysisId: analysis(1).id,
        panel: panel(2),
        panelVersion: 2,
        supersededPanelId: panel(1).id,
        fallbackPanel: false,
        analysisPromptVersion: 'v008',
        panelPromptVersion: 'v009',
      };
      return ok(result);
    }),
  };

  const defaults = new Set(options.defaultStages ?? []);
  const overrides: StageOverrides = {
    ...(defaults.has('understand') ? {} : { understand: { run: stages.understand } }),
    ...(defaults.has('investigate') ? {} : { investigate: { run: stages.investigate } }),
    ...(defaults.has('plan') ? {} : { plan: { run: stages.plan } }),
    ...(defaults.has('capture') ? {} : { capture: { arm: stages.arm, complete: stages.complete } }),
    ...(defaults.has('analyze') ? {} : { analyze: { run: stages.analyze } }),
    ...(defaults.has('generatePanel') ? {} : { generatePanel: { run: stages.generatePanel } }),
    ...(defaults.has('followUp') ? {} : { followUp: { run: stages.followUp } }),
  };

  const provider = { generateText: vi.fn(), generateStructured: vi.fn(), callTools: vi.fn() };
  const versions = vi.fn(() => ok(MANIFEST));
  const codeIndex = {
    load: vi.fn<CodeIndexPort['load']>(() => Promise.resolve(ok(code))),
    invalidate: vi.fn(),
  };
  const instrumentation = {
    arming: vi.fn(() => options.arming),
    ...(options.evaluateReadiness !== undefined
      ? { evaluateReadiness: options.evaluateReadiness }
      : {}),
  };

  const deps: PipelineOrchestratorDeps = {
    config: { indexCacheDir: '/tmp/orchestrator-suite-never-written' } as unknown as ServiceConfig,
    logger: log.logger,
    provider: { id: 'tripwire', ...provider },
    promptLoader: { versions } as unknown as PromptLoader,
    contextBuilder: options.contextBuilder ?? ({} as unknown as ContextBuilder),
    sessions: manager.manager,
    progress: progress.progress,
    sessionsRepo: {
      latestPlanVersion: vi.fn(() => ok(1)),
      getPlan: vi.fn(() => ok(PLAN_V1)),
    } as unknown as SessionsRepo,
    panelsRepo: {} as unknown as PanelsRepo,
    telemetryRepo: {} as unknown as TelemetryRepo,
    instrumentation: instrumentation as unknown as InstrumentationService,
    modifications: { latestRecordForFile: vi.fn() },
    summarizer: {} as unknown as AnalysisSummarizer,
    facts: {} as unknown as AnalysisFacts,
    panelGenerator: options.panelGenerator ?? ({} as unknown as PanelGenerator),
    adapters: {} as unknown as AdapterRegistry,
    codeIndex,
    stages: overrides,
    now: () => FIXED_EPOCH_MS,
  };

  return {
    orchestrator: createPipelineOrchestrator(deps),
    manager,
    progress,
    log,
    stages,
    provider,
    codeIndex,
    code,
    versions,
  };
}

/** The statuses the session moved to, in order. */
function statusesOf(h: Harness): SessionStatus[] {
  return h.manager.transitions.map((entry) => entry.to);
}

/** The failures the session was filed under, in order. */
function failuresOf(h: Harness): SessionFailure[] {
  return h.manager.transitions.flatMap((entry) =>
    entry.to === 'failed' && entry.context?.failure !== undefined ? [entry.context.failure] : [],
  );
}

/** The `failed` progress rows sent. */
function failedRows(h: Harness): ProgressRowRecord[] {
  return h.progress.rows.filter((row) => row.status === 'failed');
}

/** Unwraps an `Ok`, failing the test with the error otherwise. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`Expected Ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Unwraps an `Err`, failing the test otherwise. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('Expected Err, got Ok.');
  }
  return result.error;
}

/** Drives a session from `created` through a completed capture. */
async function throughCapture(h: Harness): Promise<void> {
  expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
  expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));
  expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));
}

/** A stage error of the product's shape, tagged with a stage. */
function stageError(
  stage: ProgressStage,
  code: 'MODEL_UNAVAILABLE' | 'INSTRUMENTATION_INSTALL_FAILED' = 'MODEL_UNAVAILABLE',
): DebuggenError {
  return new DebuggenError(code, 'The model provider is unavailable.', {
    hint: 'Check the provider configuration.',
    details: { stage },
  });
}

// ---------------------------------------------------------------------------
// 1. Order
// ---------------------------------------------------------------------------

describe('PIPELINE_STAGE_ORDER', () => {
  it('is derived from protocol’s PROGRESS_STAGES, in protocol’s order', () => {
    const expected = PROGRESS_STAGES.filter(
      (stage) => statusForStage(stage) !== undefined || stage === FOLLOW_UP_STAGE,
    );
    expect(PIPELINE_STAGE_ORDER).toEqual(expected);

    const positions = PIPELINE_STAGE_ORDER.map((stage) => PROGRESS_STAGES.indexOf(stage));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(Object.isFrozen(PIPELINE_STAGE_ORDER)).toBe(true);
  });

  it('leaves out exactly the progress stages that own no status and are not the follow-up', () => {
    const excluded = PROGRESS_STAGES.filter((stage) => !PIPELINE_STAGE_ORDER.includes(stage));
    for (const stage of excluded) {
      expect(statusForStage(stage)).toBeUndefined();
      expect(stage).not.toBe(FOLLOW_UP_STAGE);
    }
    expect(excluded.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. run — Stages 1–3 and the installation
// ---------------------------------------------------------------------------

describe('run', () => {
  it('runs understand, investigate and plan in order and ends at ready', async () => {
    const h = harness();

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome).toMatchObject({
      sessionId: SESSION_ID,
      status: 'ready',
      ready: true,
      planVersion: 1,
      fallbackPlan: false,
      relevantFileCount: 1,
      appliedModifications: 1,
      promptVersionsRecorded: true,
    });
    expect(statusesOf(h)).toEqual([
      'understanding',
      'investigating',
      'planning',
      'instrumenting',
      'ready',
    ]);

    const order = [h.stages.understand, h.stages.investigate, h.stages.plan].map(
      (spy) => spy.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(h.stages.arm).not.toHaveBeenCalled();
  });

  it('guards instrumenting → ready with the install’s readiness verdict', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    const ready = h.manager.transitions.find((entry) => entry.to === 'ready');
    expect(ready?.from).toBe('instrumenting');
    expect(ready?.context?.readinessSatisfied).toBe(true);
  });

  it('stays at instrumenting, without failing, while readiness is unsatisfied', async () => {
    const h = harness({ installation: installation(PLAN_V1, false) });

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome.status).toBe('instrumenting');
    expect(outcome.ready).toBe(false);
    expect(statusesOf(h)).not.toContain('ready');
    expect(failedRows(h)).toEqual([]);
  });

  it('persists the understanding, the relevant files and the applied modifications', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    const record = h.manager.current();
    expect(record.understanding).toEqual(UNDERSTANDING);
    expect(record.relevantFiles.map((file) => file.file)).toEqual(['src/ledger/totals.ts']);
    expect(record.modifications.map((entry) => entry.id)).toEqual([MODIFICATION.id]);
  });

  it('loads the code handles once, refreshed, and threads the same bundle through every stage', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(h.codeIndex.load).toHaveBeenCalledTimes(1);
    expect(h.codeIndex.load.mock.calls[0]?.[0]).toBe(PROJECT_ROOT);
    expect(h.codeIndex.load.mock.calls[0]?.[1]).toMatchObject({ refresh: true });
    for (const spy of [h.stages.understand, h.stages.investigate, h.stages.plan]) {
      const context = spy.mock.calls[0]?.[0];
      expect(context?.code).toBe(h.code);
      expect(context?.projectRoot).toBe(PROJECT_ROOT);
    }
  });

  it('hands Stage 2 the Stage 1 artifact and Stage 3 both upstream artifacts', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(h.stages.investigate.mock.calls[0]?.[1]).toEqual({ understanding: UNDERSTANDING });
    const planInput = h.stages.plan.mock.calls[0]?.[1];
    expect(planInput?.understanding).toEqual(UNDERSTANDING);
    expect(planInput?.investigation.relevantFiles).toHaveLength(1);
    expect(typeof planInput?.beforeInstall).toBe('function');
  });

  it('records the prompt versions the stages reported, and the manifest’s for stages not yet run', async () => {
    const h = harness();
    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome.promptVersions).toEqual({
      understand: REPORTED.understand,
      investigate: REPORTED.investigate,
      plan: REPORTED.plan,
      analyze: MANIFEST.analyze,
      'generate-panel': MANIFEST['generate-panel'],
      followup: MANIFEST.followup,
    });
    expect(h.manager.current().promptVersions).toEqual(outcome.promptVersions);
    expect(h.versions).toHaveBeenCalledTimes(1);
  });

  it('keeps a version the session already recorded for a stage that has not run', async () => {
    const h = harness({ session: { promptVersions: { analyze: 'v010' } } });
    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome.promptVersions.analyze).toBe('v010');
  });

  it('refuses a session that is not startable without moving it', async () => {
    const h = harness({ session: { status: 'ready' } });

    const error = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(h.manager.transitions).toEqual([]);
    expect(h.stages.understand).not.toHaveBeenCalled();
  });

  it('refuses to start over while the session’s instrumentation is still installed', async () => {
    const h = harness({ session: { status: 'failed' }, arming: { activePlanVersion: 1 } });

    const error = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(error.details?.['reason']).toBe('instrumentation-installed');
    expect(h.manager.transitions).toEqual([]);
  });

  it('retries from failed when nothing is installed', async () => {
    const h = harness({ session: { status: 'failed' } });

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome.status).toBe('ready');
    expect(statusesOf(h)[0]).toBe('understanding');
  });

  it('answers SESSION_NOT_FOUND for an unknown session', async () => {
    const h = harness();

    const error = expectErr(await h.orchestrator.run({ sessionId: 'session-unknown' }));

    expect(error.code).toBe('SESSION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 3. Failure is never success
// ---------------------------------------------------------------------------

describe('stage failures', () => {
  it('files a Stage 2 failure once, under investigate, and stops the pipeline', async () => {
    const h = harness();
    const failure = stageError('investigate');
    h.stages.investigate.mockResolvedValueOnce(err(failure));

    const error = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(error).toBe(failure);
    expect(failuresOf(h)).toEqual([
      { stage: 'investigate', code: failure.code, message: failure.message, hint: failure.hint },
    ]);
    expect(failedRows(h)).toHaveLength(1);
    expect(failedRows(h)[0]?.stage).toBe('investigate');
    expect(statusesOf(h)).not.toContain('generated');
    expect(h.stages.plan).not.toHaveBeenCalled();
    expect(h.manager.current().status).toBe('failed');
  });

  it('files an install failure under the stage the error names', async () => {
    const h = harness();
    const failure = stageError('instrument', 'INSTRUMENTATION_INSTALL_FAILED');
    h.stages.plan.mockResolvedValueOnce(err(failure));

    expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(failuresOf(h).map((entry) => entry.stage)).toEqual(['instrument']);
    expect(failedRows(h)).toHaveLength(1);
  });

  it('shows the failed row of a default stage once: the stage’s row is recorded, the manager’s is sent', async () => {
    const refusal = new DebuggenError(
      'PROJECT_NOT_FOUND',
      'The stub builder refused the request.',
      {
        hint: 'Open the project again.',
      },
    );
    const contextBuilder = {
      buildUnderstandRequest: vi.fn(() => err(refusal)),
    } as unknown as ContextBuilder;
    const h = harness({ defaultStages: ['understand'], contextBuilder });

    const error = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(error).toBe(refusal);
    expect(failedRows(h)).toEqual([
      { method: 'stageFailed', stage: 'understand', status: 'failed', message: refusal.message },
    ]);
    expect(failuresOf(h)).toHaveLength(1);
    expect(
      h.progress.rows.filter((row) => row.stage === 'understand').map((row) => row.status),
    ).toEqual(['running', 'failed']);
    expect(h.provider.generateStructured).not.toHaveBeenCalled();
    expect(h.provider.generateText).not.toHaveBeenCalled();
  });

  it('never reaches generated when analysis fails, and never calls panel generation', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));
    const failure = new DebuggenError(
      'MODEL_OUTPUT_INVALID',
      'The analysis cited evidence the capture does not hold.',
      {
        details: { stage: 'analyze' },
      },
    );
    h.stages.analyze.mockResolvedValueOnce(err(failure));

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(failure);
    expect(failuresOf(h).map((entry) => entry.stage)).toEqual(['analyze']);
    expect(failedRows(h)).toHaveLength(1);
    expect(statusesOf(h)).not.toContain('generated');
    expect(h.stages.generatePanel).not.toHaveBeenCalled();
  });

  it('never reaches generated when panel generation fails', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));
    h.stages.generatePanel.mockResolvedValueOnce(err(stageError('generate-panel')));

    expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(failuresOf(h).map((entry) => entry.stage)).toEqual(['generate-panel']);
    expect(h.manager.current().status).toBe('failed');
    expect(statusesOf(h)).not.toContain('generated');
  });

  it('files a stage that broke its never-throw contract as a failure of that stage', async () => {
    const h = harness();
    h.stages.investigate.mockRejectedValueOnce(new Error('collaborator exploded'));

    const error = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(error.code).toBe('INTERNAL');
    expect(failuresOf(h).map((entry) => entry.stage)).toEqual(['investigate']);
  });
});

// ---------------------------------------------------------------------------
// 4. beginCapture and completeCapture
// ---------------------------------------------------------------------------

describe('capture', () => {
  it('opens the capture group after arming and closes it before analysis', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    const armed = expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));
    expect(armed).toMatchObject({
      captureId: CAPTURE_ID,
      planVersion: 1,
      readinessSource: 'supplied',
    });
    expect(h.manager.current().status).toBe('capturing');
    expect(h.stages.arm.mock.calls[0]?.[1]).toMatchObject({ readiness: { satisfied: true } });

    const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));
    expect(result).toMatchObject({
      captureId: CAPTURE_ID,
      emptyCapture: false,
      panelId: panel(1).id,
      panelVersion: 1,
      fallback: false,
    });
    expect(result.analysis?.id).toBe(analysis(1).id);
    expect(h.manager.current().status).toBe('generated');
  });

  it('takes the guarded edge to generated with both validated artifacts', async () => {
    const h = harness();
    await throughCapture(h);

    const generated = h.manager.transitions.find((entry) => entry.to === 'generated');
    expect(generated?.from).toBe('analyzing');
    expect(generated?.context?.analysis?.id).toBe(analysis(1).id);
    expect(generated?.context?.panel?.id).toBe(panel(1).id);
  });

  it('pairs every stage’s running row before its done row, in pipeline order', async () => {
    const h = harness();
    await throughCapture(h);

    const seen = PIPELINE_STAGE_ORDER.filter((stage) =>
      h.progress.rows.some((row) => row.stage === stage),
    );
    expect(seen).toEqual([
      'understand',
      'investigate',
      'plan',
      'instrument',
      'capture',
      'analyze',
      'generate-panel',
    ]);

    const firstAppearance = h.progress.rows
      .map((row) => row.stage)
      .filter((stage, index, all) => all.indexOf(stage) === index);
    expect(firstAppearance).toEqual(seen);

    for (const stage of seen) {
      const statuses = h.progress.rows
        .filter((row) => row.stage === stage)
        .map((row) => row.status);
      expect(statuses[0]).toBe('running');
      expect(statuses.at(-1)).toBe('done');
    }
    expect(failedRows(h)).toEqual([]);
  });

  it('passes the capture, its understanding and its analysis to Stages 5 and 6', async () => {
    const h = harness();
    await throughCapture(h);

    const [analyzeContext, analyzeInput] = h.stages.analyze.mock.calls[0] ?? [];
    expect(analyzeContext?.captureId).toBe(CAPTURE_ID);
    expect(analyzeInput).toEqual({ captureId: CAPTURE_ID, understanding: UNDERSTANDING });
    const [panelContext, panelInput] = h.stages.generatePanel.mock.calls[0] ?? [];
    expect(panelContext?.captureId).toBe(CAPTURE_ID);
    expect(panelInput).toEqual({ captureId: CAPTURE_ID, analysis: analysis(1), summary: SUMMARY });
  });

  it('mirrors the analysis and the panel onto the record and records their prompt versions', async () => {
    const h = harness();
    await throughCapture(h);

    const record = h.manager.current();
    expect(record.analyses.map((entry) => entry.id)).toEqual([analysis(1).id]);
    expect(record.panelIds).toEqual([panel(1).id]);
    expect(record.promptVersions).toMatchObject({
      understand: REPORTED.understand,
      analyze: REPORTED.analyze,
      'generate-panel': REPORTED['generate-panel'],
    });
  });

  it('reaches generated with a fallback panel from the default generate-panel stage', async () => {
    const generate = vi.fn(() => {
      const result: PanelGenerationResult = {
        panel: panel(1, true),
        fallback: true,
        promptVersion: REPORTED['generate-panel'],
        attempts: 3,
        repairs: 2,
        broadcast: true,
      };
      return Promise.resolve(ok(result));
    });
    const panelGenerator = { generate, regenerate: vi.fn() } as unknown as PanelGenerator;
    const h = harness({ defaultStages: ['generatePanel'], panelGenerator });

    await throughCapture(h);

    expect(h.manager.current().status).toBe('generated');
    const generated = h.manager.transitions.find((entry) => entry.to === 'generated');
    expect(generated?.context?.panel?.meta?.fallback).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const panelRows = h.progress.rows.filter((row) => row.stage === 'generate-panel');
    expect(panelRows.map((row) => row.method)).toEqual([
      'stageStarted',
      'finding',
      'stageCompleted',
    ]);
    expect(failedRows(h)).toEqual([]);
  });

  it('reports the fallback flag to the caller', async () => {
    const h = harness();
    h.stages.generatePanel.mockResolvedValueOnce(
      ok({
        panelId: panel(1).id,
        panel: panel(1, true),
        panelVersion: 1,
        promptVersion: REPORTED['generate-panel'],
        fallback: true,
        repairs: 2,
        attempts: 3,
      }),
    );
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(result.fallback).toBe(true);
    expect(h.manager.current().status).toBe('generated');
  });

  it('skips analysis for an empty capture and returns the session to ready', async () => {
    const h = harness({ emptyCapture: true });
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(result).toEqual({ captureId: CAPTURE_ID, summary: SUMMARY, emptyCapture: true });
    expect(h.manager.current().status).toBe('ready');
    expect(h.stages.analyze).not.toHaveBeenCalled();
    expect(h.stages.generatePanel).not.toHaveBeenCalled();
    const closing = h.progress.rows.filter((row) => row.stage === 'capture').at(-1);
    expect(closing).toMatchObject({ status: 'done', message: CAPTURE_EMPTY_MESSAGE });
    expect(failedRows(h)).toEqual([]);
  });

  it('returns a capture conflict unchanged and leaves the session ready', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
    const conflict = new DebuggenError(
      'CAPTURE_ALREADY_ACTIVE',
      'Another session is capturing this project.',
      {
        details: { owningSessionId: 'session-other' },
      },
    );
    h.stages.arm.mockResolvedValueOnce(err(conflict));

    const error = expectErr(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(conflict);
    expect(h.manager.current().status).toBe('ready');
    expect(failedRows(h)).toEqual([]);
    expect(h.progress.rows.some((row) => row.stage === 'capture')).toBe(false);
  });

  it('re-gates an instrumenting session through evaluateReadiness before arming', async () => {
    const evaluateReadiness = vi.fn(() => Promise.resolve(ok(verdict(true))));
    const h = harness({ installation: installation(PLAN_V1, false), evaluateReadiness });
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expect(h.manager.current().status).toBe('instrumenting');

    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    expect(evaluateReadiness).toHaveBeenCalledTimes(1);
    expect(evaluateReadiness.mock.calls[0]).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, plan: PLAN_V1 }),
    ]);
    expect(statusesOf(h).slice(-2)).toEqual(['ready', 'capturing']);
  });

  it('refuses to capture an instrumenting session whose readiness is still unsatisfied', async () => {
    const h = harness({ installation: installation(PLAN_V1, false) });
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    const error = expectErr(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(error.details?.['reason']).toBe('readiness-unsatisfied');
    expect(h.manager.current().status).toBe('instrumenting');
    expect(h.stages.arm).not.toHaveBeenCalled();
  });

  it('returns a refusal to complete a capture that is not running without changing anything', async () => {
    const h = harness({ session: { status: 'ready' } });
    const refusal = new DebuggenError('SESSION_INVALID_STATE', 'No capture is running.', {
      details: { reason: 'no-active-capture' },
    });
    h.stages.complete.mockResolvedValueOnce(err(refusal));

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(refusal);
    expect(h.manager.transitions).toEqual([]);
    expect(failedRows(h)).toEqual([]);
  });

  it('resumes the stored capture of a session left failed after analysis', async () => {
    const h = harness();
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));
    h.stages.analyze.mockResolvedValueOnce(err(stageError('analyze')));
    expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));
    expect(h.manager.current().status).toBe('failed');
    h.stages.complete.mockImplementationOnce(() => {
      const record = h.manager.current();
      const capture = record.captures.at(-1);
      if (capture === undefined) {
        return Promise.resolve(err(new DebuggenError('INTERNAL', 'The suite lost its capture.')));
      }
      const result: CaptureStageCompleteResult = {
        captureId: capture.id,
        planVersion: 1,
        summary: SUMMARY,
        summarySource: 'stored',
        emptiness: { empty: false, eventCount: 12, interactionCount: 1, interactionRequired: true },
        next: 'analyzing',
        capture,
        stoppedNow: false,
        armed: {
          agentHooks: DORMANT_AGENT_HOOK_CONFIG,
          serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
          source: 'service',
        },
      };
      return Promise.resolve(ok(result));
    });

    const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(h.stages.complete.mock.calls.at(-1)?.[1]).toEqual({ captureId: CAPTURE_ID });
    expect(result.panelId).toBe(panel(1).id);
    expect(statusesOf(h).slice(-2)).toEqual(['analyzing', 'generated']);
  });
});

// ---------------------------------------------------------------------------
// 5. Follow-ups
// ---------------------------------------------------------------------------

describe('followUp', () => {
  async function generatedHarness(options: HarnessOptions = {}): Promise<Harness> {
    const h = harness(options);
    await throughCapture(h);
    return h;
  }

  it('existing-evidence: generated → analyzing → generated with the next analysis and panel versions', async () => {
    const h = await generatedHarness();
    const before = h.manager.transitions.length;

    const outcome = expectOk(
      await h.orchestrator.followUp({ sessionId: SESSION_ID, question: `Why twice ${SENTINEL}?` }),
    );

    expect(outcome).toMatchObject({
      path: 'existing-evidence',
      status: 'generated',
      panelId: panel(2).id,
      panelVersion: 2,
      supersedes: panel(1).id,
      fallback: false,
    });
    expect(outcome.analysis?.analysisVersion).toBe(2);
    expect(h.manager.transitions.slice(before).map((entry) => entry.to)).toEqual([
      'analyzing',
      'generated',
    ]);
    const record = h.manager.current();
    expect(record.analyses.map((entry) => entry.id)).toEqual([analysis(1).id, analysis(2).id]);
    expect(record.panelIds).toEqual([panel(1).id, panel(2).id]);
    expect(record.promptVersions).toMatchObject({
      followup: REPORTED.followup,
      analyze: 'v008',
      'generate-panel': 'v009',
    });
    expect(h.stages.plan).toHaveBeenCalledTimes(1);
  });

  it('passes the follow-up question to the stage untouched and reuses the loaded code handles', async () => {
    const h = await generatedHarness();
    const question = `Why twice ${SENTINEL}?`;

    expectOk(await h.orchestrator.followUp({ sessionId: SESSION_ID, question }));

    const [context, input] = h.stages.followUp.mock.calls[0] ?? [];
    expect(input?.followUpQuestion).toBe(question);
    expect(context?.followUpQuestion).toBe(question);
    expect(context?.code).toBe(h.code);
    expect(h.codeIndex.load.mock.calls.at(-1)?.[1]).toMatchObject({ refresh: false });
  });

  it('new-capture: generated → planning → instrumenting → ready with plan version n + 1', async () => {
    const h = await generatedHarness();
    h.stages.followUp.mockImplementationOnce(async (context, input) => {
      const chosen = await input.onPathChosen?.('new-capture');
      if (chosen !== undefined && !chosen.ok) {
        return err(chosen.error);
      }
      const handed = await input.beforeInstall?.(PLAN_V2);
      if (handed !== undefined && !handed.ok) {
        return err(handed.error);
      }
      const result: FollowUpStageResult = {
        path: 'new-capture',
        decision: decision(true),
        session: context.session,
        outcomeRecorded: true,
        plan: PLAN_V2,
        planVersion: 2,
        previousPlanVersion: 1,
        delta: [],
        feasibility: {} as unknown as Extract<
          FollowUpStageResult,
          { path: 'new-capture' }
        >['feasibility'],
        chainedFiles: 0,
        installation: {
          ...installation(PLAN_V2),
          applied: [{ ...MODIFICATION, id: 'mod-orchestrator-suite-2' }],
        },
      };
      return ok(result);
    });
    const before = h.manager.transitions.length;

    const outcome = expectOk(
      await h.orchestrator.followUp({ sessionId: SESSION_ID, question: 'Why again?' }),
    );

    expect(outcome).toMatchObject({
      path: 'new-capture',
      status: 'ready',
      planVersion: 2,
      ready: true,
    });
    expect(h.manager.transitions.slice(before).map((entry) => entry.to)).toEqual([
      'planning',
      'instrumenting',
      'ready',
    ]);
    expect(h.manager.current().modifications.map((entry) => entry.id)).toEqual([
      MODIFICATION.id,
      'mod-orchestrator-suite-2',
    ]);
    expect(h.stages.analyze).toHaveBeenCalledTimes(1);
  });

  it('files a failed delta install under instrument and never reaches ready or generated', async () => {
    const h = await generatedHarness();
    const failure = stageError('instrument', 'INSTRUMENTATION_INSTALL_FAILED');
    h.stages.followUp.mockImplementationOnce(async (_context, input) => {
      await input.onPathChosen?.('new-capture');
      await input.beforeInstall?.(PLAN_V2);
      return err(failure);
    });
    const before = h.manager.transitions.length;

    const error = expectErr(
      await h.orchestrator.followUp({ sessionId: SESSION_ID, question: 'Why again?' }),
    );

    expect(error).toBe(failure);
    expect(h.manager.transitions.slice(before).map((entry) => entry.to)).toEqual([
      'planning',
      'instrumenting',
      'failed',
    ]);
    expect(failuresOf(h).map((entry) => entry.stage)).toEqual(['instrument']);
  });

  it('refuses a follow-up on a session neither path can start from, without calling the stage', async () => {
    const h = harness({ session: { status: 'ready' } });

    const error = expectErr(
      await h.orchestrator.followUp({ sessionId: SESSION_ID, question: 'Why?' }),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(h.stages.followUp).not.toHaveBeenCalled();
    expect(h.manager.transitions).toEqual([]);
  });

  it('returns a refusal the stage raises before choosing a path without failing the session', async () => {
    const h = await generatedHarness();
    const refusal = new DebuggenError('SESSION_INVALID_STATE', 'A follow-up needs a question.', {
      details: { reason: 'missing-follow-up-question', stage: FOLLOW_UP_STAGE },
    });
    h.stages.followUp.mockResolvedValueOnce(err(refusal));

    const error = expectErr(
      await h.orchestrator.followUp({ sessionId: SESSION_ID, question: ' ' }),
    );

    expect(error).toBe(refusal);
    expect(h.manager.current().status).toBe('generated');
    expect(failedRows(h)).toEqual([]);
  });

  it('files a model failure before a path was chosen under followup', async () => {
    const h = await generatedHarness();
    h.stages.followUp.mockResolvedValueOnce(err(stageError(FOLLOW_UP_STAGE)));

    expectErr(await h.orchestrator.followUp({ sessionId: SESSION_ID, question: 'Why?' }));

    expect(failuresOf(h).map((entry) => entry.stage)).toEqual([FOLLOW_UP_STAGE]);
    expect(h.manager.current().status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrency, cancellation and lifecycle
// ---------------------------------------------------------------------------

describe('concurrency and lifecycle', () => {
  it('allows one operation per session and names the active stage in the refusal', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.stages.understand.mockImplementationOnce(async () => {
      await gate;
      return ok({ understanding: UNDERSTANDING, promptVersion: REPORTED.understand, repairs: 0 });
    });

    const first = h.orchestrator.run({ sessionId: SESSION_ID });
    await vi.waitFor(() => {
      expect(h.stages.understand).toHaveBeenCalled();
    });
    expect(h.orchestrator.activeRun(SESSION_ID)).toBe('understand');

    const seconds: Result<unknown, DebuggenError>[] = [
      await h.orchestrator.run({ sessionId: SESSION_ID }),
      await h.orchestrator.completeCapture({ sessionId: SESSION_ID }),
      await h.orchestrator.followUp({ sessionId: SESSION_ID, question: 'Why?' }),
    ];
    for (const second of seconds) {
      const error = expectErr(second);
      expect(error.code).toBe('SESSION_INVALID_STATE');
      expect(error.details).toMatchObject({ reason: 'pipeline-busy', activeStage: 'understand' });
    }

    release?.();
    expectOk(await first);
    expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();
    expect(h.stages.understand).toHaveBeenCalledTimes(1);
  });

  it('cancel aborts the stage, files the cancellation and releases the code handles', async () => {
    const h = harness();
    h.stages.understand.mockImplementationOnce(
      (context: PipelineStageContext) =>
        new Promise((resolve) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              resolve(
                err(
                  new DebuggenError('INTERNAL', 'The understand stage was cancelled.', {
                    details: { stage: 'understand', reason: 'aborted' },
                  }),
                ),
              );
            },
            { once: true },
          );
        }),
    );

    const pending = h.orchestrator.run({ sessionId: SESSION_ID });
    await vi.waitFor(() => {
      expect(h.stages.understand).toHaveBeenCalled();
    });
    expect(h.orchestrator.cancel(SESSION_ID)).toBe(true);

    const error = expectErr(await pending);

    expect(error.details?.['reason']).toBe('aborted');
    expect(h.manager.current().status).toBe('failed');
    expect(failuresOf(h).map((entry) => entry.stage)).toEqual(['understand']);
    expect(statusesOf(h)).not.toContain('generated');
    expect(h.codeIndex.invalidate).toHaveBeenCalledWith(PROJECT_ROOT);
    expect(h.stages.investigate).not.toHaveBeenCalled();
    expect(h.orchestrator.cancel(SESSION_ID)).toBe(false);
  });

  it('threads the caller’s signal into every stage context', async () => {
    const h = harness();
    const controller = new AbortController();
    h.stages.investigate.mockImplementationOnce((context) => {
      controller.abort();
      expect(context.signal?.aborted).toBe(true);
      return Promise.resolve(
        err(
          new DebuggenError('INTERNAL', 'The investigate stage was cancelled.', {
            details: { stage: 'investigate', reason: 'aborted' },
          }),
        ),
      );
    });

    expectErr(await h.orchestrator.run({ sessionId: SESSION_ID, signal: controller.signal }));

    expect(h.stages.plan).not.toHaveBeenCalled();
    expect(h.manager.current().status).toBe('failed');
  });

  it('refuses an operation whose signal is already aborted without moving the session', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    const error = expectErr(
      await h.orchestrator.run({ sessionId: SESSION_ID, signal: controller.signal }),
    );

    expect(error.details?.['reason']).toBe('aborted');
    expect(h.manager.transitions).toEqual([]);
  });

  it('dispose aborts in-flight work, is idempotent, and refuses later operations', async () => {
    const h = harness();
    h.stages.understand.mockImplementationOnce(
      (context: PipelineStageContext) =>
        new Promise((resolve) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              resolve(
                err(
                  new DebuggenError('INTERNAL', 'Cancelled.', { details: { reason: 'aborted' } }),
                ),
              );
            },
            { once: true },
          );
        }),
    );
    const pending = h.orchestrator.run({ sessionId: SESSION_ID });
    await vi.waitFor(() => {
      expect(h.stages.understand).toHaveBeenCalled();
    });

    const first = h.orchestrator.dispose();
    const second = h.orchestrator.dispose();
    expect(second).toBe(first);
    await first;

    expectErr(await pending);
    expect(h.codeIndex.invalidate).toHaveBeenCalledWith(PROJECT_ROOT);
    const refused = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expect(refused.details?.['reason']).toBe('orchestrator-disposed');
  });
});

// ---------------------------------------------------------------------------
// 7. The model boundary and privacy
// ---------------------------------------------------------------------------

describe('model boundary and privacy', () => {
  it('never calls the provider itself across the whole lifecycle', async () => {
    const h = harness();
    await throughCapture(h);
    expectOk(await h.orchestrator.followUp({ sessionId: SESSION_ID, question: 'Why?' }));

    expect(h.provider.generateText).not.toHaveBeenCalled();
    expect(h.provider.generateStructured).not.toHaveBeenCalled();
    expect(h.provider.callTools).not.toHaveBeenCalled();
  });

  it('logs stage boundaries without the question or the follow-up question', async () => {
    const h = harness();
    await throughCapture(h);
    expectOk(
      await h.orchestrator.followUp({ sessionId: SESSION_ID, question: `Why ${SENTINEL}?` }),
    );

    expect(h.log.records.length).toBeGreaterThan(0);
    for (const record of h.log.records) {
      expect(JSON.stringify(record)).not.toContain(SENTINEL);
    }
    const boundary = h.log.records.find((record) => record.message === 'Pipeline stage started.');
    expect(boundary?.fields).toMatchObject({ subsystem: 'pipeline', sessionId: SESSION_ID });
  });

  it('imports no validation library, no renderer, no database driver and reads no environment', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./orchestrator.ts', import.meta.url)),
      'utf8',
    );
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).not.toContain('zod');
    expect(specifiers.some((specifier) => specifier?.includes('panel-renderer') === true)).toBe(
      false,
    );
    expect(specifiers.some((specifier) => specifier?.startsWith('node:') === true)).toBe(false);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/\bfetch\(/);
    for (const specifier of specifiers) {
      if (specifier?.startsWith('.') === true) {
        expect(specifier.endsWith('.js')).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. The default code-index loader
// ---------------------------------------------------------------------------

describe('createCodeIndexLoader', () => {
  const fixtureRoot = fileURLToPath(
    new URL('../../../../tests/fixtures/sample-next-app', import.meta.url),
  );
  const cacheDir = mkdtempSync(join(tmpdir(), 'orchestrator-suite-index-'));

  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('indexes a project once, caches the handles, refreshes on request and releases on invalidate', async () => {
    const loader = createCodeIndexLoader({
      config: { indexCacheDir: cacheDir },
      logger: capturedLogger().logger,
    });

    const first = expectOk(await loader.load(fixtureRoot));
    expect(first.loaded).toBeDefined();
    expect(first.routeMap.entries.length).toBeGreaterThan(0);
    expect(typeof first.queries.findByName).toBe('function');
    expect(first.projectSummary).toBeDefined();

    const cached = expectOk(await loader.load(fixtureRoot));
    expect(cached).toBe(first);

    const refreshed = expectOk(await loader.load(fixtureRoot, { refresh: true }));
    expect(refreshed).not.toBe(first);

    loader.invalidate?.(fixtureRoot);
    const reloaded = expectOk(await loader.load(fixtureRoot));
    expect(reloaded).not.toBe(refreshed);
  }, 120_000);

  it('answers an Err for a project that cannot be opened', async () => {
    const loader = createCodeIndexLoader({
      config: { indexCacheDir: cacheDir },
      logger: capturedLogger().logger,
    });

    const error = expectErr(await loader.load(join(cacheDir, 'no-such-project')));

    expect(error).toBeInstanceOf(DebuggenError);
  }, 60_000);
});
