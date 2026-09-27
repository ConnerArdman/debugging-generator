/**
 * The host↔webview contract's two parsers (`src/webview-messages.ts`), run in
 * the `vscode-extension-host` Vitest project (Node).
 *
 * What is proven here, member by member and in both directions:
 *
 * - a valid frame is accepted and the parser returns a **rebuilt copy** — equal
 *   to the input for a frame the host itself produces, never the same object;
 * - a missing or wrong-typed field, an unknown key at any webview-local level,
 *   a non-object and an unknown `type` are each refused with the right closed
 *   rejection, and an unknown `type` is never echoed into it;
 * - the embedded protocol shapes are validated by their own schemas, whose
 *   parsed output is what the copy carries;
 * - the snapshots the real `ExtensionState` (`src/state.ts`) produces — empty,
 *   and after every kind of update the host applies — are accepted as they
 *   are, so the host's own pushes can never be refused by the webview.
 *
 * `src/state.ts` imports `vscode` for its `EventEmitter`, which no installable
 * package provides outside the editor, so `vi.mock` substitutes a minimal,
 * synchronous emitter with the same `event`/`fire`/`dispose` surface.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  analysisResultSchema,
  sessionRecordSchema,
  type AnalysisResult,
  type PanelGeneratedPayload,
  type SelectedTarget,
  type SessionRecord,
} from '@debuggen/protocol';
import type { SourceLocation } from '@debuggen/shared';

import { ExtensionState } from './state';
import {
  ACTION_RESULT_STATUSES,
  FOCUS_SECTIONS,
  HOST_TO_WEBVIEW_MESSAGE_TYPES,
  MAX_RETRY_STAGE_LENGTH,
  MAX_WEBVIEW_QUESTION_LENGTH,
  MAX_WEBVIEW_REQUEST_ID_LENGTH,
  NOTICE_LEVELS,
  WEBVIEW_REQUEST_TYPES,
  WEBVIEW_TO_HOST_MESSAGE_TYPES,
  isHostToWebviewMessage,
  isWebviewRequestMessage,
  isWebviewRequestType,
  isWebviewToHostMessage,
  parseHostToWebviewMessage,
  parseWebviewToHostMessage,
  type HostToWebviewMessage,
  type HostToWebviewMessageType,
  type WebviewState,
  type WebviewToHostMessage,
  type WebviewToHostMessageType,
} from './webview-messages';

vi.mock('vscode', () => {
  /** The part of `vscode.EventEmitter` `ExtensionState` uses, delivering synchronously. */
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void): { dispose(): void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        },
      };
    };

    fire(value: T): void {
      for (const listener of [...this.listeners]) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }
  return { EventEmitter };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Sender-controlled text that must never reach a rejection: shaped like the
 * URL-with-query a malformed frame could carry.
 */
const SENTINEL = 'https://example.invalid/private-sentinel?q=do-not-log';

const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';
const CAPTURE_ID = 'cap_7f3q0m2zk1x8ab9c';
const PANEL_ID = 'pan_6h2j8k4l0z5x1c7v';
const ANALYSIS_ID = 'ana_3v8n1t6y2r9w0q5s';
const EVENT_ID = 'evt_9p2k4m7q1z8x3c0v';
const MODIFICATION_ID = 'mod_5b1n7m3q9w2e4r6t';
const ACTION_ID = 'act_2q7w1e9r4t6y8u3i';
const PROJECT_ROOT = '/home/example/workspace/site';
const SOURCE_FILE = 'src/lib/thing.ts';
/** A request id in the form the view mints: 16 random bytes as lowercase hex. */
const REQUEST_ID = '5f0c2a9e7b1d4c3a8e6f0b2d9a7c1e3f';

/** The fixed host clock, in Unix epoch milliseconds. */
const NOW = 1_758_000_200_000;

/** A 64-character lowercase hex digest from a repeating seed (low entropy on purpose). */
function hashFixture(seed: string): string {
  return seed.repeat(32).slice(0, 64);
}

function validLocation(): SourceLocation {
  return {
    file: SOURCE_FILE,
    line: 12,
    column: 3,
    symbol: 'runTask',
    endLine: 20,
    resolvedBy: 'code-graph',
    confidence: 0.85,
  };
}

/** The element selected in DevTools. */
function validTarget(): SelectedTarget {
  return {
    selector: 'main > button.primary',
    tagName: 'BUTTON',
    text: 'Continue',
    componentChain: ['PrimaryAction', 'ActionRow'],
    url: 'http://localhost:3000/list',
  };
}

/** A complete analysis: one evidenced fact, one located hypothesis, two metrics. */
function validAnalysis(): AnalysisResult {
  return {
    id: ANALYSIS_ID,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    analysisVersion: 1,
    createdAt: 1_758_000_110_000,
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
        suggestedLocation: validLocation(),
      },
    ],
    metrics: [
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
    ],
  };
}

