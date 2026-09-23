/**
 * Tests for this package's message payload modules, in the directory
 * `packages/protocol/tsconfig.json` names for them (AAP 0.8.3).
 *
 * What is on trial here is the **wire contract**, not the schema library: every
 * assertion below is a statement about what one process may send and another
 * will accept, and each one exists because a producer and a consumer live in
 * different bundles and can only disagree at run time.
 *
 * ## The generic `error` frame, and why it is pinned this tightly
 *
 * AAP 0.4.2 specifies that payload exactly as `{ code, message, ref? }`, and
 * `../messages/error.ts` is the single definition of it (AAP 0.9.1). Two
 * properties make the shape easy to widen by accident, which is what these
 * tests stand against:
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
 *   **value** (AAP 0.5.2), because a rejected frame is unvalidated data from
 *   another process and this product does not put such data into an error
 *   message, a log line or a persisted session row.
 *
 * ## The analysis artifact, and what the suites below are actually proving
 *
 * `../analysis.ts` is the single definition of the shape carried by the
 * `analysis.completed` payload, stored in the `analyses` table and handed to
 * `normalizePanel` (AAP 0.9.1). Its element schemas are **imported** from
 * `@debuggen/panel-schema` rather than restated, and that is not a claim a
 * reader can check by inspection — a local copy of `Fact` would compile, would
 * type-check identically and would differ only in what it refuses. So the cases
 * below exercise the constraint only the imported schema has: a fact with an
 * empty `evidence` array is refused, which is what makes AAP 0.8.4's
 * "unevidenced observation" structurally impossible rather than merely
 * discouraged. The rest pin the fields deterministic code owns — the version
 * floor, the self-supersede rule, the closed metric vocabulary — and the
 * privacy rule, which applies to a rejected analysis exactly as it applies to a
 * rejected frame.
 */

import { describe, expect, it } from 'vitest';

import { DEBUGGEN_ERROR_CODES, DebuggenError } from '@debuggen/shared';
import { METRIC_IDS } from '@debuggen/telemetry';
import type { MetricValue } from '@debuggen/telemetry';

import {
  ANALYSIS_VERSION_START,
  analysisFindingsSchema,
  analysisResultSchema,
  createAnalysisResult,
  parseAnalysisFindings,
  parseAnalysisResult,
} from '../analysis.js';
import type { AnalysisFindings, AnalysisResult } from '../analysis.js';
import {
  ERROR_MESSAGE_PAYLOADS,
  errorPayloadSchema,
  parseErrorPayload,
  toErrorPayload,
} from '../messages/error.js';

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
