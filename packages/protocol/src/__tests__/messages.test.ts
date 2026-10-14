/**
 * Tests for this package's message payload modules, in the directory
 * `packages/protocol/tsconfig.json` names for them.
 *
 * What is on trial here is the **wire contract**, not the schema library: every
 * assertion below is a statement about what one process may send and another
 * will accept, and each one exists because a producer and a consumer live in
 * different bundles and can only disagree at run time.
 *
 * ## The generic `error` frame, and why it is pinned this tightly
 *
 * Its payload is exactly `{ code, message, ref? }`, and `../messages/error.ts`
 * is the single definition of it. Two properties make the shape easy to widen
 * by accident, which is what these tests stand against:
 *
 * - `DebuggenError.toPayload()` — the class every process reports failures
 *   through — returns `{ code, message, hint? }`. It is *nearly* this payload,
 *   and TypeScript's structural typing will pass an object carrying an extra
 *   property where `ErrorPayload` is expected, so the compiler does not catch a
 *   producer that forwards it verbatim. The strict parser does, at the receiving
 *   end, which is the worst place to find out. `toErrorPayload` is the
 *   sanctioned projection, and the cases below assert both halves: what it
 *   produces parses, and what it exists to replace does not.
 * - a rejection must name the offending **key** and never echo the offending
 *   **value**, because a rejected frame is unvalidated data from
 *   another process and this product does not put such data into an error
 *   message, a log line or a persisted session row.
 *
 * ## The analysis artifact, and what the suites below are actually proving
 *
 * `../analysis.ts` is the single definition of the shape carried by the
 * `analysis.completed` payload, stored in the `analyses` table and handed to
 * `normalizePanel`. Its element schemas are **imported** from
 * `@debuggen/panel-schema` rather than restated, and that is not a claim a
 * reader can check by inspection — a local copy of `Fact` would compile, would
 * type-check identically and would differ only in what it refuses. So the cases
 * below exercise the constraint only the imported schema has: a fact with an
 * empty `evidence` array is refused, which is what makes an observation with
 * no evidence structurally impossible rather than merely
 * discouraged. The rest pin the fields deterministic code owns — the version
 * floor, the self-supersede rule, the closed metric vocabulary — and the
 * privacy rule, which applies to a rejected analysis exactly as it applies to a
 * rejected frame.
 *
 * ## The twenty-eight payloads, and the one property that cannot be read
 *
 * The third and largest part of this file — everything below the section banner
 * that names it — is one valid case and a set of refusals for every payload in
 * `../messages/*.ts`. The organising claim is not "this object has these
 * fields", which a reader can check by eye and which a hand-written copy of an
 * upstream shape would satisfy just as well. It is that **each payload embeds
 * the imported schema rather than a restatement of it**, and the only way to
 * observe the difference is to feed in the value that only the imported schema
 * refuses:
 *
 * - `instrumentation.plan` carries the **normalised** plan, so the authoring
 *   shape a model produces — no `version`, no `planVersion`, actions with no
 *   `adapter` or `mode` — is refused;
 * - `telemetry.event` carries the strict **ingress** event, so an element
 *   carrying `sessionId`, `captureId` or `ingestSeq` is refused: attribution is
 *   the service's to assign, and a producer that could claim a session could
 *   write into another session's capture;
 * - `telemetry.tail` carries the **persisted** event, which is the mirror image
 *   — the same three fields are required;
 * - `instrumentation.ready` carries the journal's own record, so a digest that
 *   is not 64 lowercase hexadecimal characters is refused;
 * - `agent.config` and `server-agent.config` carry the hook and signal
 *   configurations whose key names are a wire contract the page agent and the
 *   dev-server preload read structurally, so the key sets are asserted against
 *   the imported schemas rather than written out a second time;
 * - `panel.generated` carries the panel specification, so a node type outside
 *   the catalogue is refused — while a specification marked `meta.fallback` is a
 *   **success**, never an error;
 * - `source.open` and `cleanup.completed` carry the shared source-location and
 *   conflict shapes, so an absolute path, a `..` traversal and a zero line are
 *   refused by the same schema every located runtime item already answers to;
 * - `source.result` is a union discriminated on `status`, so a failure's
 *   `error` is required exactly when the status is `failed` and forbidden
 *   otherwise, and the editor-open URI built for a `no-editor` answer survives
 *   the two decodes its receiver applies.
 *
 * Two cross-cutting suites follow. One is driven from
 * `MESSAGE_PAYLOAD_SCHEMAS` itself, so a twenty-ninth message cannot escape the
 * JSON round trip or the no-transform check by being added without a test; the
 * other plants a sentinel in a refused field of several payloads — the
 * credential on `client.hello` included — and requires that nothing the
 * rejection produces contains it.
 *
 * ## Discrimination, frame by frame — `parseMessage`
 *
 * The final section is this file's evidence for `parseMessage` from
 * `../envelope.ts`: the step every receiver takes, from a whole frame to a
 * typed message. It is driven from the `MESSAGE_TYPES` tuple, one case per type,
 * and proves two things of every registered message. Its fixture from
 * `VALID_PAYLOADS`, framed as `{ id, type, sessionId?, ts, payload }`, parses to
 * a message of that same type with its payload deep-equal and its routing key
 * exactly as `createEnvelope` would have set it. And the same type framed around
 * a payload that is valid for a *different* type — drawn from a second
 * exhaustive table, typed so a type cannot be paired with its own payload — is
 * refused with `PROTOCOL_INVALID_MESSAGE`, every issue located under `payload`,
 * and a sentinel planted in that payload absent from the message, hint, details
 * and `toPayload()` alike. Unknown types, the five HTTP-only operation names
 * among them, are refused at the discriminator. `./envelope.test.ts` owns the
 * envelope fields themselves; the pairing of `type` with `payload` is asserted
 * here. So is the one cross-field rule every member carries: a routing
 * `sessionId` naming a different session than the payload does — its own
 * `sessionId`, or a session record's `id` — is refused at `sessionId` without
 * echoing either id, for every type whose fixture names a session, while the
 * eight payloads that name none accept any routing key.
 *
 * ## The parse helpers, one table
 *
 * Every `parse*` function the messages barrel exports is exercised by one
 * table-driven suite at the end of this file: a valid input comes back
 * deep-equal, and an input refused for one reason while carrying the sentinel
 * in another value is rejected with `PROTOCOL_INVALID_MESSAGE` and echoes the
 * sentinel nowhere. A guard compares the table with the barrel's own exports,
 * so a helper added without a row fails the suite.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  CAPTURE_SIGNALS,
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  agentHookConfigSchema,
  instrumentationPlanSchema,
  modificationConflictSchema,
  modificationRecordSchema,
  selectedTargetSchema,
  serverAgentSignalsSchema,
} from '@debuggen/instrumentation';
import type {
  AgentHookConfig,
  InstrumentationAction,
  ModificationConflict,
  SelectedTarget,
  ServerAgentSignals,
} from '@debuggen/instrumentation';
import { CONFIDENCE_LEVELS, PANEL_NODE_TYPES, panelSpecSchema } from '@debuggen/panel-schema';
import type { Fact, Hypothesis, PanelSpec } from '@debuggen/panel-schema';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  isErr,
  isOk,
  sourceLocationSchema,
} from '@debuggen/shared';
import type { Result, SourceLocation } from '@debuggen/shared';
import {
  METRIC_IDS,
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  computeCaptureSummary,
  telemetryEventIngressSchema,
  telemetryEventSchema,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  MetricValue,
  TelemetryEvent,
  TelemetryEventIngress,
} from '@debuggen/telemetry';

import {
  ANALYSIS_VERSION_START,
  analysisFindingsSchema,
  analysisResultSchema,
  createAnalysisResult,
  parseAnalysisFindings,
  parseAnalysisResult,
} from '../analysis.js';
import type { AnalysisFindings, AnalysisResult } from '../analysis.js';
import { createEnvelope, parseMessage } from '../envelope.js';
import type { MessageByType } from '../envelope.js';
import {
  ERROR_MESSAGE_PAYLOADS,
  errorPayloadSchema,
  parseErrorPayload,
  toErrorPayload,
} from '../messages/error.js';
import {
  BINDING_REASONS,
  CLIENT_HELLO_TIMEOUT_MS,
  CLIENT_KINDS,
  EDITOR_OPEN_URI,
  HTTP_ONLY_PAYLOAD_NAMES,
  HTTP_ONLY_PAYLOAD_SCHEMAS,
  MAX_TAIL_CAPTURE_TALLIES,
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPE,
  MESSAGE_TYPES,
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  SELECTION_DOCUMENT_VERDICTS,
  SERVICE_PONG_TIMEOUT_MS,
  SOURCE_MESSAGE_PAYLOADS,
  SOURCE_OPEN_EDITOR_TIMEOUT_MS,
  SOURCE_OPEN_RESULT_TIMEOUT_MS,
  SOURCE_RESULT_STATUSES,
  WS_CLOSE_UNAUTHORIZED,
  agentConfigPayloadSchema,
  agentReadyPayloadSchema,
  analysisCompletedPayloadSchema,
  buildEditorOpenUri,
  captureStartedPayloadSchema,
  captureStoppedPayloadSchema,
  cleanupCompletedPayloadSchema,
  clientHelloPayloadSchema,
  clientPingPayloadSchema,
  compareSelectionDocument,
  instrumentationFailedPayloadSchema,
  instrumentationPlanPayloadSchema,
  instrumentationReadyPayloadSchema,
  panelGeneratedPayloadSchema,
  parseAgentConfigPayload,
  parseClientHelloPayload,
  parseClientPingPayload,
  parseInstrumentationPlanPayload,
  parseInstrumentationReadyPayload,
  parsePanelGeneratedPayload,
  parseServicePongPayload,
  parseSourceOpenPayload,
  parseSourceResultPayload,
  parseTargetSelectedPayload,
  parseTelemetryEventPayload,
  sameSelectedTarget,
  serverAgentConfigPayloadSchema,
  servicePongPayloadSchema,
  sessionBindPayloadSchema,
  sessionBoundPayloadSchema,
  sessionCreatedPayloadSchema,
  sessionProgressPayloadSchema,
  sessionUnbindPayloadSchema,
  sessionUpdatedPayloadSchema,
  sourceOpenPayloadSchema,
  sourceResultPayloadSchema,
  tabNavigatedPayloadSchema,
  targetRequestPayloadSchema,
  targetSelectedPayloadSchema,
  telemetryEventPayloadSchema,
  telemetryTailCaptureTallySchema,
  telemetryTailPayloadSchema,
  unavailableSignalSchema,
} from '../messages/index.js';
import type { MessageType, SourceResultPayload } from '../messages/index.js';
import * as messagesBarrel from '../messages/index.js';
import {
  CLEANUP_STATUSES,
  FOLLOW_UP_ATTEMPT_ID_PREFIX,
  FOLLOW_UP_OUTCOME_KEYS,
  PROMPT_STAGE_KEYS,
  PROVIDER_IDS,
  SESSION_STATUSES,
  followUpAttemptIdSchema,
  followUpRecordSchema,
  isCleanupStatus,
  isFollowUpAnswered,
  isSessionStatus,
  parseSessionRecord,
  relevantFileSchema,
  sessionRecordSchema,
  touchSessionRecord,
} from '../session-record.js';
import type { FollowUpRecord, SessionRecord } from '../session-record.js';
import { PROTOCOL_VERSION, protocolVersionSchema } from '../version.js';

/** A code from the `@debuggen/shared` vocabulary, used as a valid fixture. */
const CODE = 'MODEL_UNAVAILABLE';

describe('errorPayloadSchema — the generic error frame is exactly { code, message, ref? }', () => {
  it('accepts the two specified shapes', () => {
    expect(errorPayloadSchema.parse({ code: CODE, message: 'provider unavailable' })).toEqual({
      code: CODE,
      message: 'provider unavailable',
    });
    expect(
      errorPayloadSchema.parse({ code: CODE, message: 'provider unavailable', ref: 'msg_1' }),
    ).toEqual({ code: CODE, message: 'provider unavailable', ref: 'msg_1' });
  });

  it('refuses a fourth field, naming the key it refused', () => {
    const refused = errorPayloadSchema.safeParse({
      code: CODE,
      message: 'provider unavailable',
      hint: 'check ANTHROPIC_API_KEY',
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    const issue = refused.error.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect(issue).toMatchObject({ keys: ['hint'] });
  });

  it('refuses a code outside the shared vocabulary, an empty message and a blank ref', () => {
    expect(errorPayloadSchema.safeParse({ code: 'NOT_A_CODE', message: 'x' }).success).toBe(false);
    expect(errorPayloadSchema.safeParse({ code: CODE, message: '' }).success).toBe(false);
    expect(errorPayloadSchema.safeParse({ code: CODE, message: 'x', ref: '' }).success).toBe(false);
  });

  it('registers itself under the message type name AAP 0.4.2 uses', () => {
    expect(Object.keys(ERROR_MESSAGE_PAYLOADS)).toEqual(['error']);
    expect(ERROR_MESSAGE_PAYLOADS.error).toBe(errorPayloadSchema);
  });
});

describe('parseErrorPayload — a failure message never becomes a leak', () => {
  it('returns the validated payload', () => {
    const parsed = parseErrorPayload({ code: CODE, message: 'provider unavailable' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.code).toBe(CODE);
    }
  });

  it('rejects a hint-bearing frame by key name, without echoing the value', () => {
    // A distinctive sentinel rather than a credential-shaped literal: the
    // assertion needs a string that could not appear by chance, and
    // `scripts/check-secrets.mjs` refuses a tracked file that carries a
    // provider-key prefix even inside a test fixture.
    const sentinel = 'sentinel-value-9d41a0-must-not-be-echoed';
    const parsed = parseErrorPayload({ code: CODE, message: 'x', hint: sentinel });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('hint');
    expect(parsed.error.message).not.toContain(sentinel);
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(sentinel);
  });
});

describe('toErrorPayload — the one sanctioned producer path', () => {
  it('projects a DebuggenError into a payload the receiving end accepts', () => {
    const error = new DebuggenError(CODE, 'Model provider unavailable (401).', {
      hint: 'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.',
    });

    const payload = toErrorPayload(error);

    expect(Object.keys(payload)).toEqual(['code', 'message']);
    expect(errorPayloadSchema.safeParse(payload).success).toBe(true);
    // The hint is dropped from the frame, not from the process: it stays on the
    // local error for logging and for the messages that declare one.
    expect(error.hint).toBe('Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.');
  });

  it('is what a producer must use, because the class payload itself is refused', () => {
    const error = new DebuggenError(CODE, 'Model provider unavailable (401).', {
      hint: 'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.',
    });

    // The idiom this projection replaces: structurally assignable at compile
    // time, refused at run time. Pinned so that documentation which tells a
    // producer to send `toPayload()` directly fails a test rather than a user.
    expect(errorPayloadSchema.safeParse(error.toPayload()).success).toBe(false);
    expect(errorPayloadSchema.safeParse(toErrorPayload(error)).success).toBe(true);
  });

  it('carries a supplied ref and omits the key entirely when there is none', () => {
    const error = new DebuggenError('STORE_ERROR', 'The session store could not be opened.');

    const withRef = toErrorPayload(error, 'msg_42');
    expect(withRef.ref).toBe('msg_42');
    expect(errorPayloadSchema.safeParse(withRef).success).toBe(true);

    const withoutRef = toErrorPayload(error);
    expect('ref' in withoutRef).toBe(false);
    // An absent optional stays absent across a JSON round trip, so the object a
    // consumer parses is the object the producer built.
    expect(JSON.parse(JSON.stringify(withoutRef))).toEqual(withoutRef);
  });

  it('treats an explicitly undefined ref as an absent key', () => {
    const error = new DebuggenError('STORE_ERROR', 'The session store could not be opened.');
    expect('ref' in toErrorPayload(error, undefined)).toBe(false);
  });
});

/** An event id shaped like the ones `@debuggen/shared` mints, used as a citation. */
const EVENT_ID = 'evt_9p2k4m7q1z8x3c0v';

/** The analysis's own id in the fixtures below. */
const ANALYSIS_ID = 'ana_3v8n1t6y2r9w0q5s';

/** A valid analyze-stage output: one evidenced fact, one ranked hypothesis. */
function validFindings(): AnalysisFindings {
  return {
    observed: [
      {
        statement: 'Two spans in the captured trace exceeded the duration threshold.',
        evidence: [{ eventId: EVENT_ID }],
      },
    ],
    likelyCauses: [
      {
        statement: 'The work the slower span covers is performed once per iteration.',
        evidence: [{ eventId: EVENT_ID }],
        confidence: 'medium',
      },
    ],
  };
}

/** One available metric and one the capture could not measure (AAP 0.6.6). */
function validMetrics(): MetricValue[] {
  return [
    {
      id: 'total_duration',
      label: 'Total duration',
      unit: 'milliseconds',
      available: true,
      value: 1175,
    },
    {
      id: 'transferred_bytes',
      label: 'Transferred bytes',
      unit: 'bytes',
      available: false,
      note: 'Reported for same-origin responses only.',
    },
  ];
}

/** The assembled artifact the wire and the store carry. */
function validResult(): AnalysisResult {
  return createAnalysisResult(validFindings(), {
    id: ANALYSIS_ID,
    sessionId: 'ses_4k2p9dq7m1zx0c3v',
    captureId: 'cap_7f3q0m2zk1x8ab9c',
    analysisVersion: ANALYSIS_VERSION_START,
    createdAt: 1_758_000_000_000,
    metrics: validMetrics(),
  });
}

describe('analysisFindingsSchema — the model may not assert what it cannot cite', () => {
  it('accepts an evidenced fact and an evidenced, ranked hypothesis', () => {
    const findings = validFindings();
    expect(analysisFindingsSchema.parse(findings)).toEqual(findings);
  });

  it('accepts two empty lists, because a weak capture is not a shape error', () => {
    // AAP 0.5.5: a capture that collected nothing skips analysis and the
    // fallback panel path carries no model-derived facts at all.
    expect(analysisFindingsSchema.parse({ observed: [], likelyCauses: [] })).toEqual({
      observed: [],
      likelyCauses: [],
    });
  });

  it('refuses a fact whose evidence array is empty', () => {
    // The mechanical proof that the IMPORTED factSchema is in force: a local
    // copy of the shape would accept this, and only `@debuggen/panel-schema`'s
    // `.min(1)` refuses it (AAP 0.8.4).
    const refused = analysisFindingsSchema.safeParse({
      observed: [{ statement: 'Something happened.', evidence: [] }],
      likelyCauses: [],
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues[0]?.code).toBe('too_small');
    expect(refused.error.issues[0]?.path).toEqual(['observed', 0, 'evidence']);
  });

  it('refuses a hypothesis with no confidence and one with an unranked confidence', () => {
    const [cause] = validFindings().likelyCauses;
    expect(
      analysisFindingsSchema.safeParse({
        observed: [],
        likelyCauses: [{ statement: cause?.statement, evidence: cause?.evidence }],
      }).success,
    ).toBe(false);
    expect(
      analysisFindingsSchema.safeParse({
        observed: [],
        likelyCauses: [{ ...cause, confidence: 'certain' }],
      }).success,
    ).toBe(false);
  });

  it('refuses an invented field, so a misunderstanding is repaired rather than ignored', () => {
    const refused = analysisFindingsSchema.safeParse({ ...validFindings(), metrics: [] });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('reports a rejection as MODEL_OUTPUT_INVALID, not as a transport fault', () => {
    const parsed = parseAnalysisFindings({ observed: [], likelyCauses: 'none' });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('MODEL_OUTPUT_INVALID');
    expect([...DEBUGGEN_ERROR_CODES]).toContain(parsed.error.code);
  });
});

describe('analysisResultSchema — the artifact the wire and the store carry', () => {
  it('accepts the assembled result and survives a JSON round trip unchanged', () => {
    const result = validResult();

    expect(analysisResultSchema.parse(result)).toEqual(result);
    // It crosses a WebSocket as the `analysis.completed` payload, so the object
    // a consumer parses must be the object the producer built.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(analysisResultSchema.safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
  });

  it('accepts a follow-up version that supersedes a different analysis', () => {
    const previous = validResult();
    const next = createAnalysisResult(validFindings(), {
      id: 'ana_0c5x2z9m6q1t8w3n',
      sessionId: previous.sessionId,
      captureId: previous.captureId,
      analysisVersion: previous.analysisVersion + 1,
      supersedes: previous.id,
      createdAt: previous.createdAt + 1,
      metrics: validMetrics(),
    });

    expect(analysisResultSchema.safeParse(next).success).toBe(true);
    expect(next.supersedes).toBe(previous.id);
  });

  it('refuses a version below the first one, and a non-integer version', () => {
    for (const analysisVersion of [0, -1, 1.5]) {
      expect(analysisResultSchema.safeParse({ ...validResult(), analysisVersion }).success).toBe(
        false,
      );
    }
    expect(ANALYSIS_VERSION_START).toBe(1);
  });

  it('refuses an analysis that supersedes itself, naming the field and no value', () => {
    const refused = analysisResultSchema.safeParse({ ...validResult(), supersedes: ANALYSIS_ID });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues[0]?.path).toEqual(['supersedes']);
    expect(refused.error.issues[0]?.message).not.toContain(ANALYSIS_ID);
  });

  it('refuses an unknown extra key and an absent required field', () => {
    expect(
      analysisResultSchema.safeParse({ ...validResult(), promptVersion: 'v001' }).success,
    ).toBe(false);
    // Built by deletion rather than by destructuring, so the assertion needs no
    // discarded binding: the point is the absent key, whatever produced it.
    const withoutCapture: Record<string, unknown> = { ...validResult() };
    delete withoutCapture['captureId'];
    expect(analysisResultSchema.safeParse(withoutCapture).success).toBe(false);
  });

  it('refuses a null supersedes, because absence has one spelling', () => {
    expect(analysisResultSchema.safeParse({ ...validResult(), supersedes: null }).success).toBe(
      false,
    );
  });

  it('holds the metric vocabulary closed, while allowing an unmeasured metric', () => {
    const [available, unavailable] = validMetrics();

    // An id outside the fourteen `METRIC_IDS` is refused by the imported
    // `isMetricId` predicate rather than by a copy of the list.
    expect(
      analysisResultSchema.safeParse({
        ...validResult(),
        metrics: [{ ...available, id: 'total_latency' }],
      }).success,
    ).toBe(false);

    // `available: false` with no `value` is the honest report of a metric the
    // capture could not measure (AAP 0.6.6), and it parses.
    expect(unavailable && 'value' in unavailable).toBe(false);
    expect(
      analysisResultSchema.safeParse({ ...validResult(), metrics: [unavailable] }).success,
    ).toBe(true);

    // A primitive where a metric belongs, and more metrics than exist.
    expect(analysisResultSchema.safeParse({ ...validResult(), metrics: [7] }).success).toBe(false);
    expect(
      analysisResultSchema.safeParse({
        ...validResult(),
        metrics: Array.from({ length: METRIC_IDS.length + 1 }, () => available),
      }).success,
    ).toBe(false);
  });
});

describe('parseAnalysisResult — a rejected analysis never leaks its data', () => {
  it('returns the validated artifact', () => {
    const parsed = parseAnalysisResult(validResult());

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.observed).toHaveLength(1);
      expect(parsed.value.likelyCauses[0]?.confidence).toBe('medium');
    }
  });

  it('names the offending field without echoing the value it refused', () => {
    // A distinctive sentinel rather than a credential-shaped literal, for the
    // reason the error-frame suite above states.
    const sentinel = 'sentinel-analysis-4f81c2-must-not-be-echoed';
    const parsed = parseAnalysisResult({ ...validResult(), createdAt: sentinel });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect([...DEBUGGEN_ERROR_CODES]).toContain(parsed.error.code);
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('createdAt');
    expect(parsed.error.message).not.toContain(sentinel);
    expect(parsed.error.hint ?? '').not.toContain(sentinel);
    expect(JSON.stringify(parsed.error.details)).not.toContain(sentinel);
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(sentinel);
  });

  it('refuses a statement carrying data when its own field is malformed, without quoting it', () => {
    const sentinel = 'sentinel-statement-7b20e9-must-not-be-echoed';
    const parsed = parseAnalysisResult({
      ...validResult(),
      observed: [{ statement: sentinel, evidence: [] }],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.message).toContain('observed[0].evidence');
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(sentinel);
  });
});

describe('createAnalysisResult — deterministic, and nobody else owns its arrays', () => {
  it('produces the same artifact twice for the same inputs', () => {
    expect(validResult()).toEqual(validResult());
  });

  it('omits supersedes entirely rather than storing an undefined', () => {
    const result = validResult();

    expect('supersedes' in result).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('mints an id and reads the clock only for the fields the caller omitted', () => {
    const first = createAnalysisResult(validFindings(), {
      sessionId: 'ses_4k2p9dq7m1zx0c3v',
      captureId: 'cap_7f3q0m2zk1x8ab9c',
      analysisVersion: ANALYSIS_VERSION_START,
      metrics: validMetrics(),
    });
    const second = createAnalysisResult(validFindings(), {
      sessionId: 'ses_4k2p9dq7m1zx0c3v',
      captureId: 'cap_7f3q0m2zk1x8ab9c',
      analysisVersion: ANALYSIS_VERSION_START,
      metrics: validMetrics(),
    });

    expect(first.id).not.toBe(second.id);
    expect(analysisResultSchema.safeParse(first).success).toBe(true);
    expect(first.createdAt).toBeGreaterThan(0);
  });

  it('copies the lists it is given, so a later mutation cannot change a stored analysis', () => {
    const findings = validFindings();
    const metrics = validMetrics();
    const result = createAnalysisResult(findings, {
      id: ANALYSIS_ID,
      sessionId: 'ses_4k2p9dq7m1zx0c3v',
      captureId: 'cap_7f3q0m2zk1x8ab9c',
      analysisVersion: ANALYSIS_VERSION_START,
      createdAt: 1_758_000_000_000,
      metrics,
    });

    expect(result.observed).not.toBe(findings.observed);
    expect(result.likelyCauses).not.toBe(findings.likelyCauses);
    expect(result.metrics).not.toBe(metrics);

    findings.observed.length = 0;
    findings.likelyCauses.length = 0;
    metrics.length = 0;

    expect(result.observed).toHaveLength(1);
    expect(result.likelyCauses).toHaveLength(1);
    expect(result.metrics).toHaveLength(2);
    expect(result).toEqual(validResult());
  });
});

// ---------------------------------------------------------------------------
// The session record — `../session-record.ts`, the payload of
// `session.created` / `session.updated` and the body every session route
// returns.
//
// What the suites below are for is the same thing the analysis suites above are
// for, one layer wider: this record embeds five shapes owned by
// `@debuggen/instrumentation`, one owned by `./analysis.ts` and one type owned by
// `@debuggen/telemetry`, and a local copy of any of them would compile,
// type-check identically and differ only in what it refuses. So each case feeds
// in the value only the imported schema rejects — a plan with no `adapter` on an
// action, a modification whose digest is not 64 lowercase hex, a fact citing
// nothing — and requires the rejection. `SessionRecordEmbeddedShapesPreserved`
// is the compile-time half of the same guarantee.
//
// The two path fields carry deliberately **opposite** constraints (AAP §0.2.3):
// `projectRoot` is the absolute boundary, and every `RelevantFile.file` is
// relative and must be unable to escape it.
// ---------------------------------------------------------------------------

/** The session that owns every fixture below; the id `validResult()` already uses. */
const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

/** The capture the fixture session recorded. */
const CAPTURE_ID = 'cap_7f3q0m2zk1x8ab9c';

/** The panel generated from it. */
const PANEL_ID = 'pan_6h2j8k4l0z5x1c7v';

/** A modification id of the shape `newModificationId()` mints. */
const MODIFICATION_ID = 'mod_5b1n7m3q9w2e4r6t';

/** An action id of the shape a normalised plan carries. */
const ACTION_ID = 'act_2q7w1e9r4t6y8u3i';

/** The developer's workspace folder: absolute, POSIX, on their own machine. */
const PROJECT_ROOT = '/home/example/workspace/site';

/** A project-relative source path, the only spelling `RelevantFile.file` accepts. */
const SOURCE_FILE = 'src/lib/thing.ts';

/**
 * A 64-character lowercase hexadecimal digest, built from a repeating seed.
 *
 * Synthetic and low-entropy on purpose: the digests only have to satisfy the
 * imported `sha256HexSchema`, and `scripts/check-secrets.mjs` scans every
 * tracked file for high-entropy strings.
 */
function hashFixture(seed: string): string {
  return seed.repeat(32).slice(0, 64);
}

/** A normalised instrumentation plan: the shape a session stores, never the authoring one. */
function validPlan(): SessionRecord['plans'][number] {
  return {
    version: 1,
    planVersion: 1,
    sessionId: SESSION_ID,
    objective: 'Determine where the time in the selected interaction is spent.',
    hypotheses: ['The work happens on the server rather than in the browser.'],
    capture: ['click event timing', 'fetch calls', 'server request spans'],
    instrumentationTargets: [
      {
        id: ACTION_ID,
        file: SOURCE_FILE,
        symbol: 'runTask',
        type: 'function-timing',
        adapter: 'nextjs',
        mode: 'patch',
        rationale: 'The symbol the investigation identified as the entry point.',
      },
    ],
  };
}

/** One applied modification record, with both digests and its diff. */
function validModification(): SessionRecord['modifications'][number] {
  return {
    id: MODIFICATION_ID,
    sessionId: SESSION_ID,
    planVersion: 1,
    file: SOURCE_FILE,
    originalHash: hashFixture('1a'),
    backupPath: `/home/example/.debuggen/backups/${SESSION_ID}/${hashFixture('1a')}`,
    instrumentedHash: hashFixture('2b'),
    appliedAt: 1_758_000_000_500,
    status: 'reverted',
    diff: '--- a/src/lib/thing.ts\n+++ b/src/lib/thing.ts\n',
  };
}

/** A complete, realistic session record: every field populated, nothing invented. */
function validSessionRecord(): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: 'site',
    devServerUrl: 'http://localhost:3000',
    boundTab: { tabId: 7, url: 'http://localhost:3000/list?filter=%3F' },
    createdAt: 1_758_000_000_000,
    updatedAt: 1_758_000_120_000,
    status: 'generated',
    question: 'Why does this action take so long?',
    followUps: [
      {
        question: 'Why did that step run twice?',
        askedAt: 1_758_000_100_000,
        needsNewCapture: false,
        captureId: CAPTURE_ID,
        analysisId: ANALYSIS_ID,
        panelId: PANEL_ID,
      },
    ],
    target: {
      selector: 'main > button.primary',
      tagName: 'BUTTON',
      text: 'Continue',
      componentChain: ['PrimaryAction', 'ActionRow'],
      url: 'http://localhost:3000/list',
    },
    understanding: {
      category: 'performance',
      signalsNeeded: ['interactions', 'fetch', 'http'],
      entities: [{ kind: 'function', name: 'runTask', file: SOURCE_FILE }],
      searchHints: ['slow interaction'],
    },
    relevantFiles: [
      {
        file: SOURCE_FILE,
        symbol: 'runTask',
        reason: 'The function the selected element’s handler calls.',
        score: 0.9,
      },
      { file: 'src/lib/other.ts', reason: 'Imported by the file above.', score: 0.25 },
    ],
    plans: [validPlan()],
    modifications: [validModification()],
    captures: [
      {
        id: CAPTURE_ID,
        planVersion: 1,
        startedAt: 1_758_000_000_900,
        stoppedAt: 1_758_000_010_900,
        summary: computeCaptureSummary([], { captureId: CAPTURE_ID, sessionId: SESSION_ID }),
        eventCount: 0,
      },
    ],
    panelIds: [PANEL_ID],
    analyses: [validResult()],
    cleanup: { status: 'clean', completedAt: 1_758_000_119_000, conflicts: [] },
    promptVersions: {
      understand: 'v001',
      investigate: 'v001',
      plan: 'v001',
      analyze: 'v001',
      'generate-panel': 'v001',
      followup: 'v001',
    },
    provider: { id: 'deterministic' },
  };
}

describe('SESSION_STATUSES and CLEANUP_STATUSES — two closed vocabularies', () => {
  it('holds exactly the eleven session statuses, in the AAP order, without duplicates', () => {
    expect([...SESSION_STATUSES]).toEqual([
      'created',
      'understanding',
      'investigating',
      'planning',
      'instrumenting',
      'ready',
      'capturing',
      'analyzing',
      'generated',
      'ended',
      'failed',
    ]);
    // The order is what a progress view renders in, so it is pinned as an order
    // and not as a set — and the set has no duplicate hiding in it.
    expect(SESSION_STATUSES).toHaveLength(11);
    expect(new Set(SESSION_STATUSES).size).toBe(11);
  });

  it('holds exactly the four cleanup statuses, beginning with pending', () => {
    expect([...CLEANUP_STATUSES]).toEqual(['pending', 'clean', 'partial', 'conflict']);
    expect(new Set(CLEANUP_STATUSES).size).toBe(4);
    // `pending` is the state a session is in before cleanup has run, which is
    // why this vocabulary has one more member than a cleanup *pass*'s verdict.
    expect(CLEANUP_STATUSES[0]).toBe('pending');
  });

  it('refuses an unknown status in either position', () => {
    expect(
      sessionRecordSchema.safeParse({ ...validSessionRecord(), status: 'complete' }).success,
    ).toBe(false);
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        cleanup: { status: 'clean-ish', conflicts: [] },
      }).success,
    ).toBe(false);
  });

  it('narrows a value with its guards without allocating a result', () => {
    expect(isSessionStatus('capturing')).toBe(true);
    expect(isSessionStatus('Capturing')).toBe(false);
    expect(isSessionStatus(undefined)).toBe(false);
    expect(isCleanupStatus('conflict')).toBe(true);
    expect(isCleanupStatus('clean-ish')).toBe(false);
    expect(isCleanupStatus(7)).toBe(false);
  });
});

