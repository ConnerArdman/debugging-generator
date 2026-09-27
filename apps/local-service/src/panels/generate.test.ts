/**
 * Colocated tests for `./generate.ts`: what the generate-panel request may
 * carry of a developer's question and of URLs quoted in its sections.
 *
 * The generation pipeline itself — the validation order, the repair bound, the
 * fallback, the version ladder and the broadcast — is covered end to end by
 * `test/integration/panel-fallback.test.ts`. This suite pins the one boundary
 * those runs do not vary: every value that reaches `{{question}}`,
 * `{{analysis}}` and `{{captureOverview}}` is a redaction-layer output, so a
 * question that quotes a queried route or pastes a request header,
 * and an analysis statement or a captured span name that quotes a queried URL,
 * are sent with their values masked instead of being sent raw or refusing the
 * whole generation at the outbound guard.
 *
 * The request is observed at the provider: a recording double answers every
 * structured call with a provider failure, which the generator passes through
 * without a fallback, a store write or a broadcast. The validator and the
 * fallback builder are the real ones; the prompt is an in-memory template naming
 * exactly the five placeholders. Names are invented and generic, and
 * header-shaped question fixtures are assembled from fragments.
 */

import { describe, expect, it } from 'vitest';

import type {
  ModelProvider,
  ModelRequest,
  ModelTextResponse,
  PromptFile,
  StructuredAttempt,
  ToolCallsResponse,
} from '@debuggen/model-provider';
import type { PanelSpec } from '@debuggen/panel-schema';
import {
  ANALYSIS_VERSION_START,
  createAnalysisResult,
  parseSessionRecord,
} from '@debuggen/protocol';
import type { AnalysisResult, SessionRecord } from '@debuggen/protocol';
import {
  DebuggenError,
  ID_PREFIXES,
  createConsoleLogger,
  err,
  ok,
  type CaptureId,
  type LogRecord,
  type PanelId,
  type Result,
  type SessionId,
} from '@debuggen/shared';
import { TELEMETRY_TIERS, computeCaptureSummary, isTierAllowedForKind } from '@debuggen/telemetry';
import type { CaptureSummary, TelemetryEvent } from '@debuggen/telemetry';

import { createFallbackPanelBuilder } from './fallback.js';
import {
  PANEL_PROMPT_PLACEHOLDERS,
  PANEL_PROMPT_STAGE,
  buildPanelStageContext,
  createPanelGenerator,
  panelFramingOf,
  type PanelGenerator,
  type PanelSessionPort,
  type PanelStorePort,
} from './generate.js';
import { createPanelValidator } from './validate.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** An opaque id of the minted shape — `<prefix>_<16 base-36 characters>` — for `ordinal`. */
function opaqueId(prefix: string, ordinal: number): string {
  return `${prefix}_${ordinal.toString(36).padStart(16, '0')}`;
}

const SESSION: SessionId = opaqueId(ID_PREFIXES.session, 1);
const CAPTURE: CaptureId = opaqueId(ID_PREFIXES.capture, 1);
const PANEL_ID: PanelId = opaqueId(ID_PREFIXES.panel, 1);
const PREVIOUS_PANEL_ID: PanelId = opaqueId(ID_PREFIXES.panel, 2);
const TRACE = '0000000000000000000000000000abcd';
const BASE_TIME = 1_768_000_000_000;

/** A query value no content rule recognises, planted where only URL masking can keep it out. */
const PLANTED = 'QQZZ7';

/** The first tier `TELEMETRY_TIERS` allows for a fetch. */
const FETCH_TIER = TELEMETRY_TIERS.find((tier) => isTierAllowedForKind('fetch', tier)) ?? 'browser';

