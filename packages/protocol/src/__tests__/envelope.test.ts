/**
 * Tests for the WebSocket transport contract — `../envelope.ts` — in the
 * directory `packages/protocol/tsconfig.json` names for this package's suites
 * (AAP 0.8.3).
 *
 * What is on trial here is the **frame**: the shape AAP 0.2.3 fixes
 * (`{ id, type, sessionId?, ts, payload }`), the completeness of the one
 * discriminated union built over it, and the four properties a boundary between
 * four processes lives or dies by. Each group below exists because a producer
 * and a consumer live in different bundles — the local service, the VS Code
 * extension host, the Chrome MV3 service worker and its DevTools panel, and the
 * Node preload — and can only disagree at run time.
 *
 * - **Every message survives a JSON round trip.** An envelope crosses a
 *   WebSocket text frame, a `window.postMessage` hop and a `chrome.runtime`
 *   port, so a payload that only works in memory — a `Date`, a `Map`, a class
 *   instance, a `NaN` — is a defect that shows up on one transport and not the
 *   others. The round-trip case builds a real frame for each of the twenty-five
 *   types and proves the bytes come back unchanged.
 * - **The union covers the vocabulary exactly.** `../messages/index.ts` proves
 *   at compile time that its registry and its tuple agree; this suite proves at
 *   run time that the union has one member per name, no duplicate and no extra,
 *   and that the tuple still names the twenty-five WebSocket messages AAP 0.4.2
 *   specifies — written out literally below so drift fails loudly rather than
 *   quietly redefining the protocol. The five names that are HTTP operations
 *   rather than frames are asserted to be exactly that, so no name from the
 *   user's list is lost in either direction.
 * - **A stray field is a violation, not extra information.** The envelope is a
 *   strict object: a sixth top-level key, a missing `id`, a timestamp on the
 *   wrong time base or a `null` where a key should be absent are all rejected,
 *   because tolerating any of them lets a producer's typo look like a valid
 *   frame — a silently dropped `sessionId` is a frame that parses and reaches
 *   nobody.
 * - **A rejected frame is never echoed (AAP 0.5.2).** A frame that fails
 *   validation is unvalidated data from another process and routinely carries
 *   telemetry attributes, a database statement, a URL or a bearer credential.
 *   The service logs every parse failure, both user interfaces show it and a
 *   session may persist it, and none of those paths passes through the redaction
 *   layer. The leak case plants a sentinel in a rejected payload and asserts it
 *   appears in no part of the resulting error — message, hint, details or the
 *   payload that crosses the wire.
 */

import { describe, expect, it } from 'vitest';

import { DEBUGGEN_ERROR_CODES } from '@debuggen/shared';
import { computeCaptureSummary } from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryEventIngress } from '@debuggen/telemetry';