/**
 * A realistic session record with every field populated, after
 * `packages/protocol/src/__tests__/messages.test.ts`'s `validSessionRecord()`.
 * The capture is in flight and carries no summary, because the summary's
 * builder belongs to `@debuggen/telemetry`, which this workspace does not import.
 */
function validSessionRecord(): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: 'site',
    devServerUrl: 'http://localhost:3000',
    boundTab: { tabId: 7, url: 'http://localhost:3000/list?filter=%3F' },
    createdAt: 1_758_000_000_000,
    updatedAt: 1_758_000_120_000,
    status: 'capturing',
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
    target: validTarget(),
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
    plans: [
      {
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
      },
    ],
    modifications: [
      {
        id: MODIFICATION_ID,
        sessionId: SESSION_ID,
        planVersion: 1,
        file: SOURCE_FILE,
        originalHash: hashFixture('1a'),
        backupPath: `/home/example/.debuggen/backups/${SESSION_ID}/${hashFixture('1a')}`,
        instrumentedHash: hashFixture('2b'),
        appliedAt: 1_758_000_000_500,
        status: 'applied',
        diff: '--- a/src/lib/thing.ts\n+++ b/src/lib/thing.ts\n',
      },
    ],
    captures: [{ id: CAPTURE_ID, planVersion: 1, startedAt: 1_758_000_000_900, eventCount: 42 }],
    panelIds: [PANEL_ID],
    analyses: [validAnalysis()],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: { understand: 'v001', investigate: 'v001', plan: 'v001', analyze: 'v001' },
    provider: { id: 'deterministic' },
  };
}

/** A snapshot with no session and every optional key absent. */
function minimalState(): WebviewState {
  return {
    connection: {
      status: 'open',
      serviceUrl: 'http://127.0.0.1:43117',
      serviceReachable: true,
      provider: 'deterministic',
    },
    progress: [],
    relevantFiles: [],
    modifications: [],
    capture: { active: false, eventCount: 0 },
    cleanup: { status: 'pending', conflicts: [] },
  };
}

/** A snapshot with every optional key present. */
function fullState(): WebviewState {
  const session = validSessionRecord();
  return {
    connection: {
      status: 'reconnecting',
      serviceUrl: 'http://127.0.0.1:43117',
      serviceReachable: false,
      provider: 'deterministic',
    },
    session,
    progress: [
      {
        stage: 'investigate',
        status: 'done',
        message: 'Resolved runTask in src/lib/thing.ts',
        ts: NOW,
      },
      {
        stage: 'capture',
        status: 'running',
        message: 'Waiting for interactions',
        detail: 'Interact with the page, then stop the capture.',
        ts: NOW + 1.5,
      },
    ],
    relevantFiles: session.relevantFiles,
    modifications: session.modifications,
    modificationsTotal: session.modifications.length + 2,
    analysis: validAnalysis(),
    latestPanel: { id: PANEL_ID, title: 'Where the time goes', panelVersion: 2, fallback: true },
    target: validTarget(),
    capture: { active: true, captureId: CAPTURE_ID, eventCount: 42 },
    cleanup: { status: 'conflict', completedAt: NOW, conflicts: [] },
    pairing: { code: 'ABCD2345', expiresAt: NOW + 300_000 },
    failure: {
      stage: 'analyze',
      code: 'MODEL_UNAVAILABLE',
      message: 'Model provider unavailable.',
      hint: 'Switch DEBUGGEN_PROVIDER.',
    },
  };
}

/** One valid frame per host-to-webview member; the record type forces a sample for a new member. */
function hostSamples(): Record<HostToWebviewMessageType, HostToWebviewMessage> {
  return {
    state: { type: 'state', state: fullState() },
    notice: {
      type: 'notice',
      level: 'warning',
      message: 'Could not enable fetch.',
      hint: 'Reload.',
    },
    pairing: { type: 'pairing', pairing: { code: 'ABCD2345', expiresAt: NOW + 300_000 } },
    focus: { type: 'focus', section: 'modifications' },
    actionResult: {
      type: 'actionResult',
      requestId: REQUEST_ID,
      action: 'startCapture',
      status: 'accepted',
    },
  };
}

/** One valid frame per webview-to-host member; the record type forces a sample for a new member. */
function webviewSamples(): Record<WebviewToHostMessageType, WebviewToHostMessage> {
  return {
    ready: { type: 'ready' },
    askQuestion: { type: 'askQuestion', requestId: REQUEST_ID, question: 'Why is this slow?' },
    askFollowUp: { type: 'askFollowUp', requestId: REQUEST_ID, question: 'Why twice?' },
    startCapture: { type: 'startCapture', requestId: REQUEST_ID },
    stopCapture: { type: 'stopCapture', requestId: REQUEST_ID },
    endSession: { type: 'endSession', requestId: REQUEST_ID },
    openFile: { type: 'openFile', location: validLocation() },
    requestTarget: { type: 'requestTarget', requestId: REQUEST_ID },
    pairChrome: { type: 'pairChrome', requestId: REQUEST_ID },
    dismissPairing: { type: 'dismissPairing', requestId: REQUEST_ID },
    launchDevServer: { type: 'launchDevServer', requestId: REQUEST_ID },
    retryStage: { type: 'retryStage', requestId: REQUEST_ID, stage: 'capture' },
    loadModifications: { type: 'loadModifications', requestId: REQUEST_ID },
  };
}