describe('sessionRecordSchema — the single definition of a session’s state', () => {
  it('accepts a complete record and survives a JSON round trip unchanged', () => {
    const record = validSessionRecord();

    expect(sessionRecordSchema.parse(record)).toEqual(record);
    // A reopened session is rebuilt from this object alone (AAP §0.4.2): it
    // crosses a WebSocket, an HTTP response and a SQLite text column, so the
    // object a consumer parses must be the object the producer built.
    const roundTripped: unknown = JSON.parse(JSON.stringify(record));
    expect(roundTripped).toEqual(record);
    expect(sessionRecordSchema.safeParse(roundTripped).success).toBe(true);
  });

  it('accepts a freshly created session, whose containers are empty rather than absent', () => {
    const created: SessionRecord = {
      id: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      projectName: 'site',
      devServerUrl: 'http://localhost:3000',
      createdAt: 1_758_000_000_000,
      updatedAt: 1_758_000_000_000,
      status: 'created',
      question: 'Why does this action take so long?',
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
    };

    expect(sessionRecordSchema.safeParse(created).success).toBe(true);
    // The three genuinely optional fields are absent keys, not nulls, so the
    // record round-trips as itself.
    expect('boundTab' in created).toBe(false);
    expect('target' in created).toBe(false);
    expect('understanding' in created).toBe(false);
    expect(JSON.parse(JSON.stringify(created))).toEqual(created);
  });

  it('refuses an unknown top-level key, so no app can quietly extend the record', () => {
    const refused = sessionRecordSchema.safeParse({
      ...validSessionRecord(),
      panelSpec: { title: 'x' },
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues[0]?.code).toBe('unrecognized_keys');
    expect(refused.error.issues[0]).toMatchObject({ keys: ['panelSpec'] });
  });

  it('refuses a null in place of an absent optional, and a missing required container', () => {
    expect(sessionRecordSchema.safeParse({ ...validSessionRecord(), boundTab: null }).success).toBe(
      false,
    );
    const withoutCleanup: Record<string, unknown> = { ...validSessionRecord() };
    delete withoutCleanup['cleanup'];
    expect(sessionRecordSchema.safeParse(withoutCleanup).success).toBe(false);
  });

  it('constrains its two path fields in deliberately opposite directions', () => {
    // `projectRoot` is the boundary: absolute POSIX, nothing else.
    for (const projectRoot of [
      'workspace/site',
      'C:/workspace/site',
      '//server/share/site',
      '/workspace/site\u0000',
      '',
    ]) {
      expect(sessionRecordSchema.safeParse({ ...validSessionRecord(), projectRoot }).success).toBe(
        false,
      );
    }
    expect(
      sessionRecordSchema.safeParse({ ...validSessionRecord(), projectRoot: '/workspace/site' })
        .success,
    ).toBe(true);

    // `relevantFiles[].file` is measured against it: project-relative, and
    // unable to escape. The refusals are the imported `isSafeRelativePath`'s,
    // not a local regular expression's.
    for (const file of [
      '/home/example/workspace/site/src/lib/thing.ts',
      '../../etc/shadow',
      'src/../../secret.ts',
      'C:\\workspace\\site\\src\\lib\\thing.ts',
      'src/lib/thing.ts\u0000.bak',
      '   ',
    ]) {
      expect(
        relevantFileSchema.safeParse({ file, reason: 'Investigated.', score: 0.5 }).success,
      ).toBe(false);
      expect(
        sessionRecordSchema.safeParse({
          ...validSessionRecord(),
          relevantFiles: [{ file, reason: 'Investigated.', score: 0.5 }],
        }).success,
      ).toBe(false);
    }
    // An interior `..` that resolves back inside is accepted, because
    // normalisation has already removed it.
    expect(
      relevantFileSchema.safeParse({
        file: 'src/../src/lib/thing.ts',
        reason: 'Investigated.',
        score: 0,
      }).success,
    ).toBe(true);
  });

  it('keeps a relevance score inside 0..1 and refuses a score that is not a number', () => {
    for (const score of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
      expect(
        relevantFileSchema.safeParse({ file: SOURCE_FILE, reason: 'Investigated.', score }).success,
      ).toBe(false);
    }
    expect(
      relevantFileSchema.safeParse({ file: SOURCE_FILE, reason: 'Investigated.', score: 1 })
        .success,
    ).toBe(true);
  });

  it('embeds the NORMALIZED plan schema rather than a local copy of it', () => {
    // Each of these is a plan a local restatement would have accepted, and only
    // `instrumentationPlanSchema` refuses: the authoring shape (no `version`,
    // no `planVersion`, no `sessionId`), and a normalised plan whose action is
    // missing the `adapter` and `mode` that normalisation assigns (AAP §0.2.3).
    const authoringShape = {
      objective: 'Determine where the time in the selected interaction is spent.',
      capture: ['click event timing'],
      instrumentationTargets: [{ file: SOURCE_FILE, symbol: 'runTask', type: 'function-timing' }],
    };
    expect(
      sessionRecordSchema.safeParse({ ...validSessionRecord(), plans: [authoringShape] }).success,
    ).toBe(false);

    // Built by deletion rather than by destructuring, so the assertion needs no
    // discarded bindings: the point is the absent keys, whatever produced them.
    const actionWithoutAdapter: Record<string, unknown> = {
      ...validPlan().instrumentationTargets[0],
    };
    delete actionWithoutAdapter['adapter'];
    delete actionWithoutAdapter['mode'];

    const refused = sessionRecordSchema.safeParse({
      ...validSessionRecord(),
      plans: [{ ...validPlan(), instrumentationTargets: [actionWithoutAdapter] }],
    });
    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues.map((issue) => issue.path.join('.'))).toContain(
      'plans.0.instrumentationTargets.0.adapter',
    );

    // And a wrong `version` literal, which only the normalised schema pins.
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        plans: [{ ...validPlan(), version: 2 }],
      }).success,
    ).toBe(false);
  });

  it('embeds the modification-record schema, digests and all', () => {
    for (const originalHash of [
      hashFixture('1a').toUpperCase(),
      hashFixture('1a').slice(1),
      'not-a-digest',
    ]) {
      expect(
        sessionRecordSchema.safeParse({
          ...validSessionRecord(),
          modifications: [{ ...validModification(), originalHash }],
        }).success,
      ).toBe(false);
    }
    // A status outside the journal's five is refused by the same imported schema.
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        modifications: [{ ...validModification(), status: 'undone' }],
      }).success,
    ).toBe(false);
  });

  it('embeds the analysis schema, so a stored fact cannot cite nothing', () => {
    const refused = sessionRecordSchema.safeParse({
      ...validSessionRecord(),
      analyses: [
        { ...validResult(), observed: [{ statement: 'Something happened.', evidence: [] }] },
      ],
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    // `./analysis.ts` → `@debuggen/panel-schema`'s `factSchema` `.min(1)` is the
    // only rule that refuses this (AAP §0.8.4).
    expect(refused.error.issues[0]?.code).toBe('too_small');
    expect(refused.error.issues[0]?.path).toEqual(['analyses', 0, 'observed', 0, 'evidence']);
  });

  it('embeds the selected-target and problem-understanding schemas', () => {
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        target: { ...validSessionRecord().target, url: 'not-a-url' },
      }).success,
    ).toBe(false);
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        understanding: { ...validSessionRecord().understanding, signalsNeeded: [] },
      }).success,
    ).toBe(false);
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        understanding: { ...validSessionRecord().understanding, category: 'slowness' },
      }).success,
    ).toBe(false);
  });

  it('accepts an in-flight capture and refuses a summary that is not one', () => {
    const inFlight = {
      ...validSessionRecord(),
      status: 'capturing',
      captures: [{ id: CAPTURE_ID, planVersion: 1, startedAt: 1_758_000_000_900 }],
    };
    expect(sessionRecordSchema.safeParse(inFlight).success).toBe(true);

    // The shallow guard behind the embedded `CaptureSummary` type: a plain
    // object missing the capture's identity and measurements is refused, and so
    // is a primitive where the aggregate belongs.
    for (const summary of [{ eventCount: 0, metrics: [] }, 7, null, []]) {
      expect(
        sessionRecordSchema.safeParse({
          ...validSessionRecord(),
          captures: [{ id: CAPTURE_ID, planVersion: 1, startedAt: 1_758_000_000_900, summary }],
        }).success,
      ).toBe(false);
    }
  });

  it('pins the prompt-version vocabulary and the version spelling', () => {
    expect([...PROMPT_STAGE_KEYS]).toEqual([
      'understand',
      'investigate',
      'plan',
      'analyze',
      'generate-panel',
      'followup',
    ]);
    // A stage outside the six, and a version that is not `vNNN`.
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        promptVersions: { summarise: 'v001' },
      }).success,
    ).toBe(false);
    for (const version of ['v1', '1.0.0', 'latest', 'V001']) {
      expect(
        sessionRecordSchema.safeParse({
          ...validSessionRecord(),
          promptVersions: { analyze: version },
        }).success,
      ).toBe(false);
    }
  });

  it('records the provider that ran the session, over a closed pair', () => {
    expect([...PROVIDER_IDS]).toEqual(['anthropic', 'deterministic']);
    expect(
      sessionRecordSchema.safeParse({ ...validSessionRecord(), provider: { id: 'openai' } })
        .success,
    ).toBe(false);
    // A model id is recorded, never derived: the value comes from
    // DEBUGGEN_MODEL, so the schema bounds its shape and nothing more.
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        provider: { id: 'anthropic', model: 'example-model-id' },
      }).success,
    ).toBe(true);
  });

  it('bounds every array, so one long session cannot grow a row without limit', () => {
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        panelIds: Array.from({ length: 129 }, () => PANEL_ID),
      }).success,
    ).toBe(false);
    expect(
      sessionRecordSchema.safeParse({
        ...validSessionRecord(),
        relevantFiles: Array.from({ length: 51 }, () => ({
          file: SOURCE_FILE,
          reason: 'Investigated.',
          score: 0.5,
        })),
      }).success,
    ).toBe(false);
  });
});

describe('parseSessionRecord — a rejected session never leaks the developer’s data', () => {
  it('returns the validated record', () => {
    const parsed = parseSessionRecord(validSessionRecord());

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.status).toBe('generated');
      expect(parsed.value.cleanup.conflicts).toEqual([]);
      expect(parsed.value.plans[0]?.instrumentationTargets[0]?.mode).toBe('patch');
    }
  });

  it('names the offending fields without echoing the question or the project path', () => {
    // Two sentinels rather than credential-shaped literals, for the reason the
    // error-frame suite above states: the question and the project root are the
    // two most sensitive fields this record carries (AAP §0.5.2).
    const questionSentinel = 'sentinel-question-6ad920-must-not-be-echoed';
    const rootSentinel = '/sentinel-root-31bc47-must-not-be-echoed/../escape';
    const parsed = parseSessionRecord({
      ...validSessionRecord(),
      question: `${questionSentinel}\u0000`,
      projectRoot: rootSentinel.replace('/sentinel', 'sentinel'),
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect([...DEBUGGEN_ERROR_CODES]).toContain(parsed.error.code);
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('question');
    expect(parsed.error.message).toContain('projectRoot');
    for (const leak of [questionSentinel, 'sentinel-root-31bc47']) {
      expect(parsed.error.message).not.toContain(leak);
      expect(parsed.error.hint ?? '').not.toContain(leak);
      expect(JSON.stringify(parsed.error.details)).not.toContain(leak);
      expect(JSON.stringify(parsed.error.toPayload())).not.toContain(leak);
    }
  });

  it('reports a corrupted store row rather than throwing', () => {
    // What `apps/local-service/src/store/sessions-repo.ts` does with a row an
    // older build wrote: an `Err` it can log and skip while listing sessions.
    for (const value of [undefined, null, '{}', 42, []]) {
      const parsed = parseSessionRecord(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      }
    }
  });
});

describe('followUpRecordSchema — a follow-up attempt carries an identity, not a guessable key', () => {
  /** An attempt id of the shape the product mints; literal, so no clock or generator is read. */
  const ATTEMPT_ID = `${FOLLOW_UP_ATTEMPT_ID_PREFIX}_4k2p9dq7m1zx0c3v`;

  /** A follow-up as the service records it when asked: the ask, and no outcome yet. */
  const asked: FollowUpRecord = {
    question: 'Why did that step run twice?',
    askedAt: 1_758_000_100_000,
    attemptId: ATTEMPT_ID,
    attempt: 1,
  };

  it('accepts an attempt id and its counter, and a stored follow-up that predates both', () => {
    expect(followUpRecordSchema.safeParse(asked).success).toBe(true);
    expect(followUpRecordSchema.safeParse({ ...asked, attempt: 3 }).success).toBe(true);
    // A legacy row: written before attempts had an identity, and still readable.
    expect(
      followUpRecordSchema.safeParse({ question: asked.question, askedAt: asked.askedAt }).success,
    ).toBe(true);
    expect(
      sessionRecordSchema.safeParse({ ...validSessionRecord(), followUps: [asked] }).success,
    ).toBe(true);
  });

  it('refuses an attempt counter below one or off the integers, and a malformed attempt id', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, '1']) {
      expect(followUpRecordSchema.safeParse({ ...asked, attempt }).success, String(attempt)).toBe(
        false,
      );
    }
    for (const attemptId of ['', ' ', 'fua_\u0000', 'x'.repeat(65), 7, null]) {
      expect(followUpRecordSchema.safeParse({ ...asked, attemptId }).success).toBe(false);
      expect(followUpAttemptIdSchema.safeParse(attemptId).success).toBe(false);
    }
    expect(followUpAttemptIdSchema.safeParse(ATTEMPT_ID).success).toBe(true);
  });

  it('names the attempt id and prefix the product mints', () => {
    expect(FOLLOW_UP_ATTEMPT_ID_PREFIX).toMatch(/^[a-z]{3}$/);
  });
});

describe('isFollowUpAnswered — any outcome link, present, answers a follow-up', () => {
  it('reads an ask with no outcome link as unanswered, whatever its attempt counter', () => {
    const ask: FollowUpRecord = {
      question: 'Why did that step run twice?',
      askedAt: 1_758_000_100_000,
      attemptId: `${FOLLOW_UP_ATTEMPT_ID_PREFIX}_4k2p9dq7m1zx0c3v`,
      attempt: 2,
    };

    expect(isFollowUpAnswered(ask)).toBe(false);
    expect(isFollowUpAnswered({ question: ask.question, askedAt: ask.askedAt })).toBe(false);
  });

  it.each([
    ['needsNewCapture: false', { needsNewCapture: false }],
    ['needsNewCapture: true', { needsNewCapture: true }],
    ['planVersion', { planVersion: 2 }],
    ['captureId', { captureId: CAPTURE_ID }],
    ['analysisId', { analysisId: ANALYSIS_ID }],
    ['panelId', { panelId: PANEL_ID }],
  ] as const)('reads a follow-up carrying only %s as answered', (_link, outcome) => {
    const followUp: FollowUpRecord = {
      question: 'Why did that step run twice?',
      askedAt: 1_758_000_100_000,
      ...outcome,
    };

    expect(followUpRecordSchema.safeParse(followUp).success).toBe(true);
    expect(isFollowUpAnswered(followUp)).toBe(true);
  });

  it('lists exactly the five outcome links, frozen', () => {
    expect([...FOLLOW_UP_OUTCOME_KEYS]).toEqual([
      'needsNewCapture',
      'planVersion',
      'captureId',
      'analysisId',
      'panelId',
    ]);
    expect(Object.isFrozen(FOLLOW_UP_OUTCOME_KEYS)).toBe(true);
  });
});

describe('touchSessionRecord — a pure updatedAt bump, and nothing else', () => {
  it('returns a new record with the new timestamp and leaves the original alone', () => {
    const record = validSessionRecord();
    const stamped = touchSessionRecord(record, 1_758_000_999_000);

    expect(stamped).not.toBe(record);
    expect(stamped.updatedAt).toBe(1_758_000_999_000);
    expect(record.updatedAt).toBe(1_758_000_120_000);
    expect(sessionRecordSchema.safeParse(stamped).success).toBe(true);
    // Everything else is the same record, status included: the state machine
    // lives in the service and this helper is not it.
    expect({ ...stamped, updatedAt: record.updatedAt }).toEqual(record);
  });
});

// ---------------------------------------------------------------------------
// The message payloads — `../messages/*.ts`, one strict payload per frame
//
// Fixtures first. They are literal and fixed: a clock or a live id generator
// inside an assertion would make a failure depend on when it ran, and this
// package's suites have no environment to read one from anyway
// (`packages/protocol/tsconfig.json` sets `types: []`, so there is no
// `process`, no `Buffer` and no `node:*` builtin here).
//
// Digests and trace ids are built from repeating seeds so they satisfy their
// schemas while staying low-entropy: `scripts/check-secrets.mjs` scans every
// tracked file for a dense value bound to a key-like name, and a test fixture
// is not worth a false positive. Every synthetic name is generic for the same
// reason the product's are (AAP §0.5.4): no component, service function or
// route path from the demo application appears here.
//
// The record and plan builders this section needs already exist above —
// `validSessionRecord()`, `validPlan()`, `validModification()`,
// `validResult()`, `validFindings()` and `validMetrics()` — and are reused
// rather than restated. Duplication with `./http.test.ts` and
// `./envelope.test.ts` is expected instead: this package keeps exactly three
// suites (AAP §0.8.3), so a shared helper module is not an option, and neither
// suite imports the other.
// ---------------------------------------------------------------------------

/** The Chrome tab every binding and agent fixture below is about. */
const TAB_ID = 7;

/** Chrome's per-document id for the document the page agent installed into. */
const DOCUMENT_ID = 'doc_2m9q4x7c1v6b0n3z';

/** The producer identity one page document's agent stamps on its events. */
const PRODUCER_ID = 'prd_8x4c2v6b0n1m5q3w';

/** A 32-character lowercase hexadecimal trace id, from a repeating seed. */
const TRACE_ID = '3f2a'.repeat(8);

/** A 16-character lowercase hexadecimal span id. */
const SPAN_ID = '1b2c3d4e5f60718a';

/** That tab's document URL, query-redacted before it left the page (AAP §0.5.2). */
const PAGE_URL = 'http://localhost:3000/list?filter=%3F';

/** The serialized origin of that URL: scheme, host and port, and nothing else. */
const PAGE_ORIGIN = 'http://localhost:3000';

/** A fixed point in time, so no assertion below depends on a clock. */
const START_TIME = 1_758_000_000_000;

/**
 * A placeholder credential.
 *
 * Bounded and non-empty, which is all `client.hello`'s token field checks, and
 * deliberately unlike any provider's key format: the service resolves a
 * presented credential by hashing it and looking the hash up (AAP §0.5.6), so
 * nothing here needs to look real, and a realistic-looking one would trip the
 * repository's own secret scanner.
 */
const TOKEN = 'editor-credential-placeholder';

/**
 * The string planted in a field a payload must refuse, then looked for in
 * everything the rejection produces.
 *
 * Distinctive enough that it could not appear by chance, and short enough that
 * it is not a dense value in its own right — `scripts/check-secrets.mjs` reads
 * this file too.
 */
const SENTINEL = 'SENTINEL-do-not-leak-9c31';

/**
 * The envelope id of the `source.open` a `source.result` fixture answers, in the
 * shape `newMessageId()` mints — the value its `ref` correlates by.
 */
const SOURCE_OPEN_FRAME_ID = 'msg_8e2r4t6y1u3i5o7p';

/**
 * The envelope id of the `client.ping` the `service.pong` fixture answers, in
 * the shape `newMessageId()` mints — the value its `ref` correlates by.
 */
const PING_FRAME_ID = 'msg_2p4i6n8g0f3r5a7m';

/**
 * A `failed` source result with every optional field present.
 *
 * Typed as that one member of the union rather than as the whole payload, so
 * the cases below can reach its `error` without narrowing first; it is also the
 * `source.result` fixture of {@link VALID_PAYLOADS}.
 */
const FAILED_SOURCE_RESULT: Extract<SourceResultPayload, { status: 'failed' }> = {
  sessionId: SESSION_ID,
  ref: SOURCE_OPEN_FRAME_ID,
  status: 'failed',
  error: {
    code: 'PATH_OUTSIDE_PROJECT',
    message: 'The location is outside the session\u2019s project.',
    hint: 'Open the project folder in VS Code and try the link again.',
  },
};

/**
 * The payload type the registry binds to a message type.
 *
 * Derived from `MESSAGE_PAYLOAD_SCHEMAS` rather than from a hand-written map, so
 * the tables below are typed by the schemas themselves: a payload whose shape
 * drifts from its schema is a compile error in this file.
 */
type PayloadOf<T extends MessageType> = z.infer<(typeof MESSAGE_PAYLOAD_SCHEMAS)[T]>;

/**
 * A copy of `source` with `keys` removed.
 *
 * Built by deletion rather than by destructuring, so a case about an absent key
 * needs no discarded binding — `noUnusedLocals` is on — and so the assertion
 * reads as what it is about: the missing field, whatever produced it.
 *
 * @param source The object to copy.
 * @param keys The keys to leave out.
 * @returns A new object without those keys.
 */
function without(source: object, ...keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };

  for (const key of keys) {
    delete copy[key];
  }

  return copy;
}

/** Every browser hook armed but the component-tree snapshot. */
function validAgentHookConfig(): AgentHookConfig {
  return {
    interactions: true,
    react: true,
    state: true,
    fetch: true,
    perf: true,
    errors: true,
    componentTree: false,
  };
}