import type { AnalysisResult } from '../analysis.js';
import {
  createEnvelope,
  decodeMessage,
  encodeMessage,
  envelopeBaseShape,
  isMessageOfType,
  assertExhaustiveMessage,
  parseMessage,
  protocolMessageSchema,
} from '../envelope.js';
import type {
  CreateEnvelopeOptions,
  MessageByType,
  MessagePayload,
  MessageTypeOf,
  ProtocolMessage,
  ProtocolMessageMap,
  ProtocolMessageSchema,
} from '../envelope.js';
import { HTTP_OPERATIONS } from '../http.js';
import {
  HTTP_ONLY_PAYLOAD_NAMES,
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
} from '../messages/index.js';
import type { MessageType } from '../messages/index.js';
import type { SessionRecord } from '../session-record.js';
import { PROTOCOL_VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// Deterministic throughout: every id, hash and timestamp is a literal, so no
// assertion depends on a clock or on a random generator, and a failure names one
// field rather than a whole frame.
// ---------------------------------------------------------------------------

/** The frame identifier injected into every envelope these cases build. */
const MESSAGE_ID = 'msg_2f4h6k8m0p1r3t5v';

/** The session every session-scoped fixture belongs to. */
const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

/** The capture the telemetry fixtures were recorded during. */
const CAPTURE_ID = 'cap_7f3q0m2zk1x8ab9c';

/** The generated panel the panel fixture carries. */
const PANEL_ID = 'pan_6h2j8k4l0z5x1c7v';

/** The analysis the `analysis.completed` fixture carries. */
const ANALYSIS_ID = 'ana_3g7j1k5m9p2r6t0v';

/** The journal entry the `instrumentation.ready` fixture reports. */
const MODIFICATION_ID = 'mod_5b1n7m3q9w2e4r6t';

/** The plan action the `instrumentation.plan` fixture carries. */
const ACTION_ID = 'act_9q2w4e6r8t0y1u3i';

/** The producer that emitted the event fixtures: one page document's agent. */
const PRODUCER_ID = 'prd_8x4c2v6b0n1m5q3w';

/** Chrome's per-document identifier for the inspected document. */
const DOCUMENT_ID = 'doc_1a3c5e7g9i0k2m4o';

/** A 32-character lowercase hexadecimal trace id, from a repeating seed. */
const TRACE_ID = '3f2a'.repeat(8);

/** A 16-character lowercase hexadecimal span id. */
const SPAN_ID = '1b2c3d4e5f60718a';

/** The inspected Chrome tab. Never `-1`, which is `chrome.tabs.TAB_ID_NONE`. */
const TAB_ID = 7;

/** The developer's workspace folder: absolute, POSIX, on their own machine. */
const PROJECT_ROOT = '/home/example/workspace/site';

/** A project-relative source path, the only spelling a located item accepts. */
const SOURCE_FILE = 'src/lib/thing.ts';

/** The dev server the fixture session is bound to. */
const DEV_SERVER_URL = 'http://localhost:3000';

/** That dev server's serialized origin: no path, no trailing slash. */
const ORIGIN = 'http://localhost:3000';

/** The document the fixture tab has open. */
const PAGE_URL = `${DEV_SERVER_URL}/section/item`;

/**
 * A fixed point in time — 2025-09-16T05:20:00Z — used as both the frame
 * timestamp and the base of every fixture's own times, so the whole suite is
 * clock-independent.
 */
const SENT_AT = 1_758_000_000_000;

/**
 * An obviously fake bearer credential.
 *
 * `client.hello` carries a real credential in production (AAP 0.5.6); a fixture
 * must therefore be a value no provider pattern can match and no scanner can
 * mistake for a leak, which is what `scripts/check-secrets.mjs` is there to
 * enforce.
 */
const CREDENTIAL_PLACEHOLDER = 'devtools-credential-placeholder';

/**
 * The string planted in the leak case's rejected payload.
 *
 * It stands in for the classes of data a real rejected frame carries — a
 * database statement, a URL with query parameters, a React prop preview — and
 * its absence from every part of the error is the assertion (AAP 0.5.2).
 */
const SENTINEL = 'do-not-echo-this-value';

/**
 * A 64-character lowercase hexadecimal digest, built from a repeating seed.
 *
 * @param seed Two characters, repeated to fill the digest.
 * @returns A value a modification record's hash fields accept.
 */
function hashFixture(seed: string): string {
  return seed.repeat(32).slice(0, 64);
}

/** One event as a producer sends it: no `sessionId`, `captureId` or `ingestSeq`. */
const INGRESS_EVENT: TelemetryEventIngress = {
  id: 'evt_1a2b3c4d5e6f7g8h',
  traceId: TRACE_ID,
  spanId: SPAN_ID,
  kind: 'interaction',
  name: 'click primary action',
  startTime: SENT_AT,
  duration: 12.5,
  tier: 'browser',
  attributes: { 'event.type': 'click' },
  status: 'ok',
  producerId: PRODUCER_ID,
  seq: 0,
};

/** The same event as the store holds it, with the three attribution fields. */
const STORED_EVENT: TelemetryEvent = {
  ...INGRESS_EVENT,
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  ingestSeq: 1,
};

/** A database statement, redacted to its parameterized form, on the `db` tier. */
const QUERY_EVENT: TelemetryEvent = {
  id: 'evt_5e6f7g8h9i0j1k2l',
  traceId: TRACE_ID,
  spanId: '5f60718a9b2c3d4e',
  parentSpanId: SPAN_ID,
  kind: 'db.query',
  name: 'SELECT',
  startTime: SENT_AT + 18,
  duration: 612,
  tier: 'db',
  attributes: {
    'db.system': 'postgresql',
    'db.statement': 'SELECT id FROM records WHERE owner_id = $1',
    'db.rowCount': 3,
  },
  status: 'ok',
  producerId: 'prd_9y5d3b7n1m2q6w4e',
  seq: 0,
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  ingestSeq: 2,
};

/** The summary a stopped capture answers with, computed by its owner. */
const CAPTURE_SUMMARY = computeCaptureSummary([STORED_EVENT, QUERY_EVENT], {
  captureId: CAPTURE_ID,
  sessionId: SESSION_ID,
});

/** A minimal session record: every required field, nothing invented. */
const SESSION_RECORD: SessionRecord = {
  id: SESSION_ID,
  projectRoot: PROJECT_ROOT,
  projectName: 'site',
  devServerUrl: DEV_SERVER_URL,
  createdAt: SENT_AT,
  updatedAt: SENT_AT + 120_000,
  status: 'generated',
  question: 'Why does this action take so long?',
  followUps: [],
  relevantFiles: [],
  plans: [],
  modifications: [],
  captures: [],
  panelIds: [PANEL_ID],
  analyses: [],
  cleanup: { status: 'clean', completedAt: SENT_AT + 119_000, conflicts: [] },
  promptVersions: {},
  provider: { id: 'deterministic' },
};

/** A stored analysis with no findings: the shape, without inventing evidence. */
const ANALYSIS: AnalysisResult = {
  id: ANALYSIS_ID,
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  analysisVersion: 1,
  createdAt: SENT_AT + 100_000,
  observed: [],
  likelyCauses: [],
  metrics: [],
};

/**
 * A valid payload for every message type, keyed by type.
 *
 * The mapped type is the point: a missing key, or a payload of the wrong shape
 * for its type, is a compile error — so this table cannot fall behind the
 * registry it mirrors, and a twenty-sixth message type fails `tsc -b` here as
 * well as in `../messages/index.ts`.
 */
const VALID_PAYLOADS: { readonly [K in MessageType]: MessagePayload<K> } = {
  'client.hello': {
    client: 'devtools',
    tabId: TAB_ID,
    version: PROTOCOL_VERSION,
    token: CREDENTIAL_PLACEHOLDER,
  },
  'agent.ready': {
    tabId: TAB_ID,
    documentId: DOCUMENT_ID,
    producerId: PRODUCER_ID,
    url: PAGE_URL,
    installedBeforeReact: true,
    reactDetected: true,
  },
  'agent.config': {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    hooks: {
      interactions: true,
      react: true,
      state: true,
      fetch: true,
      perf: true,
      errors: true,
      componentTree: false,
    },
  },
  'server-agent.config': {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    signals: {
      http: true,
      routeHandlers: true,
      fetch: true,
      prisma: false,
      pg: true,
      functions: ['handleAction'],
    },
  },
  'session.bind': { tabId: TAB_ID, url: PAGE_URL, origin: ORIGIN, sessionId: SESSION_ID },
  'session.bound': { sessionId: SESSION_ID, tabId: TAB_ID, url: PAGE_URL, reason: 'bound' },
  'tab.navigated': { tabId: TAB_ID, url: PAGE_URL },
  'session.unbind': { tabId: TAB_ID },
  'session.created': { session: SESSION_RECORD },
  'session.updated': { session: SESSION_RECORD },
  'session.progress': {
    sessionId: SESSION_ID,
    stage: 'investigate',
    status: 'done',
    message: 'Traced event handler',
  },
  'analysis.completed': { sessionId: SESSION_ID, analysis: ANALYSIS },
  'capture.started': { sessionId: SESSION_ID, captureId: CAPTURE_ID },
  'capture.stopped': {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    summary: CAPTURE_SUMMARY,
  },
  'instrumentation.plan': {
    sessionId: SESSION_ID,
    plan: {
      version: 1,
      planVersion: 1,
      sessionId: SESSION_ID,
      objective: 'Determine where the time in this interaction is spent',
      hypotheses: ['The slowest span is on the server tier'],
      capture: ['click event timing', 'server request spans'],
      instrumentationTargets: [
        {
          id: ACTION_ID,
          file: SOURCE_FILE,
          symbol: 'handleAction',
          type: 'function-timing',
          adapter: 'nextjs',
          mode: 'patch',
          rationale: 'Time the named function the objective points at',
        },
      ],
    },
  },
  'instrumentation.ready': {
    sessionId: SESSION_ID,
    applied: [
      {
        id: MODIFICATION_ID,
        sessionId: SESSION_ID,
        planVersion: 1,
        file: SOURCE_FILE,
        originalHash: hashFixture('1a'),
        backupPath: `/home/example/.debuggen/backups/${SESSION_ID}/${hashFixture('1a')}`,
        instrumentedHash: hashFixture('2b'),
        appliedAt: SENT_AT + 500,
        status: 'applied',
        diff: `--- a/${SOURCE_FILE}\n+++ b/${SOURCE_FILE}\n`,
      },
    ],
    runtimeHooks: ['interactions', 'react'],
    unavailable: [
      {
        signal: 'prisma',
        reason: 'the dev server was not started with the telemetry preload',
        hint: 'Relaunch the dev server from the Debug Generator view.',
      },
    ],
  },
  'instrumentation.failed': {
    sessionId: SESSION_ID,
    error: {
      code: 'INSTRUMENTATION_INSTALL_FAILED',
      message: 'no signal could be enabled',
      hint: 'Start the dev server through the extension so the preload is attached.',
    },
  },
  'telemetry.event': { events: [INGRESS_EVENT] },
  'telemetry.tail': { sessionId: SESSION_ID, events: [STORED_EVENT, QUERY_EVENT] },
  'panel.generated': {
    sessionId: SESSION_ID,
    panelId: PANEL_ID,
    panel: {
      version: 1,
      id: PANEL_ID,
      sessionId: SESSION_ID,
      panelVersion: 1,
      title: 'Where the time went',
      summary: { observed: [], likelyCauses: [] },
      layout: [],
    },
  },
  'source.open': {
    sessionId: SESSION_ID,
    location: {
      file: SOURCE_FILE,
      line: 42,
      column: 3,
      symbol: 'handleAction',
      resolvedBy: 'code-graph',
      confidence: 0.9,
    },
  },
  'target.request': { sessionId: SESSION_ID },
  'target.selected': {
    sessionId: SESSION_ID,
    target: {
      selector: 'main > form > button.primary',
      tagName: 'button',
      text: 'Submit',
      componentChain: ['PrimaryAction', 'ActionForm'],
      url: PAGE_URL,
    },
  },
  'cleanup.completed': { sessionId: SESSION_ID, status: 'clean', conflicts: [] },
  error: { code: 'MODEL_UNAVAILABLE', message: 'provider unavailable', ref: MESSAGE_ID },
};

/**
 * Builds the deterministic frame for one message type.
 *
 * Generic in `K` so the payload handed to `createEnvelope` is the payload of
 * *that* type rather than the union of all of them — which is also what lets
 * the loop below assert per-type properties without a cast.
 */
function frameFor<K extends MessageType>(type: K): MessageByType<K> {
  return createEnvelope(type, VALID_PAYLOADS[type], { id: MESSAGE_ID, ts: SENT_AT });
}

/** Every message's deterministic frame, keyed by type. */
type FrameTable = { readonly [K in MessageType]: MessageByType<K> };

/**
 * The frame table, built mechanically from {@link frameFor}.
 *
 * Indexing it with a *literal* type yields that message's envelope type, and
 * indexing it with the whole `MessageType` union yields exactly
 * `ProtocolMessage` — which is what lets the round-trip case below iterate the
 * vocabulary and still hand `encodeMessage` a properly paired frame.
 * `Object.fromEntries` cannot express a mapped return type, hence the one
 * assertion; the pairing inside each entry is still checked, because
 * {@link frameFor} is generic and {@link VALID_PAYLOADS} is a mapped table, and
 * a key missing at run time would fail every case in the loop.
 */
const VALID_FRAMES = Object.fromEntries(
  MESSAGE_TYPES.map((type) => [type, frameFor(type)]),
) as FrameTable;

/**
 * The twenty-five WebSocket message names AAP 0.4.2 specifies, written out.
 *
 * Deliberately not derived from `MESSAGE_TYPES`: a test that recomputed the
 * expectation from the value under test would agree with any drift. The order
 * here is the order the AAP documents them in, which is not the order the tuple
 * declares them in, so the comparison below is over sets.
 */
const AAP_WEBSOCKET_MESSAGE_NAMES = [
  'client.hello',
  'session.bind',
  'session.bound',
  'session.unbind',
  'tab.navigated',
  'session.created',
  'session.updated',
  'session.progress',
  'target.request',
  'target.selected',
  'instrumentation.plan',
  'instrumentation.ready',
  'instrumentation.failed',
  'capture.started',
  'capture.stopped',
  'agent.ready',
  'agent.config',
  'server-agent.config',
  'telemetry.event',
  'telemetry.tail',
  'analysis.completed',
  'panel.generated',
  'source.open',
  'cleanup.completed',
  'error',
] as const;

/**
 * The five names from the same AAP list that are **HTTP operations**, not
 * frames.
 *
 * They are asserted against `../http.js` below so that no verbatim name from the
 * user's vocabulary is lost: a socket client must not be able to send
 * `session.end` as a frame and expect the effect of the route.
 */
const AAP_HTTP_ONLY_NAMES = [
  'session.create',
  'session.question',
  'session.end',
  'capture.start',
  'capture.stop',
] as const;

/** A valid frame as a plain record, for the strictness cases to mutate. */
function baseFrame(): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    type: 'session.unbind',
    ts: SENT_AT,
    payload: { tabId: TAB_ID },
  };
}