/** Request ids the contract refuses, each with why. */
const INVALID_REQUEST_IDS: readonly (readonly [unknown, string])[] = [
  ['', 'empty'],
  ['r'.repeat(MAX_WEBVIEW_REQUEST_ID_LENGTH + 1), 'one character too long'],
  ['req 1', 'a space'],
  ['req/1', 'a slash'],
  ['req.1', 'a dot'],
  ['réq', 'a non-ASCII letter'],
  [SENTINEL, 'a URL'],
  [42, 'a number'],
  [null, 'null'],
  [['req'], 'an array'],
];

/** A `state` frame whose snapshot `edit` has altered (the snapshot is untyped from here on). */
function stateFrame(edit: (state: Record<string, unknown>) => void, base = fullState()): unknown {
  const state = structuredClone(base) as unknown as Record<string, unknown>;
  edit(state);
  return { type: 'state', state };
}

/** Reads a nested webview-local object of an untyped snapshot for editing. */
function field(state: Record<string, unknown>, key: string): Record<string, unknown> {
  return state[key] as Record<string, unknown>;
}

/** Reads one element of an untyped array field for editing. */
function element(
  state: Record<string, unknown>,
  key: string,
  index: number,
): Record<string, unknown> {
  return (state[key] as Record<string, unknown>[])[index] as Record<string, unknown>;
}

/** Every value of a non-object class, with the `valueType` its rejection must name. */
const NON_OBJECTS: readonly (readonly [unknown, string])[] = [
  [undefined, 'undefined'],
  [null, 'null'],
  [true, 'boolean'],
  [42, 'number'],
  [42n, 'bigint'],
  [SENTINEL, 'string'],
  [Symbol('frame'), 'symbol'],
  [() => SENTINEL, 'function'],
  [[{ type: 'ready' }], 'array'],
];

/** Objects whose `type` is not a member of either direction, or not readable as one. */
function unknownTypeFrames(): unknown[] {
  return [
    { type: SENTINEL },
    { type: SENTINEL, state: minimalState() },
    { type: 123 },
    { type: null },
    {},
    { question: SENTINEL },
    Object.create({ type: 'ready' }) as unknown,
  ];
}

// ---------------------------------------------------------------------------
// Host → webview
// ---------------------------------------------------------------------------

