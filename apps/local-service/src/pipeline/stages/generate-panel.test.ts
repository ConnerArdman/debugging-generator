/**
 * The expected-predecessor contract of Stage 6 as the pipeline drives it
 * (`./generate-panel.ts`): the panel a caller names in `supersedes` is handed
 * to the panel subsystem as `expectedPredecessor`, a stale refusal from that
 * subsystem fails the stage unchanged, and a returned panel that supersedes any
 * other panel fails the stage rather than being reported as a success.
 *
 * The panel generator is a double: its own checks — before the model call and
 * inside the store's insert transaction — are pinned by
 * `../../panels/generate.test.ts`. Every identifier here is invented, generic
 * vocabulary.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import type { PanelSpec } from '@debuggen/panel-schema';
import type {
  AnalysisResult,
  ProgressStage,
  SessionProgressPayload,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, createConsoleLogger, err, ok } from '@debuggen/shared';
import type { LogRecord, Result } from '@debuggen/shared';

import type {
  PanelGenerationRequest,
  PanelGenerationResult,
  PanelRegenerationRequest,
} from '../../panels/generate.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { PipelineCodeHandles, PipelineStageContext } from '../context-builder.js';
import { GENERATE_PANEL_STAGE, createGeneratePanelStage } from './generate-panel.js';
import type {
  GeneratePanelStageDeps,
  GeneratePanelStageInput,
  GeneratePanelStageResult,
} from './generate-panel.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

const SESSION_ID = 'session-generate-panel-suite';
const CAPTURE_ID = 'capture-generate-panel-suite';
const FIXED_EPOCH_MS = 1_767_225_600_000;

/** The panel the caller decided against. */
const EXPECTED_PANEL_ID = 'panel-generate-panel-suite-v1';

/** A panel the caller did not decide against. */
const OTHER_PANEL_ID = 'panel-generate-panel-suite-elsewhere';

/** The id of the panel the generator double answers with. */
const NEW_PANEL_ID = 'panel-generate-panel-suite-v2';

/** The success record the stage writes once it has produced a panel. */
const PRODUCED_LOG = 'The generate-panel stage produced a panel.';

/** The validated analysis the stage hands on; the generator double never reads it. */
const ANALYSIS: AnalysisResult = {
  id: 'analysis-generate-panel-suite',
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  analysisVersion: 2,
  supersedes: 'analysis-generate-panel-suite-v1',
  createdAt: FIXED_EPOCH_MS,
  metrics: [],
  observed: [],
  likelyCauses: [],
};

/** The stored session the stage context is built over. */
const SESSION: SessionRecord = {
  id: SESSION_ID,
  projectRoot: '/workspace/sample-tool',
  projectName: 'sample-tool',
  devServerUrl: 'http://127.0.0.1:4173/',
  createdAt: FIXED_EPOCH_MS,
  updatedAt: FIXED_EPOCH_MS,
  status: 'analyzing',
  question: 'Why does the view take long to update?',
  followUps: [],
  relevantFiles: [],
  plans: [],
  modifications: [],
  captures: [],
  panelIds: [EXPECTED_PANEL_ID],
  analyses: [],
  cleanup: { status: 'pending', conflicts: [] },
  promptVersions: {},
  provider: { id: 'deterministic' },
};

/**
 * Code-analysis handles the stage never reads: the panel stage consults no
 * code graph, so the handles are opaque stand-ins.
 */
const CODE: PipelineCodeHandles = {
  graph: {} as unknown as PipelineCodeHandles['graph'],
  queries: {} as unknown as PipelineCodeHandles['queries'],
  routeMap: {} as unknown as PipelineCodeHandles['routeMap'],
  projectSummary: {} as unknown as PipelineCodeHandles['projectSummary'],
};

/** A panel the generator double answers with, superseding `supersedes` when given. */
function panelOf(supersedes: string | undefined): PanelSpec {
  return {
    version: 1,
    id: NEW_PANEL_ID,
    sessionId: SESSION_ID,
    panelVersion: 2,
    ...(supersedes === undefined ? {} : { supersedes }),
    title: 'Generated panel',
    summary: { observed: [], likelyCauses: [] },
    layout: [{ type: 'eventLog', id: 'layout[0]', query: { source: 'events' } }],
  };
}

/** A successful generation of {@link panelOf}. */
function generated(supersedes: string | undefined): Result<PanelGenerationResult, DebuggenError> {
  return ok({
    panel: panelOf(supersedes),
    fallback: false,
    promptVersion: 'v001',
    attempts: 1,
    repairs: 0,
    broadcast: true,
  });
}

