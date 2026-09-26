/**
 * The expected-predecessor contract of the panel generator (`./generate.ts`): a
 * generation told which panel it must supersede is answered on that panel or
 * not at all (AAP §0.4.2, Follow-up row: `panelVersion n + 1` with
 * `supersedes` naming panel `n`).
 *
 * `../../test/integration/followup.test.ts` drives the follow-up stage's own
 * pre-check end to end against the real store. This suite pins the
 * generator's two checks in isolation — a real prompt loader over the
 * committed prompt tree and the real structured-output loop, with doubles for
 * the model, the validator, the fallback builder, the panel store and the
 * broadcaster:
 *
 * - **Before the model call**, a session whose latest panel is not the expected
 *   one is refused with `SESSION_INVALID_STATE` and
 *   `details.reason: 'supersedes-stale'`: no provider call, no insert, no
 *   fallback and no broadcast.
 * - **Inside the store's insert transaction**, a `supersedes-stale` refusal —
 *   another writer stored a panel between the generator's read of the ladder
 *   and its insert — is answered with the same refusal, whether the refused
 *   insert was the model's panel or its fallback, and never with a fallback
 *   or a broadcast.
 * - **Otherwise the ladder behaves as before**: a matching predecessor and a
 *   request with no expectation both supersede the session's latest panel as
 *   the next version, and any other store refusal passes through unchanged.
 *
 * Every identifier is minted by `@debuggen/shared`; no product, demo or
 * developer vocabulary appears in the fixtures.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createPromptLoader } from '@debuggen/model-provider';
import type {
  ModelProvider,
  ModelTextResponse,
  StructuredAttempt,
  ToolCallsResponse,
} from '@debuggen/model-provider';
import { parsePanelSpec } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import type { AnalysisResult } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  newAnalysisId,
  newCaptureId,
  newPanelId,
  newSessionId,
  ok,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { computeCaptureSummary } from '@debuggen/telemetry';

import { PANEL_PROMPT_STAGE, createPanelGenerator } from './generate.js';
import type {
  PanelFallbackPort,
  PanelGenerationRequest,
  PanelGenerator,
  PanelStorePort,
  PanelValidationPort,
} from './generate.js';
import type { PanelValidationRejection } from './validate.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The committed prompt tree the generator renders `generate-panel` from. */
const PROMPTS_DIR = fileURLToPath(new URL('../../prompts', import.meta.url));

/** A model answer the authoring schema accepts: the committed valid-panel fixture. */
const VALID_AUTHORED: unknown = JSON.parse(
  readFileSync(
    new URL('../../test/fixtures/model-output-valid-panel.json', import.meta.url),
    'utf8',
  ),
);

const SESSION_ID = newSessionId();
const CAPTURE_ID = newCaptureId();

/** The panel a follow-up was decided against: version 1 of the session's panels. */
const PANEL_A = newPanelId();

/** A panel another writer stored after the decision: version 2, superseding {@link PANEL_A}. */
const PANEL_B = newPanelId();

/** The id the generator mints for the panel it produces. */
const NEW_PANEL_ID = newPanelId();

/** The id the fallback double gives the fallback panel it builds. */
const FALLBACK_PANEL_ID = newPanelId();

/** The validated analysis every generation draws its facts from. */
const ANALYSIS: AnalysisResult = {
  id: newAnalysisId(),
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  analysisVersion: 1,
  createdAt: 1_767_225_600_000,
  metrics: [],
  observed: [],
  likelyCauses: [],
};

/** The request of a generation over the one capture of the suite. */
const REQUEST: PanelGenerationRequest = {
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  question: 'Why does the view take long to update?',
  analysis: ANALYSIS,
  summary: computeCaptureSummary([], { captureId: CAPTURE_ID, sessionId: SESSION_ID }),
};

/** The follow-up question a regeneration answers. */
const FOLLOW_UP_QUESTION = 'Which step accounts for most of that time?';

/** A minimal valid panel of the suite's session: one event-log node over the `events` source. */
function panelOf(id: string, panelVersion: number, supersedes?: string): PanelSpec {
  return {
    version: 1,
    id,
    sessionId: SESSION_ID,
    panelVersion,
    ...(supersedes === undefined ? {} : { supersedes }),
    title: 'Generated panel',
    summary: { observed: [], likelyCauses: [] },
    layout: [{ type: 'eventLog', id: 'layout[0]', query: { source: 'events' } }],
  };
}

/** The store's in-transaction refusal of a panel whose predecessor is no longer the latest. */
function storeStaleRefusal(): DebuggenError {
  return new DebuggenError('STORE_ERROR', 'The predecessor is no longer the latest panel.', {
    details: { operation: 'insertPanel', reason: 'supersedes-stale' },
  });
}

