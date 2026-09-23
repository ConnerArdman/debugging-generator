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
import { METRIC_IDS, computeCaptureSummary } from '@debuggen/telemetry';
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
import {
  CLEANUP_STATUSES,
  PROMPT_STAGE_KEYS,
  PROVIDER_IDS,
  SESSION_STATUSES,
  isCleanupStatus,
  isSessionStatus,
  parseSessionRecord,
  relevantFileSchema,
  sessionRecordSchema,
  touchSessionRecord,
} from '../session-record.js';
import type { SessionRecord } from '../session-record.js';

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