describe('parseHostToWebviewMessage', () => {
  it('accepts one valid frame of every member and returns an equal, rebuilt copy', () => {
    const samples = hostSamples();
    for (const type of HOST_TO_WEBVIEW_MESSAGE_TYPES) {
      const sample = samples[type];
      const parsed = parseHostToWebviewMessage(sample);
      expect(parsed, type).toStrictEqual({ ok: true, message: sample });
      if (parsed.ok) {
        expect(parsed.message).not.toBe(sample);
      }
      expect(isHostToWebviewMessage(sample)).toBe(true);
    }
  });

  it('accepts a snapshot without a session, with every optional key absent', () => {
    const state = minimalState();
    const parsed = parseHostToWebviewMessage({ type: 'state', state });
    expect(parsed).toStrictEqual({ ok: true, message: { type: 'state', state } });
    if (parsed.ok && parsed.message.type === 'state') {
      expect(parsed.message.state).not.toBe(state);
      expect(parsed.message.state.connection).not.toBe(state.connection);
    }
  });

  it('accepts a realistic, fully populated session record inside the snapshot', () => {
    expect(sessionRecordSchema.safeParse(validSessionRecord()).success).toBe(true);
    expect(analysisResultSchema.safeParse(validAnalysis()).success).toBe(true);
    const parsed = parseHostToWebviewMessage({ type: 'state', state: fullState() });
    expect(parsed.ok).toBe(true);
  });

  it('carries modificationsTotal as sent: zero, or a count above the list’s length', () => {
    for (const modificationsTotal of [0, 1, 256, Number.MAX_SAFE_INTEGER]) {
      const state: WebviewState = { ...minimalState(), modificationsTotal };
      expect(
        parseHostToWebviewMessage({ type: 'state', state }),
        String(modificationsTotal),
      ).toStrictEqual({
        ok: true,
        message: { type: 'state', state },
      });
    }
  });

  it('refuses a state frame without a whole snapshot', () => {
    for (const frame of [
      { type: 'state' },
      { type: 'state', state: {} },
      { type: 'state', state: null },
    ]) {
      expect(parseHostToWebviewMessage(frame)).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'state' },
      });
      expect(isHostToWebviewMessage(frame)).toBe(false);
    }
  });

  it('refuses a snapshot missing any required field', () => {
    for (const key of [
      'connection',
      'progress',
      'relevantFiles',
      'modifications',
      'capture',
      'cleanup',
    ]) {
      const frame = stateFrame((state) => {
        delete state[key];
      });
      expect(parseHostToWebviewMessage(frame), key).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'state' },
      });
    }
  });

  it('refuses an unknown key on the message itself', () => {
    const parsed = parseHostToWebviewMessage({
      type: 'state',
      state: fullState(),
      extra: SENTINEL,
    });
    expect(parsed).toStrictEqual({
      ok: false,
      rejection: { reason: 'invalid-payload', type: 'state' },
    });
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
  });

  it('refuses an unknown key at every webview-local level of the snapshot', () => {
    const edits: Record<string, (state: Record<string, unknown>) => void> = {
      state: (state) => {
        state['extra'] = SENTINEL;
      },
      connection: (state) => {
        field(state, 'connection')['token'] = SENTINEL;
      },
      capture: (state) => {
        field(state, 'capture')['extra'] = 1;
      },
      progressEntry: (state) => {
        element(state, 'progress', 0)['extra'] = 1;
      },
      latestPanel: (state) => {
        field(state, 'latestPanel')['layout'] = [];
      },
      pairing: (state) => {
        field(state, 'pairing')['extra'] = 1;
      },
      failure: (state) => {
        field(state, 'failure')['details'] = SENTINEL;
      },
    };
    for (const [level, edit] of Object.entries(edits)) {
      const parsed = parseHostToWebviewMessage(stateFrame(edit));
      expect(parsed, level).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'state' },
      });
      expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
    }
  });

  it('refuses every wrong-typed or out-of-range snapshot field', () => {
    const edits: Record<string, (state: Record<string, unknown>) => void> = {
      'connection.status': (state) => {
        field(state, 'connection')['status'] = 'online';
      },
      'connection.serviceUrl': (state) => {
        field(state, 'connection')['serviceUrl'] = 43117;
      },
      'connection.serviceReachable': (state) => {
        field(state, 'connection')['serviceReachable'] = 'yes';
      },
      'connection.provider': (state) => {
        field(state, 'connection')['provider'] = null;
      },
      'progress (not an array)': (state) => {
        state['progress'] = { 0: element(state, 'progress', 0) };
      },
      'progress[].stage empty': (state) => {
        element(state, 'progress', 0)['stage'] = '';
      },
      'progress[].status': (state) => {
        element(state, 'progress', 0)['status'] = 'pending';
      },
      'progress[].message': (state) => {
        element(state, 'progress', 0)['message'] = 7;
      },
      'progress[].detail': (state) => {
        element(state, 'progress', 1)['detail'] = false;
      },
      'progress[].ts negative': (state) => {
        element(state, 'progress', 0)['ts'] = -1;
      },
      'progress[].ts not finite': (state) => {
        element(state, 'progress', 0)['ts'] = Number.POSITIVE_INFINITY;
      },
      'progress[] hole': (state) => {
        state['progress'] = [element(state, 'progress', 0), undefined];
      },
      'relevantFiles[] absolute path': (state) => {
        element(state, 'relevantFiles', 0)['file'] = '/etc/passwd';
      },
      'modifications[] bad status': (state) => {
        element(state, 'modifications', 0)['status'] = 'kept';
      },
      'modifications[] unknown key': (state) => {
        element(state, 'modifications', 0)['extra'] = 1;
      },
      'modificationsTotal negative': (state) => {
        state['modificationsTotal'] = -1;
      },
      'modificationsTotal fractional': (state) => {
        state['modificationsTotal'] = 2.5;
      },
      'modificationsTotal unsafe': (state) => {
        state['modificationsTotal'] = Number.MAX_SAFE_INTEGER + 1;
      },
      'modificationsTotal not a number': (state) => {
        state['modificationsTotal'] = '3';
      },
      'modificationsTotal null': (state) => {
        state['modificationsTotal'] = null;
      },
      'session invalid': (state) => {
        field(state, 'session')['projectRoot'] = 'relative/root';
      },
      'session unknown key': (state) => {
        field(state, 'session')['extra'] = 1;
      },
      'analysis missing metrics': (state) => {
        delete field(state, 'analysis')['metrics'];
      },
      'latestPanel.id empty': (state) => {
        field(state, 'latestPanel')['id'] = '';
      },
      'latestPanel.panelVersion zero': (state) => {
        field(state, 'latestPanel')['panelVersion'] = 0;
      },
      'latestPanel.panelVersion fractional': (state) => {
        field(state, 'latestPanel')['panelVersion'] = 1.5;
      },
      'latestPanel.fallback': (state) => {
        field(state, 'latestPanel')['fallback'] = 'true';
      },
      'target invalid': (state) => {
        field(state, 'target')['url'] = 'not a url';
      },
      'capture.active': (state) => {
        field(state, 'capture')['active'] = 1;
      },
      'capture.captureId empty': (state) => {
        field(state, 'capture')['captureId'] = '';
      },
      'capture.eventCount fractional': (state) => {
        field(state, 'capture')['eventCount'] = 1.5;
      },
      'capture.eventCount negative': (state) => {
        field(state, 'capture')['eventCount'] = -1;
      },
      'cleanup.status': (state) => {
        field(state, 'cleanup')['status'] = 'done';
      },
      'pairing.code empty': (state) => {
        field(state, 'pairing')['code'] = '';
      },
      'pairing.expiresAt': (state) => {
        field(state, 'pairing')['expiresAt'] = Number.NaN;
      },
      'failure.code': (state) => {
        field(state, 'failure')['code'] = 500;
      },
      'failure.hint': (state) => {
        field(state, 'failure')['hint'] = 5;
      },
    };
    for (const [name, edit] of Object.entries(edits)) {
      expect(parseHostToWebviewMessage(stateFrame(edit)), name).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'state' },
      });
    }
  });

  it('reads an optional key holding undefined as absent and omits it from the copy', () => {
    const frame = stateFrame((state) => {
      state['session'] = undefined;
      state['pairing'] = undefined;
      field(state, 'capture')['captureId'] = undefined;
    });
    const parsed = parseHostToWebviewMessage(frame);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'state') {
      expect(Object.hasOwn(parsed.message.state, 'session')).toBe(false);
      expect(Object.hasOwn(parsed.message.state, 'pairing')).toBe(false);
      expect(Object.hasOwn(parsed.message.state.capture, 'captureId')).toBe(false);
    }
  });

  it('carries the embedded schemas’ parsed output, not the received objects', () => {
    // `sourceLocationSchema` strips unknown keys, so a location nested in the
    // analysis reaches the view without them: proof that the copy is the
    // schema's output rather than the input object.
    const frame = stateFrame((state) => {
      const cause = element(field(state, 'analysis'), 'likelyCauses', 0);
      (cause['suggestedLocation'] as Record<string, unknown>)['extra'] = SENTINEL;
    });
    const parsed = parseHostToWebviewMessage(frame);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'state') {
      const location = parsed.message.state.analysis?.likelyCauses[0]?.suggestedLocation;
      expect(location).toStrictEqual(validLocation());
      expect(JSON.stringify(parsed.message)).not.toContain(SENTINEL);
    }
  });

  it('validates notice frames: level vocabulary, text fields and exact keys', () => {
    for (const level of NOTICE_LEVELS) {
      expect(parseHostToWebviewMessage({ type: 'notice', level, message: 'Done.' }).ok).toBe(true);
    }
    const refused = [
      { type: 'notice', level: 'fatal', message: 'Done.' },
      { type: 'notice', message: 'Done.' },
      { type: 'notice', level: 'info' },
      { type: 'notice', level: 'info', message: 7 },
      { type: 'notice', level: 'info', message: 'Done.', hint: 5 },
      { type: 'notice', level: 'info', message: 'Done.', details: SENTINEL },
    ];
    for (const frame of refused) {
      expect(parseHostToWebviewMessage(frame)).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'notice' },
      });
    }
  });

  it('validates pairing frames: an absent code clears, a present one must be whole', () => {
    expect(parseHostToWebviewMessage({ type: 'pairing' })).toStrictEqual({
      ok: true,
      message: { type: 'pairing' },
    });
    const refused = [
      { type: 'pairing', pairing: { code: 'ABCD2345' } },
      { type: 'pairing', pairing: { code: 'ABCD2345', expiresAt: '1' } },
      { type: 'pairing', pairing: { code: 'ABCD2345', expiresAt: NOW, token: SENTINEL } },
      { type: 'pairing', pairing: null },
      { type: 'pairing', code: 'ABCD2345' },
    ];
    for (const frame of refused) {
      expect(parseHostToWebviewMessage(frame)).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'pairing' },
      });
    }
  });

  it('validates focus frames against the section vocabulary', () => {
    for (const section of FOCUS_SECTIONS) {
      expect(parseHostToWebviewMessage({ type: 'focus', section }).ok).toBe(true);
    }
    for (const frame of [
      { type: 'focus' },
      { type: 'focus', section: 'sidebar' },
      { type: 'focus', section: 1 },
    ]) {
      expect(parseHostToWebviewMessage(frame)).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'focus' },
      });
    }
  });

  it('validates actionResult frames: a request id, a request type and a result status', () => {
    for (const action of WEBVIEW_REQUEST_TYPES) {
      for (const status of ACTION_RESULT_STATUSES) {
        const frame = { type: 'actionResult', requestId: REQUEST_ID, action, status };
        expect(parseHostToWebviewMessage(frame), `${action}/${status}`).toStrictEqual({
          ok: true,
          message: frame,
        });
      }
    }
    const valid = { type: 'actionResult', requestId: REQUEST_ID, action: 'endSession' };
    const refused: unknown[] = [
      { type: 'actionResult', action: 'endSession', status: 'accepted' },
      { ...valid },
      { ...valid, status: 'done' },
      { ...valid, status: true },
      { ...valid, status: 'accepted', action: 'ready' },
      { ...valid, status: 'accepted', action: 'openFile' },
      { ...valid, status: 'accepted', action: 'state' },
      { ...valid, status: 'accepted', details: SENTINEL },
      ...INVALID_REQUEST_IDS.map(([requestId]) => ({ ...valid, status: 'failed', requestId })),
    ];
    for (const frame of refused) {
      const parsed = parseHostToWebviewMessage(frame);
      expect(parsed).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'actionResult' },
      });
      expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
    }
  });

  it('refuses a non-object with its closed value class', () => {
    for (const [value, valueType] of NON_OBJECTS) {
      expect(parseHostToWebviewMessage(value), valueType).toStrictEqual({
        ok: false,
        rejection: { reason: 'not-an-object', valueType },
      });
    }
  });

  it('refuses an unknown, missing or inherited type without echoing it', () => {
    for (const frame of [...unknownTypeFrames(), { type: 'askQuestion', question: 'Why?' }]) {
      const parsed = parseHostToWebviewMessage(frame);
      expect(parsed).toStrictEqual({ ok: false, rejection: { reason: 'unknown-type' } });
      expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
    }
  });

  it('never throws, even for a frame whose fields throw when read', () => {
    const hostile = {
      type: 'notice',
      level: 'info',
      get message(): string {
        throw new Error(SENTINEL);
      },
    };
    expect(parseHostToWebviewMessage(hostile)).toStrictEqual({
      ok: false,
      rejection: { reason: 'invalid-payload', type: 'notice' },
    });
  });
});

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