/** The semantic rejection the validator double answers with when told to reject. */
const SEMANTIC_REJECTION: PanelValidationRejection = {
  class: 'semantic',
  code: 'PANEL_SEMANTIC_INVALID',
  message: 'The generated panel cites evidence the capture does not hold.',
  error: new DebuggenError(
    'PANEL_SEMANTIC_INVALID',
    'The generated panel cites evidence the capture does not hold.',
  ),
};

/* -------------------------------------------------------------------------------------------------
 * Doubles
 * ---------------------------------------------------------------------------------------------- */

/** A provider that answers every structured call with {@link VALID_AUTHORED} and counts the calls. */
class CountingProvider implements ModelProvider {
  readonly id = 'generate-suite-provider';
  structuredCalls = 0;

  generateText(): Promise<Result<ModelTextResponse, DebuggenError>> {
    return Promise.resolve(
      err(new DebuggenError('INTERNAL', 'Panel generation makes no text call.')),
    );
  }

  generateStructured<T>(): Promise<Result<StructuredAttempt<T>, DebuggenError>> {
    this.structuredCalls += 1;
    const attempt: StructuredAttempt<T> = {
      raw: VALID_AUTHORED,
      model: 'generate-suite-model',
      providerId: this.id,
    };
    return Promise.resolve(ok(attempt));
  }

  callTools(): Promise<Result<ToolCallsResponse, DebuggenError>> {
    return Promise.resolve(
      err(new DebuggenError('INTERNAL', 'Panel generation makes no tool call.')),
    );
  }
}

/** What one scenario scripts: the session's latest panel, the insert's answer and the validator's. */
interface Scenario {
  readonly latest: PanelSpec | undefined;
  readonly insert?: (spec: PanelSpec) => Result<PanelSpec, DebuggenError>;
  readonly semanticRejects?: boolean;
}

/** A generator over the scenario's doubles, and what each double saw. */
interface Rig {
  readonly generator: PanelGenerator;
  readonly provider: CountingProvider;
  readonly inserts: PanelSpec[];
  readonly fallbackBuilds: number[];
  readonly broadcasts: string[];
}

/** Builds the generator for one scenario. */
function rig(scenario: Scenario): Rig {
  const provider = new CountingProvider();
  const inserts: PanelSpec[] = [];
  const fallbackBuilds: number[] = [];
  const broadcasts: string[] = [];

  const validator: PanelValidationPort = {
    buildStructuredOptionsNormalizer: (_analysis, context) => () =>
      panelOf(context.id, context.panelVersion, context.supersedes),
    validateGenerated: (input) => {
      if (scenario.semanticRejects === true) {
        return Promise.resolve(err(SEMANTIC_REJECTION));
      }
      const parsed = parsePanelSpec(input.spec);
      if (!parsed.ok) {
        return Promise.resolve(
          err({ ...SEMANTIC_REJECTION, class: 'internal-schema', error: parsed.error }),
        );
      }
      return Promise.resolve(
        ok({
          spec: parsed.value,
          report: { outcome: 'valid', issues: [], warnings: [], resolversSupplied: true },
        }),
      );
    },
    classifyFailure: () => SEMANTIC_REJECTION,
  };

  const fallback: PanelFallbackPort = {
    build: (request) => {
      fallbackBuilds.push(request.panelVersion);
      return Promise.resolve(
        ok({
          ...panelOf(FALLBACK_PANEL_ID, request.panelVersion, request.supersedes),
          meta: { fallback: true },
        }),
      );
    },
  };

  const panels: PanelStorePort = {
    getLatestPanel: () => ok(scenario.latest),
    nextPanelVersion: () => ok((scenario.latest?.panelVersion ?? 0) + 1),
    insertPanel: (spec) => {
      inserts.push(spec);
      return scenario.insert === undefined ? ok(spec) : scenario.insert(spec);
    },
  };

  const generator = createPanelGenerator({
    provider,
    prompts: createPromptLoader({ promptsDir: PROMPTS_DIR, env: {} }),
    validator,
    fallback,
    panels,
    broadcaster: {
      broadcastToKinds: (sessionId) => {
        broadcasts.push(sessionId);
      },
    },
    newId: () => NEW_PANEL_ID,
  });

  return { generator, provider, inserts, fallbackBuilds, broadcasts };
}

/** The error of a failed generation; fails the test when it succeeded. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('The generation succeeded where the test expected a refusal.');
  }
  return result.error;
}

/** The value of a successful generation; fails the test when it was refused. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`The generation was refused (${result.error.code}): ${result.error.message}`);
  }
  return result.value;
}

/* -------------------------------------------------------------------------------------------------
 * The suite
 * ---------------------------------------------------------------------------------------------- */