/** The panel subsystem's refusal of a panel whose predecessor is no longer the latest. */
function staleRefusal(): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'The panel this generation was asked to supersede is no longer the latest panel of the session.',
    {
      hint: 'Ask again; the answer is then built on the panel the session now holds.',
      details: { stage: GENERATE_PANEL_STAGE, reason: 'supersedes-stale' },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Doubles
 * ---------------------------------------------------------------------------------------------- */

/** The stage over a generator double, with what the double and the progress emitter saw. */
interface Rig {
  readonly run: (
    input: GeneratePanelStageInput,
  ) => Promise<Result<GeneratePanelStageResult, DebuggenError>>;
  readonly requests: PanelGenerationRequest[];
  readonly rows: string[];
  readonly failures: SessionFailure[];
  readonly records: LogRecord[];
}

/** A progress row as the emitter would answer it. */
function row(stage: ProgressStage): Result<SessionProgressPayload, DebuggenError> {
  return ok({ sessionId: SESSION_ID, stage, status: 'done', message: 'row recorded by the suite' });
}

/** Builds the stage with a generator double answering every call with `answer`. */
function rig(answer: () => Result<PanelGenerationResult, DebuggenError>): Rig {
  const requests: PanelGenerationRequest[] = [];
  const rows: string[] = [];
  const failures: SessionFailure[] = [];
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });

  const deps: GeneratePanelStageDeps = {
    panelGenerator: {
      generate: vi.fn((request: PanelGenerationRequest) => {
        requests.push(request);
        return Promise.resolve(answer());
      }),
      regenerate: vi.fn((request: PanelRegenerationRequest) => {
        requests.push(request);
        return Promise.resolve(answer());
      }),
    },
    progress: {
      stageStarted: (_sessionId, stage) => {
        rows.push(`started:${stage}`);
        return row(stage);
      },
      stageCompleted: (_sessionId, stage) => {
        rows.push(`completed:${stage}`);
        return row(stage);
      },
      stageFailed: (_sessionId, failure) => {
        rows.push(`failed:${failure.stage}`);
        failures.push(failure);
        return row(failure.stage);
      },
      finding: (_sessionId, stage) => {
        rows.push(`finding:${stage}`);
        return row(stage);
      },
    },
    logger,
  };
  const stage = createGeneratePanelStage(deps);
  const context: PipelineStageContext = {
    sessionId: SESSION_ID,
    session: SESSION,
    projectRoot: SESSION.projectRoot,
    question: SESSION.question,
    followUpQuestion: 'Which step accounts for most of that time?',
    code: CODE,
    promptVersions: {},
    captureId: CAPTURE_ID,
    logger,
    now: () => FIXED_EPOCH_MS,
  };

  return {
    run: (input) => stage.run(context, input),
    requests,
    rows,
    failures,
    records,
  };
}

/** The input of a run over the suite's capture. */
function inputOf(overrides: Partial<GeneratePanelStageInput> = {}): GeneratePanelStageInput {
  return { captureId: CAPTURE_ID, analysis: ANALYSIS, ...overrides };
}

/* -------------------------------------------------------------------------------------------------
 * The suite
 * ---------------------------------------------------------------------------------------------- */

describe('createGeneratePanelStage — the expected predecessor', () => {
  it.each([
    ['regenerate', true],
    ['generate', false],
  ] as const)(
    'hands `supersedes` to %s as the expected predecessor and reports a panel that supersedes it',
    async (_label, regenerate) => {
      const h = rig(() => generated(EXPECTED_PANEL_ID));
      const outcome = await h.run(inputOf({ regenerate, supersedes: EXPECTED_PANEL_ID }));

      expect(outcome.ok).toBe(true);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]?.expectedPredecessor).toBe(EXPECTED_PANEL_ID);
      expect(h.rows).toStrictEqual([
        `started:${GENERATE_PANEL_STAGE}`,
        `completed:${GENERATE_PANEL_STAGE}`,
      ]);
      if (outcome.ok) {
        expect(outcome.value.supersedes).toBe(EXPECTED_PANEL_ID);
        expect(outcome.value.panelId).toBe(NEW_PANEL_ID);
      }
    },
  );

  it('holds no expectation when the caller names no predecessor, as the capture path does', async () => {
    const h = rig(() => generated(OTHER_PANEL_ID));
    const outcome = await h.run(inputOf());

    expect(outcome.ok).toBe(true);
    expect(h.requests[0]?.expectedPredecessor).toBeUndefined();
  });

  it.each([
    ['another panel', OTHER_PANEL_ID],
    ['no panel', undefined],
  ] as const)(
    'fails, never succeeds, when the returned panel supersedes %s',
    async (_label, supersedes) => {
      const h = rig(() => generated(supersedes));
      const outcome = await h.run(inputOf({ supersedes: EXPECTED_PANEL_ID }));

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe('STORE_ERROR');
        expect(outcome.error.details).toStrictEqual({
          stage: GENERATE_PANEL_STAGE,
          reason: 'panel-ladder-inconsistent',
        });
      }
      expect(h.rows).toStrictEqual([
        `started:${GENERATE_PANEL_STAGE}`,
        `failed:${GENERATE_PANEL_STAGE}`,
      ]);
      expect(h.failures.map((failure) => failure.code)).toStrictEqual(['STORE_ERROR']);
      expect(h.records.some((record) => record.level === 'error')).toBe(true);
      expect(h.records.some((record) => record.message === PRODUCED_LOG)).toBe(false);
    },
  );

  it('fails with the panel subsystem’s stale refusal unchanged, closing its group with a failed row', async () => {
    const refusal = staleRefusal();
    const h = rig(() => err(refusal));
    const outcome = await h.run(inputOf({ regenerate: true, supersedes: EXPECTED_PANEL_ID }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe(refusal);
    }
    expect(h.rows).toStrictEqual([
      `started:${GENERATE_PANEL_STAGE}`,
      `failed:${GENERATE_PANEL_STAGE}`,
    ]);
    expect(h.failures).toStrictEqual([
      {
        stage: GENERATE_PANEL_STAGE,
        code: refusal.code,
        message: refusal.message,
        hint: refusal.hint,
      },
    ]);
    expect(h.records.some((record) => record.message === PRODUCED_LOG)).toBe(false);
  });
});