/** One captured request whose span name quotes its queried address unmasked. */
const REQUEST_EVENT: TelemetryEvent = {
  id: opaqueId(ID_PREFIXES.event, 1),
  traceId: TRACE,
  spanId: '00000000000000a1',
  kind: 'fetch',
  name: `GET /v1/items?page=${PLANTED}`,
  startTime: BASE_TIME,
  duration: 120,
  tier: FETCH_TIER,
  attributes: {
    'http.method': 'GET',
    url: '/v1/items?page=?',
    'http.status_code': 200,
    request_key: 'rk-items',
  },
  status: 'ok',
  producerId: opaqueId(ID_PREFIXES.producer, 1),
  seq: 1,
  sessionId: SESSION,
  captureId: CAPTURE,
  ingestSeq: 1,
};

const SUMMARY: CaptureSummary = Object.freeze(
  computeCaptureSummary([REQUEST_EVENT], { captureId: CAPTURE, sessionId: SESSION }),
);

/** Model-authored statements quoting a relative and an absolute queried URL. */
const OBSERVED_STATEMENT = `Two calls to /v1/items?page=${PLANTED} overlapped.`;
const CAUSE_STATEMENT = `The handler documented at https://example.test/docs?tab=${PLANTED} refetches.`;

const ANALYSIS: AnalysisResult = Object.freeze(
  createAnalysisResult(
    {
      observed: [{ statement: OBSERVED_STATEMENT, evidence: [{ eventId: REQUEST_EVENT.id }] }],
      likelyCauses: [
        {
          statement: CAUSE_STATEMENT,
          evidence: [{ eventId: REQUEST_EVENT.id }],
          confidence: 'low',
        },
      ],
    },
    {
      id: opaqueId(ID_PREFIXES.analysis, 1),
      sessionId: SESSION,
      captureId: CAPTURE,
      analysisVersion: ANALYSIS_VERSION_START,
      createdAt: BASE_TIME + 1_000,
      metrics: SUMMARY.metrics,
    },
  ),
);

/** The session question of every regeneration: nothing in it needs redacting. */
const PLAIN_QUESTION = 'Why do the item requests overlap?';

/** A question carrying a value no request may send, and the only form of it that may be sent. */
interface SensitiveQuestion {
  readonly label: string;
  readonly question: string;
  readonly redacted: string;
  readonly leaks: readonly string[];
}

/** A queried route, a punctuation-only query value and two pasted header lines. */
function sensitiveQuestions(): readonly SensitiveQuestion[] {
  const code = ['ZIP', '42'].join('');
  const bangs = '!'.repeat(4);
  const bearer = ['S3', 'CRET'].join('');
  const cookie = ['ab', 'c'].join('');
  return [
    {
      label: 'a queried route',
      question: `Why is /reset?code=${code} slow?`,
      redacted: 'Why is /reset?code=? slow?',
      leaks: [code],
    },
    {
      label: 'a punctuation-only query value',
      question: `Why is /reset?code=${bangs} slow?`,
      redacted: 'Why is /reset?code=? slow?',
      leaks: [bangs],
    },
    {
      label: 'a pasted authorization header',
      question: ['Author', 'ization: ', 'Bea', 'rer ', bearer].join(''),
      redacted: 'Authorization: [redacted]',
      leaks: [bearer],
    },
    {
      label: 'a pasted cookie header',
      question: ['Coo', 'kie: ', 'session=', cookie].join(''),
      redacted: 'Cookie: [redacted]',
      leaks: [['session=', cookie].join('')],
    },
  ];
}

/** The selected element's owner chain, nearest first: invented, generic component names. */
const TARGET_CHAIN: readonly string[] = ['TallyTile', 'TallyBoard'];

/** Page text on the selected element: it must never reach the panel's structured context. */
const TARGET_TEXT = `Tile ${PLANTED}`;

/**
 * A stored session whose understanding settled on `category` and whose
 * developer selected an element, validated by the protocol's own schema.
 */