describe('createPanelGenerator — the expected predecessor', () => {
  it('refuses a regeneration whose expected panel is no longer the latest, before any model call', async () => {
    const h = rig({ latest: panelOf(PANEL_B, 2, PANEL_A) });
    const error = expectErr(
      await h.generator.regenerate({
        ...REQUEST,
        followUpQuestion: FOLLOW_UP_QUESTION,
        expectedPredecessor: PANEL_A,
      }),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(error.details).toStrictEqual({
      stage: PANEL_PROMPT_STAGE,
      reason: 'supersedes-stale',
      latestPanelVersion: 2,
    });
    expect(error.cause).toBeUndefined();
    expect(error.hint?.trim().length ?? 0).toBeGreaterThan(0);
    expect(h.provider.structuredCalls).toBe(0);
    expect(h.inserts).toStrictEqual([]);
    expect(h.fallbackBuilds).toStrictEqual([]);
    expect(h.broadcasts).toStrictEqual([]);
  });

  it('refuses an expectation the session holds no panel for, before any model call', async () => {
    const h = rig({ latest: undefined });
    const error = expectErr(
      await h.generator.generate({ ...REQUEST, expectedPredecessor: PANEL_A }),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(error.details).toStrictEqual({ stage: PANEL_PROMPT_STAGE, reason: 'supersedes-stale' });
    expect(h.provider.structuredCalls).toBe(0);
    expect(h.inserts).toStrictEqual([]);
    expect(h.broadcasts).toStrictEqual([]);
  });

  it('answers a store that refuses the model panel as stale with the same refusal, never a fallback', async () => {
    const refusal = storeStaleRefusal();
    const h = rig({ latest: panelOf(PANEL_A, 1), insert: () => err(refusal) });
    const error = expectErr(
      await h.generator.regenerate({
        ...REQUEST,
        followUpQuestion: FOLLOW_UP_QUESTION,
        expectedPredecessor: PANEL_A,
      }),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(error.details).toStrictEqual({
      stage: PANEL_PROMPT_STAGE,
      reason: 'supersedes-stale',
      causeCode: 'STORE_ERROR',
    });
    expect(error.cause).toBe(refusal);
    expect(h.provider.structuredCalls).toBe(1);
    expect(h.inserts.map((spec) => [spec.id, spec.panelVersion, spec.supersedes])).toStrictEqual([
      [NEW_PANEL_ID, 2, PANEL_A],
    ]);
    expect(h.fallbackBuilds).toStrictEqual([]);
    expect(h.broadcasts).toStrictEqual([]);
  });

  it('answers a store that refuses the fallback panel as stale with the same refusal, broadcasting nothing', async () => {
    const refusal = storeStaleRefusal();
    const h = rig({
      latest: panelOf(PANEL_A, 1),
      insert: () => err(refusal),
      semanticRejects: true,
    });
    const error = expectErr(
      await h.generator.generate({ ...REQUEST, expectedPredecessor: PANEL_A }),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(error.details?.['reason']).toBe('supersedes-stale');
    expect(error.details?.['causeCode']).toBe('STORE_ERROR');
    expect(error.cause).toBe(refusal);
    expect(h.fallbackBuilds).toStrictEqual([2]);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]?.meta?.fallback).toBe(true);
    expect(h.inserts[0]?.supersedes).toBe(PANEL_A);
    expect(h.broadcasts).toStrictEqual([]);
  });

  it('stores and broadcasts the next version superseding the expected panel while it is still the latest', async () => {
    const h = rig({ latest: panelOf(PANEL_A, 1) });
    const result = expectOk(
      await h.generator.regenerate({
        ...REQUEST,
        followUpQuestion: FOLLOW_UP_QUESTION,
        expectedPredecessor: PANEL_A,
      }),
    );

    expect(result.panel.id).toBe(NEW_PANEL_ID);
    expect(result.panel.panelVersion).toBe(2);
    expect(result.panel.supersedes).toBe(PANEL_A);
    expect(result.fallback).toBe(false);
    expect(result.broadcast).toBe(true);
    expect(h.provider.structuredCalls).toBe(1);
    expect(h.broadcasts).toStrictEqual([SESSION_ID]);
  });

  it('supersedes whatever panel is latest when the request holds no expectation, as the capture path does', async () => {
    const h = rig({ latest: panelOf(PANEL_B, 2, PANEL_A) });
    const result = expectOk(await h.generator.generate(REQUEST));

    expect(result.panel.supersedes).toBe(PANEL_B);
    expect(result.panel.panelVersion).toBe(3);
    expect(h.broadcasts).toStrictEqual([SESSION_ID]);
  });

  it('passes any other store refusal through unchanged', async () => {
    const refusal = new DebuggenError('STORE_ERROR', 'The predecessor is not stored.', {
      details: { operation: 'insertPanel', reason: 'supersedes-unknown' },
    });
    const h = rig({ latest: panelOf(PANEL_A, 1), insert: () => err(refusal) });
    const error = expectErr(
      await h.generator.generate({ ...REQUEST, expectedPredecessor: PANEL_A }),
    );

    expect(error).toBe(refusal);
    expect(h.fallbackBuilds).toStrictEqual([]);
    expect(h.broadcasts).toStrictEqual([]);
  });
});
