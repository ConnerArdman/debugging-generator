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
 *
 * The second suite exercises the verification the stage's `verifyFindings` and
 * `acceptFindings` delegate to — the real `collectFactVerificationReport` and
 * `createAnalysisFacts` — over an in-memory evidence port holding a small fixed
 * event set (two captures, several traces, one span per event). It proves AAP
 * §0.8.4's evidence rule at the level of a whole citation: valid ids of
 * unrelated events cannot be combined into one reference, a cited span the
 * port cannot look up fails closed, and a rejected analysis reaches the store
 * not at all.
 *
 * The third suite pins the stage's single source of evidence: one build call,
 * whose summary — the one describing exactly the events the input aggregated —
 * is what the fact candidates are derived from, what the stored metrics are
 * taken from and what the result reports.
 */

import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import type { ProblemUnderstanding } from '@debuggen/instrumentation';
import type { ModelProvider, ModelRequest, StructuredAttempt } from '@debuggen/model-provider';
import { DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import type { EventRef } from '@debuggen/panel-schema';
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
import { computeCaptureSummary } from '@debuggen/telemetry';
import type { CaptureSummary, MetricValue, TelemetryEvent } from '@debuggen/telemetry';

import {
  FACT_VERIFICATION_ISSUE_CODES,
  FACT_VERIFICATION_ISSUE_REASONS,
  collectFactVerificationReport,
  createAnalysisFacts,
} from '../../analysis/facts.js';
import type {
  AnalysisStorePort,
  EvidenceLookupPort,
  EvidenceTracePageOptions,
  FactVerificationContext,
  FactVerificationReport,
} from '../../analysis/facts.js';
import type {
  AnalysisStageInputBuild,
  AnalysisStageInputRequest,
} from '../../analysis/summarize.js';
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

/** The build the fake summarizer answers with: only the fields the stage passes along. */
function fakeBuild(summary: CaptureSummary): AnalysisStageInputBuild {
  return {
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
    summary,
  } as unknown as AnalysisStageInputBuild;
}

function deps(
  overrides: Partial<Pick<AnalyzeStageDeps, 'broadcaster' | 'facts' | 'summarizer'>> = {},
): AnalyzeStageDeps {
  const build = fakeBuild({ metrics: [] } as unknown as CaptureSummary);
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
    summarizer: overrides.summarizer ?? {
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

/* -------------------------------------------------------------------------------------------------
 * Evidence verification: every citation resolves to one captured event (AAP §0.8.4)
 * ---------------------------------------------------------------------------------------------- */

/** A second capture of the same session, whose events no citation of {@link CAPTURE_ID} may use. */
const OTHER_CAPTURE_ID = 'capture-analyze-other';

const TRACE_A = '0af7651916cd43dd8448eb211c80319c';
const TRACE_B = '4bf92f3577b34da6a3ce929d0e0e4736';
/** The trace of {@link OTHER_CAPTURE_ID}. */
const TRACE_C = 'b7ad6b7169203331b7ad6b7169203331';
/** A trace of {@link CAPTURE_ID} longer than one store page. */
const TRACE_LONG = 'c0ffee00c0ffee00c0ffee00c0ffee01';

/** The stored fields the evidence port answers from. */
interface StoredEvent {
  readonly id: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly captureId: string;
}

const EVENT_A1: StoredEvent = {
  id: 'evt-trace-a-first',
  traceId: TRACE_A,
  spanId: '00f067aa0ba902b7',
  captureId: CAPTURE_ID,
};
const EVENT_A2: StoredEvent = {
  id: 'evt-trace-a-second',
  traceId: TRACE_A,
  spanId: '53995c3f42cd8ad8',
  captureId: CAPTURE_ID,
};
const EVENT_B1: StoredEvent = {
  id: 'evt-trace-b-first',
  traceId: TRACE_B,
  spanId: 'e457b5a2e4d86bd1',
  captureId: CAPTURE_ID,
};
const EVENT_C1: StoredEvent = {
  id: 'evt-trace-c-other-capture',
  traceId: TRACE_C,
  spanId: '8448eb211c80319c',
  captureId: OTHER_CAPTURE_ID,
};

/** The fixed event set: two traces in the verified capture, one in another capture. */
const EVENTS: readonly StoredEvent[] = [EVENT_A1, EVENT_A2, EVENT_B1, EVENT_C1];

/** {@link TRACE_LONG}: three events more than the store's largest page, each with its own span. */
const LONG_TRACE_EVENTS: readonly StoredEvent[] = Array.from(
  { length: DATA_QUERY_MAX_LIMIT + 3 },
  (_unused, index) => ({
    id: `evt-long-${String(index + 1).padStart(5, '0')}`,
    traceId: TRACE_LONG,
    spanId: (index + 1).toString(16).padStart(16, '0'),
    captureId: CAPTURE_ID,
  }),
);

const VERIFY_CONTEXT: FactVerificationContext = {
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  projectRoot: PROJECT_ROOT,
};

/** One `listByTrace` call the in-memory port received. */
interface TraceRead {
  readonly traceId: string;
  readonly options: EvidenceTracePageOptions | undefined;
}

/** How {@link evidenceFixture} deviates from a healthy store. */
interface EvidenceFixtureOptions {
  /** Omit `getBySpanId`, so cited span ids cannot be checked at all. */
  readonly withoutSpanLookup?: boolean;
  /** Answers every `listByTrace` call instead of the event set: a failing or defective store. */
  readonly listByTrace?: EvidenceLookupPort['listByTrace'];
}

/** An in-memory evidence port and the trace reads it served. */
interface EvidenceFixture {
  readonly port: EvidenceLookupPort;
  readonly traceReads: TraceRead[];
}

/**
 * An {@link EvidenceLookupPort} over `events` that answers as `TelemetryRepo`
 * does: session-scoped, capture-narrowed when asked, span lookup session-wide,
 * and trace pages in stored order, clamped to `DATA_QUERY_MAX_LIMIT` rows, with
 * a `nextOffset` only while rows remain.
 */
function evidenceFixture(
  events: readonly StoredEvent[] = EVENTS,
  options: EvidenceFixtureOptions = {},
): EvidenceFixture {
  const traceReads: TraceRead[] = [];
  const inScope = (event: StoredEvent, sessionId: string, captureId: string | undefined): boolean =>
    sessionId === SESSION_ID && (captureId === undefined || event.captureId === captureId);
  const port: EvidenceLookupPort = {
    existingEventIds: (sessionId, ids, captureId) =>
      ok(
        new Set(
          ids.filter((id) =>
            events.some((event) => event.id === id && inScope(event, sessionId, captureId)),
          ),
        ),
      ),
    existingTraceIds: (sessionId, ids, captureId) =>
      ok(
        new Set(
          ids.filter((id) =>
            events.some((event) => event.traceId === id && inScope(event, sessionId, captureId)),
          ),
        ),
      ),
    ...(options.withoutSpanLookup === true
      ? {}
      : {
          getBySpanId: (sessionId: string, spanId: string) =>
            ok(
              events.find(
                (event) => event.spanId === spanId && inScope(event, sessionId, undefined),
              ),
            ),
        }),
    listByTrace: (sessionId, traceId, pageOptions) => {
      traceReads.push({ traceId, options: pageOptions });
      if (options.listByTrace !== undefined) {
        return options.listByTrace(sessionId, traceId, pageOptions);
      }
      const matching = events.filter(
        (event) => event.traceId === traceId && inScope(event, sessionId, pageOptions?.captureId),
      );
      const offset = pageOptions?.offset ?? 0;
      const limit = Math.min(pageOptions?.limit ?? DATA_QUERY_MAX_LIMIT, DATA_QUERY_MAX_LIMIT);
      const rows = matching.slice(offset, offset + limit);
      const next = offset + rows.length;
      return ok(rows.length > 0 && next < matching.length ? { rows, nextOffset: next } : { rows });
    },
  };
  return { port, traceReads };
}

/** Findings whose one observed fact cites `evidence`. */
function citing(...evidence: EventRef[]): AnalysisFindings {
  return {
    observed: [{ statement: 'One request took 300 ms.', evidence }],
    likelyCauses: [],
  };
}

/** The verification report of `findings` against {@link VERIFY_CONTEXT}; a lookup failure fails the test. */
function reportOf(findings: AnalysisFindings, fixture: EvidenceFixture): FactVerificationReport {
  const report = collectFactVerificationReport(findings, VERIFY_CONTEXT, fixture.port);
  if (!report.ok) {
    throw report.error;
  }
  return report.value;
}

/** Each issue as `path code`, in report order. */
function issuesOf(report: FactVerificationReport): string[] {
  return report.issues.map((issue) => `${issue.path} ${issue.code}`);
}

/** The offsets of every trace page read, in call order. */
function offsetsOf(fixture: EvidenceFixture): (number | undefined)[] {
  return fixture.traceReads.map((read) => read.options?.offset);
}

/** An analysis store that records every call and refuses it: verification must never reach it. */
function refusingStore(): { readonly store: AnalysisStorePort; readonly calls: string[] } {
  const calls: string[] = [];
  const refuse = (operation: string): Result<never, DebuggenError> => {
    calls.push(operation);
    return err(new DebuggenError('STORE_ERROR', `${operation} was called for rejected findings.`));
  };
  return {
    calls,
    store: {
      insertAnalysis: () => refuse('insertAnalysis'),
      getLatestAnalysis: () => refuse('getLatestAnalysis'),
      nextAnalysisVersion: () => refuse('nextAnalysisVersion'),
      listAnalyses: () => refuse('listAnalyses'),
    },
  };
}

/** An empty analysis history that stores what it is handed and records every insert. */
function acceptingStore(): {
  readonly store: AnalysisStorePort;
  readonly inserted: AnalysisResult[];
} {
  const inserted: AnalysisResult[] = [];
  return {
    inserted,
    store: {
      insertAnalysis: (result) => {
        inserted.push(result);
        return ok(result);
      },
      getLatestAnalysis: () => ok(undefined),
      nextAnalysisVersion: () => ok(1),
      listAnalyses: () => ok([...inserted]),
    },
  };
}

describe('analysis facts: every citation resolves to one captured event', () => {
  it('accepts a fully consistent citation and an event-id-only one without reading a trace page', () => {
    const fixture = evidenceFixture();

    const report = reportOf(
      citing(
        { eventId: EVENT_A1.id, traceId: TRACE_A, spanId: EVENT_A1.spanId },
        { eventId: EVENT_B1.id },
      ),
      fixture,
    );

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.spanCheck).toBe('performed');
    expect(report.checkedEventIds).toEqual([EVENT_A1.id, EVENT_B1.id].sort());
    expect(fixture.traceReads).toEqual([]);
  });

  it('accepts a cited trace without a span once a capture-narrowed trace page holds the event', () => {
    const fixture = evidenceFixture();

    const report = reportOf(citing({ eventId: EVENT_A2.id, traceId: TRACE_A }), fixture);

    expect(report.valid).toBe(true);
    expect(fixture.traceReads).toEqual([
      {
        traceId: TRACE_A,
        options: { captureId: CAPTURE_ID, limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
      },
    ]);
  });

  it('rejects a valid event id cited with the valid trace id of an unrelated trace', () => {
    const report = reportOf(citing({ eventId: EVENT_B1.id, traceId: TRACE_A }), evidenceFixture());

    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([
      {
        path: 'observed[0].evidence[0].traceId',
        code: 'event-trace-mismatch',
        reason: FACT_VERIFICATION_ISSUE_REASONS['event-trace-mismatch'],
      },
    ]);
    // Each id exists on its own: only the combined check can see the defect.
    expect(report.unresolvedEventIds).toEqual([]);
    expect(report.unresolvedTraceIds).toEqual([]);
  });

  it('checks trace membership even when the port offers no span lookup', () => {
    const fixture = evidenceFixture(EVENTS, { withoutSpanLookup: true });

    const report = reportOf(
      citing({ eventId: EVENT_A1.id, traceId: TRACE_B, spanId: EVENT_B1.spanId }),
      fixture,
    );

    expect(report.spanCheck).toBe('unavailable');
    // The trace is still walked; the span that could not be checked fails closed.
    expect(issuesOf(report)).toEqual([
      'observed[0].evidence[0].traceId event-trace-mismatch',
      'observed[0].evidence[0].spanId span-unverifiable',
    ]);
    expect(fixture.traceReads.map((read) => read.traceId)).toEqual([TRACE_B]);
  });

  it('fails closed on a cited span id when the port offers no span lookup', () => {
    const withoutLookup = evidenceFixture(EVENTS, { withoutSpanLookup: true });
    const withLookup = evidenceFixture();
    // Event A1 and trace A belong together; the span id is event A2's.
    const findings = citing({ eventId: EVENT_A1.id, traceId: TRACE_A, spanId: EVENT_A2.spanId });

    const unchecked = reportOf(findings, withoutLookup);
    const checked = reportOf(findings, withLookup);
    const truthful = reportOf(
      citing({ eventId: EVENT_A1.id, traceId: TRACE_A, spanId: EVENT_A1.spanId }),
      evidenceFixture(EVENTS, { withoutSpanLookup: true }),
    );

    expect(unchecked.spanCheck).toBe('unavailable');
    expect(unchecked.valid).toBe(false);
    expect(unchecked.issues).toEqual([
      {
        path: 'observed[0].evidence[0].spanId',
        code: 'span-unverifiable',
        reason: FACT_VERIFICATION_ISSUE_REASONS['span-unverifiable'],
      },
    ]);
    // Nothing was looked up, so nothing is claimed as checked or unresolved.
    expect(unchecked.checkedSpanIds).toEqual([]);
    expect(unchecked.unresolvedSpanIds).toEqual([]);
    // With the lookup available the same citation is the mismatch it is.
    expect(checked.spanCheck).toBe('performed');
    expect(issuesOf(checked)).toEqual(['observed[0].evidence[0].spanId span-event-mismatch']);
    // Unchecked is not verified, however consistent the citation happens to be.
    expect(issuesOf(truthful)).toEqual(['observed[0].evidence[0].spanId span-unverifiable']);
  });

  it('rejects an unverifiable span before storage, naming only its path and code', async () => {
    const { store, calls } = refusingStore();
    const facts = createAnalysisFacts({
      evidence: evidenceFixture(EVENTS, { withoutSpanLookup: true }).port,
      store,
    });
    const findings = citing({ eventId: EVENT_A1.id, traceId: TRACE_A, spanId: EVENT_A2.spanId });

    const verified = await facts.verifyFindings(findings, VERIFY_CONTEXT);
    const accepted = await facts.acceptFindings(findings, { ...VERIFY_CONTEXT, metrics: [] });

    expect(accepted.ok).toBe(false);
    expect(!accepted.ok && accepted.error.code).toBe('MODEL_OUTPUT_INVALID');
    // The store — its insert included — is never reached.
    expect(calls).toEqual([]);
    expect(verified.ok).toBe(false);
    expect(!verified.ok && verified.error.details).toMatchObject({
      reason: 'evidence-unverified',
      issueCount: 1,
      issueCodes: ['span-unverifiable'],
      paths: ['observed[0].evidence[0].spanId'],
      unresolvedSpanIdCount: 0,
    });
  });

  it('still verifies and stores event and trace citations without a span id when the port offers no span lookup', async () => {
    const fixture = evidenceFixture(EVENTS, { withoutSpanLookup: true });
    const findings = citing(
      { eventId: EVENT_A2.id, traceId: TRACE_A },
      { eventId: EVENT_B1.id, traceId: TRACE_B },
      { eventId: EVENT_A1.id },
    );
    const { store, inserted } = acceptingStore();
    const facts = createAnalysisFacts({
      evidence: evidenceFixture(EVENTS, { withoutSpanLookup: true }).port,
      store,
    });

    const report = reportOf(findings, fixture);
    const accepted = await facts.acceptFindings(findings, { ...VERIFY_CONTEXT, metrics: [] });

    expect(report.spanCheck).toBe('unavailable');
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(fixture.traceReads.map((read) => read.traceId)).toEqual([TRACE_A, TRACE_B]);
    expect(accepted.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.observed).toEqual(findings.observed);
  });

  it('rejects a valid event id cited with the valid span id of a different event', () => {
    const sameTrace = reportOf(
      citing({ eventId: EVENT_A1.id, traceId: TRACE_A, spanId: EVENT_A2.spanId }),
      evidenceFixture(),
    );
    const otherTrace = reportOf(
      citing({ eventId: EVENT_A1.id, spanId: EVENT_B1.spanId }),
      evidenceFixture(),
    );

    expect(issuesOf(sameTrace)).toEqual(['observed[0].evidence[0].spanId span-event-mismatch']);
    expect(issuesOf(otherTrace)).toEqual(['observed[0].evidence[0].spanId span-event-mismatch']);
  });

  it('rejects a span id recorded in another capture, and an event of another capture', () => {
    const foreignSpan = reportOf(
      citing({ eventId: EVENT_A1.id, spanId: EVENT_C1.spanId }),
      evidenceFixture(),
    );
    const foreignEvent = reportOf(
      citing({ eventId: EVENT_C1.id, traceId: TRACE_C, spanId: EVENT_C1.spanId }),
      evidenceFixture(),
    );

    expect(issuesOf(foreignSpan)).toEqual([
      'observed[0].evidence[0].spanId span-outside-capture',
      'observed[0].evidence[0].spanId span-event-mismatch',
    ]);
    // Unresolved in this capture is reported as such, not also as a mismatch.
    expect(issuesOf(foreignEvent)).toEqual([
      'observed[0].evidence[0].eventId event-unresolved',
      'observed[0].evidence[0].traceId trace-unresolved',
      'observed[0].evidence[0].spanId span-outside-capture',
    ]);
  });

  it('walks a trace longer than one store page, stopping at the page that holds the event', () => {
    const events = [...EVENTS, ...LONG_TRACE_EVENTS];
    const last = LONG_TRACE_EVENTS.at(-1);
    const first = LONG_TRACE_EVENTS.at(0);
    if (last === undefined || first === undefined) {
      throw new Error('The long trace fixture is empty.');
    }
    const onLastPage = evidenceFixture(events);
    const onFirstPage = evidenceFixture(events);
    const absent = evidenceFixture(events);

    const lastReport = reportOf(citing({ eventId: last.id, traceId: TRACE_LONG }), onLastPage);
    const firstReport = reportOf(citing({ eventId: first.id, traceId: TRACE_LONG }), onFirstPage);
    const absentReport = reportOf(citing({ eventId: EVENT_A1.id, traceId: TRACE_LONG }), absent);

    expect(lastReport.valid).toBe(true);
    expect(offsetsOf(onLastPage)).toEqual([0, DATA_QUERY_MAX_LIMIT]);
    expect(firstReport.valid).toBe(true);
    expect(offsetsOf(onFirstPage)).toEqual([0]);
    expect(issuesOf(absentReport)).toEqual([
      'observed[0].evidence[0].traceId event-trace-mismatch',
    ]);
    expect(offsetsOf(absent)).toEqual([0, DATA_QUERY_MAX_LIMIT]);
  });

  it('walks each distinct cited trace once, however many citations name it', () => {
    const fixture = evidenceFixture();

    const report = reportOf(
      citing(
        { eventId: EVENT_A1.id, traceId: TRACE_A },
        { eventId: EVENT_A2.id, traceId: TRACE_A },
        { eventId: EVENT_B1.id, traceId: TRACE_B },
      ),
      fixture,
    );

    expect(report.valid).toBe(true);
    expect(fixture.traceReads.map((read) => read.traceId)).toEqual([TRACE_A, TRACE_B]);
  });

  it('returns Err, concluding nothing, when a trace page fails, throws or does not advance', () => {
    const findings = citing({ eventId: EVENT_A1.id, traceId: TRACE_A });
    const failing = evidenceFixture(EVENTS, {
      listByTrace: () => err(new DebuggenError('STORE_ERROR', 'database is locked')),
    });
    const throwing = evidenceFixture(EVENTS, {
      listByTrace: () => {
        throw new Error('SQLITE_IOERR');
      },
    });
    const stuck = evidenceFixture(EVENTS, {
      listByTrace: () => ok({ rows: [], nextOffset: 0 }),
    });

    for (const fixture of [failing, throwing]) {
      const result = collectFactVerificationReport(findings, VERIFY_CONTEXT, fixture.port);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('STORE_ERROR');
      expect(!result.ok && result.error.details).toMatchObject({
        reason: 'lookup-failed',
        operation: 'listByTrace',
      });
    }
    const stuckResult = collectFactVerificationReport(findings, VERIFY_CONTEXT, stuck.port);
    expect(!stuckResult.ok && stuckResult.error.details).toMatchObject({
      reason: 'page-not-advancing',
      operation: 'listByTrace',
    });
    expect(offsetsOf(stuck)).toEqual([0]);
  });

  it('rejects mismatched citations without echoing statements and without touching the store', async () => {
    const statement = 'The checkout handler waited on the inventory lookup for 812 ms.';
    const label = 'inventory lookup chip';
    const { store, calls } = refusingStore();
    const facts = createAnalysisFacts({ evidence: evidenceFixture().port, store });
    const findings: AnalysisFindings = {
      observed: [
        {
          statement,
          evidence: [{ eventId: EVENT_B1.id, traceId: TRACE_A, label }],
        },
      ],
      likelyCauses: [
        {
          statement: `${statement} Likely a missing index.`,
          confidence: 'medium',
          evidence: [{ eventId: EVENT_A1.id, spanId: EVENT_A2.spanId }],
        },
      ],
    };

    const verified = await facts.verifyFindings(findings, VERIFY_CONTEXT);
    const accepted = await facts.acceptFindings(findings, { ...VERIFY_CONTEXT, metrics: [] });

    expect(verified.ok).toBe(false);
    expect(accepted.ok).toBe(false);
    expect(calls).toEqual([]);
    if (verified.ok) {
      return;
    }
    expect(verified.error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(verified.error.details).toMatchObject({
      reason: 'evidence-unverified',
      issueCount: 2,
      issueCodes: ['event-trace-mismatch', 'span-event-mismatch'],
      paths: ['observed[0].evidence[0].traceId', 'likelyCauses[0].evidence[0].spanId'],
    });
    const serialized = JSON.stringify({
      message: verified.error.message,
      hint: verified.error.hint,
      details: verified.error.details,
    });
    expect(serialized).not.toContain('checkout handler');
    expect(serialized).not.toContain('812');
    expect(serialized).not.toContain(label);
  });

  it('pairs every verification code, the cross-check and fail-closed codes included, with a fixed reason', () => {
    expect(FACT_VERIFICATION_ISSUE_CODES).toEqual(
      expect.arrayContaining(['span-event-mismatch', 'event-trace-mismatch', 'span-unverifiable']),
    );
    for (const code of FACT_VERIFICATION_ISSUE_CODES) {
      expect(FACT_VERIFICATION_ISSUE_REASONS[code].trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(FACT_VERIFICATION_ISSUE_REASONS).sort()).toEqual(
      [...FACT_VERIFICATION_ISSUE_CODES].sort(),
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * One event set: the stored metrics, the fact candidates and the result summary (AAP §0.8.4)
 * ---------------------------------------------------------------------------------------------- */

/** Two persisted events of {@link CAPTURE_ID}: an interaction and the render it caused. */
function consistencyEvents(): TelemetryEvent[] {
  const shared = {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    traceId: '5c2f4e8a1b3d4f6a8c0e2a4b6d8f0a1c',
    status: 'ok' as const,
    producerId: 'producer-analyze-suite',
  };
  return [
    {
      ...shared,
      id: 'evt-interaction-1',
      spanId: '1a2b3c4d5e6f7a8b',
      kind: 'interaction',
      tier: 'browser',
      name: 'click',
      startTime: FIXED_EPOCH_MS,
      duration: 12,
      attributes: {},
      seq: 1,
      ingestSeq: 1,
    },
    {
      ...shared,
      id: 'evt-render-1',
      spanId: '2b3c4d5e6f7a8b9c',
      parentSpanId: '1a2b3c4d5e6f7a8b',
      kind: 'render',
      tier: 'browser',
      name: 'LedgerRow',
      startTime: FIXED_EPOCH_MS + 2,
      duration: 3,
      attributes: { component: 'LedgerRow', phase: 'update', trigger: 'props' },
      seq: 2,
      ingestSeq: 2,
    },
  ];
}

describe('analyze stage: the stored metrics, the fact candidates and the result describe one event set', () => {
  it('builds once, derives the candidates from the build summary and stores that summary’s metrics', async () => {
    const summary = computeCaptureSummary(consistencyEvents(), {
      captureId: CAPTURE_ID,
      sessionId: SESSION_ID,
    });
    const build = fakeBuild(summary);
    const requests: AnalysisStageInputRequest[] = [];
    const derivedFrom: CaptureSummary[] = [];
    const storedMetrics: (readonly MetricValue[])[] = [];
    const stage = createAnalyzeStage(
      deps({
        summarizer: {
          buildStageInput: (request) => {
            requests.push(request);
            // The summarizer calls the derivation with the input it assembled and its summary.
            const derived = request.options?.deriveFactCandidates?.({
              input: build.input,
              summary: build.summary,
            });
            expect(derived).toEqual([]);
            return Promise.resolve(ok(build));
          },
        },
        facts: {
          candidatesFor: (source) => {
            derivedFrom.push(source.summary);
            return [];
          },
          verifyFindings: () => Promise.resolve(ok(FINDINGS)),
          verificationReportFor: () => Promise.resolve(ok(VERIFICATION)),
          acceptFindings: (findings, context) => {
            expect(findings).toStrictEqual(FINDINGS);
            storedMetrics.push(context.metrics);
            return Promise.resolve(ok(STORED));
          },
        },
      }),
    );

    const result = await stage.run(stageContext(), RUN_INPUT);

    expect(result.ok).toBe(true);
    // One build: the capture is read and aggregated once, the candidates derived inside it.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.captureId).toBe(CAPTURE_ID);
    expect(requests[0]?.options?.deriveFactCandidates).toBeTypeOf('function');
    // The candidates, the stored metrics and the reported summary are the build's summary.
    expect(derivedFrom).toHaveLength(1);
    expect(derivedFrom[0]).toBe(summary);
    expect(storedMetrics).toHaveLength(1);
    expect(storedMetrics[0]).toBe(summary.metrics);
    expect(result.ok && result.value.summary).toBe(summary);
  });

  it('fails the stage with the build error and stores nothing when the capture is empty', async () => {
    let accepted = 0;
    const empty = new DebuggenError(
      'CAPTURE_EMPTY',
      'No telemetry was captured. Interact with the page while capture is running, then Capture again.',
    );
    const stage = createAnalyzeStage(
      deps({
        summarizer: { buildStageInput: () => Promise.resolve(err(empty)) },
        facts: {
          candidatesFor: () => [],
          verifyFindings: () => Promise.resolve(ok(FINDINGS)),
          verificationReportFor: () => Promise.resolve(ok(VERIFICATION)),
          acceptFindings: () => {
            accepted += 1;
            return Promise.resolve(ok(STORED));
          },
        },
      }),
    );

    const result = await stage.run(stageContext(), RUN_INPUT);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('CAPTURE_EMPTY');
    expect(accepted).toBe(0);
  });
});
