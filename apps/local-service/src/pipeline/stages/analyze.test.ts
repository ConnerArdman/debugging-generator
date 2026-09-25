/**
 * The analyze stage's live `analysis.completed` broadcast (AAP §0.4.2: service
 * → VS Code, DevTools).
 *
 * Every collaborator is a narrow fake: the summarizer, facts module, context
 * builder and provider only hand the stage the artifacts it passes along, and
 * the facts module's `acceptFindings` stores exactly what protocol's
 * `createAnalysisResult` assembles. What is under test is the stage's own
 * contract once an analysis is stored — one validated frame to the two user
 * interfaces, delivery that can never fail the stage, and no frame at all for
 * an analysis that was not stored.
 */

import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import type { ProblemUnderstanding } from '@debuggen/instrumentation';
import type { ModelProvider, ModelRequest, StructuredAttempt } from '@debuggen/model-provider';
import { analysisCompletedPayloadSchema, createAnalysisResult } from '@debuggen/protocol';
import type {
  AnalysisFindings,
  AnalysisResult,
  ClientKind,
  ProtocolMessage,
  SessionProgressPayload,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, err, noopLogger, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import type { FactVerificationReport } from '../../analysis/facts.js';
import type { AnalysisStageInputBuild } from '../../analysis/summarize.js';
import type { PipelineCodeHandles, PipelineStageContext } from '../context-builder.js';
import { ANALYSIS_BROADCAST_KINDS, createAnalyzeStage } from './analyze.js';
import type { AnalyzeStageDeps } from './analyze.js';

const SESSION_ID = 'session-analyze-suite';
const CAPTURE_ID = 'capture-analyze-suite';
const PROJECT_ROOT = '/workspace/ledger-tool';
const FIXED_EPOCH_MS = 1_767_225_600_000;

const UNDERSTANDING: ProblemUnderstanding = {
  category: 'performance',
  signalsNeeded: ['interactions', 'fetch'],
  entities: [],
  searchHints: [],
};

/** What the fake model answers: one evidenced fact, no causes. */
const FINDINGS: AnalysisFindings = {
  observed: [{ statement: 'One request took 300 ms.', evidence: [{ eventId: 'evt-request-1' }] }],
  likelyCauses: [],
};

/** A complete, valid fact-verification report; the stage only carries it through. */
const VERIFICATION: FactVerificationReport = {
  checkedEventIds: ['evt-request-1'],
  unresolvedEventIds: [],
  checkedTraceIds: [],
  unresolvedTraceIds: [],
  checkedSpanIds: [],
  unresolvedSpanIds: [],
  spanCheck: 'performed',
  checkedLocations: 0,
  issues: [],
  valid: true,
};

/** The analysis the fake facts module stores. */
const STORED: AnalysisResult = createAnalysisResult(FINDINGS, {
  id: 'analysis-v1-suite',
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  analysisVersion: 1,
  createdAt: FIXED_EPOCH_MS,
  metrics: [],
});

/** One frame the fake broadcaster was handed. */
interface SentFrame {
  readonly sessionId: string;
  readonly kinds: readonly ClientKind[];
  readonly message: ProtocolMessage;
}

function stageContext(): PipelineStageContext {
  const session = {
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    question: 'Why does the ledger refresh slowly?',
    promptVersions: {},
  } as unknown as SessionRecord;
  return {
    sessionId: SESSION_ID,
    session,
    projectRoot: PROJECT_ROOT,
    question: session.question,
    code: {} as unknown as PipelineCodeHandles,
    promptVersions: {},
    logger: noopLogger,
    now: () => FIXED_EPOCH_MS,
  };
}

/** A provider whose one structured answer is {@link FINDINGS}. */
function fakeProvider(): ModelProvider {
  const refuse = (): Promise<never> =>
    Promise.reject(new DebuggenError('INTERNAL', 'Only structured output is expected here.'));
  return {
    id: 'fake',
    generateText: refuse,
    callTools: refuse,
    generateStructured: <T>(
      schema: ZodType<T>,
    ): Promise<Result<StructuredAttempt<T>, DebuggenError>> =>
      Promise.resolve(
        ok({ raw: FINDINGS, value: schema.parse(FINDINGS), model: 'fake', providerId: 'fake' }),
      ),
  };
}

function deps(
  overrides: Partial<Pick<AnalyzeStageDeps, 'broadcaster' | 'facts'>> = {},
): AnalyzeStageDeps {
  const build = {
    input: { truncated: { sections: [] }, factCandidates: [] },
    stats: {
      eventsConsidered: 1,
      eventsExcluded: 0,
      tracesIncluded: 0,
      spansIncluded: 1,
      excerptsWithheld: 0,
      approxBytes: 1,
      sectionsTruncated: 0,
      droppedForBudget: 0,
    },
  } as unknown as AnalysisStageInputBuild;
  return {
    contextBuilder: {
      buildAnalyzeRequest: () =>
        ok({
          request: {
            stage: 'analyze',
            promptVersion: 'v001',
            prompt: 'Analyse the capture.',
          } as unknown as ModelRequest,
          stage: 'analyze',
          promptVersion: 'v001',
          truncated: [],
          bytes: 1,
        }),
    },
    provider: fakeProvider(),
    summarizer: {
      loadCaptureSummary: () => Promise.resolve(ok({ metrics: [] } as unknown as CaptureSummary)),
      buildStageInput: () => Promise.resolve(ok(build)),
    },
    facts: overrides.facts ?? {
      candidatesFor: () => [],
      verifyFindings: () => Promise.resolve(ok(FINDINGS)),
      verificationReportFor: () => Promise.resolve(ok(VERIFICATION)),
      acceptFindings: () => Promise.resolve(ok(STORED)),
    },
    panels: { getLatestAnalysis: () => ok(undefined) },
    progress: {
      stageStarted: progressRow,
      stageCompleted: progressRow,
      stageFailed: progressRow,
      finding: progressRow,
    },
    logger: noopLogger,
    ...(overrides.broadcaster !== undefined ? { broadcaster: overrides.broadcaster } : {}),
  };
}

/** Every progress row the fake emitter accepts; the stage only checks that it was sent. */
function progressRow(): Result<SessionProgressPayload, DebuggenError> {
  return ok({ sessionId: SESSION_ID, stage: 'analyze', status: 'running', message: 'progress' });
}

function recordingBroadcaster(): {
  readonly broadcaster: NonNullable<AnalyzeStageDeps['broadcaster']>;
  readonly sent: SentFrame[];
} {
  const sent: SentFrame[] = [];
  return {
    sent,
    broadcaster: {
      broadcastToKinds: (sessionId, kinds, message) => {
        sent.push({ sessionId, kinds, message });
      },
    },
  };
}

const RUN_INPUT = { captureId: CAPTURE_ID, understanding: UNDERSTANDING };

describe('analyze stage: the analysis.completed broadcast', () => {
  it('sends the stored analysis once to the editor and the DevTools panel', async () => {
    const { broadcaster, sent } = recordingBroadcaster();
    const stage = createAnalyzeStage(deps({ broadcaster }));

    const result = await stage.run(stageContext(), RUN_INPUT);

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const [frame] = sent;
    expect(frame?.sessionId).toBe(SESSION_ID);
    expect([...(frame?.kinds ?? [])].sort()).toEqual(['devtools', 'vscode']);
    expect(frame?.kinds).toEqual(ANALYSIS_BROADCAST_KINDS);
    expect(frame?.message.type).toBe('analysis.completed');
    const payload = analysisCompletedPayloadSchema.parse(frame?.message.payload);
    expect(payload).toStrictEqual({ sessionId: SESSION_ID, analysis: STORED });
  });

  it('stores and reports the analysis without a broadcaster, sending nothing', async () => {
    const stage = createAnalyzeStage(deps());

    const result = await stage.run(stageContext(), RUN_INPUT);

    expect(result.ok && result.value.analysis).toStrictEqual(STORED);
  });

  it('never fails the stage when delivery throws: the analysis is already stored', async () => {
    const stage = createAnalyzeStage(
      deps({
        broadcaster: {
          broadcastToKinds: () => {
            throw new Error('socket closed');
          },
        },
      }),
    );

    const result = await stage.run(stageContext(), RUN_INPUT);

    expect(result.ok && result.value.analysis).toStrictEqual(STORED);
  });

  it('sends nothing for an analysis whose evidence was rejected', async () => {
    const { broadcaster, sent } = recordingBroadcaster();
    const stage = createAnalyzeStage(
      deps({
        broadcaster,
        facts: {
          candidatesFor: () => [],
          verifyFindings: () =>
            Promise.resolve(
              err(
                new DebuggenError('MODEL_OUTPUT_INVALID', 'An evidence id is not in the capture.'),
              ),
            ),
          verificationReportFor: () => Promise.resolve(ok(VERIFICATION)),
          acceptFindings: () => Promise.resolve(ok(STORED)),
        },
      }),
    );

    const result = await stage.run(stageContext(), RUN_INPUT);

    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