/** Server-tier signals for a capture that wants the backend but not outgoing fetches. */
function validServerAgentSignals(): ServerAgentSignals {
  return {
    http: true,
    routeHandlers: true,
    fetch: false,
    prisma: true,
    pg: true,
    functions: ['runTask'],
  };
}

/**
 * One normalised instrumentation action.
 *
 * Typed as the upstream `InstrumentationAction`, which is itself part of the
 * assertion: the payload tables below place this value in a slot typed from
 * `instrumentationPlanSchema`, so the assignment compiles only while the
 * payload's action really is the shape `@debuggen/instrumentation` exports.
 */
function validAction(): InstrumentationAction {
  return {
    id: ACTION_ID,
    file: SOURCE_FILE,
    symbol: 'runTask',
    type: 'function-timing',
    adapter: 'nextjs',
    mode: 'patch',
    rationale: 'The symbol the investigation identified as the entry point.',
  };
}

/** One event exactly as a producer sends it: no session, no capture, no ingest sequence. */
function validIngressEvent(): TelemetryEventIngress {
  return {
    id: 'evt_1a2b3c4d5e6f7g8h',
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    kind: 'interaction',
    name: 'click primary action',
    startTime: START_TIME,
    duration: 12.5,
    tier: 'browser',
    attributes: { 'event.type': 'click' },
    status: 'ok',
    producerId: PRODUCER_ID,
    seq: 0,
  };
}

/** The same event as the store holds it, with the three fields the service assigns. */
function validPersistedEvent(): TelemetryEvent {
  return {
    ...validIngressEvent(),
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: 1,
  };
}

/** A resolved source location: project-relative, 1-based, with its resolution route. */
function validSourceLocation(): SourceLocation {
  return {
    file: SOURCE_FILE,
    line: 42,
    column: 3,
    symbol: 'runTask',
    resolvedBy: 'patch',
    confidence: 1,
  };
}

/** The five-field element descriptor, with a query-redacted URL. */
function validSelectedTarget(): SelectedTarget {
  return {
    selector: 'main > button.primary',
    tagName: 'BUTTON',
    text: 'Continue',
    componentChain: ['PrimaryAction', 'ActionRow'],
    url: PAGE_URL,
  };
}

/** One observed fact, citing an event the capture holds. */
function validFact(): Fact {
  return {
    statement: 'Two spans in the captured trace exceeded the duration threshold.',
    evidence: [{ eventId: EVENT_ID, traceId: TRACE_ID, kind: 'interaction', label: 'the click' }],
  };
}

/** One ranked hypothesis, with the location it points at. */
function validHypothesis(): Hypothesis {
  return {
    statement: 'The work the slower span covers is performed once per iteration.',
    evidence: [{ eventId: EVENT_ID }],
    confidence: 'medium',
    suggestedLocation: validSourceLocation(),
  };
}

/** One measured metric, from the closed vocabulary its owner defines. */
function validMetricValue(): MetricValue {
  return {
    id: 'total_duration',
    label: 'Total duration',
    unit: 'milliseconds',
    available: true,
    value: 1175,
  };
}

/**
 * A panel specification the renderer would accept, composing three node types.
 *
 * Typed from the payload rather than as `PanelSpec`, and that asymmetry is real
 * rather than incidental: the interface declares `layout` as a readonly array
 * while the schema infers a mutable one, so a `PanelSpec` is not assignable
 * *into* the payload. The direction that matters — the parsed payload being
 * assignable to `PanelSpec`, which is what lets a receiver hand it straight to
 * the renderer's host — holds, and the case
 * "hands its parsed panel to a PanelSpec consumer without a cast" asserts it.
 */
function validPanelSpec(): PayloadOf<'panel.generated'>['panel'] {
  return {
    version: 1,
    id: PANEL_ID,
    sessionId: SESSION_ID,
    panelVersion: 2,
    supersedes: 'pan_1a2b3c4d5e6f7g8h',
    title: 'Where the time went',
    summary: {
      headline: 'Most of the interaction was held by one span.',
      observed: [validFact()],
      likelyCauses: [validHypothesis()],
    },
    layout: [
      {
        type: 'timeline',
        id: 'layout[0]',
        title: 'The interaction',
        query: { source: 'trace', filter: { traceId: TRACE_ID } },
      },
      {
        type: 'metricCards',
        id: 'layout[1]',
        query: { source: 'metrics' },
        metrics: ['total_duration', 'backend_duration'],
      },
      { type: 'sourceLink', id: 'layout[2]', location: validSourceLocation() },
    ],
  };
}

/** One conflict a cleanup pass refused to overwrite. */
function validModificationConflict(): ModificationConflict {
  return {
    recordId: MODIFICATION_ID,
    sessionId: SESSION_ID,
    file: SOURCE_FILE,
    reason: 'content-changed',
    expectedHash: hashFixture('2b'),
    actualHash: hashFixture('3c'),
    backupPath: `/home/example/.debuggen/backups/${SESSION_ID}/${hashFixture('1a')}`,
    detectedAt: START_TIME + 100_000,
    message: 'The file was edited while instrumented; the original is still in the backup.',
    diffs: { instrumentedToCurrent: '--- a/src/lib/thing.ts\n+++ b/src/lib/thing.ts\n' },
  };
}

/**
 * The summary a stopped capture carries, computed by the package that owns it.
 *
 * Built rather than hand-written because the payload's guard is deliberately
 * shallow — a plain-record check over an opaque type — and the failure worth
 * catching is a guard that refuses a value its own producer emits.
 */
const CAPTURE_SUMMARY: CaptureSummary = computeCaptureSummary([validPersistedEvent()], {
  captureId: CAPTURE_ID,
  sessionId: SESSION_ID,
});

/**
 * One valid payload per message type, keyed by type.
 *
 * The mapped type is the point twice over. It makes the table **exhaustive** — a
 * message added to the protocol without a fixture here is a compile error, which
 * is what stops the registry-driven suites at the end of this file from silently
 * covering twenty-eight of twenty-nine frames. And it types every slot from the
 * *schema*, so placing an upstream value (a `SelectedTarget`, an
 * `InstrumentationAction`, a `TelemetryEvent`, a `SourceLocation`) into it is a
 * compile-time statement that the payload field is that same type rather than a
 * lookalike (AAP §0.2.3).
 *
 * Every payload is **fully specified**: each optional field a frame can carry is
 * present. That is what lets the no-transform case below compare the parsed
 * object with its input for equality without having to reason about defaults.
 */
const VALID_PAYLOADS: { readonly [T in MessageType]: PayloadOf<T> } = {
  'client.hello': {
    client: 'vscode',
    projectRoot: PROJECT_ROOT,
    tabId: TAB_ID,
    version: PROTOCOL_VERSION,
    token: TOKEN,
  },
  'client.ping': {},
  'service.pong': { ref: PING_FRAME_ID },
  'agent.ready': {
    tabId: TAB_ID,
    documentId: DOCUMENT_ID,
    producerId: PRODUCER_ID,
    url: PAGE_URL,
    installedBeforeReact: true,
    reactDetected: true,
  },
  'agent.config': { sessionId: SESSION_ID, captureId: CAPTURE_ID, hooks: validAgentHookConfig() },
  'server-agent.config': {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    signals: validServerAgentSignals(),
  },
  'session.bind': { tabId: TAB_ID, url: PAGE_URL, origin: PAGE_ORIGIN, sessionId: SESSION_ID },
  'session.bound': { sessionId: SESSION_ID, tabId: TAB_ID, url: PAGE_URL, reason: 'bound' },
  'tab.navigated': { tabId: TAB_ID, url: PAGE_URL },
  'session.unbind': { tabId: TAB_ID },
  'session.created': { session: validSessionRecord() },
  'session.updated': { session: validSessionRecord() },
  'session.progress': {
    sessionId: SESSION_ID,
    stage: 'capture',
    status: 'running',
    message: 'Ready to capture',
    detail: 'Reproduce the issue now.',
  },
  'analysis.completed': { sessionId: SESSION_ID, analysis: validResult() },
  'capture.started': { sessionId: SESSION_ID, captureId: CAPTURE_ID },
  'capture.stopped': { sessionId: SESSION_ID, captureId: CAPTURE_ID, summary: CAPTURE_SUMMARY },
  'instrumentation.plan': { sessionId: SESSION_ID, plan: validPlan() },
  'instrumentation.ready': {
    sessionId: SESSION_ID,
    applied: [validModification()],
    runtimeHooks: ['Browser performance', 'React renders', 'Network tracing'],
    unavailable: [
      {
        signal: 'prisma',
        reason: 'the dev server is not running with the telemetry preload',
        hint: 'Relaunch the dev server through the editor extension.',
      },
    ],
  },
  'instrumentation.failed': {
    sessionId: SESSION_ID,
    error: {
      code: 'INSTRUMENTATION_UNAVAILABLE',
      message: 'No signal in the plan could be enabled.',
      hint: 'Relaunch the dev server through the editor extension and try again.',
      ref: 'msg_7c1v6b0n3z2m9q4x',
    },
  },
  'telemetry.event': { events: [validIngressEvent()] },
  'telemetry.tail': { sessionId: SESSION_ID, events: [validPersistedEvent()] },
  'panel.generated': { sessionId: SESSION_ID, panelId: PANEL_ID, panel: validPanelSpec() },
  'source.open': { sessionId: SESSION_ID, location: validSourceLocation() },
  // The `failed` member, because it is the one that carries every optional
  // field a `source.result` can hold — the error and its hint.
  'source.result': FAILED_SOURCE_RESULT,
  'target.request': { sessionId: SESSION_ID },
  'target.selected': { sessionId: SESSION_ID, target: validSelectedTarget() },
  'cleanup.completed': {
    sessionId: SESSION_ID,
    status: 'conflict',
    conflicts: [validModificationConflict()],
  },
  error: { code: CODE, message: 'The model provider is unavailable.', ref: 'msg_3z2m9q4x7c1v6b0n' },
};

/**
 * The schema each message type is expected to be bound to, written out by name.
 *
 * The runtime half of what `MessageRegistryIsComplete` proves at compile time,
 * and it catches something that assertion cannot see: a *mis-keyed* entry. Two
 * payloads in this folder have compatible shapes at some nesting level — the two
 * session broadcasts are deliberately identical, and the four binding frames
 * overlap heavily — so a registry that mapped `session.bound` to the bind schema
 * would still satisfy every type-level check and would still parse most frames.
 * Comparing by identity is what refuses it.
 */
const REGISTERED_SCHEMAS: { readonly [T in MessageType]: (typeof MESSAGE_PAYLOAD_SCHEMAS)[T] } = {
  'client.hello': clientHelloPayloadSchema,
  'client.ping': clientPingPayloadSchema,
  'service.pong': servicePongPayloadSchema,
  'agent.ready': agentReadyPayloadSchema,
  'agent.config': agentConfigPayloadSchema,
  'server-agent.config': serverAgentConfigPayloadSchema,
  'session.bind': sessionBindPayloadSchema,
  'session.bound': sessionBoundPayloadSchema,
  'tab.navigated': tabNavigatedPayloadSchema,
  'session.unbind': sessionUnbindPayloadSchema,
  'session.created': sessionCreatedPayloadSchema,
  'session.updated': sessionUpdatedPayloadSchema,
  'session.progress': sessionProgressPayloadSchema,
  'analysis.completed': analysisCompletedPayloadSchema,
  'capture.started': captureStartedPayloadSchema,
  'capture.stopped': captureStoppedPayloadSchema,
  'instrumentation.plan': instrumentationPlanPayloadSchema,
  'instrumentation.ready': instrumentationReadyPayloadSchema,
  'instrumentation.failed': instrumentationFailedPayloadSchema,
  'telemetry.event': telemetryEventPayloadSchema,
  'telemetry.tail': telemetryTailPayloadSchema,
  'panel.generated': panelGeneratedPayloadSchema,
  'source.open': sourceOpenPayloadSchema,
  'source.result': sourceResultPayloadSchema,
  'target.request': targetRequestPayloadSchema,
  'target.selected': targetSelectedPayloadSchema,
  'cleanup.completed': cleanupCompletedPayloadSchema,
  error: errorPayloadSchema,
};

/**
 * The issue paths a rejection reported, as dotted strings.
 *
 * Paths and codes are the only part of a failure this package renders (AAP
 * §0.5.2), so they are the only part worth asserting on — never the issue's
 * received value, which the assertions here must not read even to compare.
 *
 * @param error The error a `safeParse` returned.
 * @returns One dotted path per issue, in the order Zod reported them.
 */
function issuePaths(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.map((segment) => String(segment)).join('.'));
}

describe('client.hello — the frame that turns a socket into a participant', () => {
  it('accepts a full announcement and one from a client with nothing to announce', () => {
    const full = VALID_PAYLOADS['client.hello'];
    expect(clientHelloPayloadSchema.parse(full)).toEqual(full);

    // A DevTools connection has no project root and an agent relay has no tab:
    // both fields are optional, and absent rather than null is how a client says
    // it has nothing to name.
    const minimal = { client: 'devtools', version: PROTOCOL_VERSION, token: TOKEN };
    expect(clientHelloPayloadSchema.parse(minimal)).toEqual(minimal);
    expect(clientHelloPayloadSchema.safeParse({ ...minimal, projectRoot: null }).success).toBe(
      false,
    );
  });

  it('accepts each of the four client kinds and refuses a fifth', () => {
    expect([...CLIENT_KINDS]).toEqual(['vscode', 'devtools', 'agent', 'server-agent']);

    for (const client of CLIENT_KINDS) {
      expect(
        clientHelloPayloadSchema.safeParse({ client, version: PROTOCOL_VERSION, token: TOKEN })
          .success,
      ).toBe(true);
    }

    // The kind is a claim used for routing and attribution, never a capability
    // (AAP §0.5.6) — but it is a *closed* claim, so a surface that switched over
    // it exhaustively cannot be handed a fifth case.
    for (const client of ['panel', 'vsCode', '', 7]) {
      expect(
        clientHelloPayloadSchema.safeParse({ client, version: PROTOCOL_VERSION, token: TOKEN })
          .success,
      ).toBe(false);
    }
  });

  it('validates the version with the imported protocol-version schema', () => {
    expect(protocolVersionSchema.safeParse(PROTOCOL_VERSION).success).toBe(true);

    for (const version of ['v1', '1.0', '1.0.0-beta', '01.0.0', 1]) {
      // Asserted against the imported schema and against the payload, because
      // the point is that they are the same rule rather than two similar ones:
      // the handshake compares versions with `isCompatibleProtocolVersion`,
      // which is written against this shape.
      expect(protocolVersionSchema.safeParse(version).success).toBe(false);
      expect(
        clientHelloPayloadSchema.safeParse({ client: 'vscode', version, token: TOKEN }).success,
      ).toBe(false);
    }
  });

  it('requires a credential, and refuses an empty one', () => {
    const payload = VALID_PAYLOADS['client.hello'];

    expect(clientHelloPayloadSchema.safeParse(without(payload, 'token')).success).toBe(false);
    expect(clientHelloPayloadSchema.safeParse({ ...payload, token: '' }).success).toBe(false);
    expect(clientHelloPayloadSchema.safeParse({ ...payload, token: 'x'.repeat(513) }).success).toBe(
      false,
    );
  });

  it('refuses a tab id that is not a real tab', () => {
    const payload = VALID_PAYLOADS['client.hello'];

    // -1 is `chrome.tabs.TAB_ID_NONE`: a connection claiming a tab must name one
    // that can actually be sent a configuration frame.
    for (const tabId of [-1, 1.5, Number.NaN, '7']) {
      expect(clientHelloPayloadSchema.safeParse({ ...payload, tabId }).success).toBe(false);
    }
    expect(clientHelloPayloadSchema.safeParse({ ...payload, tabId: 0 }).success).toBe(true);
  });

  it('publishes the two transport constants of the access boundary', () => {
    // The close code a refused, late or silent handshake is closed with, and the
    // deadline it is late against (AAP §0.5.6). Both are read by the service and
    // by both extension clients, so they are part of this module's contract.
    expect(WS_CLOSE_UNAUTHORIZED).toBe(4401);
    expect(CLIENT_HELLO_TIMEOUT_MS).toBe(3000);
  });
});

describe('client.ping and service.pong — a liveness pair with nothing to act on', () => {
  it('accepts an empty ping and refuses a ping carrying any key at all', () => {
    expect(clientPingPayloadSchema.parse(VALID_PAYLOADS['client.ping'])).toEqual({});

    // The envelope id is the correlation key: a ping has no field to carry, so
    // a session, a tab, a ref or anything else is a producer mistake, refused.
    for (const payload of [
      { ref: PING_FRAME_ID },
      { sessionId: SESSION_ID },
      { tabId: TAB_ID },
      { ping: true },
    ]) {
      const parsed = clientPingPayloadSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
      }
    }
    for (const value of [undefined, null, [], 'ping', 0]) {
      expect(clientPingPayloadSchema.safeParse(value).success).toBe(false);
    }
  });

  it('requires a pong to name the ping it answers, bounded like every ref, and nothing else', () => {
    const payload = VALID_PAYLOADS['service.pong'];
    expect(servicePongPayloadSchema.parse(payload)).toEqual({ ref: PING_FRAME_ID });

    // Sixty-four characters is the bound every correlation ref in the folder
    // shares, so the longest id `newMessageId()` could ever mint fits and a
    // payload smuggled through the field does not.
    expect(servicePongPayloadSchema.safeParse({ ref: 'r'.repeat(64) }).success).toBe(true);
    for (const ref of ['', 'r'.repeat(65), 7, null]) {
      expect(servicePongPayloadSchema.safeParse({ ref }).success).toBe(false);
    }
    expect(servicePongPayloadSchema.safeParse({}).success).toBe(false);
    expect(servicePongPayloadSchema.safeParse({ ...payload, sessionId: SESSION_ID }).success).toBe(
      false,
    );
    expect(servicePongPayloadSchema.safeParse({ ...payload, status: 'ok' }).success).toBe(false);
  });

  it('refuses a malformed ping or pong through its parse helper without echoing what arrived', () => {
    const cases: readonly {
      readonly named: string;
      readonly parsed: Result<unknown, DebuggenError>;
    }[] = [
      { named: 'unrecognized_keys keys=ref', parsed: parseClientPingPayload({ ref: SENTINEL }) },
      {
        named: 'ref (too_big origin=string max=64)',
        parsed: parseServicePongPayload({ ref: `${SENTINEL}-${'x'.repeat(64)}` }),
      },
      {
        named: 'unrecognized_keys keys=note',
        parsed: parseServicePongPayload({ ref: PING_FRAME_ID, note: SENTINEL }),
      },
    ];

    for (const { named, parsed } of cases) {
      expect(isErr(parsed)).toBe(true);
      if (!isErr(parsed)) {
        continue;
      }
      expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(parsed.error.message).toContain(named);
      expect(parsed.error.cause).toBeUndefined();
      for (const rendered of [
        parsed.error.message,
        parsed.error.hint ?? '',
        JSON.stringify(parsed.error.details),
        JSON.stringify(parsed.error.toPayload()),
      ]) {
        expect(rendered).not.toContain(SENTINEL);
      }
    }
  });

  it('publishes the client budget for a pong', () => {
    // The service answers on arrival; how long a pinging client waits before it
    // treats the connection as dead is this one declared figure.
    expect(SERVICE_PONG_TIMEOUT_MS).toBe(5000);
  });
});