describe('parseWebviewToHostMessage', () => {
  /** The requests whose payload is their `requestId` and nothing else. */
  const idOnlyRequestTypes = WEBVIEW_REQUEST_TYPES.filter(
    (type) => type !== 'askQuestion' && type !== 'askFollowUp' && type !== 'retryStage',
  );

  it('accepts one valid frame of every member and returns an equal, rebuilt copy', () => {
    const samples = webviewSamples();
    for (const type of WEBVIEW_TO_HOST_MESSAGE_TYPES) {
      const sample = samples[type];
      const parsed = parseWebviewToHostMessage(sample);
      expect(parsed, type).toStrictEqual({ ok: true, message: sample });
      if (parsed.ok) {
        expect(parsed.message).not.toBe(sample);
      }
      expect(isWebviewToHostMessage(sample)).toBe(true);
    }
  });

  it('accepts ready only as exactly { type }, without a request id', () => {
    expect(parseWebviewToHostMessage({ type: 'ready' })).toStrictEqual({
      ok: true,
      message: { type: 'ready' },
    });
    for (const frame of [
      { type: 'ready', requestId: REQUEST_ID },
      { type: 'ready', question: SENTINEL },
    ]) {
      const parsed = parseWebviewToHostMessage(frame);
      expect(parsed).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'ready' },
      });
      expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
    }
  });

  it('accepts an id-only request only as exactly { type, requestId }', () => {
    expect(idOnlyRequestTypes).toHaveLength(8);
    expect(idOnlyRequestTypes).toContain('loadModifications');
    for (const type of idOnlyRequestTypes) {
      expect(parseWebviewToHostMessage({ type, requestId: REQUEST_ID }), type).toStrictEqual({
        ok: true,
        message: { type, requestId: REQUEST_ID },
      });
      for (const frame of [{ type }, { type, requestId: REQUEST_ID, question: SENTINEL }]) {
        const parsed = parseWebviewToHostMessage(frame);
        expect(parsed, type).toStrictEqual({
          ok: false,
          rejection: { reason: 'invalid-payload', type },
        });
        expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
      }
    }
  });

  it('refuses every request whose id is missing, malformed or out of bounds', () => {
    const samples = webviewSamples();
    const longest = 'r'.repeat(MAX_WEBVIEW_REQUEST_ID_LENGTH);
    for (const type of WEBVIEW_REQUEST_TYPES) {
      const sample: Record<string, unknown> = { ...samples[type] };
      expect(parseWebviewToHostMessage({ ...sample, requestId: longest }).ok, type).toBe(true);
      expect(parseWebviewToHostMessage({ ...sample, requestId: 'Req_0-9' }).ok, type).toBe(true);

      const withoutId = Object.fromEntries(
        Object.entries(sample).filter(([key]) => key !== 'requestId'),
      );
      const frames = [
        withoutId,
        ...INVALID_REQUEST_IDS.map(([requestId]) => ({ ...sample, requestId })),
      ];
      for (const frame of frames) {
        const parsed = parseWebviewToHostMessage(frame);
        expect(parsed, type).toStrictEqual({
          ok: false,
          rejection: { reason: 'invalid-payload', type },
        });
        expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
      }
    }
  });

  it('forwards a question as typed and refuses a blank, oversized or non-text one', () => {
    for (const type of ['askQuestion', 'askFollowUp'] as const) {
      expect(
        parseWebviewToHostMessage({ type, requestId: REQUEST_ID, question: '  why?  ' }),
      ).toStrictEqual({
        ok: true,
        message: { type, requestId: REQUEST_ID, question: '  why?  ' },
      });
      const longest = 'q'.repeat(MAX_WEBVIEW_QUESTION_LENGTH);
      expect(parseWebviewToHostMessage({ type, requestId: REQUEST_ID, question: longest }).ok).toBe(
        true,
      );

      const requestId = REQUEST_ID;
      const refused = [
        { type, requestId },
        { type, requestId, question: '' },
        { type, requestId, question: ' \n\t ' },
        { type, requestId, question: 5 },
        { type, requestId, question: ['Why?'] },
        { type, requestId, question: `${longest}q` },
        { type, requestId, question: 'Why?', sessionId: SENTINEL },
      ];
      for (const frame of refused) {
        expect(parseWebviewToHostMessage(frame)).toStrictEqual({
          ok: false,
          rejection: { reason: 'invalid-payload', type },
        });
      }
    }
  });

  it('validates an openFile location with the shared SourceLocation schema', () => {
    const withExtra = { ...validLocation(), extra: SENTINEL };
    const parsed = parseWebviewToHostMessage({ type: 'openFile', location: withExtra });
    // The schema strips unknown keys; the copy carries its parsed output only.
    expect(parsed).toStrictEqual({
      ok: true,
      message: { type: 'openFile', location: validLocation() },
    });

    const invalid: Record<string, unknown>[] = [
      { ...validLocation(), file: '../x' },
      { ...validLocation(), file: '/etc/passwd' },
      { ...validLocation(), file: 'src\\lib\\thing.ts' },
      { ...validLocation(), line: 0 },
      { ...validLocation(), column: 1.5 },
      { ...validLocation(), endLine: 1 },
      { ...validLocation(), resolvedBy: 'guess' },
      { ...validLocation(), confidence: 2 },
    ];
    for (const location of invalid) {
      expect(parseWebviewToHostMessage({ type: 'openFile', location })).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'openFile' },
      });
    }
    for (const frame of [{ type: 'openFile' }, { type: 'openFile', location: SOURCE_FILE }]) {
      expect(parseWebviewToHostMessage(frame)).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'openFile' },
      });
    }
  });

  it('refuses an openFile carrying a request id: opening a file is not a request', () => {
    expect(
      parseWebviewToHostMessage({
        type: 'openFile',
        requestId: REQUEST_ID,
        location: validLocation(),
      }),
    ).toStrictEqual({ ok: false, rejection: { reason: 'invalid-payload', type: 'openFile' } });
  });

  it('bounds a retried stage name to 1..MAX_RETRY_STAGE_LENGTH characters', () => {
    const longest = 's'.repeat(MAX_RETRY_STAGE_LENGTH);
    const requestId = REQUEST_ID;
    expect(parseWebviewToHostMessage({ type: 'retryStage', requestId, stage: longest }).ok).toBe(
      true,
    );
    for (const stage of ['', `${longest}s`, 5, undefined]) {
      expect(parseWebviewToHostMessage({ type: 'retryStage', requestId, stage })).toStrictEqual({
        ok: false,
        rejection: { reason: 'invalid-payload', type: 'retryStage' },
      });
    }
  });

  it('refuses a non-object with its closed value class', () => {
    for (const [value, valueType] of NON_OBJECTS) {
      expect(parseWebviewToHostMessage(value), valueType).toStrictEqual({
        ok: false,
        rejection: { reason: 'not-an-object', valueType },
      });
    }
  });

  it('refuses an unknown, missing or inherited type without echoing it', () => {
    for (const frame of [...unknownTypeFrames(), { type: 'state', state: minimalState() }]) {
      const parsed = parseWebviewToHostMessage(frame);
      expect(parsed).toStrictEqual({ ok: false, rejection: { reason: 'unknown-type' } });
      expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
    }
  });
});