function sessionRecordWith(category: string): SessionRecord {
  const parsed = parseSessionRecord({
    id: SESSION,
    projectRoot: '/work/sample-project',
    projectName: 'sample-project',
    devServerUrl: 'http://127.0.0.1:3000/',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    status: 'analyzing',
    question: PLAIN_QUESTION,
    followUps: [],
    target: {
      selector: 'main .tile',
      tagName: 'div',
      text: TARGET_TEXT,
      componentChain: [...TARGET_CHAIN],
      url: `http://127.0.0.1:3000/items?page=${PLANTED}`,
    },
    understanding: {
      category,
      signalsNeeded: ['react', 'componentTree', 'state'],
      entities: [{ kind: 'component', name: 'TallyTile' }],
      searchHints: ['TallyTile'],
    },
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/** A session port answering every read with `record`. */
function sessionsHolding(record: SessionRecord | undefined): PanelSessionPort {
  return { get: () => ok(record) };
}

/* -------------------------------------------------------------------------------------------------
 * Doubles and the harness
 * ---------------------------------------------------------------------------------------------- */

/** The schema argument a provider's `generateStructured` receives. */
type StructuredSchema = Parameters<ModelProvider['generateStructured']>[0];

/** The provider failure every structured call is answered with. */
function unavailable(): DebuggenError {
  return new DebuggenError('MODEL_UNAVAILABLE', 'Model provider unavailable (recording double).');
}

/** A provider that records every structured request and answers each with a provider failure. */
class RecordingProvider implements ModelProvider {
  readonly id = 'recording-test-provider';
  readonly requests: ModelRequest[] = [];

  generateText(): Promise<Result<ModelTextResponse, DebuggenError>> {
    return Promise.resolve(err(unavailable()));
  }

  generateStructured<T>(
    _schema: StructuredSchema,
    request: ModelRequest,
  ): Promise<Result<StructuredAttempt<T>, DebuggenError>> {
    this.requests.push(request);
    return Promise.resolve(err(unavailable()));
  }

  callTools(): Promise<Result<ToolCallsResponse, DebuggenError>> {
    return Promise.resolve(err(unavailable()));
  }
}

/** A generate-panel template naming exactly the five placeholders, each value on its own line. */
const TEMPLATE = PANEL_PROMPT_PLACEHOLDERS.map((key) => `${key}:\n{{${key}}}`).join('\n');

/** The prompt file every load answers with. */
function promptFile(): Result<PromptFile, DebuggenError> {
  return ok({
    stage: PANEL_PROMPT_STAGE,
    version: 'v001',
    text: TEMPLATE,
    path: `/virtual/prompts/${PANEL_PROMPT_STAGE}/v001.md`,
  });
}

/** The generator under test, what it sent, and everything it logged. */
interface Harness {
  readonly generator: PanelGenerator;
  readonly provider: RecordingProvider;
  readonly records: LogRecord[];
  /** Store writes and fallback builds; a passed-through provider failure makes neither. */
  readonly sideEffects: string[];
}

function harness(latest: PanelSpec | undefined, sessions?: PanelSessionPort): Harness {
  const provider = new RecordingProvider();
  const records: LogRecord[] = [];
  const sideEffects: string[] = [];
  const panels: PanelStorePort = {
    getLatestPanel: () => ok(latest),
    nextPanelVersion: () => ok(latest === undefined ? 1 : latest.panelVersion + 1),
    insertPanel: () => {
      sideEffects.push('insertPanel');
      return err(new DebuggenError('STORE_ERROR', 'The store double accepts no panel.'));
    },
  };
  const generator = createPanelGenerator({
    provider,
    prompts: { load: promptFile, loadVersion: promptFile },
    validator: createPanelValidator(),
    fallback: {
      build: () => {
        sideEffects.push('fallback');
        return Promise.resolve(err(new DebuggenError('INTERNAL', 'No fallback is expected.')));
      },
    },
    panels,
    sessions,
    logger: createConsoleLogger({ level: 'trace', sink: (record) => records.push(record) }),
    newId: () => PANEL_ID,
  });
  return { generator, provider, records, sideEffects };
}

/** A real, validated panel to supersede: the deterministic fallback of the fixture capture. */
async function previousPanel(): Promise<PanelSpec> {
  const built = await createFallbackPanelBuilder({
    validator: createPanelValidator(),
    newId: () => PREVIOUS_PANEL_ID,
  }).build({
    sessionId: SESSION,
    captureId: CAPTURE,
    analysis: ANALYSIS,
    summary: SUMMARY,
    panelVersion: 1,
    reason: 'semantic',
  });
  if (!built.ok) {
    throw new Error(`The previous panel could not be built: ${built.error.message}`);
  }
  return built.value;
}

/** The one request a generation sent, after asserting the provider failure was passed through. */
function sentRequest(fixture: Harness, result: Result<unknown, DebuggenError>): ModelRequest {
  expect(result.ok ? undefined : result.error.code).toBe('MODEL_UNAVAILABLE');
  expect(fixture.sideEffects).toEqual([]);
  expect(fixture.provider.requests).toHaveLength(1);
  const [request] = fixture.provider.requests;
  if (request === undefined) {
    throw new Error('The provider was never called.');
  }
  return request;
}

/** The prompt, the structured input and every log record, as searchable strings. */
function everythingSent(fixture: Harness, request: ModelRequest): readonly string[] {
  return [
    request.prompt,
    JSON.stringify(request.input),
    ...fixture.records.map((record) =>
      JSON.stringify({ message: record.message, fields: record.fields }),
    ),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * The suites
 * ---------------------------------------------------------------------------------------------- */

describe('buildPanelStageContext', () => {
  it('masks URLs the analysis and the capture overview quote, in the input and the texts alike', () => {
    const context = buildPanelStageContext(ANALYSIS, SUMMARY);

    expect(context.input['analysis']).toMatchObject({
      observed: [{ statement: 'Two calls to /v1/items?page=? overlapped.' }],
      likelyCauses: [
        { statement: 'The handler documented at https://example.test/docs?tab=? refetches.' },
      ],
    });
    // Each text is the rendering of the masked section it sits beside, not of the raw one.
    expect(JSON.parse(context.analysisText)).toEqual(context.input['analysis']);
    expect(JSON.parse(context.captureOverviewText)).toEqual({
      populatedSources: context.input['populatedSources'],
      capture: context.input['capture'],
    });
    expect(context.captureOverviewText).toContain('GET /v1/items?page=?');
    for (const text of [context.analysisText, context.captureOverviewText]) {
      expect(text).not.toContain(PLANTED);
    }
    expect(JSON.stringify(context.input)).not.toContain(PLANTED);

    // The caller's analysis is left as it was.
    expect(ANALYSIS.observed[0]?.statement).toBe(OBSERVED_STATEMENT);
    expect(ANALYSIS.likelyCauses[0]?.statement).toBe(CAUSE_STATEMENT);
  });
});

describe('the generate-panel request', () => {
  it.each(sensitiveQuestions())(
    'renders $label only in its redacted form',
    async ({ question, redacted, leaks }) => {
      const fixture = harness(undefined);
      const result = await fixture.generator.generate({
        sessionId: SESSION,
        captureId: CAPTURE,
        question,
        analysis: ANALYSIS,
        summary: SUMMARY,
      });
      const request = sentRequest(fixture, result);

      expect(request.prompt).toContain(`question:\n${redacted}\nanalysis:`);
      for (const text of everythingSent(fixture, request)) {
        for (const leak of [...leaks, PLANTED]) {
          expect(text).not.toContain(leak);
        }
      }
    },
  );

  it.each(sensitiveQuestions())(
    'renders $label in a follow-up only in its redacted form, after the session question',
    async ({ question, redacted, leaks }) => {
      const fixture = harness(await previousPanel());
      const result = await fixture.generator.regenerate({
        sessionId: SESSION,
        captureId: CAPTURE,
        question: PLAIN_QUESTION,
        followUpQuestion: question,
        analysis: ANALYSIS,
        summary: SUMMARY,
      });
      const request = sentRequest(fixture, result);

      expect(request.prompt).toContain(`question:\n${PLAIN_QUESTION}\n\n${redacted}\nanalysis:`);
      for (const text of everythingSent(fixture, request)) {
        for (const leak of [...leaks, PLANTED]) {
          expect(text).not.toContain(leak);
        }
      }
    },
  );
});

describe('the panel framing: what the session settled, as structured data only', () => {
  it('reads the understanding’s category and signals and the target’s chain and tag, nothing else', () => {
    const framing = panelFramingOf(sessionRecordWith('rendering'));
    expect(framing).toEqual({
      category: 'rendering',
      signalsNeeded: ['react', 'componentTree', 'state'],
      componentChain: [...TARGET_CHAIN],
      tagName: 'div',
    });
    // The target's text, selector and URL carry page content and stay behind.
    expect(JSON.stringify(framing)).not.toContain(PLANTED);
    expect(panelFramingOf(undefined)).toEqual({});
  });

  it('adds the framing to the structured input and to no rendered text', () => {
    const framed = buildPanelStageContext(
      ANALYSIS,
      SUMMARY,
      panelFramingOf(sessionRecordWith('network')),
    );
    const bare = buildPanelStageContext(ANALYSIS, SUMMARY);

    expect(framed.input['understanding']).toEqual({
      category: 'network',
      signalsNeeded: ['react', 'componentTree', 'state'],
    });
    expect(framed.input['target']).toEqual({ componentChain: [...TARGET_CHAIN], tagName: 'div' });
    expect(Object.hasOwn(bare.input, 'understanding')).toBe(false);
    expect(Object.hasOwn(bare.input, 'target')).toBe(false);
    // The rendered sections are those of the unframed context, byte for byte.
    expect(framed.analysisText).toBe(bare.analysisText);
    expect(framed.captureOverviewText).toBe(bare.captureOverviewText);
  });

  it('frames the request the generator sends with the session it answers, on both paths', async () => {
    const created = harness(undefined, sessionsHolding(sessionRecordWith('rendering')));
    const first = sentRequest(
      created,
      await created.generator.generate({
        sessionId: SESSION,
        captureId: CAPTURE,
        question: PLAIN_QUESTION,
        analysis: ANALYSIS,
        summary: SUMMARY,
      }),
    );
    const followed = harness(
      await previousPanel(),
      sessionsHolding(sessionRecordWith('rendering')),
    );
    const followUp = sentRequest(
      followed,
      await followed.generator.regenerate({
        sessionId: SESSION,
        captureId: CAPTURE,
        question: PLAIN_QUESTION,
        followUpQuestion: 'Which tile renders most?',
        analysis: ANALYSIS,
        summary: SUMMARY,
      }),
    );

    for (const request of [first, followUp]) {
      expect(request.input).toMatchObject({
        understanding: { category: 'rendering' },
        target: { componentChain: [...TARGET_CHAIN] },
      });
      expect(request.prompt).not.toContain('componentChain');
      expect(JSON.stringify(request.input)).not.toContain(PLANTED);
    }
  });

  it('composes from the capture alone when the session is absent or cannot be read', async () => {
    const failing: PanelSessionPort = {
      get: () => err(new DebuggenError('STORE_ERROR', 'The store double is closed.')),
    };
    const throwing: PanelSessionPort = {
      get: () => {
        throw new Error('The store double threw.');
      },
    };
    for (const [sessions, warns] of [
      [undefined, false],
      [sessionsHolding(undefined), false],
      [failing, true],
      [throwing, true],
    ] as const) {
      const fixture = harness(undefined, sessions);
      const request = sentRequest(
        fixture,
        await fixture.generator.generate({
          sessionId: SESSION,
          captureId: CAPTURE,
          question: PLAIN_QUESTION,
          analysis: ANALYSIS,
          summary: SUMMARY,
        }),
      );
      expect(Object.hasOwn(request.input, 'understanding')).toBe(false);
      expect(Object.hasOwn(request.input, 'target')).toBe(false);
      const warnings = fixture.records.filter(
        (record) => record.level === 'warn' && record.message.includes('could not be read'),
      );
      expect(warnings).toHaveLength(warns ? 1 : 0);
    }
  });
});