describe('protocolMessageSchema — one member per declared message type', () => {
  it('has exactly as many options as there are message types', () => {
    expect(protocolMessageSchema.options).toHaveLength(MESSAGE_TYPES.length);
    expect(MESSAGE_TYPES).toHaveLength(25);
  });

  it('discriminates on exactly the declared type names, with no duplicate or extra', () => {
    const discriminators = protocolMessageSchema.options.map((option) => option.shape.type.value);

    // Set equality in both directions: a duplicated member and a missing one
    // would both leave the sets unequal, and the array comparison that follows
    // pins the declaration order the union was built in.
    expect(new Set(discriminators)).toEqual(new Set(MESSAGE_TYPES));
    expect(discriminators).toEqual([...MESSAGE_TYPES]);
    expect(new Set(MESSAGE_TYPES).size).toBe(MESSAGE_TYPES.length);
  });

  it('names exactly the WebSocket messages AAP 0.4.2 specifies', () => {
    expect([...MESSAGE_TYPES].sort()).toEqual([...AAP_WEBSOCKET_MESSAGE_NAMES].sort());
    expect(Object.keys(MESSAGE_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...AAP_WEBSOCKET_MESSAGE_NAMES].sort(),
    );
  });

  it('keeps the five HTTP operation names out of the union and in the route table', () => {
    for (const name of AAP_HTTP_ONLY_NAMES) {
      expect(MESSAGE_TYPES).not.toContain(name);
      expect(HTTP_ONLY_PAYLOAD_NAMES).toContain(name);
      expect(HTTP_OPERATIONS).toContain(name);
    }
  });

  it('declares the four shared envelope fields once, in envelopeBaseShape', () => {
    expect(Object.keys(envelopeBaseShape)).toEqual(['id', 'sessionId', 'ts']);
    expect(Object.isFrozen(envelopeBaseShape)).toBe(true);

    for (const option of protocolMessageSchema.options) {
      expect(Object.keys(option.shape).sort()).toEqual(
        ['id', 'payload', 'sessionId', 'ts', 'type'].sort(),
      );
    }
  });
});