describe('agent.ready — what the page agent reports about its own document', () => {
  it('accepts the report and requires both readiness booleans', () => {
    const payload = VALID_PAYLOADS['agent.ready'];
    expect(agentReadyPayloadSchema.parse(payload)).toEqual(payload);

    // `installedBeforeReact` is what the readiness gate reads before it offers a
    // consented reload (AAP §0.5.5), and `reactDetected` is what stops it
    // offering one for a page that has no React at all. A missing or
    // string-typed flag would make both decisions on a value nobody sent.
    for (const key of ['installedBeforeReact', 'reactDetected']) {
      expect(agentReadyPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
      expect(agentReadyPayloadSchema.safeParse({ ...payload, [key]: 'true' }).success).toBe(false);
    }
    expect(
      agentReadyPayloadSchema.safeParse({ ...payload, installedBeforeReact: false }).success,
    ).toBe(true);
  });

  it('requires the tab, the document, the producer and the document URL', () => {
    const payload = VALID_PAYLOADS['agent.ready'];

    for (const key of ['tabId', 'documentId', 'producerId', 'url']) {
      expect(agentReadyPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
    }
    // The frame is relayed by the service worker rather than sent by the page,
    // so the URL arrives as text to compare and display — any absolute URL,
    // never a relative one.
    expect(agentReadyPayloadSchema.safeParse({ ...payload, url: '/list' }).success).toBe(false);
    expect(agentReadyPayloadSchema.safeParse({ ...payload, documentId: '' }).success).toBe(false);
  });
});

describe('agent.config — exactly the seven hook flags, imported not restated', () => {
  it('accepts an armed configuration and the all-false dormancy instruction', () => {
    const payload = VALID_PAYLOADS['agent.config'];
    expect(agentConfigPayloadSchema.parse(payload)).toEqual(payload);

    // Dormancy is all-false hooks, never an absent capture (AAP §0.5.1): the
    // agent detaches its listeners, restores the `fetch`/`XMLHttpRequest` patch
    // and unsubscribes its fiber handlers, and it still knows which capture it
    // is leaving. `DORMANT_AGENT_HOOK_CONFIG` is the canonical value, so no
    // caller hand-writes one.
    const dormant = { ...payload, hooks: DORMANT_AGENT_HOOK_CONFIG };
    expect(agentConfigPayloadSchema.parse(dormant)).toEqual(dormant);
  });

  it('requires exactly the seven flags the imported configuration declares', () => {
    // Derived from the imported schema and the imported dormant value rather
    // than written out, so a rename upstream fails *here* instead of silently
    // disabling a signal: the page agent reads these key names structurally and
    // attaches exactly the hooks it was told about.
    const declared = Object.keys(agentHookConfigSchema.shape);

    expect(declared).toEqual([
      'interactions',
      'react',
      'state',
      'fetch',
      'perf',
      'errors',
      'componentTree',
    ]);
    expect(Object.keys(DORMANT_AGENT_HOOK_CONFIG)).toEqual(declared);
    expect(declared).toHaveLength(7);

    for (const key of declared) {
      const refused = agentConfigPayloadSchema.safeParse({
        ...VALID_PAYLOADS['agent.config'],
        hooks: without(validAgentHookConfig(), key),
      });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      // A partially specified configuration would leave the agent guessing at
      // the flag it was not told about, which means either observing something
      // the developer did not ask for or missing the evidence they needed.
      expect(issuePaths(refused.error)).toContain(`hooks.${key}`);
    }
  });

  it('refuses an eighth flag this build does not know', () => {
    const refused = agentConfigPayloadSchema.safeParse({
      ...VALID_PAYLOADS['agent.config'],
      hooks: { ...validAgentHookConfig(), longTasks: true },
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues[0]?.code).toBe('unrecognized_keys');
    expect(issuePaths(refused.error)).toContain('hooks');
  });

  it('requires both ids, because an armed agent stamps them on what it emits', () => {
    const payload = VALID_PAYLOADS['agent.config'];

    for (const key of ['sessionId', 'captureId', 'hooks']) {
      expect(agentConfigPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
    }
  });

  it('reports a rejection as a protocol failure through the parse helper', () => {
    const parsed = parseAgentConfigPayload({ ...VALID_PAYLOADS['agent.config'], hooks: {} });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect([...DEBUGGEN_ERROR_CODES]).toContain(parsed.error.code);
    expect(parsed.error.message).toContain('hooks.interactions');
  });
});

describe('server-agent.config — six signals, and an absent captureId means disable', () => {
  it('accepts an arming frame and the disable frame that names neither id', () => {
    const payload = VALID_PAYLOADS['server-agent.config'];
    expect(serverAgentConfigPayloadSchema.parse(payload)).toEqual(payload);

    // The disable case of AAP §0.5.1: no capture, so the preload calls
    // `disable()` on its instrumentations and drops the global tracer provider,
    // leaving the module loaded but inert while the application keeps serving.
    // `DISABLED_SERVER_AGENT_SIGNALS` is the signal set that accompanies it.
    const disable = { signals: DISABLED_SERVER_AGENT_SIGNALS };
    expect(serverAgentConfigPayloadSchema.parse(disable)).toEqual(disable);

    // Both ids are independently optional: a frame may name the session that
    // owns the capture without naming a capture, and the preload applies the
    // precedence rather than this schema.
    expect(
      serverAgentConfigPayloadSchema.safeParse({ ...disable, sessionId: SESSION_ID }).success,
    ).toBe(true);
    expect(
      serverAgentConfigPayloadSchema.safeParse({ ...disable, captureId: CAPTURE_ID }).success,
    ).toBe(true);
    expect(serverAgentConfigPayloadSchema.safeParse({ ...disable, captureId: null }).success).toBe(
      false,
    );
  });

  it('requires exactly the six signal keys the imported schema declares', () => {
    const declared = Object.keys(serverAgentSignalsSchema.shape);

    expect(declared).toEqual(['http', 'routeHandlers', 'fetch', 'prisma', 'pg', 'functions']);
    expect(Object.keys(DISABLED_SERVER_AGENT_SIGNALS)).toEqual(declared);
    expect(declared).toHaveLength(6);

    for (const key of declared) {
      const refused = serverAgentConfigPayloadSchema.safeParse({
        signals: without(validServerAgentSignals(), key),
      });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toContain(`signals.${key}`);
    }

    expect(
      serverAgentConfigPayloadSchema.safeParse({
        signals: { ...validServerAgentSignals(), longTasks: true },
      }).success,
    ).toBe(false);
  });

  it('keeps functions a list of names, because timing a symbol costs a modification', () => {
    // The one signal that is a list rather than a flag: function timing is
    // planned per symbol because it is the only signal that edits the
    // developer's file, so it is never enabled wholesale.
    expect(
      serverAgentConfigPayloadSchema.safeParse({
        signals: { ...validServerAgentSignals(), functions: [] },
      }).success,
    ).toBe(true);

    for (const functions of [['runTask', 7], [''], 'runTask', [null], [['runTask']]]) {
      expect(
        serverAgentConfigPayloadSchema.safeParse({
          signals: { ...validServerAgentSignals(), functions },
        }).success,
      ).toBe(false);
    }
  });

  it('requires the signal set itself', () => {
    expect(serverAgentConfigPayloadSchema.safeParse({}).success).toBe(false);
    expect(serverAgentConfigPayloadSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
  });
});

describe('the binding quartet — bind, bound, navigated, unbind', () => {
  it('session.bind names the tab, the document and its origin', () => {
    const payload = VALID_PAYLOADS['session.bind'];
    expect(sessionBindPayloadSchema.parse(payload)).toEqual(payload);

    // An absent `sessionId` means "match by origin" (AAP §0.4.2), so it is
    // optional — and a misspelling of it must fail loudly rather than be
    // dropped, because silently dropping it turns "bind me to this session"
    // into "bind me to any session on this origin".
    const byOrigin = without(payload, 'sessionId');
    expect(sessionBindPayloadSchema.parse(byOrigin)).toEqual(byOrigin);
    expect(sessionBindPayloadSchema.safeParse({ ...payload, sessionID: SESSION_ID }).success).toBe(
      false,
    );

    for (const key of ['tabId', 'url', 'origin']) {
      expect(sessionBindPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
    }
  });

  it('session.bind requires a serialized origin, not a URL that looks like one', () => {
    const payload = VALID_PAYLOADS['session.bind'];

    // The service matches this value against each session's dev-server origin,
    // so a trailing slash or a path would make an equality comparison miss.
    // A userinfo segment is refused for the same reason — and is written here
    // without a password component so that this file stays clean under
    // `scripts/check-secrets.mjs`, which reads `user:secret@host` as a
    // committed credential wherever it appears (AAP §0.3.4).
    for (const origin of [
      'http://localhost:3000/',
      'http://localhost:3000/list',
      'http://localhost:3000?a=1',
      'localhost:3000',
      'http://someone@localhost:3000',
      '',
    ]) {
      expect(sessionBindPayloadSchema.safeParse({ ...payload, origin }).success).toBe(false);
    }
    expect(
      sessionBindPayloadSchema.safeParse({ ...payload, origin: 'http://127.0.0.1:43117' }).success,
    ).toBe(true);
  });

  it('session.bound announces every transition over the closed reason vocabulary', () => {
    const payload = VALID_PAYLOADS['session.bound'];
    expect(sessionBoundPayloadSchema.parse(payload)).toEqual(payload);

    expect([...BINDING_REASONS]).toEqual([
      'bound',
      'replaced',
      'navigated',
      'origin-changed',
      'unbound',
    ]);
    for (const reason of BINDING_REASONS) {
      expect(sessionBoundPayloadSchema.safeParse({ ...payload, reason }).success).toBe(true);
    }

    // Absent means an establishment; a consumer reads it that way where the
    // value is used, because this package validates without rewriting and no
    // `.default()` invents a field the producer did not send.
    const establishment = without(payload, 'reason');
    expect(sessionBoundPayloadSchema.parse(establishment)).toEqual(establishment);
    expect(sessionBoundPayloadSchema.safeParse({ ...payload, reason: 'rebound' }).success).toBe(
      false,
    );

    for (const key of ['sessionId', 'tabId', 'url']) {
      expect(sessionBoundPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
    }
  });

  it('tab.navigated reports a tab and a committed document, and asserts nothing else', () => {
    const payload = VALID_PAYLOADS['tab.navigated'];
    expect(tabNavigatedPayloadSchema.parse(payload)).toEqual(payload);

    // No `origin` and no `sessionId`: the origin is derivable by the party that
    // owns the comparison, and a service worker reporting a navigation is in no
    // position to assert which session a tab belongs to.
    expect(tabNavigatedPayloadSchema.safeParse({ ...payload, origin: PAGE_ORIGIN }).success).toBe(
      false,
    );
    expect(tabNavigatedPayloadSchema.safeParse({ ...payload, sessionId: SESSION_ID }).success).toBe(
      false,
    );

    for (const key of ['tabId', 'url']) {
      expect(tabNavigatedPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
    }
  });

  it('session.unbind is a tab id and nothing more', () => {
    const payload = VALID_PAYLOADS['session.unbind'];
    expect(sessionUnbindPayloadSchema.parse(payload)).toEqual(payload);
    expect(Object.keys(sessionUnbindPayloadSchema.shape)).toEqual(['tabId']);

    // Three causes, one message: DevTools closed, the tab closed, or the session
    // ended. Keeping the payload this narrow keeps it sendable from a service
    // worker that is being torn down, where reading anything more is a race.
    expect(sessionUnbindPayloadSchema.safeParse({}).success).toBe(false);
    expect(sessionUnbindPayloadSchema.safeParse({ tabId: TAB_ID, reason: 'unbound' }).success).toBe(
      false,
    );
  });
});

describe('session.created and session.updated — the whole record travels', () => {
  it('carries a complete record under both names and survives a JSON round trip', () => {
    const payload = VALID_PAYLOADS['session.created'];

    expect(sessionCreatedPayloadSchema.parse(payload)).toEqual(payload);
    expect(sessionUpdatedPayloadSchema.parse(payload)).toEqual(payload);

    // `session.updated` is also the frame that *replays* a session: reopening
    // one from the editor's Sessions tree sends this payload from stored data,
    // so what a consumer parses must be what the producer built (AAP §0.4.2).
    const roundTripped: unknown = JSON.parse(JSON.stringify(payload));
    expect(roundTripped).toEqual(payload);
    expect(sessionUpdatedPayloadSchema.safeParse(roundTripped).success).toBe(true);
  });

  it('declares the same single field twice rather than sharing one alias', () => {
    // Two message types, two registry entries, one shape — the envelope
    // enumerates types rather than shapes, and the editor reveals its view on
    // creation while refreshing in place on an update.
    expect(Object.keys(sessionCreatedPayloadSchema.shape)).toEqual(['session']);
    expect(Object.keys(sessionUpdatedPayloadSchema.shape)).toEqual(['session']);
    expect(sessionCreatedPayloadSchema).not.toBe(sessionUpdatedPayloadSchema);
  });

  it('embeds the record schema, so a session that fails its own rules fails here', () => {
    // The same three refusals `parseSessionRecord` makes above, asserted at the
    // payload boundary because that is where a producer in another process
    // actually crosses: an authoring-shape plan, a digest that is not 64
    // lowercase hex, and a fact citing nothing.
    const record = validSessionRecord();

    expect(
      sessionCreatedPayloadSchema.safeParse({
        session: {
          ...record,
          plans: [
            {
              objective: 'Determine where the time in the selected interaction is spent.',
              capture: ['click event timing'],
              instrumentationTargets: [
                { file: SOURCE_FILE, symbol: 'runTask', type: 'function-timing' },
              ],
            },
          ],
        },
      }).success,
    ).toBe(false);

    expect(
      sessionCreatedPayloadSchema.safeParse({
        session: {
          ...record,
          modifications: [{ ...validModification(), originalHash: 'not-a-digest' }],
        },
      }).success,
    ).toBe(false);

    expect(
      sessionCreatedPayloadSchema.safeParse({
        session: {
          ...record,
          analyses: [
            { ...validResult(), observed: [{ statement: 'Something happened.', evidence: [] }] },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('refuses an extra key beside the record, and a record that is not an object', () => {
    const payload = VALID_PAYLOADS['session.created'];

    expect(
      sessionCreatedPayloadSchema.safeParse({ ...payload, sessionId: SESSION_ID }).success,
    ).toBe(false);
    for (const session of [undefined, null, '{}', 42, []]) {
      expect(sessionCreatedPayloadSchema.safeParse({ session }).success).toBe(false);
    }
  });
});

describe('session.progress — one line of what the pipeline is doing', () => {
  it('accepts every stage and status the two vocabularies declare', () => {
    expect([...PROGRESS_STAGES]).toEqual([
      'understand',
      'investigate',
      'plan',
      'instrument',
      'capture',
      'analyze',
      'generate-panel',
      'followup',
      'cleanup',
    ]);
    expect([...PROGRESS_STATUSES]).toEqual(['running', 'done', 'failed']);

    for (const stage of PROGRESS_STAGES) {
      for (const status of PROGRESS_STATUSES) {
        // A `failed` frame is a legitimate value on this contract rather than an
        // error of it: the service reports the failing stage and the session's
        // own status becomes `failed` (AAP §0.5.5).
        expect(
          sessionProgressPayloadSchema.safeParse({
            sessionId: SESSION_ID,
            stage,
            status,
            message: 'A line the service composed from what the stage found.',
          }).success,
        ).toBe(true);
      }
    }
  });

  it('refuses a stage or a status outside its vocabulary', () => {
    const payload = VALID_PAYLOADS['session.progress'];

    for (const stage of ['summarise', 'Capture', '', 7]) {
      expect(sessionProgressPayloadSchema.safeParse({ ...payload, stage }).success).toBe(false);
    }
    for (const status of ['skipped', 'pending', 'Done', true]) {
      expect(sessionProgressPayloadSchema.safeParse({ ...payload, status }).success).toBe(false);
    }
  });

  it('requires a non-empty message and keeps the detail an optional string', () => {
    const payload = VALID_PAYLOADS['session.progress'];
    expect(sessionProgressPayloadSchema.parse(payload)).toEqual(payload);

    expect(sessionProgressPayloadSchema.safeParse({ ...payload, message: '' }).success).toBe(false);
    expect(sessionProgressPayloadSchema.safeParse(without(payload, 'message')).success).toBe(false);

    // A stage with nothing further to say omits the key; one that produced an
    // empty string has said the same thing in a way a surface can still render.
    const withoutDetail = without(payload, 'detail');
    expect(sessionProgressPayloadSchema.parse(withoutDetail)).toEqual(withoutDetail);
    expect(sessionProgressPayloadSchema.safeParse({ ...payload, detail: '' }).success).toBe(true);

    // A stage that needs structure has its own message type for it, so this
    // field stays a string rather than becoming a second, weaker channel.
    expect(
      sessionProgressPayloadSchema.safeParse({ ...payload, detail: { files: [] } }).success,
    ).toBe(false);
  });

  it('requires the session, which is what makes the frame routable', () => {
    expect(
      sessionProgressPayloadSchema.safeParse(
        without(VALID_PAYLOADS['session.progress'], 'sessionId'),
      ).success,
    ).toBe(false);
  });
});

describe('analysis.completed — the artifact, validated as deeply as it is stored', () => {
  it('carries the session and the whole analysis', () => {
    const payload = VALID_PAYLOADS['analysis.completed'];

    expect(analysisCompletedPayloadSchema.parse(payload)).toEqual(payload);
    expect(analysisCompletedPayloadSchema.safeParse(without(payload, 'sessionId')).success).toBe(
      false,
    );
    expect(
      analysisCompletedPayloadSchema.safeParse({ ...payload, panelId: PANEL_ID }).success,
    ).toBe(false);
  });

  it('refuses an observed fact that cites nothing', () => {
    // The structural guarantee behind AAP §0.8.4, asserted where a producer
    // crosses: the imported `factSchema` requires at least one `EventRef`, so an
    // unevidenced observation cannot be transmitted, let alone rendered.
    const refused = analysisCompletedPayloadSchema.safeParse({
      sessionId: SESSION_ID,
      analysis: {
        ...validResult(),
        observed: [{ statement: 'Something happened.', evidence: [] }],
      },
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues[0]?.code).toBe('too_small');
    expect(issuePaths(refused.error)).toContain('analysis.observed.0.evidence');
  });

  it('ranks every hypothesis over the imported confidence vocabulary', () => {
    expect([...CONFIDENCE_LEVELS]).toEqual(['low', 'medium', 'high']);

    for (const confidence of CONFIDENCE_LEVELS) {
      expect(
        analysisCompletedPayloadSchema.safeParse({
          sessionId: SESSION_ID,
          analysis: {
            ...validResult(),
            likelyCauses: [{ ...validHypothesis(), confidence }],
          },
        }).success,
      ).toBe(true);
    }

    for (const confidence of ['certain', 'Medium', 0.5, undefined]) {
      expect(
        analysisCompletedPayloadSchema.safeParse({
          sessionId: SESSION_ID,
          analysis: {
            ...validResult(),
            likelyCauses: [{ ...validHypothesis(), confidence }],
          },
        }).success,
      ).toBe(false);
    }
  });

  it('validates a suggested location with the shared source-location schema', () => {
    const hypothesis = validHypothesis();

    // The location a hypothesis points at is the one the editor opens, so it
    // answers to exactly the rules `source.open` enforces — not to a looser
    // copy that happened to be written beside the analysis.
    for (const suggestedLocation of [
      { ...validSourceLocation(), file: '/home/example/workspace/site/src/lib/thing.ts' },
      { ...validSourceLocation(), file: '../../etc/shadow' },
      { ...validSourceLocation(), line: 0 },
      { ...validSourceLocation(), resolvedBy: 'guess' },
      { ...validSourceLocation(), confidence: 1.5 },
      { ...validSourceLocation(), endLine: 1 },
    ]) {
      expect(
        analysisCompletedPayloadSchema.safeParse({
          sessionId: SESSION_ID,
          analysis: { ...validResult(), likelyCauses: [{ ...hypothesis, suggestedLocation }] },
        }).success,
      ).toBe(false);
    }

    // And it is optional: a cause with no code to point at is still a cause.
    expect(
      analysisCompletedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        analysis: {
          ...validResult(),
          likelyCauses: [without(hypothesis, 'suggestedLocation')],
        },
      }).success,
    ).toBe(true);
  });

  it('holds the metric vocabulary closed and admits an unmeasured metric', () => {
    const measured = validMetricValue();

    expect([...METRIC_IDS]).toContain(measured.id);
    expect(
      analysisCompletedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        analysis: { ...validResult(), metrics: [measured] },
      }).success,
    ).toBe(true);
    expect(
      analysisCompletedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        analysis: { ...validResult(), metrics: [{ ...measured, id: 'total_latency' }] },
      }).success,
    ).toBe(false);

    // AAP §0.6.6 records `transferred_bytes` as legitimately unobservable for a
    // server span, so a metric may be reported as unavailable with no value at
    // all; the card renders "n/a" rather than a zero nobody measured.
    const unavailable = {
      id: 'transferred_bytes',
      label: 'Transferred bytes',
      unit: 'bytes',
      available: false,
      note: 'Reported for same-origin responses only.',
    };
    expect('value' in unavailable).toBe(false);
    expect(
      analysisCompletedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        analysis: { ...validResult(), metrics: [unavailable] },
      }).success,
    ).toBe(true);
  });
});

describe('capture.started and capture.stopped — the window, and what it collected', () => {
  it('announces an opened window with both ids', () => {
    const payload = VALID_PAYLOADS['capture.started'];
    expect(captureStartedPayloadSchema.parse(payload)).toEqual(payload);

    for (const key of ['sessionId', 'captureId']) {
      expect(captureStartedPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
    }
    // No summary on the open frame: there is nothing collected yet, and a client
    // that started the capture over HTTP already holds the id.
    expect(
      captureStartedPayloadSchema.safeParse({ ...payload, summary: CAPTURE_SUMMARY }).success,
    ).toBe(false);
  });

  it('hands the summary to every client when the window closes', () => {
    const payload = VALID_PAYLOADS['capture.stopped'];

    expect(captureStoppedPayloadSchema.parse(payload)).toEqual(payload);
    // The summary is the whole point of the frame: a client renders metric
    // cards, counts and top-N lists from it without issuing a panel-data query.
    expect(CAPTURE_SUMMARY.captureId).toBe(CAPTURE_ID);
    expect(CAPTURE_SUMMARY.eventCount).toBe(1);
  });

  it('checks that something object-shaped arrived where the aggregate belongs', () => {
    const payload = VALID_PAYLOADS['capture.stopped'];

    // The guard is deliberately shallow — the summary is computed inside this
    // machine's own service process by the package that defines it — but it is
    // never absent: a bare custom schema would accept `undefined`, and a
    // dropped field would then reach a panel as a valid value.
    for (const summary of [undefined, null, 7, 'x', []]) {
      expect(captureStoppedPayloadSchema.safeParse({ ...payload, summary }).success).toBe(false);
    }
    expect(captureStoppedPayloadSchema.safeParse(without(payload, 'summary')).success).toBe(false);
  });

  it('accepts the summary of a capture that collected nothing', () => {
    // A capture that collected nothing is a fact about the capture, not a fault
    // in the message: the service skips analysis and returns the session to
    // `ready` (AAP §0.5.5), and a client reads the emptiness off the summary.
    const empty = computeCaptureSummary([], { captureId: CAPTURE_ID, sessionId: SESSION_ID });

    expect(empty.eventCount).toBe(0);
    expect(
      captureStoppedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        summary: empty,
      }).success,
    ).toBe(true);
  });
});

describe('instrumentation.plan — the NORMALIZED plan, never the authoring shape', () => {
  it('carries the session and the validated plan', () => {
    const payload = VALID_PAYLOADS['instrumentation.plan'];

    expect(instrumentationPlanPayloadSchema.parse(payload)).toEqual(payload);
    expect(instrumentationPlanPayloadSchema.safeParse(without(payload, 'sessionId')).success).toBe(
      false,
    );
    // The plan carries its own `sessionId` and `planVersion` inside it, which a
    // consumer may cross-check but must not substitute for the routing field.
    expect(payload.plan.sessionId).toBe(SESSION_ID);
    expect(payload.plan.planVersion).toBe(1);
  });

  it('pins the two fixtures for an action to each other', () => {
    // `validAction()` is typed as the upstream `InstrumentationAction` while the
    // plan fixture above writes its action inline; if they ever diverge, every
    // "an action without X is refused" case below would be arguing about a
    // shape the plan fixture no longer has.
    expect(validPlan().instrumentationTargets).toEqual([validAction()]);
  });

  it('refuses a plan with no format version, and one with the wrong version', () => {
    const plan = validPlan();

    expect(
      instrumentationPlanPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        plan: without(plan, 'version'),
      }).success,
    ).toBe(false);
    expect(
      instrumentationPlanPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        plan: { ...plan, version: 2 },
      }).success,
    ).toBe(false);
  });

  it('refuses a plan with no revision counter', () => {
    // `planVersion` is what a follow-up increments: the delta install applies
    // only the new actions and cleanup restores the chain in reverse, so a plan
    // that cannot say which revision it is has nothing to chain against.
    const refused = instrumentationPlanPayloadSchema.safeParse({
      sessionId: SESSION_ID,
      plan: without(validPlan(), 'planVersion'),
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(issuePaths(refused.error)).toContain('plan.planVersion');
  });

  it('refuses an action with no adapter and one with no mode', () => {
    // `adapter` and `mode` are exactly what normalisation assigns by asking the
    // registry which adapter claims each action type (AAP §0.2.3). An action
    // without them is an authoring-stage value that never went through it, and
    // the installer would have no idea whether to arm a runtime hook or write
    // to the developer's file.
    for (const key of ['adapter', 'mode']) {
      const refused = instrumentationPlanPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        plan: { ...validPlan(), instrumentationTargets: [without(validAction(), key)] },
      });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toContain(`plan.instrumentationTargets.0.${key}`);
    }

    expect(
      instrumentationPlanPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        plan: {
          ...validPlan(),
          instrumentationTargets: [{ ...validAction(), mode: 'observe' }],
        },
      }).success,
    ).toBe(false);
  });

  it('refuses the authoring shape a model produces, whole', () => {
    // The positive statement of the same point, and the one that would pass if
    // this payload had restated the plan loosely instead of embedding the
    // normalised schema: the authoring shape is a *valid* artifact one stage
    // earlier, and it is refused here because the frame is sent after
    // normalisation, not before it.
    const authoringShape = {
      objective: 'Determine where the time in the selected interaction is spent.',
      capture: ['click event timing', 'fetch calls', 'server request spans'],
      instrumentationTargets: [{ file: SOURCE_FILE, symbol: 'runTask', type: 'function-timing' }],
    };

    const refused = instrumentationPlanPayloadSchema.safeParse({
      sessionId: SESSION_ID,
      plan: authoringShape,
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    const paths = issuePaths(refused.error);
    for (const path of [
      'plan.version',
      'plan.planVersion',
      'plan.sessionId',
      'plan.instrumentationTargets.0.adapter',
      'plan.instrumentationTargets.0.mode',
    ]) {
      expect(paths).toContain(path);
    }
  });

  it('reports a rejected plan without echoing the objective it refused', () => {
    const parsed = parseInstrumentationPlanPayload({
      sessionId: SESSION_ID,
      plan: { ...validPlan(), objective: SENTINEL, planVersion: 0 },
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('plan.planVersion');
    expect(parsed.error.message).not.toContain(SENTINEL);
  });
});

describe('instrumentation.ready — what the service actually managed to arm', () => {
  it('carries the applied records, the runtime hooks and the gaps', () => {
    const payload = VALID_PAYLOADS['instrumentation.ready'];
    expect(instrumentationReadyPayloadSchema.parse(payload)).toEqual(payload);

    // None of the three is optional and none carries a default, because a
    // consumer must never have to tell "nothing happened" from "the producer
    // did not say".
    for (const key of ['sessionId', 'applied', 'runtimeHooks', 'unavailable']) {
      expect(instrumentationReadyPayloadSchema.safeParse(without(payload, key)).success).toBe(
        false,
      );
    }
    // An install that armed runtime hooks and wrote nothing is the common case.
    expect(
      instrumentationReadyPayloadSchema.safeParse({ ...payload, applied: [], unavailable: [] })
        .success,
    ).toBe(true);
  });

  it('refuses a modification record whose digest is not 64 lowercase hex', () => {
    const payload = VALID_PAYLOADS['instrumentation.ready'];
    const record = validModification();

    // The journal's own rule, inherited rather than restated: cleanup compares a
    // file's hash with the record's before it writes (AAP §0.5.1), so a digest
    // this transport accepted but the store could not use would turn a
    // reversible patch into an unverifiable one.
    for (const key of ['originalHash', 'instrumentedHash']) {
      for (const digest of [
        hashFixture('1a').slice(1),
        hashFixture('1a').toUpperCase(),
        `${hashFixture('1a').slice(0, 63)}g`,
        '',
        hashFixture('1a').slice(0, 32),
      ]) {
        const refused = instrumentationReadyPayloadSchema.safeParse({
          ...payload,
          applied: [{ ...record, [key]: digest }],
        });

        expect(refused.success).toBe(false);
        if (refused.success) {
          return;
        }
        expect(issuePaths(refused.error)).toContain(`applied.0.${key}`);
      }
    }
  });

  it('refuses a record with a status outside the journal vocabulary', () => {
    expect(
      instrumentationReadyPayloadSchema.safeParse({
        ...VALID_PAYLOADS['instrumentation.ready'],
        applied: [{ ...validModification(), status: 'undone' }],
      }).success,
    ).toBe(false);
  });

  it('accepts every capture signal the vocabulary declares as an unavailable gap', () => {
    const payload = VALID_PAYLOADS['instrumentation.ready'];

    expect([...CAPTURE_SIGNALS]).toHaveLength(12);
    for (const signal of CAPTURE_SIGNALS) {
      expect(
        instrumentationReadyPayloadSchema.safeParse({
          ...payload,
          unavailable: [{ signal, reason: 'the signal could not be armed', hint: 'Retry it.' }],
        }).success,
      ).toBe(true);
    }

    // A name a registered adapter defines is accepted too, and that is the
    // module's stated intent rather than a gap in this suite: the vocabulary is
    // a union of the twelve known signals with a bounded free name, so adding an
    // adapter does not require a protocol change. What is refused is a name no
    // surface could render.
    expect(
      instrumentationReadyPayloadSchema.safeParse({
        ...payload,
        unavailable: [
          { signal: 'adapter-defined-signal', reason: 'not available here', hint: 'Retry it.' },
        ],
      }).success,
    ).toBe(true);
    for (const signal of ['', 'x'.repeat(65), 7, null]) {
      expect(
        instrumentationReadyPayloadSchema.safeParse({
          ...payload,
          unavailable: [{ signal, reason: 'not available here', hint: 'Retry it.' }],
        }).success,
      ).toBe(false);
    }
  });

  it('requires a reason and a hint on every gap, and refuses a sixth field', () => {
    const payload = VALID_PAYLOADS['instrumentation.ready'];
    const gap = { signal: 'pg', reason: 'the driver was not detected', hint: 'Install it.' };

    expect(unavailableSignalSchema.parse(gap)).toEqual(gap);
    // This list is the graceful-degradation channel of AAP §0.5.5, whose whole
    // point is that a narrowed capture is actionable rather than merely honest.
    for (const key of ['signal', 'reason', 'hint']) {
      expect(
        instrumentationReadyPayloadSchema.safeParse({
          ...payload,
          unavailable: [without(gap, key)],
        }).success,
      ).toBe(false);
    }
    expect(unavailableSignalSchema.safeParse({ ...gap, retryable: true }).success).toBe(false);
    expect(unavailableSignalSchema.safeParse({ ...gap, reason: '' }).success).toBe(false);
  });

  it('keeps the runtime hooks a list of plain strings a developer can read', () => {
    const payload = VALID_PAYLOADS['instrumentation.ready'];

    expect(
      instrumentationReadyPayloadSchema.safeParse({ ...payload, runtimeHooks: [] }).success,
    ).toBe(true);
    for (const runtimeHooks of [['React renders', 7], [{ id: 'react' }], 'React renders', [null]]) {
      expect(
        instrumentationReadyPayloadSchema.safeParse({ ...payload, runtimeHooks }).success,
      ).toBe(false);
    }
  });

  it('reports a rejected install without echoing the backup path it refused', () => {
    const parsed = parseInstrumentationReadyPayload({
      ...VALID_PAYLOADS['instrumentation.ready'],
      applied: [{ ...validModification(), backupPath: SENTINEL, originalHash: 'not-a-digest' }],
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.message).toContain('applied[0].originalHash');
    expect(parsed.error.message).not.toContain(SENTINEL);
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(SENTINEL);
  });
});

describe('instrumentation.failed — nothing could be enabled, and one way forward', () => {
  it('carries a coded error with a required hint and an optional reference', () => {
    const payload = VALID_PAYLOADS['instrumentation.failed'];
    expect(instrumentationFailedPayloadSchema.parse(payload)).toEqual(payload);

    const withoutRef = { ...payload, error: without(payload.error, 'ref') };
    expect(instrumentationFailedPayloadSchema.parse(withoutRef)).toEqual(withoutRef);
  });

  it('requires the hint, which is the one field it adds to the generic error frame', () => {
    const payload = VALID_PAYLOADS['instrumentation.failed'];
    const bare = without(payload.error, 'hint');

    // The generic frame is `{ code, message, ref? }` and would accept this; this
    // payload extends it precisely because a total instrumentation failure is
    // only recoverable if the developer is told what to do — for a missing
    // dev-server preload, the exact relaunch command (AAP §0.5.5).
    expect(errorPayloadSchema.safeParse(bare).success).toBe(true);
    expect(instrumentationFailedPayloadSchema.safeParse({ ...payload, error: bare }).success).toBe(
      false,
    );
    expect(
      instrumentationFailedPayloadSchema.safeParse({
        ...payload,
        error: { ...payload.error, hint: '' },
      }).success,
    ).toBe(false);
  });

  it('takes its code from the shared vocabulary and nothing else', () => {
    const payload = VALID_PAYLOADS['instrumentation.failed'];

    expect([...DEBUGGEN_ERROR_CODES]).toContain(payload.error.code);
    for (const code of ['NOT_A_CODE', 'instrumentation_unavailable', '', 7]) {
      expect(
        instrumentationFailedPayloadSchema.safeParse({
          ...payload,
          error: { ...payload.error, code },
        }).success,
      ).toBe(false);
    }
    for (const key of ['sessionId', 'error']) {
      expect(instrumentationFailedPayloadSchema.safeParse(without(payload, key)).success).toBe(
        false,
      );
    }
  });
});

describe('telemetry.event — the strict ingress schema does the refusing', () => {
  it('accepts a batch exactly as a producer sends it', () => {
    const payload = VALID_PAYLOADS['telemetry.event'];

    expect(telemetryEventPayloadSchema.parse(payload)).toEqual(payload);
    // The only payload in this folder with no `sessionId`, and deliberately so:
    // the service resolves a telemetry frame to a session from the *connection*
    // — the tab binding for a browser producer, the credential's scoped project
    // root for a server one. Beside the batch it carries
    // only delivery context: the capture the producer was armed for, which can
    // refuse a late batch but never choose a capture, and its loss report.
    expect(Object.keys(telemetryEventPayloadSchema.shape)).toEqual([
      'events',
      'armedCaptureId',
      'droppedCount',
    ]);
    expect(Object.keys(telemetryEventPayloadSchema.shape)).not.toContain('captureId');
    expect(
      telemetryEventPayloadSchema.safeParse({ ...payload, sessionId: SESSION_ID }).success,
    ).toBe(false);
  });

  it('refuses an element that carries the session the service assigns', () => {
    const refused = telemetryEventPayloadSchema.safeParse({
      events: [{ ...validIngressEvent(), sessionId: SESSION_ID }],
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    // Accepting one would let a page nominate the session — and therefore the
    // stored capture and the generated panel — its events land in. The strict
    // object upstream is what makes this a failure rather than a silently
    // ignored extra, and embedding that schema is what brings the rule here.
    expect(refused.error.issues[0]?.code).toBe('unrecognized_keys');
    expect(issuePaths(refused.error)).toContain('events.0');
  });

  it('refuses an element that carries the capture the service assigns', () => {
    expect(
      telemetryEventPayloadSchema.safeParse({
        events: [{ ...validIngressEvent(), captureId: CAPTURE_ID }],
      }).success,
    ).toBe(false);
  });

  it('refuses an element that carries the store-assigned ingest sequence', () => {
    expect(
      telemetryEventPayloadSchema.safeParse({ events: [{ ...validIngressEvent(), ingestSeq: 1 }] })
        .success,
    ).toBe(false);
  });

  it('refuses a persisted event outright, which is the same rule stated once', () => {
    // A tail frame's element is not an ingress element: the three attribution
    // fields together are exactly what this direction rejects and the other
    // direction requires.
    expect(telemetryEventPayloadSchema.safeParse({ events: [validPersistedEvent()] }).success).toBe(
      false,
    );
  });

  it('refuses an empty batch that reports no loss, under the events path', () => {
    // An empty batch without a loss is a producer that flushed nothing, and a
    // consumer that accepted it would record an ingest of zero events as a
    // successful frame. Naming the capture adds nothing, and a zero count is no
    // loss at all.
    for (const payload of [
      { events: [] },
      { events: [], droppedCount: 0 },
      { events: [], armedCaptureId: CAPTURE_ID },
      { events: [], armedCaptureId: CAPTURE_ID, droppedCount: 0 },
    ]) {
      const refused = telemetryEventPayloadSchema.safeParse(payload);

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toEqual(['events']);
      expect(refused.error.issues[0]?.code).toBe('custom');
    }
    expect(telemetryEventPayloadSchema.safeParse({}).success).toBe(false);
    expect(telemetryEventPayloadSchema.safeParse({ events: validIngressEvent() }).success).toBe(
      false,
    );
  });

  it('accepts an event-less batch as a loss-only report, and returns it unchanged', () => {
    // What a producer sends when no later batch will carry its loss — at a
    // capture's end, say — so the count still reaches the service's ledger and
    // the capture does not look complete.
    const lossOnly = { events: [], droppedCount: 3 };
    const armedLossOnly = { events: [], droppedCount: 3, armedCaptureId: CAPTURE_ID };

    expect(telemetryEventPayloadSchema.parse(lossOnly)).toStrictEqual(lossOnly);
    expect(telemetryEventPayloadSchema.parse(armedLossOnly)).toStrictEqual(armedLossOnly);

    const parsed = parseTelemetryEventPayload(armedLossOnly);

    expect(parsed.ok ? parsed.value : renderedIssuePaths(parsed.error)).toStrictEqual(
      armedLossOnly,
    );
  });

  it('refuses a malformed loss count on an event-less batch by its own issue alone', () => {
    // The loss-only rule runs on an otherwise valid payload, so a bad count is
    // reported once, where it is, rather than as a second, derived issue.
    for (const droppedCount of [-1, 1.5, '3']) {
      const refused = telemetryEventPayloadSchema.safeParse({ events: [], droppedCount });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toEqual(['droppedCount']);
    }
  });

  it('reports an empty batch by the rule it broke, never by a received value', () => {
    // The sentinel is a well-formed capture id, so the loss-only rule is the one
    // issue: the rejection must name it without echoing anything it was sent.
    const parsed = parseTelemetryEventPayload({ events: [], armedCaptureId: SENTINEL });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(renderedIssuePaths(parsed.error)).toEqual(['events']);
    expect(parsed.error.message).toContain('events (custom label=empty-batch-reports-loss)');
    for (const surface of renderedSurfaces(parsed.error)) {
      expect(surface).not.toContain(SENTINEL);
    }
  });

  it('carries a loss-only report in a whole telemetry.event frame through parseMessage', () => {
    const payload = { events: [], droppedCount: 3, armedCaptureId: CAPTURE_ID };
    const frame = frameOf('telemetry.event', payload);
    const parsed = parseMessage(frame);

    expect(parsed.ok ? parsed.value : renderedIssuePaths(parsed.error)).toStrictEqual(frame);

    // The rule is the payload schema's, so the envelope enforces it too.
    const refused = parseMessage(frameOf('telemetry.event', { events: [] }));

    expect(isErr(refused)).toBe(true);
    if (!isErr(refused)) {
      return;
    }
    expect(renderedIssuePaths(refused.error)).toEqual(['payload.events']);
  });

  it('keeps its shape and its batch bound readable where consumers read them', () => {
    // The Chrome service worker and the service's ingest loop read the bound off
    // `shape.events` structurally, so the loss-only rule must leave the object's
    // `.shape` and the array's `max_length` check exactly where they were.
    expect(Object.keys(telemetryEventPayloadSchema.shape)).toEqual([
      'events',
      'armedCaptureId',
      'droppedCount',
    ]);
    const maxima = telemetryEventPayloadSchema.shape.events.def.checks?.flatMap((check) =>
      check._zod.def.check === 'max_length' && 'maximum' in check._zod.def
        ? [check._zod.def.maximum]
        : [],
    );

    expect(maxima).toEqual([5000]);

    const atBound = Array.from({ length: 5000 }, () => validIngressEvent());

    expect(telemetryEventPayloadSchema.safeParse({ events: atBound }).success).toBe(true);
    const oversized = telemetryEventPayloadSchema.safeParse({
      events: [...atBound, validIngressEvent()],
      droppedCount: 3,
    });

    expect(oversized.success).toBe(false);
    if (oversized.success) {
      return;
    }
    expect(oversized.error.issues.map((issue) => [issue.code, issue.path.join('.')])).toEqual([
      ['too_big', 'events'],
    ]);
  });

  it('runs the imported event schema element by element', () => {
    const event = validIngressEvent();

    // Field rules the payload never restates: the correlation ids, the epoch
    // scale, the sequence counter and the closed status vocabulary. Each is what
    // the correlator and the store rely on, so each is refused here.
    for (const invalid of [
      { ...event, traceId: 'not-a-trace-id' },
      { ...event, traceId: '0'.repeat(32) },
      { ...event, traceId: TRACE_ID.toUpperCase() },
      { ...event, spanId: `${SPAN_ID}ab` },
      { ...event, startTime: 1_758_000 },
      { ...event, startTime: START_TIME * 1000 },
      { ...event, duration: -1 },
      { ...event, seq: -1 },
      { ...event, seq: 1.5 },
      { ...event, status: 'failed' },
      { ...event, attributes: 'event.type=click' },
      { ...event, id: '' },
    ]) {
      expect(telemetryEventPayloadSchema.safeParse({ events: [invalid] }).success).toBe(false);
    }
  });

  it('runs the imported kind-and-tier agreement, which no payload field states', () => {
    const event = validIngressEvent();

    // The vocabularies are imported so a renamed member fails here rather than
    // silently narrowing what a producer may report.
    expect([...TELEMETRY_TIERS]).toEqual(['browser', 'server', 'db']);
    for (const kind of ['interaction', 'db.query', 'http.server', 'function']) {
      expect([...TELEMETRY_KINDS]).toContain(kind);
    }

    // One accepted pair per tier, and the same kinds on the wrong tier: a
    // database span reported as browser work would place itself in the wrong
    // lane of every timeline built from the capture.
    for (const pair of [
      { kind: 'interaction', tier: 'browser' },
      { kind: 'http.server', tier: 'server' },
      { kind: 'db.query', tier: 'db' },
      { kind: 'function', tier: 'server' },
    ]) {
      expect(
        telemetryEventPayloadSchema.safeParse({ events: [{ ...event, ...pair }] }).success,
      ).toBe(true);
    }

    for (const pair of [
      { kind: 'db.query', tier: 'browser' },
      { kind: 'interaction', tier: 'server' },
      { kind: 'http.server', tier: 'db' },
    ]) {
      const refused = telemetryEventPayloadSchema.safeParse({ events: [{ ...event, ...pair }] });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toContain('events.0.tier');
    }
  });

  it('reports a rejected batch without echoing a captured attribute value', () => {
    // The highest-risk leak surface in this folder after a credential: an
    // element's attributes hold redacted URLs, parameterized SQL and prop
    // summaries (AAP §0.5.2).
    const parsed = parseTelemetryEventPayload({
      events: [
        {
          ...validIngressEvent(),
          attributes: { url: `http://localhost:3000/list?q=${SENTINEL}` },
          spanId: 'nope',
        },
      ],
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('events[0].spanId');
    expect(parsed.error.message).not.toContain(SENTINEL);
    expect(parsed.error.hint ?? '').not.toContain(SENTINEL);
    expect(JSON.stringify(parsed.error.details)).not.toContain(SENTINEL);
  });
});

describe('telemetry.tail — the persisted schema, which is the mirror image', () => {
  it('accepts an attributed, redacted, ingest-stamped batch', () => {
    const payload = VALID_PAYLOADS['telemetry.tail'];

    expect(telemetryTailPayloadSchema.parse(payload)).toEqual(payload);
    // `ingestSeq` is what lets the panel's event log show a stable order and
    // reconcile a streamed event with the same event fetched later through the
    // panel-data route.
    expect(payload.events[0]?.ingestSeq).toBe(1);
  });

  it('requires the three fields the service assigns, one at a time', () => {
    const payload = VALID_PAYLOADS['telemetry.tail'];

    for (const key of ['sessionId', 'captureId', 'ingestSeq']) {
      const refused = telemetryTailPayloadSchema.safeParse({
        ...payload,
        events: [without(validPersistedEvent(), key)],
      });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toContain(`events.0.${key}`);
    }

    // An ingress element is therefore refused outright: a tail frame replays
    // events that have already been ingested, so an unattributed one would
    // produce a log that cannot be reconciled with anything.
    expect(
      telemetryTailPayloadSchema.safeParse({ ...payload, events: [validIngressEvent()] }).success,
    ).toBe(false);
  });

  it('requires its own sessionId, unlike the inbound batch', () => {
    const payload = VALID_PAYLOADS['telemetry.tail'];

    // The service is the sender here and the panel may hold more than one
    // session in view across a rebind, so the frame says which session it is
    // about without the receiver inspecting its elements.
    expect(telemetryTailPayloadSchema.safeParse(without(payload, 'sessionId')).success).toBe(false);
    expect(telemetryTailPayloadSchema.safeParse({ ...payload, events: [] }).success).toBe(false);
    expect(
      telemetryTailPayloadSchema.safeParse({ ...payload, captureId: CAPTURE_ID }).success,
    ).toBe(false);
  });

  it('never accepts an empty frame: the loss-only report is the inbound batch alone', () => {
    const payload = VALID_PAYLOADS['telemetry.tail'];
    const refused = telemetryTailPayloadSchema.safeParse({ ...payload, events: [] });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues.map((issue) => [issue.code, issue.path.join('.')])).toEqual([
      ['too_small', 'events'],
    ]);
    // The tail has no loss field, so a count cannot make an empty frame valid.
    expect(
      telemetryTailPayloadSchema.safeParse({ ...payload, events: [], droppedCount: 3 }).success,
    ).toBe(false);
  });

  it('stamps a one-based ingest sequence, never a zero-based one', () => {
    const payload = VALID_PAYLOADS['telemetry.tail'];

    for (const ingestSeq of [0, -1, 1.5, '1']) {
      expect(
        telemetryTailPayloadSchema.safeParse({
          ...payload,
          events: [{ ...validPersistedEvent(), ingestSeq }],
        }).success,
      ).toBe(false);
    }
    // The producer's own counter is zero-based, and the two are different
    // numbers with different owners.
    expect(
      telemetryTailPayloadSchema.safeParse({
        ...payload,
        events: [{ ...validPersistedEvent(), seq: 0 }],
      }).success,
    ).toBe(true);
  });
});

describe('telemetry.tail — per-capture tallies count the store, not the stream', () => {
  const OTHER_CAPTURE_ID = 'cap_2b8n5r0t4w6y1u3i';

  it('carries each capture’s stored and skipped counts alongside its events', () => {
    const payload = {
      ...VALID_PAYLOADS['telemetry.tail'],
      captures: [{ captureId: CAPTURE_ID, storedEvents: 93_430, skippedEvents: 81_830 }],
    };

    // The panel's one capture counter reads `storedEvents`, which a paced,
    // bounded tail can never reach by counting the events it streamed.
    expect(telemetryTailPayloadSchema.parse(payload)).toEqual(payload);
    // Optional, so a frame from a service that does not count still parses.
    expect(telemetryTailPayloadSchema.safeParse(VALID_PAYLOADS['telemetry.tail']).success).toBe(
      true,
    );
  });

  it('accepts a tally for each capture a boundary-straddling frame spans', () => {
    const events = [
      validPersistedEvent(),
      { ...validPersistedEvent(), id: 'evt_second', captureId: OTHER_CAPTURE_ID },
    ];
    const captures = [
      { captureId: CAPTURE_ID, storedEvents: 12, skippedEvents: 0 },
      { captureId: OTHER_CAPTURE_ID, storedEvents: 1, skippedEvents: 0 },
    ];

    expect(
      telemetryTailPayloadSchema.safeParse({ sessionId: SESSION_ID, events, captures }).success,
    ).toBe(true);
  });

  it('refuses a tally for a capture none of the frame’s events belong to, or one named twice', () => {
    const payload = VALID_PAYLOADS['telemetry.tail'];
    const tally = { captureId: CAPTURE_ID, storedEvents: 4, skippedEvents: 0 };

    for (const captures of [[{ ...tally, captureId: OTHER_CAPTURE_ID }], [tally, tally]]) {
      const refused = telemetryTailPayloadSchema.safeParse({ ...payload, captures });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toEqual(['captures']);
      // A rejection never echoes what it received.
      expect(JSON.stringify(refused.error.issues)).not.toContain(OTHER_CAPTURE_ID);
    }
  });

  it('refuses counts that are not whole, non-negative, safe numbers, and extra keys', () => {
    const payload = VALID_PAYLOADS['telemetry.tail'];
    const tally = { captureId: CAPTURE_ID, storedEvents: 4, skippedEvents: 0 };

    for (const bad of [-1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      for (const key of ['storedEvents', 'skippedEvents']) {
        expect(
          telemetryTailPayloadSchema.safeParse({ ...payload, captures: [{ ...tally, [key]: bad }] })
            .success,
        ).toBe(false);
      }
    }
    expect(
      telemetryTailPayloadSchema.safeParse({
        ...payload,
        captures: [{ ...tally, eventName: 'click' }],
      }).success,
    ).toBe(false);
    expect(telemetryTailPayloadSchema.safeParse({ ...payload, captures: [] }).success).toBe(false);
  });

  it('bounds the tallies one frame may carry', () => {
    const captureIds = Array.from(
      { length: MAX_TAIL_CAPTURE_TALLIES + 1 },
      (_, index) => `cap_bound${String(index).padStart(8, '0')}`,
    );
    const events = captureIds.map((captureId, index) => ({
      ...validPersistedEvent(),
      id: `evt_bound${String(index)}`,
      captureId,
    }));
    const tallies = captureIds.map((captureId) => ({
      captureId,
      storedEvents: 1,
      skippedEvents: 0,
    }));

    expect(
      telemetryTailPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        events,
        captures: tallies.slice(0, MAX_TAIL_CAPTURE_TALLIES),
      }).success,
    ).toBe(true);
    expect(
      telemetryTailPayloadSchema.safeParse({ sessionId: SESSION_ID, events, captures: tallies })
        .success,
    ).toBe(false);
    expect(telemetryTailCaptureTallySchema.shape.captureId).toBeDefined();
  });
});

describe('panel.generated — the specification, and what the catalogue refuses', () => {
  it('carries the session, the panel id and the whole specification', () => {
    const payload = VALID_PAYLOADS['panel.generated'];

    expect(panelGeneratedPayloadSchema.parse(payload)).toEqual(payload);
    for (const key of ['sessionId', 'panelId', 'panel']) {
      expect(panelGeneratedPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
    }
  });

  it('leaves versioning to the specification rather than adding a payload key', () => {
    const payload = VALID_PAYLOADS['panel.generated'];

    // A follow-up stores its answer as the next version rather than replacing
    // the previous one (AAP §0.4.2), and both halves of that live on the spec:
    // its own `panelVersion` counts the generation and `supersedes` names what
    // it replaces. A second copy on the payload would be a value to arbitrate.
    expect(payload.panel.panelVersion).toBe(2);
    expect(payload.panel.supersedes).toBe('pan_1a2b3c4d5e6f7g8h');
    expect(panelGeneratedPayloadSchema.safeParse({ ...payload, panelVersion: 2 }).success).toBe(
      false,
    );
    expect(
      panelGeneratedPayloadSchema.safeParse({ ...payload, supersedes: PANEL_ID }).success,
    ).toBe(false);

    // A first panel has no predecessor, and says so by omitting the key.
    const first = {
      ...payload,
      panel: { ...without(validPanelSpec(), 'supersedes'), panelVersion: 1 },
    };
    expect(panelGeneratedPayloadSchema.safeParse(first).success).toBe(true);
  });

  it('refuses a node type outside the catalogued vocabulary', () => {
    const panel = validPanelSpec();

    expect([...PANEL_NODE_TYPES]).not.toContain('histogram');
    const refused = panelGeneratedPayloadSchema.safeParse({
      sessionId: SESSION_ID,
      panelId: PANEL_ID,
      panel: {
        ...panel,
        layout: [{ type: 'histogram', id: 'layout[0]', query: { source: 'spans' } }],
      },
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    // Inherited rather than restated, and that is the point of embedding the
    // real schema instead of accepting a record: the renderer's component
    // registry is keyed by the same catalogue the validator consumes, so a type
    // with no component cannot reach a surface and leave a blank area.
    expect(issuePaths(refused.error)).toContain('panel.layout.0.type');
  });

  it('runs the specification\u2019s own field rules under the payload path', () => {
    const panel = validPanelSpec();

    for (const invalid of [
      { ...panel, version: 2 },
      { ...panel, panelVersion: 0 },
      { ...panel, title: '   ' },
      without(panel, 'title'),
      { ...panel, layout: [{ type: 'timeline', id: 'layout[0]' }] },
      {
        ...panel,
        layout: [{ type: 'metricCards', id: 'layout[0]', query: { source: 'metrics' } }],
      },
      {
        ...panel,
        layout: [
          {
            type: 'metricCards',
            id: 'layout[0]',
            query: { source: 'metrics' },
            metrics: ['total_latency'],
          },
        ],
      },
      { ...panel, layout: [{ type: 'timeline', id: 'a b', query: { source: 'trace' } }] },
      {
        ...panel,
        summary: {
          observed: [{ statement: 'Something happened.', evidence: [] }],
          likelyCauses: [],
        },
      },
      { ...panel, meta: { fallback: 'yes' } },
      { ...panel, footer: 'anything' },
    ]) {
      expect(
        panelGeneratedPayloadSchema.safeParse({
          sessionId: SESSION_ID,
          panelId: PANEL_ID,
          panel: invalid,
        }).success,
      ).toBe(false);
    }
  });

  it('accepts a fallback panel, because honest degradation is a success', () => {
    // AAP §0.5.5: a panel assembled deterministically from the capture because a
    // generated one could not be validated travels on *this* message and never
    // on the error frame, and the renderer draws it under a visible banner.
    // Mapping such a frame to an error would leave the developer with nothing.
    const fallback = {
      sessionId: SESSION_ID,
      panelId: PANEL_ID,
      panel: { ...validPanelSpec(), meta: { fallback: true } },
    };

    const parsed = parsePanelGeneratedPayload(fallback);
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) {
      return;
    }
    expect(parsed.value.panel.meta?.fallback).toBe(true);

    // And `meta` itself is optional: a panel that came about the ordinary way
    // says nothing about how it came about.
    expect(panelGeneratedPayloadSchema.safeParse(VALID_PAYLOADS['panel.generated']).success).toBe(
      true,
    );
    expect('meta' in validPanelSpec()).toBe(false);
  });

  it('hands its parsed panel to a PanelSpec consumer without a cast', () => {
    const parsed = parsePanelGeneratedPayload(VALID_PAYLOADS['panel.generated']);

    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) {
      return;
    }
    // The compile-time half of the receiving end: a receiver passes the parsed
    // value straight into the renderer's host and the store, so the payload's
    // panel must be assignable to the interface `@debuggen/panel-schema`
    // publishes. The annotation is the assertion.
    const spec: PanelSpec = parsed.value.panel;
    expect(spec.layout).toHaveLength(3);
    expect(spec.summary.observed[0]?.evidence[0]?.eventId).toBe(EVENT_ID);
  });
});

describe('source.open — the one hop that opens a developer\u2019s file', () => {
  it('carries a resolved location with its route and confidence', () => {
    const payload = VALID_PAYLOADS['source.open'];

    expect(sourceOpenPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload.location.resolvedBy).toBe('patch');
    expect(payload.location.confidence).toBe(1);
    for (const key of ['sessionId', 'location']) {
      expect(sourceOpenPayloadSchema.safeParse(without(payload, key)).success).toBe(false);
    }
  });

  it('refuses an absolute file, a traversal and a Windows drive path', () => {
    // The rejected value in the interesting case *is* a path: an absolute one
    // would leak the machine's layout, and a traversal is what a page that
    // reached this hop would try. The service checks containment against the
    // session's project root as well, and the editor's URI handler repeats the
    // check independently — this is the first of the three.
    for (const file of [
      '/home/example/workspace/site/src/lib/thing.ts',
      '../../etc/shadow',
      'src/../../secret.ts',
      'C:\\workspace\\site\\src\\lib\\thing.ts',
      'src\\lib\\thing.ts',
      'src/lib/thing.ts\u0000.bak',
      '',
    ]) {
      const refused = sourceOpenPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        location: { ...validSourceLocation(), file },
      });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toContain('location.file');
    }
  });

  it('refuses a zero line and a zero column, because both are 1-based', () => {
    for (const shape of [{ line: 0 }, { line: -1 }, { line: 1.5 }, { column: 0 }, { column: -1 }]) {
      expect(
        sourceOpenPayloadSchema.safeParse({
          sessionId: SESSION_ID,
          location: { ...validSourceLocation(), ...shape },
        }).success,
      ).toBe(false);
    }
  });

  it('refuses a resolution route and a confidence the shared schema does not define', () => {
    // Five routes produce a location, and a surface badges a low-confidence one
    // differently; a sixth route or an out-of-range confidence would be a value
    // the panel's source chip could not render.
    for (const shape of [
      { resolvedBy: 'guess' },
      { resolvedBy: '' },
      { confidence: -0.1 },
      { confidence: 1.1 },
      { confidence: '1' },
      { endLine: 1 },
    ]) {
      expect(
        sourceOpenPayloadSchema.safeParse({
          sessionId: SESSION_ID,
          location: { ...validSourceLocation(), ...shape },
        }).success,
      ).toBe(false);
    }
    expect(
      sourceOpenPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        location: { ...validSourceLocation(), endLine: 44 },
      }).success,
    ).toBe(true);
  });

  it('reports a refused path by field name and never by value', () => {
    const parsed = parseSourceOpenPayload({
      sessionId: SESSION_ID,
      location: { ...validSourceLocation(), file: `/${SENTINEL}/secret.ts` },
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect([...DEBUGGEN_ERROR_CODES]).toContain(parsed.error.code);
    expect(parsed.error.message).toContain('location.file');
    expect(parsed.error.message).not.toContain(SENTINEL);
    expect(parsed.error.hint ?? '').not.toContain(SENTINEL);
    expect(JSON.stringify(parsed.error.details)).not.toContain(SENTINEL);
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(SENTINEL);
  });
});

/** One valid `source.result` per member of the union, minimal where a field is optional. */
const SOURCE_RESULT_VARIANTS: readonly SourceResultPayload[] = [
  { sessionId: SESSION_ID, ref: SOURCE_OPEN_FRAME_ID, status: 'opened' },
  { sessionId: SESSION_ID, ref: SOURCE_OPEN_FRAME_ID, status: 'no-editor' },
  {
    sessionId: SESSION_ID,
    ref: SOURCE_OPEN_FRAME_ID,
    status: 'failed',
    error: { code: 'SESSION_NOT_FOUND', message: 'The session no longer exists.' },
  },
  VALID_PAYLOADS['source.result'],
];

describe('source.result — the one answer that settles a source.open', () => {
  it('names three outcomes, and the union discriminates on exactly those, in order', () => {
    expect([...SOURCE_RESULT_STATUSES]).toEqual(['opened', 'no-editor', 'failed']);
    expect(sourceResultPayloadSchema.options.map((option) => option.shape.status.value)).toEqual([
      ...SOURCE_RESULT_STATUSES,
    ]);
  });

  it('accepts every member exactly as sent, through the schema and the parse helper', () => {
    for (const payload of SOURCE_RESULT_VARIANTS) {
      const parsed = parseSourceResultPayload(payload);

      expect(sourceResultPayloadSchema.parse(payload)).toStrictEqual(payload);
      expect(isOk(parsed) ? parsed.value : parsed.error.message).toStrictEqual(payload);
    }
  });

  it('refuses an unknown or missing status at the discriminator', () => {
    for (const status of ['done', 'Opened', 'no_editor', 'open', '', 1, null, undefined]) {
      const refused = sourceResultPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        ref: SOURCE_OPEN_FRAME_ID,
        status,
      });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toEqual(['status']);
      expect(refused.error.issues[0]?.code).toBe('invalid_union');
    }
    expect(
      sourceResultPayloadSchema.safeParse({ sessionId: SESSION_ID, ref: SOURCE_OPEN_FRAME_ID })
        .success,
    ).toBe(false);
  });

  it('refuses a stray key, a missing ref and a missing sessionId on every member', () => {
    for (const payload of SOURCE_RESULT_VARIANTS) {
      const withStrayKey = sourceResultPayloadSchema.safeParse({ ...payload, tabId: 7 });

      expect(withStrayKey.success).toBe(false);
      for (const key of ['ref', 'sessionId']) {
        const refused = sourceResultPayloadSchema.safeParse(without(payload, key));

        expect(refused.success).toBe(false);
        if (refused.success) {
          return;
        }
        expect(issuePaths(refused.error)).toEqual([key]);
      }
    }
  });

  it('requires an error exactly when the status is failed', () => {
    const failed = FAILED_SOURCE_RESULT;
    const withoutError = sourceResultPayloadSchema.safeParse(without(failed, 'error'));

    expect(withoutError.success).toBe(false);
    if (!withoutError.success) {
      expect(issuePaths(withoutError.error)).toEqual(['error']);
    }

    // An `opened` or `no-editor` result that also carried an error would be a
    // contradiction only a guess could resolve, so each member refuses it.
    for (const status of ['opened', 'no-editor'] as const) {
      const contradictory = sourceResultPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        ref: SOURCE_OPEN_FRAME_ID,
        status,
        error: failed.error,
      });

      expect(contradictory.success).toBe(false);
      if (!contradictory.success) {
        expect(contradictory.error.issues[0]?.code).toBe('unrecognized_keys');
      }
    }
  });

  it('refuses an error code outside the shared vocabulary, and any key the error does not name', () => {
    const failed = FAILED_SOURCE_RESULT;

    for (const [error, path] of [
      [{ ...failed.error, code: 'NOT_A_CODE' }, 'error.code'],
      [{ ...failed.error, code: 'model_unavailable' }, 'error.code'],
      [without(failed.error, 'code'), 'error.code'],
      [without(failed.error, 'message'), 'error.message'],
      [{ ...failed.error, ref: SOURCE_OPEN_FRAME_ID }, 'error'],
      [{ ...failed.error, details: {} }, 'error'],
      ['The location is outside the project.', 'error'],
    ] as const) {
      const refused = sourceResultPayloadSchema.safeParse({ ...failed, error });

      expect(refused.success).toBe(false);
      if (refused.success) {
        return;
      }
      expect(issuePaths(refused.error)).toEqual([path]);
    }
  });

  it('bounds the ref, the session id, the message and the hint', () => {
    const failed = FAILED_SOURCE_RESULT;
    const accepts = (value: unknown): boolean => sourceResultPayloadSchema.safeParse(value).success;

    expect(accepts({ ...failed, ref: 'r'.repeat(64) })).toBe(true);
    expect(accepts({ ...failed, ref: 'r'.repeat(65) })).toBe(false);
    expect(accepts({ ...failed, ref: '' })).toBe(false);
    expect(accepts({ ...failed, ref: 7 })).toBe(false);
    expect(accepts({ ...failed, sessionId: 's'.repeat(65) })).toBe(false);
    expect(accepts({ ...failed, sessionId: '' })).toBe(false);
    expect(accepts({ ...failed, error: { ...failed.error, message: 'm'.repeat(2000) } })).toBe(
      true,
    );
    expect(accepts({ ...failed, error: { ...failed.error, message: 'm'.repeat(2001) } })).toBe(
      false,
    );
    expect(accepts({ ...failed, error: { ...failed.error, message: '' } })).toBe(false);
    expect(accepts({ ...failed, error: { ...failed.error, hint: 'h'.repeat(2000) } })).toBe(true);
    expect(accepts({ ...failed, error: { ...failed.error, hint: 'h'.repeat(2001) } })).toBe(false);
    expect(accepts({ ...failed, error: { ...failed.error, hint: '' } })).toBe(false);

    const tooLong = parseSourceResultPayload({ ...failed, ref: 'r'.repeat(65) });

    expect(isErr(tooLong) ? tooLong.error.message : '').toContain(
      'ref (too_big origin=string max=64)',
    );
  });

  it('carries DebuggenError.toPayload() unchanged, with or without a hint', () => {
    // The service and the editor report a failure by placing what the class
    // already produces into the result; the compile-time drift assertion in
    // `../messages/source.ts` keeps that true, and this proves it at run time.
    for (const error of [
      new DebuggenError('PATH_OUTSIDE_PROJECT', 'The location is outside the project.', {
        hint: 'Open the project folder in VS Code.',
      }),
      new DebuggenError('SESSION_NOT_FOUND', 'The session no longer exists.'),
    ]) {
      const payload = {
        sessionId: SESSION_ID,
        ref: SOURCE_OPEN_FRAME_ID,
        status: 'failed',
        error: error.toPayload(),
      };
      const parsed = parseSourceResultPayload(payload);

      expect(isOk(parsed) ? parsed.value : parsed.error.message).toStrictEqual(payload);
    }
  });

  it('reports a refusal by field name and never by value', () => {
    const failed = FAILED_SOURCE_RESULT;

    for (const [value, named] of [
      [
        { ...failed, error: { ...failed.error, message: SENTINEL, code: 'NOT_A_CODE' } },
        'error.code (invalid_value',
      ],
      [{ ...failed, ref: `${SENTINEL}-${'x'.repeat(64)}` }, 'ref (too_big'],
      [{ ...failed, status: SENTINEL }, 'status (invalid_union'],
      [
        { ...failed, error: { ...failed.error, hint: SENTINEL.repeat(100) } },
        'error.hint (too_big',
      ],
    ] as const) {
      const parsed = parseSourceResultPayload(value);

      expect(isErr(parsed)).toBe(true);
      if (!isErr(parsed)) {
        return;
      }
      expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(parsed.error.message.startsWith('Invalid source.result payload: ')).toBe(true);
      expect(parsed.error.message).toContain(named);
      expect(parsed.error.cause).toBeUndefined();
      for (const surface of renderedSurfaces(parsed.error)) {
        expect(surface).not.toContain(SENTINEL);
      }
    }
  });

  it('gives the editor a shorter deadline than the sender, and both fit the worker\u2019s port ceiling', () => {
    // The service answers `failed` for a silent editor before the sender stops
    // waiting, so the developer sees the specific reason; and the sender stops
    // before the MV3 worker's twenty-second port-request ceiling would time the
    // panel's request out generically.
    const workerPortRequestCeilingMs = 20_000;

    expect(SOURCE_OPEN_EDITOR_TIMEOUT_MS).toBe(10_000);
    expect(SOURCE_OPEN_RESULT_TIMEOUT_MS).toBe(15_000);
    expect(SOURCE_OPEN_RESULT_TIMEOUT_MS).toBeGreaterThan(SOURCE_OPEN_EDITOR_TIMEOUT_MS);
    expect(SOURCE_OPEN_RESULT_TIMEOUT_MS).toBeLessThan(workerPortRequestCeilingMs);
  });

  it('registers both source messages in the source domain map, which is frozen', () => {
    expect(Object.keys(SOURCE_MESSAGE_PAYLOADS)).toEqual(['source.open', 'source.result']);
    expect(SOURCE_MESSAGE_PAYLOADS['source.result']).toBe(sourceResultPayloadSchema);
    expect(Object.isFrozen(SOURCE_MESSAGE_PAYLOADS)).toBe(true);
  });
});

/**
 * Reads a file back out of an editor-open URI the way its receiver does.
 *
 * VS Code's `Uri.parse` percent-decodes the query once, and the extension's URI
 * handler splits the result with `URLSearchParams`, which decodes each value a
 * second time. Mirrored here with the same two steps — `decodeURIComponent`
 * once, then `URLSearchParams` — so the assertion is about the real receiver's
 * arithmetic rather than about this package's own encoder.
 *
 * @param uri An editor-open URI.
 * @returns The parameters the handler would see.
 */
function receivedParameters(uri: string): URLSearchParams {
  const query = uri.slice(uri.indexOf('?') + 1);

  return new URLSearchParams(decodeURIComponent(query));
}

describe('buildEditorOpenUri — the fallback a no-editor answer opens', () => {
  it('names the URI parts once, for the panel and the URI handler alike', () => {
    expect(EDITOR_OPEN_URI).toEqual({
      scheme: 'vscode',
      authority: 'debuggen.debug-generator',
      path: '/open',
      fileParameter: 'file',
      lineParameter: 'line',
      columnParameter: 'col',
    });
    expect(Object.isFrozen(EDITOR_OPEN_URI)).toBe(true);
  });

  it('builds vscode://debuggen.debug-generator/open?file=…&line=N&col=M', () => {
    const built = buildEditorOpenUri(validSourceLocation());

    expect(isOk(built) ? built.value : built.error.message).toBe(
      'vscode://debuggen.debug-generator/open?file=src%252Flib%252Fthing.ts&line=42&col=3',
    );
    if (!isOk(built)) {
      return;
    }

    const url = new URL(built.value);

    expect([url.protocol, url.host, url.pathname]).toEqual([
      'vscode:',
      'debuggen.debug-generator',
      '/open',
    ]);
  });

  it('carries only the file, the line and the column', () => {
    const built = buildEditorOpenUri({
      ...validSourceLocation(),
      symbol: SENTINEL,
      endLine: 57,
      resolvedBy: 'code-graph',
      confidence: 0.85,
    });

    expect(isOk(built)).toBe(true);
    if (!isOk(built)) {
      return;
    }
    expect(built.value).not.toContain(SENTINEL);
    expect([...receivedParameters(built.value)]).toEqual([
      ['file', SOURCE_FILE],
      ['line', '42'],
      ['col', '3'],
    ]);
  });

  it.each([
    ['a plus sign', 'src/lib/a+b.ts'],
    ['an ampersand and an equals sign', 'src/lib/a&line=1&b=c.ts'],
    ['a space', 'src/lib/with space.ts'],
    ['a percent sign', 'src/lib/100%.ts'],
    ['what looks like an escape', 'src/lib/%2F%41%zz.ts'],
    ['a hash', 'src/lib/#fragment.ts'],
    ['all of them at once', 'src/a+b &c=d %25 #e/f g.ts'],
    ['non-ASCII text', 'src/lib/\u00fcber-\u6587\u4ef6.ts'],
    ['a surrogate pair', 'src/lib/emoji-\u{1f600}.ts'],
  ])('round-trips a file name with %s through both receiving decodes', (_label, file) => {
    const built = buildEditorOpenUri({ ...validSourceLocation(), file, line: 7, column: 12 });

    expect(isOk(built) ? 'ok' : built.error.message).toBe('ok');
    if (!isOk(built)) {
      return;
    }

    // Nothing in the URI can be read as a separator by either decode: no
    // fragment marker, no space and no `+` survive encoding, and the only `&`
    // and `=` left are the two separators and three assignments of the query.
    expect(built.value).not.toMatch(/[#+ ]/);
    expect(built.value.split('&')).toHaveLength(3);

    const received = receivedParameters(built.value);

    expect(received.get('file')).toBe(file);
    expect(received.get('line')).toBe('7');
    expect(received.get('col')).toBe('12');
    expect([...received.keys()]).toEqual(['file', 'line', 'col']);
  });

  it('encodes twice because a single encoding does not survive the receiver', () => {
    // The control case: what the receiver would make of a once-encoded `+`.
    // This is the defect the second encoding exists to prevent.
    const once = `file=${encodeURIComponent('src/lib/a+b.ts')}`;

    expect(new URLSearchParams(decodeURIComponent(once)).get('file')).toBe('src/lib/a b.ts');
  });

  it.each([
    ['an absolute path', { file: `/home/example/${SENTINEL}/secret.ts` }, 'file'],
    ['a traversal', { file: `../../${SENTINEL}/secret.ts` }, 'file'],
    ['an inner traversal', { file: `src/../../${SENTINEL}.ts` }, 'file'],
    ['a Windows drive path', { file: `C:\\${SENTINEL}\\secret.ts` }, 'file'],
    ['a control character', { file: `src/${SENTINEL}\u0000.ts` }, 'file'],
    [
      'a lone high surrogate',
      { file: `src/${SENTINEL}\ud800.ts` },
      'file (custom label=well-formed-text)',
    ],
    [
      'a lone low surrogate',
      { file: `src/\udc00${SENTINEL}.ts` },
      'file (custom label=well-formed-text)',
    ],
    ['a zero line', { symbol: SENTINEL, line: 0 }, 'line (too_small'],
    ['a zero column', { symbol: SENTINEL, column: 0 }, 'column (too_small'],
    ['a fractional line', { symbol: SENTINEL, line: 1.5 }, 'line'],
    ['an inverted range', { symbol: SENTINEL, endLine: 1 }, 'endLine'],
    ['an unknown resolution route', { symbol: SENTINEL, resolvedBy: 'guess' }, 'resolvedBy'],
  ])('refuses %s without echoing it or throwing', (_label, shape, named) => {
    // Cast because each case is deliberately not a valid location; a caller
    // holding data that crossed two process boundaries can pass one, too. A
    // throw — `encodeURIComponent`'s `URIError` on a lone surrogate, say —
    // would fail this case before any assertion runs.
    const location = { ...validSourceLocation(), ...shape } as unknown as SourceLocation;
    const built = buildEditorOpenUri(location);

    expect(isErr(built)).toBe(true);
    if (!isErr(built)) {
      return;
    }

    const { error } = built;

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.message.startsWith('Invalid source location for the editor-open URI: ')).toBe(
      true,
    );
    expect(error.message).toContain(named);
    expect(error.cause).toBeUndefined();
    for (const surface of renderedSurfaces(error)) {
      expect(surface).not.toContain(SENTINEL);
    }
  });

  it('refuses a value that is not a location at all, without throwing', () => {
    for (const value of [
      null,
      undefined,
      SENTINEL,
      [],
      {},
      { ...validSourceLocation(), file: 42 },
      { ...validSourceLocation(), line: '42' },
      without(validSourceLocation(), 'file'),
    ]) {
      const built = buildEditorOpenUri(value as unknown as SourceLocation);

      expect(isErr(built)).toBe(true);
      if (!isErr(built)) {
        return;
      }
      expect(built.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      for (const surface of renderedSurfaces(built.error)) {
        expect(surface).not.toContain(SENTINEL);
      }
    }
  });
});

describe('target.request and target.selected — the element the developer pointed at', () => {
  it('target.request is a session id and nothing more', () => {
    const payload = VALID_PAYLOADS['target.request'];

    expect(targetRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(Object.keys(targetRequestPayloadSchema.shape)).toEqual(['sessionId']);
    expect(targetRequestPayloadSchema.safeParse({}).success).toBe(false);
    // A producer that believes it can attach a mode, a timeout or a highlight
    // option to this message has misread the contract.
    expect(targetRequestPayloadSchema.safeParse({ ...payload, mode: 'picker' }).success).toBe(
      false,
    );
  });

  it('target.selected accepts the five-field descriptor with a redacted URL', () => {
    const payload = VALID_PAYLOADS['target.selected'];

    expect(targetSelectedPayloadSchema.parse(payload)).toEqual(payload);
    // The URL arrives query-redacted: each parameter's value is replaced before
    // it leaves the page, and the key and path are kept (AAP §0.5.2).
    expect(payload.target.url).toContain('?filter=%3F');

    // `text` is the one optional member: an element with no text is still a
    // target.
    const withoutText = { ...payload, target: without(validSelectedTarget(), 'text') };
    expect(targetSelectedPayloadSchema.parse(withoutText)).toEqual(withoutText);
    // An unsolicited frame is legitimate — a developer selecting an element in
    // the Elements panel produces one — so nothing here carries a sequence
    // number or an acknowledgement.
    expect(Object.keys(targetSelectedPayloadSchema.shape)).toEqual(['sessionId', 'target']);
  });

  it('refuses a sixth key inside the descriptor', () => {
    // The imported descriptor's own strictness, which is what turns a page that
    // interfered with the value — or two halves of the contract that have
    // drifted apart — into a rejected frame instead of a half-trusted store row.
    const refused = targetSelectedPayloadSchema.safeParse({
      sessionId: SESSION_ID,
      target: { ...validSelectedTarget(), xpath: '/html/body/main/button' },
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    expect(refused.error.issues[0]?.code).toBe('unrecognized_keys');
    expect(issuePaths(refused.error)).toContain('target');
  });

  it('runs the descriptor\u2019s field rules and requires an absolute URL', () => {
    const target = validSelectedTarget();

    for (const invalid of [
      { ...target, url: '/list' },
      { ...target, url: 'localhost:3000/list' },
      { ...target, url: ' http://localhost:3000/list' },
      { ...target, selector: '' },
      { ...target, selector: 'main >\nbutton' },
      { ...target, tagName: '' },
      { ...target, componentChain: ['PrimaryAction', ''] },
      { ...target, componentChain: 'PrimaryAction' },
      without(target, 'url'),
      without(target, 'componentChain'),
    ]) {
      expect(
        targetSelectedPayloadSchema.safeParse({ sessionId: SESSION_ID, target: invalid }).success,
      ).toBe(false);
    }
    // A component chain may legitimately be empty: a host element the fiber
    // walk could not attribute to a component is still selectable.
    expect(
      targetSelectedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        target: { ...target, componentChain: [] },
      }).success,
    ).toBe(true);
  });

  it('reports a refused descriptor without echoing the selector or the text', () => {
    const parsed = parseTargetSelectedPayload({
      sessionId: SESSION_ID,
      target: { ...validSelectedTarget(), text: SENTINEL, url: '/list' },
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.message).toContain('target.url');
    expect(parsed.error.message).not.toContain(SENTINEL);
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(SENTINEL);
  });
});

describe('the target.selected verdict — sameSelectedTarget and compareSelectionDocument', () => {
  /** The descriptor with its optional `text` omitted, as the producer sends it. */
  function textlessTarget(): SelectedTarget {
    const { selector, tagName, componentChain, url } = validSelectedTarget();
    return { selector, tagName, componentChain, url };
  }

  it('sameSelectedTarget confirms a copy of the sent descriptor, including one read back from JSON', () => {
    const sent = validSelectedTarget();

    expect(sameSelectedTarget(sent, sent)).toBe(true);
    expect(sameSelectedTarget(sent, validSelectedTarget())).toBe(true);
    // What the service stores and replays on `session.updated` has been
    // through a JSON round trip; the comparison must survive it.
    expect(sameSelectedTarget(sent, JSON.parse(JSON.stringify(sent)) as SelectedTarget)).toBe(true);
    // Validated by the payload schema first, as the service does before it
    // records anything: the schema transforms nothing, so the value still
    // compares equal.
    const recorded = targetSelectedPayloadSchema.parse({ sessionId: SESSION_ID, target: sent });
    expect(sameSelectedTarget(recorded.target, sent)).toBe(true);
  });

  it('sameSelectedTarget refuses a descriptor that differs in any one field', () => {
    const sent = validSelectedTarget();
    const variants: readonly SelectedTarget[] = [
      { ...sent, selector: 'main > button.secondary' },
      { ...sent, tagName: 'A' },
      { ...sent, text: 'Continue later' },
      { ...sent, url: 'http://localhost:3000/cart?filter=%3F' },
      { ...sent, componentChain: ['PrimaryAction', 'ActionPanel'] },
    ];

    for (const variant of variants) {
      expect(sameSelectedTarget(sent, variant)).toBe(false);
      expect(sameSelectedTarget(variant, sent)).toBe(false);
    }
  });

  it('sameSelectedTarget reads the component chain element-wise and in order', () => {
    const sent = validSelectedTarget();

    // Nearest-first is the contract, so the same names reversed are a
    // different position in the tree.
    expect(
      sameSelectedTarget(sent, { ...sent, componentChain: ['ActionRow', 'PrimaryAction'] }),
    ).toBe(false);
    expect(sameSelectedTarget(sent, { ...sent, componentChain: ['PrimaryAction'] })).toBe(false);
    expect(
      sameSelectedTarget(sent, { ...sent, componentChain: ['PrimaryAction', 'ActionRow', 'Page'] }),
    ).toBe(false);
    expect(
      sameSelectedTarget({ ...sent, componentChain: [] }, { ...sent, componentChain: [] }),
    ).toBe(true);
  });

  it('sameSelectedTarget treats text absent on both sides as equal, and absent against present as not', () => {
    expect(sameSelectedTarget(textlessTarget(), textlessTarget())).toBe(true);
    expect(sameSelectedTarget(textlessTarget(), validSelectedTarget())).toBe(false);
    expect(sameSelectedTarget(validSelectedTarget(), textlessTarget())).toBe(false);
  });

  it('sameSelectedTarget compares tagName ASCII case-insensitively and every other field exactly', () => {
    const sent = validSelectedTarget();

    // The producer's case depends on the document type, not on the element.
    expect(sameSelectedTarget(sent, { ...sent, tagName: 'button' })).toBe(true);
    expect(sameSelectedTarget(sent, { ...sent, tagName: 'Button' })).toBe(true);
    // Only ASCII letters fold: a non-ASCII letter is compared as written.
    expect(sameSelectedTarget({ ...sent, tagName: 'x-İtem' }, { ...sent, tagName: 'x-i̇tem' })).toBe(
      false,
    );
    expect(sameSelectedTarget(sent, { ...sent, selector: 'MAIN > BUTTON.PRIMARY' })).toBe(false);
    expect(sameSelectedTarget(sent, { ...sent, text: 'CONTINUE' })).toBe(false);
  });

  it('sameSelectedTarget answers false whenever either side is undefined, both included', () => {
    expect(sameSelectedTarget(undefined, validSelectedTarget())).toBe(false);
    expect(sameSelectedTarget(validSelectedTarget(), undefined)).toBe(false);
    // A session with no target confirms nothing, and nothing pending has
    // nothing to be confirmed.
    expect(sameSelectedTarget(undefined, undefined)).toBe(false);
  });

  it('SELECTION_DOCUMENT_VERDICTS is the closed, frozen four-verdict vocabulary', () => {
    expect([...SELECTION_DOCUMENT_VERDICTS]).toEqual([
      'same-document',
      'other-origin',
      'other-document',
      'unreadable',
    ]);
    expect(Object.isFrozen(SELECTION_DOCUMENT_VERDICTS)).toBe(true);
  });

  it('compareSelectionDocument ignores the query string and the fragment', () => {
    // The binding URL is stored query-redacted while a descriptor's URL may
    // not be, and a fragment never changes the document.
    expect(compareSelectionDocument('http://localhost:3000/list?filter=shoes', PAGE_URL)).toBe(
      'same-document',
    );
    expect(compareSelectionDocument(PAGE_URL, 'http://localhost:3000/list')).toBe('same-document');
    expect(
      compareSelectionDocument('http://localhost:3000/list#reviews', 'http://localhost:3000/list?'),
    ).toBe('same-document');
    expect(compareSelectionDocument(validSelectedTarget().url, PAGE_URL)).toBe('same-document');
  });

  it('compareSelectionDocument normalises what the URL parser normalises', () => {
    expect(
      compareSelectionDocument('http://LOCALHOST:3000/list', 'http://localhost:3000/list'),
    ).toBe('same-document');
    expect(compareSelectionDocument('http://localhost:80/', 'http://localhost')).toBe(
      'same-document',
    );
    // User information is not part of the origin.
    expect(
      compareSelectionDocument(
        ['http://', 'u', ':', 'p', '@localhost:3000/list'].join(''),
        'http://localhost:3000/list',
      ),
    ).toBe('same-document');
  });

  it('compareSelectionDocument answers other-document for another path on the same origin', () => {
    expect(
      compareSelectionDocument('http://localhost:3000/list', 'http://localhost:3000/cart'),
    ).toBe('other-document');
    expect(
      compareSelectionDocument('http://localhost:3000/list', 'http://localhost:3000/list/'),
    ).toBe('other-document');
    expect(compareSelectionDocument(PAGE_URL, 'http://localhost:3000/')).toBe('other-document');
  });

  it('compareSelectionDocument answers other-origin for another scheme, host or port, never matching a prefix', () => {
    expect(
      compareSelectionDocument('http://localhost:3000/list', 'http://localhost:30001/list'),
    ).toBe('other-origin');
    expect(
      compareSelectionDocument('http://localhost:30001/list', 'http://localhost:3000/list'),
    ).toBe('other-origin');
    expect(
      compareSelectionDocument('http://localhost/list', 'http://localhost.evil.test/list'),
    ).toBe('other-origin');
    expect(
      compareSelectionDocument('http://localhost.evil.test/list', 'http://localhost/list'),
    ).toBe('other-origin');
    expect(
      compareSelectionDocument('https://localhost:3000/list', 'http://localhost:3000/list'),
    ).toBe('other-origin');
    expect(
      compareSelectionDocument('http://127.0.0.1:3000/list', 'http://localhost:3000/list'),
    ).toBe('other-origin');
  });

  it('compareSelectionDocument gives a URL without a web origin no document to share', () => {
    // The tab may show `about:blank`, a `chrome://` page or a file; none is a
    // document a selection can belong to, even compared with itself.
    for (const url of ['about:blank', 'chrome://newtab/', 'file:///tmp/list.html', 'data:,x']) {
      expect(compareSelectionDocument('http://localhost:3000/list', url)).toBe('other-origin');
      expect(compareSelectionDocument(url, url)).toBe('other-origin');
    }
  });

  it('compareSelectionDocument answers unreadable, and never throws, for a value that is not a URL', () => {
    for (const garbage of ['', 'not a url', '/list', 'localhost', 'http://', 'http://[::1']) {
      expect(compareSelectionDocument(garbage, 'http://localhost:3000/list')).toBe('unreadable');
      expect(compareSelectionDocument('http://localhost:3000/list', garbage)).toBe('unreadable');
    }
    expect(compareSelectionDocument('', '')).toBe('unreadable');
  });
});

describe('cleanup.completed — the verdict, and what was left alone', () => {
  it('accepts each of the four cleanup statuses', () => {
    expect([...CLEANUP_STATUSES]).toEqual(['pending', 'clean', 'partial', 'conflict']);

    for (const status of CLEANUP_STATUSES) {
      const payload = { sessionId: SESSION_ID, status, conflicts: [] };
      expect(cleanupCompletedPayloadSchema.parse(payload)).toEqual(payload);
    }
    for (const status of ['clean-ish', 'restored', '', 7]) {
      expect(
        cleanupCompletedPayloadSchema.safeParse({ sessionId: SESSION_ID, status, conflicts: [] })
          .success,
      ).toBe(false);
    }
  });

  it('requires the conflicts array, empty rather than absent', () => {
    const payload = VALID_PAYLOADS['cleanup.completed'];

    expect(cleanupCompletedPayloadSchema.parse(payload)).toEqual(payload);
    // An optional field would force every surface to distinguish "the pass
    // reported no conflicts" from "the pass said nothing about conflicts" — a
    // distinction with no meaning, written correctly in two surfaces and
    // forgotten in the third.
    expect(cleanupCompletedPayloadSchema.safeParse(without(payload, 'conflicts')).success).toBe(
      false,
    );
    expect(cleanupCompletedPayloadSchema.safeParse({ ...payload, conflicts: null }).success).toBe(
      false,
    );
    expect(cleanupCompletedPayloadSchema.safeParse(without(payload, 'status')).success).toBe(false);
    expect(
      cleanupCompletedPayloadSchema.safeParse({ ...payload, completedAt: START_TIME }).success,
    ).toBe(false);
  });

  it('embeds the conflict schema, digests, reasons and diffs included', () => {
    const payload = VALID_PAYLOADS['cleanup.completed'];
    const conflict = validModificationConflict();

    // A pass that restored some files and hit one edited file reports that
    // mixture, so a non-empty array does not imply the conflict status.
    expect(cleanupCompletedPayloadSchema.safeParse({ ...payload, status: 'partial' }).success).toBe(
      true,
    );

    for (const invalid of [
      { ...conflict, expectedHash: hashFixture('2b').toUpperCase() },
      { ...conflict, actualHash: 'not-a-digest' },
      { ...conflict, reason: 'edited' },
      { ...conflict, file: '/home/example/workspace/site/src/lib/thing.ts' },
      { ...conflict, file: '../../etc/shadow' },
      { ...conflict, message: '' },
      { ...conflict, detectedAt: 0 },
      without(conflict, 'backupPath'),
      without(conflict, 'recordId'),
      { ...conflict, threeWay: true },
      { ...conflict, diffs: { unknownPair: '--- a\n' } },
    ]) {
      expect(
        cleanupCompletedPayloadSchema.safeParse({ ...payload, conflicts: [invalid] }).success,
      ).toBe(false);
    }

    // `actualHash` and `diffs` are the two optional members: a file that is
    // missing has no current hash to report.
    expect(
      cleanupCompletedPayloadSchema.safeParse({
        ...payload,
        conflicts: [{ ...without(conflict, 'actualHash', 'diffs'), reason: 'file-missing' }],
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two registries, and the properties every payload shares
//
// Everything below is driven from `MESSAGE_PAYLOAD_SCHEMAS` and `MESSAGE_TYPES`
// rather than from a list written here, which is the only way these cases stay
// true of a protocol that grows: a twenty-ninth message added to the registry
// without a fixture in `VALID_PAYLOADS` is a compile error, and one added with a
// fixture is carried into the round-trip and no-transform cases without an edit —
// and into the frame-level `parseMessage` cases that close the file, which also
// need it an entry in `MISMATCHED_PAYLOADS`, again enforced by the compiler.
//
// `../messages/index.ts` proves four properties of the registries at compile
// time — the WebSocket registry covers exactly the twenty-eight types, the
// `MESSAGE_TYPE` constants are exactly those types, the HTTP-only names overlap
// them nowhere, and the HTTP-only tuple and map name the same five operations.
// A type-level assertion is blind to a repeated tuple element, to two constants
// naming one message and to key order, so the runtime halves are here.
// ---------------------------------------------------------------------------

describe('MESSAGE_TYPES and MESSAGE_PAYLOAD_SCHEMAS — one registry, no gaps', () => {
  it('lists the twenty-five cross-component WebSocket message names, source.result and the liveness pair, in order and without duplicates', () => {
    expect([...MESSAGE_TYPES]).toEqual([
      'client.hello',
      'client.ping',
      'service.pong',
      'agent.ready',
      'agent.config',
      'server-agent.config',
      'session.bind',
      'session.bound',
      'tab.navigated',
      'session.unbind',
      'session.created',
      'session.updated',
      'session.progress',
      'analysis.completed',
      'capture.started',
      'capture.stopped',
      'instrumentation.plan',
      'instrumentation.ready',
      'instrumentation.failed',
      'telemetry.event',
      'telemetry.tail',
      'panel.generated',
      'source.open',
      'source.result',
      'target.request',
      'target.selected',
      'cleanup.completed',
      'error',
    ]);
    // The count and the distinctness are separate claims: a duplicated entry
    // leaves the derived union unchanged, so the compile-time registry check
    // cannot see it, and the mistake would surface one file onward as a Zod
    // discriminated union with two members claiming the same discriminant.
    expect(MESSAGE_TYPES).toHaveLength(28);
    expect(new Set(MESSAGE_TYPES).size).toBe(28);
  });

  it('holds a schema for every type and for no other name', () => {
    expect(Object.keys(MESSAGE_PAYLOAD_SCHEMAS).sort()).toEqual([...MESSAGE_TYPES].sort());
    expect(Object.keys(MESSAGE_PAYLOAD_SCHEMAS)).toHaveLength(28);
  });

  it('binds each type to the schema its own module exports, by identity', () => {
    for (const type of MESSAGE_TYPES) {
      // `toBe`, not a structural comparison: two payloads in this folder are
      // deliberately identical in shape and four more overlap heavily, so a
      // mis-keyed entry would pass every structural check and still route a
      // frame to the wrong validator.
      expect(MESSAGE_PAYLOAD_SCHEMAS[type]).toBe(REGISTERED_SCHEMAS[type]);
    }
  });

  it('is frozen, so no consumer can add a message at runtime', () => {
    expect(Object.isFrozen(MESSAGE_PAYLOAD_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(HTTP_ONLY_PAYLOAD_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(MESSAGE_TYPE)).toBe(true);
  });

  it('names every type once under MESSAGE_TYPE, in tuple order, keyed by its upper-snake spelling', () => {
    // The tuple is built from the constants, so equal order is the claim that
    // no constant was left out of it or listed twice.
    expect(Object.values(MESSAGE_TYPE)).toEqual([...MESSAGE_TYPES]);
    // The key is derivable from the wire name — `.` and `-` become `_` — which
    // is what lets a reader go from a frame in a log to the constant, and what
    // rules out two keys naming one message (a second key could not also equal
    // the one spelling its value derives).
    for (const [key, type] of Object.entries(MESSAGE_TYPE)) {
      expect(key, type).toBe(type.replace(/[.-]/g, '_').toUpperCase());
    }
    expect(Object.keys(MESSAGE_TYPE)).toHaveLength(28);
    // None of the five HTTP operations has a WebSocket constant.
    const constants: ReadonlySet<string> = new Set(Object.values(MESSAGE_TYPE));
    expect(HTTP_ONLY_PAYLOAD_NAMES.filter((name) => constants.has(name))).toEqual([]);
  });

  it('accepts its fixture for every registered type', () => {
    for (const type of MESSAGE_TYPES) {
      const schema: z.ZodType = MESSAGE_PAYLOAD_SCHEMAS[type];
      const payload: unknown = VALID_PAYLOADS[type];
      const parsed = schema.safeParse(payload);

      // Reported with the type name so a failure names the frame rather than a
      // line number in a loop.
      expect(parsed.success ? type : { type, issues: issuePaths(parsed.error) }).toEqual(type);
    }
  });

  it('survives a JSON round trip for every registered type', () => {
    for (const type of MESSAGE_TYPES) {
      const schema: z.ZodType = MESSAGE_PAYLOAD_SCHEMAS[type];
      const payload: unknown = VALID_PAYLOADS[type];

      // Every frame crosses a WebSocket as JSON, and several are also persisted
      // as a SQLite text column and replayed later, so what a consumer parses
      // must be what the producer built — `undefined` does not survive the trip,
      // and a payload that relied on an absent key meaning something would fail
      // in production rather than here.
      const parsed: unknown = schema.parse(payload);
      const roundTripped: unknown = JSON.parse(JSON.stringify(parsed));

      expect(roundTripped).toEqual(parsed);
      expect(schema.parse(roundTripped)).toEqual(parsed);
    }
  });

  it('validates without rewriting: nothing added, dropped or mutated', () => {
    for (const type of MESSAGE_TYPES) {
      const schema: z.ZodType = MESSAGE_PAYLOAD_SCHEMAS[type];
      const payload = VALID_PAYLOADS[type];
      // A structural copy taken before parsing, so a schema that mutated its
      // input in place would be caught as well as one that transformed its
      // output.
      const before: unknown = structuredClone(payload);
      const parsed: unknown = schema.parse(payload);

      // No `.transform()`, no `.coerce`, no `.default()`, no `.catch()` anywhere
      // on the path a frame takes: a tab id of `'7'` is a producer bug rather
      // than a `7` this layer invented, and an omitted optional stays omitted
      // rather than becoming a plausible-looking value.
      expect(parsed).toEqual(before);
      expect(payload).toEqual(before);
      expect(Object.keys(parsed as object).sort()).toEqual(Object.keys(payload as object).sort());
    }
  });

  it('keeps every payload an object, never a bare value', () => {
    for (const type of MESSAGE_TYPES) {
      const schema: z.ZodType = MESSAGE_PAYLOAD_SCHEMAS[type];

      // The envelope carries `payload` as an object for every frame, so a
      // primitive, an array or an absent payload is a rejection at each of the
      // twenty-eight schemas rather than at the envelope alone.
      for (const value of [undefined, null, 7, 'x', [], true]) {
        expect(schema.safeParse(value).success).toBe(false);
      }
    }
  });
});

describe('every embedded artifact is the imported schema object itself', () => {
  it('holds the upstream schemas by reference, so a restatement cannot pass', () => {
    // The behavioural suites above prove the *consequence* of embedding — the
    // authoring plan is refused, an ingress event may not name a session, a
    // digest must be 64 lowercase hexadecimal characters. This asserts the
    // cause directly: each payload field is the very schema object the owning
    // package exported, compared by reference. A payload module that copied an
    // upstream shape would still satisfy every `toEqual` in this file on the
    // day it was written and would drift silently on the day upstream changed;
    // it cannot satisfy `toBe`.
    //
    // Reference equality is also what makes the single-definition rule of AAP
    // §0.2.3 checkable rather than aspirational: source location in `shared`,
    // events in `telemetry`, plans and modification records in
    // `instrumentation`, specifications in `panel-schema`, and the session and
    // analysis artifacts here in `protocol`.
    expect(instrumentationPlanPayloadSchema.shape.plan).toBe(instrumentationPlanSchema);
    expect(instrumentationReadyPayloadSchema.shape.applied.element).toBe(modificationRecordSchema);
    expect(cleanupCompletedPayloadSchema.shape.conflicts.element).toBe(modificationConflictSchema);
    expect(agentConfigPayloadSchema.shape.hooks).toBe(agentHookConfigSchema);
    expect(serverAgentConfigPayloadSchema.shape.signals).toBe(serverAgentSignalsSchema);
    expect(targetSelectedPayloadSchema.shape.target).toBe(selectedTargetSchema);
    expect(telemetryEventPayloadSchema.shape.events.element).toBe(telemetryEventIngressSchema);
    expect(telemetryTailPayloadSchema.shape.events.element).toBe(telemetryEventSchema);
    expect(panelGeneratedPayloadSchema.shape.panel).toBe(panelSpecSchema);
    expect(sourceOpenPayloadSchema.shape.location).toBe(sourceLocationSchema);
    expect(sessionCreatedPayloadSchema.shape.session).toBe(sessionRecordSchema);
    expect(sessionUpdatedPayloadSchema.shape.session).toBe(sessionRecordSchema);
    expect(analysisCompletedPayloadSchema.shape.analysis).toBe(analysisResultSchema);
  });

  it('carries the ingress and persisted event schemas on the two different frames', () => {
    // The two telemetry frames are the one place where holding the *wrong*
    // imported schema would be invisible to a shape test — ingress and
    // persisted share every field but three. Asserting that the two frames
    // reference two different objects rules out the copy-paste that would make
    // both strict-ingress or both persisted.
    expect(telemetryEventPayloadSchema.shape.events.element).not.toBe(
      telemetryTailPayloadSchema.shape.events.element,
    );
  });
});

describe('HTTP_ONLY_PAYLOAD_NAMES — five operations that are not message types', () => {
  it('names the five HTTP operations, in the order the map spreads them', () => {
    expect([...HTTP_ONLY_PAYLOAD_NAMES]).toEqual([
      'session.create',
      'session.question',
      'session.end',
      'capture.start',
      'capture.stop',
    ]);
    expect(Object.keys(HTTP_ONLY_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...HTTP_ONLY_PAYLOAD_NAMES].sort(),
    );
  });

  it('is disjoint from MESSAGE_TYPES in both directions', () => {
    const messageTypes: readonly string[] = MESSAGE_TYPES;
    const httpOnly: readonly string[] = HTTP_ONLY_PAYLOAD_NAMES;

    // An HTTP request body that reached the message registry would become a
    // member of the envelope's union, so a socket client could send
    // `session.end` or `capture.start` as a *frame* — validated, routed and then
    // handled by nothing, because those operations are routes with responses a
    // frame has no way to deliver (AAP §0.4.2). The reverse leak is as bad: a
    // message type in the HTTP-only map would appear in the route table as an
    // operation with no route.
    for (const name of httpOnly) {
      expect(messageTypes).not.toContain(name);
      expect(Object.keys(MESSAGE_PAYLOAD_SCHEMAS)).not.toContain(name);
    }
    for (const type of messageTypes) {
      expect(httpOnly).not.toContain(type);
    }
  });

  it('leaves telemetry.event a message type, which is not a collision', () => {
    // One name legitimately belongs to both worlds: `telemetry.event` is the
    // batch the page agent's relay sends inward *and* the operation id of
    // `POST /telemetry/ingest`, whose body `../http.ts` declares itself. The
    // same payload serves both and the difference is only which transport
    // carries it, so it stays here and must never be added to the HTTP-only map.
    // The operation-id table is asserted in `./http.test.ts`.
    expect([...MESSAGE_TYPES]).toContain('telemetry.event');
    expect([...HTTP_ONLY_PAYLOAD_NAMES]).not.toContain('telemetry.event');
  });

  it('carries a request schema for each operation, and a response only where it owns one', () => {
    // The entry shapes differ deliberately: `./capture.ts` owns both halves of
    // its two operations, while the three session operations answer with shapes
    // this folder does not own — a `SessionRecord` for two of them and
    // `{ cleanup }` assembled in `../http.ts` for the third — so their responses
    // are absent rather than restated (AAP §0.9.1).
    for (const name of HTTP_ONLY_PAYLOAD_NAMES) {
      const entry = HTTP_ONLY_PAYLOAD_SCHEMAS[name];
      expect(Object.keys(entry)).toContain('request');
    }
    expect(Object.keys(HTTP_ONLY_PAYLOAD_SCHEMAS['session.create'])).toEqual(['request']);
    expect(Object.keys(HTTP_ONLY_PAYLOAD_SCHEMAS['capture.start']).sort()).toEqual([
      'request',
      'response',
    ]);
  });
});

describe('a rejected payload never echoes what it refused', () => {
  it('keeps a credential out of a rejected handshake', () => {
    // The sharpest case in the folder: `client.hello` is the one frame that
    // carries a bearer credential, so a rejection that interpolated the value
    // would put it in an error message, a log line and — since
    // `toPayload()` crosses the wire — another process's telemetry.
    const parsed = parseClientHelloPayload({
      client: 'vscode',
      version: 'not-a-version',
      token: SENTINEL,
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect([...DEBUGGEN_ERROR_CODES]).toContain(parsed.error.code);
    expect(parsed.error.message).toContain('version');
    for (const rendered of [
      parsed.error.message,
      parsed.error.hint ?? '',
      JSON.stringify(parsed.error.details),
      JSON.stringify(parsed.error.toPayload()),
      JSON.stringify(DebuggenError.from(parsed.error).toPayload()),
    ]) {
      expect(rendered).not.toContain(SENTINEL);
    }
  });

  it('keeps a credential out of a rejection that is about the credential itself', () => {
    // The field that failed *is* the token here, so the rejection has to name it
    // while saying nothing about what arrived.
    const parsed = parseClientHelloPayload({
      client: 'vscode',
      version: PROTOCOL_VERSION,
      token: `${SENTINEL}-${'x'.repeat(512)}`,
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.message).toContain('token');
    expect(parsed.error.message).not.toContain(SENTINEL);
    expect(JSON.stringify(parsed.error.details)).not.toContain(SENTINEL);
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(SENTINEL);
  });

  it('keeps the developer\u2019s data out of every other rejection path', () => {
    // The same rule across the payloads whose fields hold project paths, the
    // developer's question, captured attributes, redacted URLs and an element's
    // text. Each case is refused for a *different* reason than the sentinel
    // field, so the sentinel had every opportunity to be rendered.
    const cases: readonly { readonly named: string; readonly parsed: unknown }[] = [
      {
        named: 'hooks',
        parsed: parseAgentConfigPayload({
          sessionId: SENTINEL,
          captureId: CAPTURE_ID,
          hooks: without(validAgentHookConfig(), 'react'),
        }),
      },
      {
        named: 'plan.planVersion',
        parsed: parseInstrumentationPlanPayload({
          sessionId: SESSION_ID,
          plan: { ...validPlan(), objective: SENTINEL, planVersion: -1 },
        }),
      },
      {
        named: 'applied[0].instrumentedHash',
        parsed: parseInstrumentationReadyPayload({
          sessionId: SESSION_ID,
          applied: [{ ...validModification(), diff: SENTINEL, instrumentedHash: 'short' }],
          runtimeHooks: [],
          unavailable: [],
        }),
      },
      {
        named: 'events[0].traceId',
        parsed: parseTelemetryEventPayload({
          events: [{ ...validIngressEvent(), name: SENTINEL, traceId: 'not-a-trace-id' }],
        }),
      },
      {
        named: 'location.line',
        parsed: parseSourceOpenPayload({
          sessionId: SESSION_ID,
          location: { ...validSourceLocation(), symbol: SENTINEL, line: 0 },
        }),
      },
      {
        named: 'target.componentChain[0]',
        parsed: parseTargetSelectedPayload({
          sessionId: SESSION_ID,
          target: { ...validSelectedTarget(), text: SENTINEL, componentChain: [''] },
        }),
      },
      {
        named: 'panel.title',
        parsed: parsePanelGeneratedPayload({
          sessionId: SESSION_ID,
          panelId: PANEL_ID,
          panel: {
            ...validPanelSpec(),
            title: '   ',
            summary: { headline: SENTINEL, observed: [], likelyCauses: [] },
          },
        }),
      },
    ];

    for (const { named, parsed } of cases) {
      expect(DebuggenError.is((parsed as { readonly error?: unknown }).error)).toBe(true);
      const error = (parsed as { readonly error: DebuggenError }).error;

      expect([...DEBUGGEN_ERROR_CODES]).toContain(error.code);
      expect(error.message).toContain(named);
      for (const rendered of [
        error.message,
        error.hint ?? '',
        JSON.stringify(error.details),
        JSON.stringify(error.toPayload()),
      ]) {
        expect(rendered).not.toContain(SENTINEL);
      }
    }
  });

  it('renders an unrecognised key by name, which is the one sanctioned exception', () => {
    // `z.strictObject` reports an extra field as an `unrecognized_keys` issue and
    // the renderer shows the key *names* it carries — the one payload-derived
    // datum AAP §0.5.2 sanctions, on the same principle by which the redaction
    // layer keeps a header's name and replaces its value. The consequence for
    // producers is the point of asserting it: a secret belongs in a field's
    // value, never in a key position.
    const parsed = parseClientHelloPayload({
      ...VALID_PAYLOADS['client.hello'],
      projectroot: PROJECT_ROOT,
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }
    expect(parsed.error.message).toContain('projectroot');
    expect(parsed.error.message).not.toContain(PROJECT_ROOT);
  });
});

// ---------------------------------------------------------------------------
// Frames — `parseMessage` discriminates every registered type, and only that
//
// Everything above proves each payload schema in isolation. What this section
// proves is the step a receiver actually takes: a whole frame
// `{ id, type, sessionId?, ts, payload }` handed to `parseMessage` from
// `../envelope.ts`, which must select the one union member the frame's `type`
// names and validate the payload against that member alone (AAP §0.4.2). Two
// properties follow, and both are asserted for every member of `MESSAGE_TYPES`
// by iterating the tuple itself: a twenty-ninth message is carried into every
// case below automatically, and it cannot be added at all without a fixture in
// `VALID_PAYLOADS` and an entry in `MISMATCHED_PAYLOADS`, each of which is a
// compile error when missing:
//
// - **Acceptance.** Each type's fixture from `VALID_PAYLOADS`, framed, parses to
//   a message of that same type with the payload, the identifiers and the
//   timestamp exactly as sent.
// - **Discrimination.** Each type, framed around a payload that is valid for a
//   *different* type, is refused — the payload is not accepted merely because
//   some member of the union would take it — and the refusal is the transport's
//   `PROTOCOL_INVALID_MESSAGE`, located under `payload`, with nothing of the
//   refused value in any part of the error (AAP §0.5.2). An unknown `type` is
//   refused as well, at the discriminator and before any payload is examined.
//
// Frames are built the way `createEnvelope` builds them — the payload's own
// `sessionId`, where it has one, becomes the routing key; otherwise the key is
// absent — and the first case below holds the builder to that rule. Identifiers
// and the timestamp are fixed literals, never a clock or a generator.
// `./envelope.test.ts` covers the envelope fields themselves (strictness, the
// epoch-millisecond bound, text decoding); this section is about the pairing of
// `type` and `payload`.
// ---------------------------------------------------------------------------

/**
 * The frame identifier every case below sends, in the shape `newMessageId()`
 * mints (`/^[a-z]{3}_[0-9a-z]{16}$/`, prefix `msg`).
 */
const FRAME_ID = 'msg_5t1v8w3x0y6z2a4b';

/**
 * The send timestamp every case below stamps: Unix epoch milliseconds with a
 * sub-millisecond fraction, which the envelope must preserve rather than round.
 */
const FRAME_TS = 1_758_000_002_500.25;

/** The shape every identifier `@debuggen/shared` mints matches. */
const MINTED_ID_PATTERN = /^[a-z]{3}_[0-9a-z]{16}$/;

/** A URL on the fixture origin whose path carries the sentinel. */
const SENTINEL_URL = `${PAGE_ORIGIN}/${SENTINEL}`;

/**
 * A valid handshake whose credential is the sentinel.
 *
 * The one payload in the protocol that carries a bearer credential, so it is
 * the sharpest thing a refused frame can hold. Named because two tables below
 * use it: as the partner payload of the mismatch case for `agent.ready`, and as
 * the payload every unknown-type frame carries.
 */
const CREDENTIAL_BEARING_HELLO: PayloadOf<'client.hello'> = {
  ...VALID_PAYLOADS['client.hello'],
  token: SENTINEL,
};

/**
 * A payload valid for some message type other than `T`, tagged with the type it
 * is valid for.
 *
 * A distributed union over every *other* type, so a fixture pairing a type with
 * its own payload is a compile error (the `partner` literal is excluded), and
 * the payload slot is typed from the partner's schema: the claim "this is a
 * valid `partner` payload" is checked by the compiler here and again at run time
 * by the case that uses it.
 */
type MismatchedPayload<T extends MessageType> = {
  readonly [P in Exclude<MessageType, T>]: {
    /** The type the payload is valid for — never `T` itself. */
    readonly partner: P;
    /** A valid `partner` payload with {@link SENTINEL} in one of its values. */
    readonly payload: PayloadOf<P>;
  };
}[Exclude<MessageType, T>];

/**
 * For every message type, a payload that belongs to a different one.
 *
 * Keyed by the registry's own type, so a message added to `MESSAGE_TYPES` with
 * no entry here is a compile error rather than a type the mismatch case skips.
 *
 * Any validator that checked `type` and `payload` independently — a known name,
 * and a payload *some* member accepts — would accept every entry here. Partners
 * are additionally chosen as near lookalikes wherever the protocol has one,
 * because that is where a looser check fails first: the binding pair, the two
 * agent configurations, the two capture frames, the two telemetry frames and the
 * two instrumentation outcomes differ by a field or two, so a member that
 * tolerated a missing or an extra key would accept exactly these. Where there is
 * no lookalike — the two session broadcasts are identical to each other, so
 * neither can partner the other — the partner is a payload from a neighbouring
 * part of the protocol.
 *
 * Every payload carries {@link SENTINEL} in a **value** the partner's schema
 * accepts — a credential, a URL path, the developer's question, captured event
 * names, an element's text, free-text messages, identifiers — and never in a key
 * position, which the renderer is sanctioned to name (see the last case of the
 * suite above).
 */
const MISMATCHED_PAYLOADS: { readonly [T in MessageType]: MismatchedPayload<T> } = {
  'client.hello': {
    partner: 'agent.ready',
    payload: { ...VALID_PAYLOADS['agent.ready'], url: SENTINEL_URL },
  },
  // An empty ping refuses every key, so the one-key pong is its nearest lookalike.
  'client.ping': { partner: 'service.pong', payload: { ref: SENTINEL } },
  // The other frame that answers by `ref`: an error carries one too, beside two
  // keys a pong refuses.
  'service.pong': {
    partner: 'error',
    payload: { ...VALID_PAYLOADS.error, message: SENTINEL },
  },
  'agent.ready': { partner: 'client.hello', payload: CREDENTIAL_BEARING_HELLO },
  'agent.config': {
    partner: 'server-agent.config',
    payload: { ...VALID_PAYLOADS['server-agent.config'], captureId: SENTINEL },
  },
  'server-agent.config': {
    partner: 'agent.config',
    payload: { ...VALID_PAYLOADS['agent.config'], captureId: SENTINEL },
  },
  'session.bind': {
    partner: 'session.bound',
    payload: { ...VALID_PAYLOADS['session.bound'], url: SENTINEL_URL },
  },
  'session.bound': {
    partner: 'session.bind',
    payload: { ...VALID_PAYLOADS['session.bind'], url: SENTINEL_URL },
  },
  'tab.navigated': {
    partner: 'session.bind',
    payload: { ...VALID_PAYLOADS['session.bind'], url: SENTINEL_URL },
  },
  'session.unbind': {
    partner: 'tab.navigated',
    payload: { ...VALID_PAYLOADS['tab.navigated'], url: SENTINEL_URL },
  },
  'session.created': {
    partner: 'session.progress',
    payload: { ...VALID_PAYLOADS['session.progress'], detail: SENTINEL },
  },
  'session.updated': {
    partner: 'cleanup.completed',
    payload: {
      sessionId: SESSION_ID,
      status: 'conflict',
      conflicts: [{ ...validModificationConflict(), message: SENTINEL }],
    },
  },
  'session.progress': {
    partner: 'error',
    payload: { ...VALID_PAYLOADS.error, message: SENTINEL },
  },
  'analysis.completed': {
    partner: 'instrumentation.plan',
    payload: { sessionId: SESSION_ID, plan: { ...validPlan(), objective: SENTINEL } },
  },
  'capture.started': {
    partner: 'capture.stopped',
    payload: { ...VALID_PAYLOADS['capture.stopped'], captureId: SENTINEL },
  },
  'capture.stopped': {
    partner: 'capture.started',
    payload: { sessionId: SESSION_ID, captureId: SENTINEL },
  },
  'instrumentation.plan': {
    partner: 'analysis.completed',
    payload: {
      sessionId: SESSION_ID,
      analysis: {
        ...validResult(),
        observed: [{ statement: SENTINEL, evidence: [{ eventId: EVENT_ID }] }],
      },
    },
  },
  'instrumentation.ready': {
    partner: 'instrumentation.failed',
    payload: {
      sessionId: SESSION_ID,
      error: { ...VALID_PAYLOADS['instrumentation.failed'].error, hint: SENTINEL },
    },
  },
  'instrumentation.failed': {
    partner: 'instrumentation.ready',
    payload: {
      ...VALID_PAYLOADS['instrumentation.ready'],
      unavailable: [
        {
          signal: 'prisma',
          reason: SENTINEL,
          hint: 'Relaunch the dev server through the editor extension.',
        },
      ],
    },
  },
  'telemetry.event': {
    partner: 'telemetry.tail',
    payload: { sessionId: SESSION_ID, events: [{ ...validPersistedEvent(), name: SENTINEL }] },
  },
  'telemetry.tail': {
    partner: 'telemetry.event',
    payload: { events: [{ ...validIngressEvent(), name: SENTINEL }] },
  },
  'panel.generated': {
    partner: 'session.created',
    payload: { session: { ...validSessionRecord(), question: SENTINEL } },
  },
  'source.open': {
    partner: 'target.selected',
    payload: { sessionId: SESSION_ID, target: { ...validSelectedTarget(), text: SENTINEL } },
  },
  // The nearest lookalike of a failed source answer: a session and a nested
  // `{ code, message, hint }` error, missing only the `ref` and the `status`.
  'source.result': {
    partner: 'instrumentation.failed',
    payload: {
      sessionId: SESSION_ID,
      error: { ...VALID_PAYLOADS['instrumentation.failed'].error, message: SENTINEL },
    },
  },
  'target.request': {
    partner: 'target.selected',
    payload: { sessionId: SESSION_ID, target: { ...validSelectedTarget(), url: SENTINEL_URL } },
  },
  'target.selected': {
    partner: 'source.open',
    payload: { sessionId: SESSION_ID, location: { ...validSourceLocation(), symbol: SENTINEL } },
  },
  'cleanup.completed': {
    partner: 'instrumentation.ready',
    payload: {
      ...VALID_PAYLOADS['instrumentation.ready'],
      applied: [{ ...validModification(), diff: SENTINEL }],
    },
  },
  error: {
    partner: 'instrumentation.failed',
    payload: {
      sessionId: SESSION_ID,
      error: { ...VALID_PAYLOADS['instrumentation.failed'].error, message: SENTINEL },
    },
  },
};

/**
 * The routing key a payload implies: its own `sessionId` when that is a string,
 * otherwise none.
 *
 * The rule `createEnvelope` applies when no explicit routing key is given, stated
 * structurally for the same reason it is there — most payloads carry a
 * `sessionId` and some do not, and asking the value keeps one function correct
 * for all of them without a per-type table.
 *
 * @param payload Any message payload.
 * @returns The `sessionId` to put on the envelope, or `undefined` for none.
 */
function routingKeyOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('sessionId' in payload)) {
    return undefined;
  }

  return typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
}

/**
 * A complete frame around a payload, with the fixed id and timestamp.
 *
 * Written out rather than produced by `createEnvelope`, so the acceptance cases
 * do not depend on the function they would otherwise be testing through; the
 * first case of the suite below proves the two agree. Typed as the envelope of
 * `T`, so a frame pairing a type with a payload of the wrong shape cannot be
 * built here by accident — the mismatch cases relabel a correct frame instead.
 *
 * @param type The message type.
 * @param payload A payload of that type.
 * @returns `{ id, type, sessionId?, ts, payload }`, with `sessionId` present only
 * when the payload implies one (see {@link routingKeyOf}).
 */
function frameOf<T extends MessageType>(type: T, payload: PayloadOf<T>): MessageByType<T> {
  const routingKey = routingKeyOf(payload);

  return routingKey === undefined
    ? { id: FRAME_ID, type, ts: FRAME_TS, payload }
    : { id: FRAME_ID, type, sessionId: routingKey, ts: FRAME_TS, payload };
}

/**
 * The issue paths a `parseMessage` rejection rendered into its `details`.
 *
 * `details.issues` is the one structured, value-free account of a failure this
 * package produces (`protocolParseError` in `../version.ts`): a path and a code
 * per issue, nothing received. An entry without a string path is reported as a
 * marker rather than dropped, so a malformed `details` fails the assertions that
 * read it instead of passing them vacuously.
 *
 * @param error The error a rejection carried.
 * @returns One dotted path per rendered issue, in order; empty when `details`
 * carries no issue list.
 */
function renderedIssuePaths(error: DebuggenError): string[] {
  const issues: unknown = error.details?.issues;

  if (!Array.isArray(issues)) {
    return [];
  }

  return issues.map((issue: unknown) =>
    typeof issue === 'object' && issue !== null && 'path' in issue && typeof issue.path === 'string'
      ? issue.path
      : '<unrendered issue>',
  );
}

/**
 * Every form in which a rejection can leave the receiving process.
 *
 * The message and hint are logged and displayed, `details` is logged and may be
 * persisted with a session, `toPayload()` is what crosses the wire in an `error`
 * frame, and `DebuggenError.from` is the normalisation every boundary applies
 * before any of those. `String(error)` is what a bare template or a console
 * prints.
 *
 * @param error The error a rejection carried.
 * @returns Each rendering, as text to search.
 */
function renderedSurfaces(error: DebuggenError): string[] {
  return [
    error.message,
    error.hint ?? '',
    JSON.stringify(error.details ?? {}),
    JSON.stringify(error.toPayload()),
    JSON.stringify(DebuggenError.from(error).toPayload()),
    String(error),
  ];
}

describe('parseMessage — every registered type is discriminated to its own member', () => {
  it('frames each case exactly as createEnvelope would, from fixed well-formed values', () => {
    // The frame builder is a restatement of the envelope's routing rule, so it is
    // held to the implementation rather than trusted: for every type, the frame
    // it writes out is the frame `createEnvelope` produces from the same payload,
    // id and timestamp — routing key lifted or omitted alike. The id has the
    // minted shape, and the timestamp really carries a sub-millisecond fraction,
    // so the acceptance cases below prove that fraction survives validation.
    expect(FRAME_ID).toMatch(MINTED_ID_PATTERN);
    expect(Number.isInteger(FRAME_TS)).toBe(false);

    for (const type of MESSAGE_TYPES) {
      const payload = VALID_PAYLOADS[type];

      expect(frameOf(type, payload)).toStrictEqual(
        createEnvelope(type, payload, { id: FRAME_ID, ts: FRAME_TS }),
      );
    }
  });

  it.each([...MESSAGE_TYPES])(
    '%s: accepts the framed fixture and returns that type with its payload intact',
    (type) => {
      const payload = VALID_PAYLOADS[type];
      const frame = frameOf(type, payload);
      const parsed = parseMessage(frame);

      // Reported with the rendered issue paths, so a failure names the field that
      // was refused rather than printing `false`.
      expect(parsed.ok ? type : { type, issues: renderedIssuePaths(parsed.error) }).toEqual(type);
      if (!parsed.ok) {
        return;
      }

      // The discriminant selected this type's own member — not merely *a*
      // member that happened to accept the payload — and validation handed back
      // exactly what was sent: the payload deep-equal, nothing added, dropped or
      // rewritten, and the id and sub-millisecond timestamp untouched.
      expect(parsed.value.type).toBe(type);
      expect(parsed.value.payload).toStrictEqual(payload);
      expect(parsed.value).toStrictEqual(frame);
      expect(parsed.value.id).toBe(FRAME_ID);
      expect(parsed.value.ts).toBe(FRAME_TS);

      // The routing key survives exactly as the envelope rule set it: equal to
      // the payload's own `sessionId` where the payload has one, and an absent
      // key — not a present `undefined` — where it does not.
      const routingKey = routingKeyOf(payload);

      expect(Object.hasOwn(parsed.value, 'sessionId')).toBe(routingKey !== undefined);
      expect(parsed.value.sessionId).toBe(routingKey);
    },
  );
});

describe('parseMessage — a payload is accepted only under its own type', () => {
  it.each([...MESSAGE_TYPES])(
    '%s: refuses a frame carrying another type\u2019s payload, without echoing it',
    (type) => {
      const { partner, payload } = MISMATCHED_PAYLOADS[type];
      const partnerSchema: z.ZodType = MESSAGE_PAYLOAD_SCHEMAS[partner];
      const declaredSchema: z.ZodType = MESSAGE_PAYLOAD_SCHEMAS[type];
      const partnerFrame = frameOf(partner, payload);

      // Preconditions, each of which would otherwise make the rejection below
      // prove nothing: the payload really belongs to another type, it really is
      // valid there — alone and as a whole frame — while this type's own schema
      // really refuses it, and the sentinel is really in it.
      expect(partner).not.toBe(type);
      expect(JSON.stringify(payload)).toContain(SENTINEL);
      expect(partnerSchema.safeParse(payload).success).toBe(true);
      expect(declaredSchema.safeParse(payload).success).toBe(false);
      expect(parseMessage(partnerFrame).ok).toBe(true);

      // The mismatch itself: the partner's valid frame with nothing changed but
      // its `type`, so the envelope fields are all acceptable and the only fault
      // is the pairing.
      const parsed = parseMessage({ ...partnerFrame, type });

      expect(isErr(parsed)).toBe(true);
      if (!isErr(parsed)) {
        return;
      }

      const { error } = parsed;

      expect(DebuggenError.is(error)).toBe(true);
      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect([...DEBUGGEN_ERROR_CODES]).toContain(error.code);
      expect(error.message.startsWith('Invalid protocol message: ')).toBe(true);

      // Every issue is located under `payload`: the frame was matched to the
      // member its `type` names and failed there, rather than failing at the
      // envelope or being reported as twenty-seven rejected branches.
      const paths = renderedIssuePaths(error);

      expect(paths).not.toHaveLength(0);
      for (const path of paths) {
        expect(path === 'payload' || /^payload[.[]/.test(path) ? path : { outside: path }).toBe(
          path,
        );
      }

      // And nothing of what was refused leaves in any form (AAP §0.5.2).
      for (const surface of renderedSurfaces(error)) {
        expect(surface).not.toContain(SENTINEL);
      }
    },
  );

  it.each([
    ...HTTP_ONLY_PAYLOAD_NAMES.map((name): [string, string] => [
      `the HTTP-only operation ${name}`,
      name,
    ]),
    ['a registered name in another case', 'Session.Progress'],
    ['a registered name with trailing whitespace', 'session.progress '],
    ['an empty type', ''],
    ['the sentinel itself', SENTINEL],
  ])('refuses %s as a message type, at the discriminator', (_label, type) => {
    const messageTypes: readonly string[] = MESSAGE_TYPES;

    // Precondition: the name really is outside the vocabulary. The HTTP-only
    // names are the realistic case — an operation a client might try to send as
    // a frame, which has a route and a response but no message (AAP §0.4.2).
    expect(messageTypes).not.toContain(type);

    const parsed = parseMessage({
      ...frameOf('client.hello', CREDENTIAL_BEARING_HELLO),
      type,
    });

    expect(isErr(parsed)).toBe(true);
    if (!isErr(parsed)) {
      return;
    }

    const { error } = parsed;

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.message.startsWith('Invalid protocol message: ')).toBe(true);
    // Refused at `type` alone: no member was selected, so the payload — a valid
    // handshake carrying a credential — was never validated against anything.
    // The credential is not echoed, and — as the case whose type *is* the
    // sentinel shows — neither is the name that was offered.
    expect(renderedIssuePaths(error)).toEqual(['type']);
    for (const surface of renderedSurfaces(error)) {
      expect(surface).not.toContain(SENTINEL);
    }
  });
});

/**
 * A well-formed session id that no fixture names: the routing key a
 * confused-deputy frame claims while its payload names {@link SESSION_ID}.
 */
const OTHER_SESSION_ID = 'ses_0z9y8x7w6v5u4t3s';

/**
 * The message types whose payload names no session at all, written out.
 *
 * Not derived from the registry, so the partition the next suite iterates is
 * itself an assertion: a payload that gains or loses a session subject moves a
 * type across this line and fails the first case below.
 */
const SUBJECTLESS_TYPES = [
  'client.hello',
  'client.ping',
  'service.pong',
  'agent.ready',
  'tab.navigated',
  'session.unbind',
  'telemetry.event',
  'error',
] as const;

/**
 * The session a payload is *about*: its own `sessionId`, or else the record `id`
 * of a `session.created` / `session.updated` broadcast.
 *
 * Restated structurally rather than imported — `../envelope.ts` keeps its reader
 * module-private — so the cases below hold the envelope to the rule instead of
 * agreeing with whatever the implementation happens to do.
 *
 * @param payload Any message payload.
 * @returns The session the payload names, or `undefined` when it names none.
 */
function payloadSubjectOf(payload: unknown): string | undefined {
  const own = routingKeyOf(payload);

  if (own !== undefined) {
    return own;
  }
  if (typeof payload !== 'object' || payload === null || !('session' in payload)) {
    return undefined;
  }

  const { session } = payload;

  if (typeof session !== 'object' || session === null || !('id' in session)) {
    return undefined;
  }

  return typeof session.id === 'string' ? session.id : undefined;
}

/** The registered types whose fixture payload names a session, in tuple order. */
const SUBJECT_TYPES = MESSAGE_TYPES.filter(
  (type) => payloadSubjectOf(VALID_PAYLOADS[type]) !== undefined,
);

// The envelope's `sessionId` is what the service routes and authorizes by; the
// payload's subject is what a handler acts on. A devtools principal is
// authorized only for its bound session, so every member of the
// union must refuse a frame whose two answers differ — the rule lives in one
// place in `../envelope.ts`, and this suite proves it reached all twenty-eight.
describe('parseMessage — every member refuses a routing key that contradicts its payload', () => {
  it('partitions the registry into payloads that name a session and eight that name none', () => {
    const subjectless = MESSAGE_TYPES.filter(
      (type) => payloadSubjectOf(VALID_PAYLOADS[type]) === undefined,
    );

    expect([...subjectless].sort()).toEqual([...SUBJECTLESS_TYPES].sort());
    expect(SUBJECT_TYPES.length + subjectless.length).toBe(MESSAGE_TYPES.length);
    for (const type of SUBJECT_TYPES) {
      expect(payloadSubjectOf(VALID_PAYLOADS[type])).toBe(SESSION_ID);
    }
  });

  it.each(SUBJECT_TYPES)(
    '%s: refuses a routing key naming another session than its payload, echoing neither',
    (type) => {
      const payload = VALID_PAYLOADS[type];
      const frame = { ...frameOf(type, payload), sessionId: OTHER_SESSION_ID };

      // Precondition: the same frame routed to its own subject is accepted, so the
      // refusal below is about the routing key and nothing else.
      expect(isOk(parseMessage({ ...frame, sessionId: SESSION_ID }))).toBe(true);

      const parsed = parseMessage(frame);

      expect(isErr(parsed)).toBe(true);
      if (!isErr(parsed)) {
        return;
      }

      const { error } = parsed;

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(error.message).toBe(
        'Invalid protocol message: sessionId (custom label=routing-matches-payload)',
      );
      expect(renderedIssuePaths(error)).toEqual(['sessionId']);
      for (const surface of renderedSurfaces(error)) {
        expect(surface).not.toContain(OTHER_SESSION_ID);
        expect(surface).not.toContain(SESSION_ID);
      }
    },
  );

  it.each([...SUBJECTLESS_TYPES])(
    '%s: accepts any routing key, because its payload names no session',
    (type) => {
      const parsed = parseMessage({
        ...frameOf(type, VALID_PAYLOADS[type]),
        sessionId: OTHER_SESSION_ID,
      });

      expect(isOk(parsed)).toBe(true);
      if (!isOk(parsed)) {
        return;
      }
      expect(parsed.value.type).toBe(type);
      expect(parsed.value.sessionId).toBe(OTHER_SESSION_ID);
    },
  );
});

// ---------------------------------------------------------------------------
// The parse helpers — every exported `parse*` function, one table
//
// Every suite above validates a schema; this one calls the helpers the three
// apps actually import. Each helper wraps its schema in the same sequence —
// `safeParse`, then `protocolParseError` — and a helper that attached the
// `ZodError`, forwarded an issue message or threw would pass every schema case
// above while leaking or crashing at the socket. So each row proves the two
// halves of the helper's contract directly: a valid input comes back as the
// same value, and an input refused for one reason while the sentinel sits in
// another value is answered with `PROTOCOL_INVALID_MESSAGE`, names the field it
// was refused for, and echoes the sentinel in no rendering.
//
// The table is keyed by the barrel's own export names, so it is exhaustive at
// compile time, and a guard case compares it with the barrel at run time too.
// ---------------------------------------------------------------------------

/** The name of every `parse*` function the messages barrel exports. */
type ParseHelperName = Extract<keyof typeof messagesBarrel, `parse${string}`>;

/** The value a helper answers with when it accepts its input. */
type ParsedBy<N extends ParseHelperName> = Extract<
  ReturnType<(typeof messagesBarrel)[N]>,
  { readonly ok: true }
>['value'];

/** One row of {@link PARSE_HELPER_CASES}. */
interface ParseHelperCase<N extends ParseHelperName> {
  /**
   * An input the helper accepts, typed as what it answers with — so a fixture
   * that stops matching the helper's own result type is a compile error.
   */
  readonly valid: ParsedBy<N>;
  /**
   * An input the helper refuses for the reason in `refusedFor`, with
   * {@link SENTINEL} planted in a different value, so the sentinel had every
   * opportunity to be rendered.
   */
  readonly invalid: unknown;
  /** The rendered issue the refusal must be for: a field path and issue code. */
  readonly refusedFor: string;
}

/**
 * A valid and a refused input for every parse helper, keyed by helper name.
 *
 * The mapped type over {@link ParseHelperName} is the compile-time half of the
 * coverage guarantee: a helper added to the barrel without a row here fails
 * `tsc -b`. Valid inputs reuse {@link VALID_PAYLOADS} for every message payload;
 * the seven request and response bodies of the five HTTP-only operations in
 * `../messages/capture.ts` and `../messages/session.ts` are written out from
 * their schemas.
 */
const PARSE_HELPER_CASES: { readonly [N in ParseHelperName]: ParseHelperCase<N> } = {
  parseClientHelloPayload: {
    valid: VALID_PAYLOADS['client.hello'],
    invalid: { ...VALID_PAYLOADS['client.hello'], token: SENTINEL, version: '1.0' },
    refusedFor: 'version (invalid_format format=regex)',
  },
  parseClientPingPayload: {
    valid: VALID_PAYLOADS['client.ping'],
    invalid: { ref: SENTINEL },
    refusedFor: '<root> (unrecognized_keys keys=ref)',
  },
  parseServicePongPayload: {
    valid: VALID_PAYLOADS['service.pong'],
    invalid: { ...VALID_PAYLOADS['service.pong'], note: SENTINEL },
    refusedFor: '<root> (unrecognized_keys keys=note)',
  },
  parseAgentReadyPayload: {
    valid: VALID_PAYLOADS['agent.ready'],
    invalid: { ...VALID_PAYLOADS['agent.ready'], url: SENTINEL_URL, tabId: -1 },
    refusedFor: 'tabId (too_small',
  },
  parseAgentConfigPayload: {
    valid: VALID_PAYLOADS['agent.config'],
    invalid: {
      ...VALID_PAYLOADS['agent.config'],
      captureId: SENTINEL,
      hooks: without(validAgentHookConfig(), 'react'),
    },
    refusedFor: 'hooks.react (invalid_type expected=boolean)',
  },
  parseServerAgentConfigPayload: {
    valid: VALID_PAYLOADS['server-agent.config'],
    invalid: {
      ...VALID_PAYLOADS['server-agent.config'],
      captureId: SENTINEL,
      signals: without(validServerAgentSignals(), 'pg'),
    },
    refusedFor: 'signals.pg (invalid_type expected=boolean)',
  },
  parseSessionBindPayload: {
    valid: VALID_PAYLOADS['session.bind'],
    invalid: { ...VALID_PAYLOADS['session.bind'], url: SENTINEL_URL, origin: `${PAGE_ORIGIN}/` },
    refusedFor: 'origin (custom label=serialized-origin)',
  },
  parseSessionBoundPayload: {
    valid: VALID_PAYLOADS['session.bound'],
    invalid: { ...VALID_PAYLOADS['session.bound'], url: SENTINEL_URL, reason: 'not-a-reason' },
    refusedFor: 'reason (invalid_value',
  },
  parseTabNavigatedPayload: {
    valid: VALID_PAYLOADS['tab.navigated'],
    invalid: { url: SENTINEL_URL, tabId: -1 },
    refusedFor: 'tabId (too_small',
  },
  parseSessionUnbindPayload: {
    valid: VALID_PAYLOADS['session.unbind'],
    invalid: { ...VALID_PAYLOADS['session.unbind'], url: SENTINEL_URL },
    refusedFor: '<root> (unrecognized_keys keys=url)',
  },
  parseSessionCreatedPayload: {
    valid: VALID_PAYLOADS['session.created'],
    invalid: { session: { ...validSessionRecord(), question: SENTINEL, status: 'paused' } },
    refusedFor: 'session.status (invalid_value',
  },
  parseSessionUpdatedPayload: {
    valid: VALID_PAYLOADS['session.updated'],
    invalid: { session: { ...validSessionRecord(), question: SENTINEL, followUps: 'none' } },
    refusedFor: 'session.followUps (invalid_type expected=array)',
  },
  parseSessionProgressPayload: {
    valid: VALID_PAYLOADS['session.progress'],
    invalid: { ...VALID_PAYLOADS['session.progress'], detail: SENTINEL, stage: 'deploy' },
    refusedFor: 'stage (invalid_value',
  },
  parseAnalysisCompletedPayload: {
    valid: VALID_PAYLOADS['analysis.completed'],
    invalid: {
      sessionId: SESSION_ID,
      analysis: { ...validResult(), observed: [{ statement: SENTINEL, evidence: [] }] },
    },
    refusedFor: 'analysis.observed[0].evidence (too_small origin=array min=1)',
  },
  parseSessionCreateRequest: {
    valid: {
      projectRoot: PROJECT_ROOT,
      question: 'Why does this action take so long?',
      target: validSelectedTarget(),
    },
    invalid: { projectRoot: '', question: SENTINEL, target: validSelectedTarget() },
    refusedFor: 'projectRoot (too_small origin=string min=1)',
  },
  parseSessionQuestionRequest: {
    valid: { question: 'Why did that step run twice?' },
    invalid: { question: SENTINEL, followUp: true },
    refusedFor: '<root> (unrecognized_keys keys=followUp)',
  },
  parseSessionEndRequest: {
    valid: {},
    invalid: { force: SENTINEL },
    refusedFor: '<root> (unrecognized_keys keys=force)',
  },
  parseCaptureStartedPayload: {
    valid: VALID_PAYLOADS['capture.started'],
    invalid: { sessionId: SENTINEL, captureId: '' },
    refusedFor: 'captureId (too_small origin=string min=1)',
  },
  parseCaptureStoppedPayload: {
    valid: VALID_PAYLOADS['capture.stopped'],
    invalid: { sessionId: SESSION_ID, captureId: SENTINEL, summary: null },
    refusedFor: 'summary (custom label=CaptureSummary)',
  },
  parseCaptureStartRequest: {
    valid: {},
    invalid: { captureId: SENTINEL },
    refusedFor: '<root> (unrecognized_keys keys=captureId)',
  },
  parseCaptureStartResponse: {
    valid: { captureId: CAPTURE_ID },
    invalid: { captureId: CAPTURE_ID, sessionId: SENTINEL },
    refusedFor: '<root> (unrecognized_keys keys=sessionId)',
  },
  parseCaptureStopRequest: {
    valid: {},
    invalid: { hooks: SENTINEL },
    refusedFor: '<root> (unrecognized_keys keys=hooks)',
  },
  parseCaptureStopResponse: {
    valid: { summary: CAPTURE_SUMMARY },
    invalid: { summary: [SENTINEL] },
    refusedFor: 'summary (custom label=CaptureSummary)',
  },
  parseInstrumentationPlanPayload: {
    valid: VALID_PAYLOADS['instrumentation.plan'],
    invalid: {
      sessionId: SESSION_ID,
      plan: { ...validPlan(), objective: SENTINEL, planVersion: -1 },
    },
    refusedFor: 'plan.planVersion (too_small',
  },
  parseInstrumentationReadyPayload: {
    valid: VALID_PAYLOADS['instrumentation.ready'],
    invalid: {
      ...VALID_PAYLOADS['instrumentation.ready'],
      applied: [{ ...validModification(), diff: SENTINEL, instrumentedHash: 'short' }],
    },
    refusedFor: 'applied[0].instrumentedHash',
  },
  parseInstrumentationFailedPayload: {
    valid: VALID_PAYLOADS['instrumentation.failed'],
    invalid: {
      sessionId: SESSION_ID,
      error: {
        ...VALID_PAYLOADS['instrumentation.failed'].error,
        message: SENTINEL,
        code: 'NOT_A_CODE',
      },
    },
    refusedFor: 'error.code (invalid_value',
  },
  parseTelemetryEventPayload: {
    valid: VALID_PAYLOADS['telemetry.event'],
    invalid: { events: [{ ...validIngressEvent(), name: SENTINEL, traceId: 'not-a-trace-id' }] },
    refusedFor: 'events[0].traceId',
  },
  parseTelemetryTailPayload: {
    valid: VALID_PAYLOADS['telemetry.tail'],
    invalid: {
      sessionId: SESSION_ID,
      events: [{ ...validPersistedEvent(), name: SENTINEL, ingestSeq: 0 }],
    },
    refusedFor: 'events[0].ingestSeq (too_small',
  },
  parsePanelGeneratedPayload: {
    valid: VALID_PAYLOADS['panel.generated'],
    invalid: {
      sessionId: SESSION_ID,
      panelId: PANEL_ID,
      panel: {
        ...validPanelSpec(),
        title: '   ',
        summary: { headline: SENTINEL, observed: [], likelyCauses: [] },
      },
    },
    refusedFor: 'panel.title',
  },
  parseSourceOpenPayload: {
    valid: VALID_PAYLOADS['source.open'],
    invalid: {
      sessionId: SESSION_ID,
      location: { ...validSourceLocation(), symbol: SENTINEL, line: 0 },
    },
    refusedFor: 'location.line (too_small',
  },
  parseSourceResultPayload: {
    valid: VALID_PAYLOADS['source.result'],
    invalid: {
      ...FAILED_SOURCE_RESULT,
      error: { ...FAILED_SOURCE_RESULT.error, message: SENTINEL, code: 'NOT_A_CODE' },
    },
    refusedFor: 'error.code (invalid_value',
  },
  parseTargetRequestPayload: {
    valid: VALID_PAYLOADS['target.request'],
    invalid: { ...VALID_PAYLOADS['target.request'], selector: SENTINEL },
    refusedFor: '<root> (unrecognized_keys keys=selector)',
  },
  parseTargetSelectedPayload: {
    valid: VALID_PAYLOADS['target.selected'],
    invalid: {
      sessionId: SESSION_ID,
      target: { ...validSelectedTarget(), text: SENTINEL, componentChain: [''] },
    },
    refusedFor: 'target.componentChain[0]',
  },
  parseCleanupCompletedPayload: {
    valid: VALID_PAYLOADS['cleanup.completed'],
    invalid: {
      ...VALID_PAYLOADS['cleanup.completed'],
      status: 'partially-clean',
      conflicts: [{ ...validModificationConflict(), message: SENTINEL }],
    },
    refusedFor: 'status (invalid_value',
  },
  parseErrorPayload: {
    valid: VALID_PAYLOADS.error,
    invalid: { code: 'NOT_A_CODE', message: SENTINEL },
    refusedFor: 'code (invalid_value',
  },
};

/**
 * Whether a string names a row of {@link PARSE_HELPER_CASES}.
 *
 * @param name A candidate helper name.
 * @returns `true` when the table has a row under that name.
 */
function isParseHelperName(name: string): name is ParseHelperName {
  return Object.hasOwn(PARSE_HELPER_CASES, name);
}

/** The table's helper names, in declaration order, typed for indexing. */
const PARSE_HELPER_NAMES: readonly ParseHelperName[] =
  Object.keys(PARSE_HELPER_CASES).filter(isParseHelperName);

/**
 * The helper a row is about, read from the barrel by name and widened to the
 * one signature every helper shares, so a single case body can call any of them.
 *
 * @param name The helper's export name.
 * @returns That export of `../messages/index.ts`.
 */
function parseHelperNamed(
  name: ParseHelperName,
): (value: unknown) => Result<unknown, DebuggenError> {
  return messagesBarrel[name];
}

describe('the parse helpers — every exported parse* function accepts, refuses and never echoes', () => {
  it('has a row for exactly the parse* functions the messages barrel exports', () => {
    // The run-time half of the coverage guarantee, read from the module
    // namespace itself: a helper exported without a row, or a row whose helper
    // was renamed or removed, makes the two sets differ.
    const exported = Object.entries(messagesBarrel)
      .filter(([name, value]) => name.startsWith('parse') && typeof value === 'function')
      .map(([name]) => name);

    expect([...PARSE_HELPER_NAMES].sort()).toEqual(exported.sort());
    expect(Object.keys(PARSE_HELPER_CASES)).toHaveLength(PARSE_HELPER_NAMES.length);
  });

  it.each(PARSE_HELPER_NAMES)('%s accepts its valid input and returns it unchanged', (name) => {
    const { valid } = PARSE_HELPER_CASES[name];
    const parsed = parseHelperNamed(name)(valid);

    // Reported with the rendered issue paths, so a failure names the field that
    // was refused rather than printing `false`.
    expect(isOk(parsed) ? name : { name, issues: renderedIssuePaths(parsed.error) }).toEqual(name);
    if (!isOk(parsed)) {
      return;
    }
    expect(parsed.value).toStrictEqual(valid);
  });

  it.each(PARSE_HELPER_NAMES)(
    '%s refuses its invalid input as PROTOCOL_INVALID_MESSAGE, without echoing the sentinel',
    (name) => {
      const { invalid, refusedFor } = PARSE_HELPER_CASES[name];

      // Precondition: the sentinel really is in the refused input.
      expect(JSON.stringify(invalid)).toContain(SENTINEL);

      const parsed = parseHelperNamed(name)(invalid);

      expect(isErr(parsed)).toBe(true);
      if (!isErr(parsed)) {
        return;
      }

      const { error } = parsed;

      expect(DebuggenError.is(error)).toBe(true);
      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(error.cause).toBeUndefined();
      // Refused for the planted reason alone — one field — and not for some
      // other fault in the fixture, the sentinel's own field included.
      expect(error.message).toContain(refusedFor);
      expect(new Set(renderedIssuePaths(error)).size).toBe(1);
      for (const surface of renderedSurfaces(error)) {
        expect(surface).not.toContain(SENTINEL);
      }
    },
  );
});