// ---------------------------------------------------------------------------
// The request vocabulary
// ---------------------------------------------------------------------------

describe('webview requests', () => {
  it('names as requests exactly the members that carry a request id', () => {
    expect(WEBVIEW_TO_HOST_MESSAGE_TYPES.filter((type) => isWebviewRequestType(type))).toEqual([
      ...WEBVIEW_REQUEST_TYPES,
    ]);
    expect(WEBVIEW_TO_HOST_MESSAGE_TYPES.filter((type) => !isWebviewRequestType(type))).toEqual([
      'ready',
      'openFile',
    ]);
    const samples = webviewSamples();
    for (const type of WEBVIEW_TO_HOST_MESSAGE_TYPES) {
      const sample = samples[type];
      expect(isWebviewRequestMessage(sample), type).toBe(Object.hasOwn(sample, 'requestId'));
    }
  });
});

// ---------------------------------------------------------------------------
// The host's own snapshots
// ---------------------------------------------------------------------------

describe('ExtensionState snapshots pass the webview parser unchanged', () => {
  /**
   * The service the store is configured with, and the endpoint a session is
   * adopted from: a record becomes the active session only through
   * `adoptSession`, as the commands adopt the service's answer — never
   * through `applySessionRecord`, which merges into the active session only.
   */
  const SERVICE_URL = 'http://127.0.0.1:43117';

  let state: ExtensionState | undefined;

  afterEach(() => {
    state?.dispose();
    state = undefined;
  });

  function createState(): ExtensionState {
    state = new ExtensionState({
      serviceUrl: SERVICE_URL,
      provider: 'deterministic',
      now: () => NOW,
    });
    return state;
  }

  function expectAccepted(snapshot: WebviewState): void {
    expect(parseHostToWebviewMessage({ type: 'state', state: snapshot })).toStrictEqual({
      ok: true,
      message: { type: 'state', state: snapshot },
    });
  }

  it('accepts the initial snapshot', () => {
    expectAccepted(createState().toWebviewState());
  });

  it('accepts the snapshot after a session record and every kind of push', () => {
    const store = createState();
    store.setConnectionStatus('open');
    store.setServiceReachable(true);
    store.adoptSession(validSessionRecord(), SERVICE_URL);
    expectAccepted(store.toWebviewState());

    store.applyProgress({
      sessionId: SESSION_ID,
      stage: 'capture',
      status: 'running',
      message: 'Waiting for interactions',
      detail: 'Interact with the page.',
    });
    store.applyCaptureStarted({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    store.applyAnalysis({
      ...validAnalysis(),
      analysisVersion: 2,
      supersedes: ANALYSIS_ID,
      id: 'ana_8c1v5b7n2m4q6w9e',
    });
    const panel: PanelGeneratedPayload = {
      sessionId: SESSION_ID,
      panelId: PANEL_ID,
      panel: {
        version: 1,
        id: PANEL_ID,
        sessionId: SESSION_ID,
        panelVersion: 1,
        title: 'Where the time goes',
        summary: { observed: [], likelyCauses: [] },
        layout: [],
        meta: { fallback: true },
      },
    };
    store.applyPanelGenerated(panel);
    // The element picked in DevTools arrives on a newer record of the session.
    const adopted = validSessionRecord();
    store.applySessionRecord({
      ...adopted,
      updatedAt: adopted.updatedAt + 1,
      target: { ...validTarget(), selector: 'main > button.secondary' },
    });
    store.applyCleanupCompleted({ sessionId: SESSION_ID, status: 'clean', conflicts: [] });
    const journal = validSessionRecord().modifications;
    store.applyModificationJournal(SESSION_ID, journal, journal.length + 3);
    store.setPairing({ code: 'ABCD2345', expiresAt: NOW + 300_000 });
    store.setStageFailure({
      stage: 'analyze',
      code: 'MODEL_UNAVAILABLE',
      message: 'Model provider unavailable.',
    });

    const snapshot = store.toWebviewState();
    expect(Object.keys(snapshot).sort()).toStrictEqual(
      [
        'analysis',
        'capture',
        'cleanup',
        'connection',
        'failure',
        'latestPanel',
        'modifications',
        'modificationsTotal',
        'pairing',
        'progress',
        'relevantFiles',
        'session',
        'target',
      ].sort(),
    );
    expect(snapshot.modificationsTotal).toBe(journal.length + 3);
    expect(snapshot.target?.selector).toBe('main > button.secondary');
    expectAccepted(snapshot);
  });

  it('accepts the snapshot the change event fires', async () => {
    const store = createState();
    const fired: WebviewState[] = [];
    const subscription = store.onDidChange((snapshot) => fired.push(snapshot));
    store.adoptSession(validSessionRecord(), SERVICE_URL);
    await Promise.resolve();
    subscription.dispose();
    expect(fired).toHaveLength(1);
    expectAccepted(fired[0] ?? fail());
  });

  it('parses a realistic full snapshot in a few milliseconds', () => {
    const frame = { type: 'state', state: fullState() };
    // Warm up once so the measurement is of steady-state parsing, not of
    // first-call compilation.
    expect(parseHostToWebviewMessage(frame).ok).toBe(true);
    const iterations = 50;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      parseHostToWebviewMessage(frame);
    }
    const perParse = (performance.now() - started) / iterations;
    // A generous ceiling that still fails on an accidental quadratic walk or a
    // schema rebuilt per call; the measured cost is well under a millisecond.
    expect(perParse).toBeLessThan(10);
  });
});

/** Fails a case whose fixture lacks a value it was built with. */
function fail(): never {
  throw new Error('fixture invariant violated');
}