describe('round trip — every message survives encode, decode and re-encode', () => {
  it.each([...MESSAGE_TYPES])('%s', (type) => {
    const frame = VALID_FRAMES[type];
    const encoded = encodeMessage(frame);
    const decoded = decodeMessage(encoded);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }

    // Deep equality proves the payload is JSON-safe: a Date, a Map, a class
    // instance or a NaN does not survive a round trip unchanged, and a dropped
    // optional key or an added default would show up here too.
    expect(decoded.value).toStrictEqual(frame);
    expect(decoded.value.type).toBe(type);
    expect(Object.keys(decoded.value).sort()).toEqual(Object.keys(frame).sort());

    // Re-encoding and decoding again is idempotent, which is the honest form of
    // "nothing was added on the way". Byte equality deliberately is not
    // asserted: a validated frame's keys come back in the schema's shape order
    // rather than the sender's insertion order, and JSON key order carries no
    // meaning on this wire.
    const reDecoded = decodeMessage(encodeMessage(decoded.value));

    expect(reDecoded.ok).toBe(true);
    if (!reDecoded.ok) {
      return;
    }
    expect(reDecoded.value).toStrictEqual(decoded.value);
  });

  it('accepts a structured-clone hop, where the value was never text', () => {
    const frame = frameFor('telemetry.event');
    const cloned: unknown = structuredClone(frame);

    const parsed = decodeMessage(cloned);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value).toEqual(frame);
  });
});

describe('parseMessage — rejections are typed, total and silent about the value', () => {
  it('rejects an unknown message type', () => {
    const parsed = parseMessage({
      id: MESSAGE_ID,
      type: 'does.not.exist',
      ts: SENT_AT,
      payload: {},
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('Invalid protocol message');
  });

  it.each([
    ['a stray top-level key', { ...baseFrame(), extra: true }],
    ['a missing id', { type: 'session.unbind', ts: SENT_AT, payload: { tabId: TAB_ID } }],
    ['an empty id', { ...baseFrame(), id: '' }],
    ['a missing ts', { id: MESSAGE_ID, type: 'session.unbind', payload: { tabId: TAB_ID } }],
    ['a missing payload', { id: MESSAGE_ID, type: 'session.unbind', ts: SENT_AT }],
    ['a missing type', { id: MESSAGE_ID, ts: SENT_AT, payload: { tabId: TAB_ID } }],
    ['a null sessionId', { ...baseFrame(), sessionId: null }],
    ['a payload of the wrong shape', { ...baseFrame(), payload: { tabId: -1 } }],
    ['a payload with a stray key', { ...baseFrame(), payload: { tabId: TAB_ID, extra: 1 } }],
    ['a seconds-precision ts', { ...baseFrame(), ts: Math.trunc(SENT_AT / 1000) }],
    ['a relative performance ts', { ...baseFrame(), ts: 1234.5 }],
    ['a microsecond-scale ts', { ...baseFrame(), ts: SENT_AT * 1000 }],
    ['a NaN ts', { ...baseFrame(), ts: Number.NaN }],
    ['a non-object frame', 'session.unbind'],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    const parsed = parseMessage(value);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('accepts a frame with no sessionId key at all', () => {
    const parsed = parseMessage(baseFrame());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.sessionId).toBeUndefined();
  });

  it('never echoes a rejected value, in any part of the error (AAP 0.5.2)', () => {
    const parsed = parseMessage({
      id: MESSAGE_ID,
      type: 'telemetry.tail',
      ts: SENT_AT,
      payload: {
        sessionId: SESSION_ID,
        events: [
          { ...STORED_EVENT, kind: SENTINEL, name: SENTINEL, attributes: { url: SENTINEL } },
        ],
      },
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    const { error } = parsed;
    const surfaces = [
      error.message,
      error.hint ?? '',
      JSON.stringify(error.details ?? {}),
      JSON.stringify(error.toPayload()),
    ];

    for (const surface of surfaces) {
      expect(surface).not.toContain(SENTINEL);
    }

    // The code stays in the shared vocabulary, and the message still says which
    // field failed — a leak-free error is not a useless one.
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.message).toContain('payload.events[0].kind');
  });
});

describe('decodeMessage — text that is not JSON', () => {
  it('rejects malformed JSON without quoting it', () => {
    const malformed = `{"id":"${MESSAGE_ID}","type":"session.unbind","ts":${String(SENT_AT)},`;

    const parsed = decodeMessage(malformed);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toBe('Invalid protocol message: the frame is not valid JSON');
    expect(parsed.error.message).not.toContain(MESSAGE_ID);
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(MESSAGE_ID);
  });

  it('rejects valid JSON that is not a frame', () => {
    const parsed = decodeMessage('{"hello":"world"}');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('refuses a frame carrying a prototype-polluting key, and pollutes nothing', () => {
    const hostile = `{"id":"${MESSAGE_ID}","type":"session.unbind","ts":${String(
      SENT_AT,
    )},"payload":{"tabId":${String(TAB_ID)}},"__proto__":{"polluted":true}}`;

    const parsed = decodeMessage(hostile);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect({}).not.toHaveProperty('polluted');
  });
});

describe('createEnvelope — deterministic, non-mutating, routable', () => {
  it('honours an injected id and timestamp', () => {
    const first = createEnvelope(
      'target.request',
      { sessionId: SESSION_ID },
      {
        id: MESSAGE_ID,
        ts: SENT_AT,
      },
    );
    const second = createEnvelope(
      'target.request',
      { sessionId: SESSION_ID },
      {
        id: MESSAGE_ID,
        ts: SENT_AT,
      },
    );

    expect(encodeMessage(first)).toBe(encodeMessage(second));
    expect(first.id).toBe(MESSAGE_ID);
    expect(first.ts).toBe(SENT_AT);
  });

  it('mints an id and a timestamp when none is injected', () => {
    const before = Date.now();
    const frame = createEnvelope('session.unbind', { tabId: TAB_ID });
    const after = Date.now();

    expect(frame.id).not.toBe('');
    expect(frame.ts).toBeGreaterThanOrEqual(before);
    expect(frame.ts).toBeLessThanOrEqual(after);
    expect(parseMessage(frame).ok).toBe(true);
  });

  it('lifts a sessionId off the payload so a call site cannot break routing', () => {
    const frame = frameFor('session.progress');

    expect(frame.sessionId).toBe(SESSION_ID);
    expect(frame.payload.sessionId).toBe(SESSION_ID);
  });

  it('prefers an explicitly supplied sessionId over the payload’s', () => {
    const other = 'ses_0z9y8x7w6v5u4t3s';

    const frame = createEnvelope('session.progress', VALID_PAYLOADS['session.progress'], {
      sessionId: other,
      id: MESSAGE_ID,
      ts: SENT_AT,
    });

    expect(frame.sessionId).toBe(other);
    expect(frame.payload.sessionId).toBe(SESSION_ID);
  });

  it('omits the sessionId key entirely when there is none', () => {
    const frame = frameFor('client.hello');

    expect('sessionId' in frame).toBe(false);
    expect(JSON.parse(encodeMessage(frame))).not.toHaveProperty('sessionId');
    expect(encodeMessage(frame)).not.toContain('sessionId');
  });

  it('does not mutate or copy the payload it was given', () => {
    const payload = VALID_PAYLOADS['telemetry.event'];
    const snapshot: unknown = JSON.parse(JSON.stringify(payload));

    const frame = createEnvelope('telemetry.event', payload, { id: MESSAGE_ID, ts: SENT_AT });

    expect(frame.payload).toBe(payload);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(snapshot);
  });

  it('serialises the envelope fields in the documented order', () => {
    expect(Object.keys(frameFor('session.progress'))).toEqual([
      'id',
      'type',
      'sessionId',
      'ts',
      'payload',
    ]);
  });
});

describe('isMessageOfType and assertExhaustiveMessage — narrowing and exhaustiveness', () => {
  it('narrows a frame to its own payload type', () => {
    const frame: ProtocolMessage = frameFor('session.progress');

    expect(isMessageOfType(frame, 'panel.generated')).toBe(false);
    expect(isMessageOfType(frame, 'session.progress')).toBe(true);

    if (!isMessageOfType(frame, 'session.progress')) {
      expect.unreachable('the guard must narrow the fixture frame');
      return;
    }

    // Reading these fields without a cast is the assertion: they exist only on
    // the `session.progress` payload, so this line fails `tsc -b` if the guard
    // stops narrowing.
    const stage: string = frame.payload.stage;
    const status: string = frame.payload.status;
    expect([stage, status]).toEqual(['investigate', 'done']);
  });

  it('throws for a message type a switch did not handle', () => {
    const rogue = { ...baseFrame(), type: 'not.a.message' } as unknown as never;

    expect(() => assertExhaustiveMessage(rogue)).toThrow(/Unhandled protocol message type/);
  });
});

describe('type-level guarantees', () => {
  /** Accepts `true` and nothing else, so a comparison becomes an assertion. */
  type AssertTrue<T extends true> = T;

  /**
   * The payload of `panel.generated` carries the fields AAP 0.4.2 specifies,
   * resolved through the registry rather than restated.
   */
  type PanelPayloadIsResolved = AssertTrue<
    MessageByType<'panel.generated'>['payload'] extends {
      sessionId: string;
      panelId: string;
      panel: { id: string; layout: readonly unknown[] };
    }
      ? true
      : false
  >;

  /** A frame's `type` is the literal it was built for, not the whole union. */
  type PanelTypeIsLiteral = AssertTrue<
    MessageByType<'panel.generated'>['type'] extends 'panel.generated' ? true : false
  >;

  /** The map form and the union form describe the same frames. */
  type MapAgreesWithUnion = AssertTrue<
    ProtocolMessageMap['source.open'] extends MessageByType<'source.open'>
      ? MessageByType<'source.open'> extends ProtocolMessageMap['source.open']
        ? true
        : false
      : false
  >;

  /** `MessageTypeOf` recovers the literal discriminant of a single frame type. */
  type TypeOfRecoversLiteral = AssertTrue<
    MessageTypeOf<MessageByType<'cleanup.completed'>> extends 'cleanup.completed' ? true : false
  >;

  it('resolves a payload type from the registry and keeps the discriminant literal', () => {
    const payloadResolved: PanelPayloadIsResolved = true;
    const typeIsLiteral: PanelTypeIsLiteral = true;
    const mapAgrees: MapAgreesWithUnion = true;
    const typeOfWorks: TypeOfRecoversLiteral = true;

    expect([payloadResolved, typeIsLiteral, mapAgrees, typeOfWorks]).toEqual([
      true,
      true,
      true,
      true,
    ]);

    const frame = frameFor('panel.generated');
    expect(frame.payload.panel.id).toBe(PANEL_ID);
  });

  it('accepts the options object by its exported type, and the schema by its own', () => {
    // Naming both exported types is the assertion: a consumer that holds its
    // overrides in a variable, or takes the validator by injection, must be able
    // to spell them without reaching into Zod's internals.
    const options: CreateEnvelopeOptions = { id: MESSAGE_ID, ts: SENT_AT };
    const schema: ProtocolMessageSchema = protocolMessageSchema;

    const frame = createEnvelope('target.request', { sessionId: SESSION_ID }, options);

    expect(schema.safeParse(frame).success).toBe(true);
    expect(frame.id).toBe(MESSAGE_ID);
  });
});
