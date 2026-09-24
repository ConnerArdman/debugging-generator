/**
 * Tests for the WebSocket transport contract — `../envelope.ts` — in the
 * directory `packages/protocol/tsconfig.json` names for this package's suites
 * (AAP 0.8.3).
 *
 * Provenance: this suite covers `../envelope.ts`, the primitives it is built
 * from in `../version.ts`, the registry vocabulary of `../messages/index.ts`,
 * the HTTP-only operation names of `../http.ts` and the package barrel
 * `../index.ts`. It constructs no transport client: the WebSocket and HTTP
 * clients have their own suites.
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
 *   types and proves the decoded value is deep-equal to the frame that was
 *   sent — no key dropped, added or retyped. Byte equality is not the claim:
 *   a validated frame comes back in the schema's key order.
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
 *   layer. The leak cases plant a sentinel — in a rejected payload, in an
 *   unknown `type`, in a `client.hello` credential, in text that is not JSON —
 *   and assert it appears in no part of the resulting error: message, hint,
 *   details, stack, serialised form or the payload that crosses the wire.
 * - **The primitives underneath are what the envelope claims they are.**
 *   `../version.ts` supplies the wire version and its handshake predicate, the
 *   epoch-millisecond timestamp every frame carries, the leak-free issue
 *   renderer every rejection is built by, and `opaqueSchema`, whose one job is
 *   to refuse the `undefined` a bare `z.custom<T>()` accepts. Each is exercised
 *   directly, because every guarantee above rests on it.
 * - **The barrel is the whole door.** `../index.ts` is the single `"."` entry of
 *   this package, so a symbol it forgets is invisible to all three apps and a
 *   symbol it adds carelessly is an upstream package's runtime inside three
 *   bundles. The last group is this package's own boundary check — every value
 *   the package's own modules export reaches the barrel unchanged, the only
 *   borrowed values are the named closed vocabularies, there is no default
 *   export, and re-evaluating the barrel does nothing observable — and it lives
 *   here, in the suite that already holds the union, because AAP 0.8.3 fixes
 *   this package at three suites.
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import * as zodPackage from 'zod';

// The owning packages as namespaces, next to the named imports from each: the
// barrel group below decides whether a barrel value is borrowed by asking which
// package publishes it, so a module this package adds behind its barrel can
// never be mistaken for an upstream leak.
import * as instrumentationPackage from '@debuggen/instrumentation';
import {
  CONFIDENCE_LEVELS,
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
} from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import * as panelSchemaPackage from '@debuggen/panel-schema';
import { DEBUGGEN_ERROR_CODES, DebuggenError, ID_PREFIXES } from '@debuggen/shared';
import * as sharedPackage from '@debuggen/shared';
import {
  MAX_EPOCH_MS,
  METRIC_IDS,
  MIN_EPOCH_MS,
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  computeCaptureSummary,
} from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryEventIngress } from '@debuggen/telemetry';
import * as telemetryPackage from '@debuggen/telemetry';

import type { AnalysisResult } from '../analysis.js';
import * as analysisModule from '../analysis.js';
import * as httpClientModule from '../client/http-client.js';
import * as wsClientModule from '../client/ws-client.js';
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
import * as envelopeModule from '../envelope.js';
import { HTTP_OPERATIONS, HTTP_ROUTES } from '../http.js';
import * as httpModule from '../http.js';
// The namespace import is the assertion: it is how a consumer of the published
// `"."` entry sees this package, so the barrel group below can only observe
// what an app can observe.
import * as protocol from '../index.js';
import {
  HTTP_ONLY_PAYLOAD_NAMES,
  HTTP_ONLY_PAYLOAD_SCHEMAS,
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
} from '../messages/index.js';
import type {
  MessageType,
  PanelGeneratedPayload,
  SessionProgressPayload,
} from '../messages/index.js';
import * as messagesModule from '../messages/index.js';
import type { SessionRecord } from '../session-record.js';
import * as sessionRecordModule from '../session-record.js';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MAJOR,
  PROTOCOL_VERSION_PATTERN,
  describeZodIssues,
  epochMsSchema,
  isCompatibleProtocolVersion,
  isPlainRecord,
  opaqueArraySchema,
  opaqueSchema,
  parseProtocolVersion,
  protocolParseError,
  protocolVersionSchema,
  recordWithKeys,
} from '../version.js';
import * as versionModule from '../version.js';

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

/** The generated panel the panel fixture carries, in the `pnl_` id grammar. */
const PANEL_ID = 'pnl_6h2j8k4l0z5x1c7v';

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
  'tab.navigated',
  'session.unbind',
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

/**
 * The method and path AAP 0.4.2 gives each of those five operations, written
 * out for the same reason as the list above: the route table is the value
 * under test, so the expectation cannot be read from it.
 */
const AAP_HTTP_ONLY_ROUTES: {
  readonly [K in (typeof AAP_HTTP_ONLY_NAMES)[number]]: {
    readonly method: 'POST';
    readonly pattern: string;
  };
} = {
  'session.create': { method: 'POST', pattern: '/sessions' },
  'session.question': { method: 'POST', pattern: '/sessions/:id/question' },
  'session.end': { method: 'POST', pattern: '/sessions/:id/end' },
  'capture.start': { method: 'POST', pattern: '/sessions/:id/capture/start' },
  'capture.stop': { method: 'POST', pattern: '/sessions/:id/capture/stop' },
};

/**
 * The shape `newMessageId()` from `@debuggen/shared` mints: the message prefix,
 * one underscore and sixteen characters of `[0-9a-z]`.
 */
const MINTED_MESSAGE_ID_PATTERN = new RegExp(`^${ID_PREFIXES.message}_[0-9a-z]{16}$`);

/** A valid frame as a plain record, for the strictness cases to mutate. */
function baseFrame(): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    type: 'session.unbind',
    ts: SENT_AT,
    payload: { tabId: TAB_ID },
  };
}

/**
 * Every place a rejection's content can surface once it leaves this package:
 * the message and hint a user interface shows, the structured details a log
 * line carries, the payload an `error` frame sends, the error's own serialised
 * and string forms, and its stack.
 *
 * @param error The rejection to inspect.
 * @returns Each surface as text, so a planted value can be searched for.
 */
function errorSurfaces(error: DebuggenError): readonly string[] {
  return [
    error.message,
    error.hint ?? '',
    JSON.stringify(error.details ?? {}),
    JSON.stringify(error.toPayload()),
    JSON.stringify(error),
    String(error),
    error.stack ?? '',
  ];
}

/**
 * Asserts that a planted value reached no surface of a rejection and that no
 * underlying error rides along as a `cause` (a `SyntaxError` or a `ZodError`
 * would carry the rejected input with it).
 *
 * @param error The rejection to inspect.
 * @param planted The value that must not be echoed.
 */
function expectNoEcho(error: DebuggenError, planted: string): void {
  for (const surface of errorSurfaces(error)) {
    expect(surface).not.toContain(planted);
  }
  expect(error.cause).toBeUndefined();
}

/**
 * Freezes a value and everything reachable from it, so a function handed it
 * throws on any write instead of mutating it quietly.
 *
 * @param value The value to freeze in place.
 * @returns The same value, frozen.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    const container: object = value;
    const children: unknown[] = Object.values(container);
    for (const child of children) {
      deepFreeze(child);
    }
    Object.freeze(container);
  }
  return value;
}

/**
 * The issues a schema reports for a value it must reject.
 *
 * @param schema The schema under test.
 * @param value A value that schema refuses.
 * @returns The Zod issues, or an empty list after a failed expectation if the
 * value was unexpectedly accepted.
 */
function issuesOf(schema: z.ZodType, value: unknown): z.core.$ZodIssue[] {
  const result = schema.safeParse(value);

  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues;
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
    // The literal list is checked first, so a typo in the expectation cannot
    // pass by being mirrored in the tuple.
    expect(new Set(AAP_WEBSOCKET_MESSAGE_NAMES).size).toBe(25);
    expect([...MESSAGE_TYPES].sort()).toEqual([...AAP_WEBSOCKET_MESSAGE_NAMES].sort());
    expect(Object.keys(MESSAGE_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...AAP_WEBSOCKET_MESSAGE_NAMES].sort(),
    );
  });

  it('keeps the five HTTP operation names out of the union and in the route table', () => {
    // Exactly these five, in both HTTP-only registries: a sixth name there —
    // `telemetry.event`, say — would be a request body posing as a frame.
    expect([...HTTP_ONLY_PAYLOAD_NAMES].sort()).toEqual([...AAP_HTTP_ONLY_NAMES].sort());
    expect(Object.keys(HTTP_ONLY_PAYLOAD_SCHEMAS).sort()).toEqual([...AAP_HTTP_ONLY_NAMES].sort());

    for (const name of AAP_HTTP_ONLY_NAMES) {
      expect(MESSAGE_TYPES).not.toContain(name);
      expect(HTTP_OPERATIONS).toContain(name);

      const route = HTTP_ROUTES[name];
      expect({ operation: route.operation, method: route.method, pattern: route.pattern }).toEqual({
        operation: name,
        ...AAP_HTTP_ONLY_ROUTES[name],
      });
    }
  });

  it.each([...AAP_HTTP_ONLY_NAMES])('refuses %s sent as a frame rather than a request', (name) => {
    const parsed = parseMessage({ id: MESSAGE_ID, type: name, ts: SENT_AT, payload: {} });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('type (invalid_union');
  });

  it('declares the three shared envelope fields once, in envelopeBaseShape', () => {
    expect(Object.keys(envelopeBaseShape)).toEqual(['id', 'sessionId', 'ts']);
    expect(Object.isFrozen(envelopeBaseShape)).toBe(true);

    for (const option of protocolMessageSchema.options) {
      expect(Object.keys(option.shape).sort()).toEqual(
        ['id', 'payload', 'sessionId', 'ts', 'type'].sort(),
      );
      // Written once and spread, not re-declared per member: every member's
      // envelope fields are the base shape's own schema objects, and each
      // member's payload is the registry's schema for its type.
      expect(option.shape.id).toBe(envelopeBaseShape.id);
      expect(option.shape.sessionId).toBe(envelopeBaseShape.sessionId);
      expect(option.shape.ts).toBe(envelopeBaseShape.ts);
      expect(option.shape.payload).toBe(MESSAGE_PAYLOAD_SCHEMAS[option.shape.type.value]);
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
    expect(parsed.value).toStrictEqual(frame);
  });
});

describe('strictness — every member of the union, not just one', () => {
  it.each([...MESSAGE_TYPES])('%s refuses a stray top-level key and a null sessionId', (type) => {
    const valid: Record<string, unknown> = { ...VALID_FRAMES[type] };

    const withStrayKey = parseMessage({ ...valid, extra: true });
    const withNullSession = parseMessage({ ...valid, sessionId: null });

    expect(parseMessage(valid).ok).toBe(true);
    expect(withStrayKey.ok).toBe(false);
    expect(withNullSession.ok).toBe(false);
    if (withStrayKey.ok || withNullSession.ok) {
      return;
    }
    expect(withStrayKey.error.message).toContain('<root> (unrecognized_keys keys=extra)');
    expect(withNullSession.error.message).toContain('sessionId (invalid_type expected=string)');
  });
});

describe('parseMessage — rejections are typed, total and silent about the value', () => {
  it('rejects an unknown message type without naming it', () => {
    const parsed = parseMessage({
      id: MESSAGE_ID,
      type: SENTINEL,
      ts: SENT_AT,
      payload: {},
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error).toBeInstanceOf(DebuggenError);
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toBe(
      'Invalid protocol message: type (invalid_union branches=0 discriminator=type)',
    );
    expectNoEcho(parsed.error, SENTINEL);
  });

  // Each case names the issue it must be rejected *for*: a frame refused for
  // some other reason — a fixture that stopped being valid, say — would
  // otherwise satisfy every row of this table at once.
  it.each([
    [
      'a stray top-level key',
      { ...baseFrame(), extra: true },
      '<root> (unrecognized_keys keys=extra)',
    ],
    [
      'a missing id',
      { type: 'session.unbind', ts: SENT_AT, payload: { tabId: TAB_ID } },
      'id (invalid_type expected=string)',
    ],
    ['an empty id', { ...baseFrame(), id: '' }, 'id (too_small origin=string min=1)'],
    [
      'an over-long id',
      { ...baseFrame(), id: 'x'.repeat(129) },
      'id (too_big origin=string max=128)',
    ],
    [
      'a missing ts',
      { id: MESSAGE_ID, type: 'session.unbind', payload: { tabId: TAB_ID } },
      'ts (invalid_type expected=number)',
    ],
    [
      'a missing payload',
      { id: MESSAGE_ID, type: 'session.unbind', ts: SENT_AT },
      'payload (invalid_type expected=object)',
    ],
    [
      'a missing type',
      { id: MESSAGE_ID, ts: SENT_AT, payload: { tabId: TAB_ID } },
      'type (invalid_union',
    ],
    [
      'a null sessionId',
      { ...baseFrame(), sessionId: null },
      'sessionId (invalid_type expected=string)',
    ],
    [
      'an empty sessionId',
      { ...baseFrame(), sessionId: '' },
      'sessionId (too_small origin=string min=1)',
    ],
    [
      'a payload of the wrong shape',
      { ...baseFrame(), payload: { tabId: -1 } },
      'payload.tabId (too_small origin=number min=0)',
    ],
    [
      'a payload with a stray key',
      { ...baseFrame(), payload: { tabId: TAB_ID, extra: 1 } },
      'payload (unrecognized_keys keys=extra)',
    ],
    [
      'a seconds-precision ts',
      { ...baseFrame(), ts: Math.trunc(SENT_AT / 1000) },
      `ts (too_small origin=number min=${String(MIN_EPOCH_MS)})`,
    ],
    [
      'a relative performance ts',
      { ...baseFrame(), ts: 1234.5 },
      `ts (too_small origin=number min=${String(MIN_EPOCH_MS)})`,
    ],
    [
      'a microsecond-scale ts',
      { ...baseFrame(), ts: SENT_AT * 1000 },
      `ts (too_big origin=number max=${String(MAX_EPOCH_MS)})`,
    ],
    ['a NaN ts', { ...baseFrame(), ts: Number.NaN }, 'ts (invalid_type expected=number)'],
    [
      'an infinite ts',
      { ...baseFrame(), ts: Number.POSITIVE_INFINITY },
      'ts (invalid_type expected=number)',
    ],
    ['a string ts', { ...baseFrame(), ts: String(SENT_AT) }, 'ts (invalid_type expected=number)'],
    ['a non-object frame', 'session.unbind', '<root> (invalid_type expected=object)'],
    ['null', null, '<root> (invalid_type expected=object)'],
    ['an array', [], '<root> (invalid_type expected=object)'],
  ])('rejects %s', (_label, value, issue) => {
    const parsed = parseMessage(value);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain(`Invalid protocol message: ${issue}`);
  });

  it('accepts a frame with no sessionId key at all', () => {
    const parsed = parseMessage(baseFrame());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect('sessionId' in parsed.value).toBe(false);
  });

  it('keeps sub-millisecond precision, and accepts both telemetry bounds inclusively', () => {
    // Every other fixture timestamp is a whole millisecond, so without this case
    // an integer-only `ts` schema would pass the whole suite (AAP 0.2.3).
    for (const ts of [SENT_AT + 0.375, MIN_EPOCH_MS, MAX_EPOCH_MS]) {
      const parsed = parseMessage({ ...baseFrame(), ts });

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(parsed.value.ts).toBe(ts);
    }

    expect(parseMessage({ ...baseFrame(), ts: MIN_EPOCH_MS - 1 }).ok).toBe(false);
    expect(parseMessage({ ...baseFrame(), ts: MAX_EPOCH_MS + 1 }).ok).toBe(false);
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

    expectNoEcho(error, SENTINEL);

    // The code stays in the shared vocabulary, and the message still says which
    // field failed — a leak-free error is not a useless one.
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.message).toContain('payload.events[0].kind');
  });

  // `client.hello` is the one frame that carries a live bearer credential
  // (AAP 0.5.6), so each way it can be refused is checked separately: the
  // credential itself failing, and another field failing beside a valid one.
  it.each([
    [
      'an over-long credential',
      {
        client: 'devtools',
        tabId: TAB_ID,
        version: PROTOCOL_VERSION,
        token: CREDENTIAL_PLACEHOLDER.repeat(20),
      },
      'payload.token (too_big origin=string max=512)',
    ],
    [
      'a malformed version beside a valid credential',
      { client: 'devtools', tabId: TAB_ID, version: '1.0', token: CREDENTIAL_PLACEHOLDER },
      'payload.version (invalid_format format=regex)',
    ],
    [
      'an unknown client kind beside a valid credential',
      { client: 'editor', tabId: TAB_ID, version: PROTOCOL_VERSION, token: CREDENTIAL_PLACEHOLDER },
      'payload.client (invalid_value',
    ],
    [
      'a stray key beside a valid credential',
      { ...VALID_PAYLOADS['client.hello'], extra: CREDENTIAL_PLACEHOLDER },
      'payload (unrecognized_keys keys=extra)',
    ],
  ])('never echoes the client.hello credential: %s', (_label, payload, issue) => {
    const parsed = parseMessage({ id: MESSAGE_ID, type: 'client.hello', ts: SENT_AT, payload });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain(issue);
    expectNoEcho(parsed.error, CREDENTIAL_PLACEHOLDER);
  });

  it('names a stray key but never its value, and redacts a key that is not a field name', () => {
    const strayValue = parseMessage({ ...baseFrame(), extra: SENTINEL });
    const strayName = parseMessage({ ...baseFrame(), [`Bearer ${CREDENTIAL_PLACEHOLDER}`]: 1 });

    expect(strayValue.ok).toBe(false);
    expect(strayName.ok).toBe(false);
    if (strayValue.ok || strayName.ok) {
      return;
    }
    expect(strayValue.error.message).toContain('<root> (unrecognized_keys keys=extra)');
    expectNoEcho(strayValue.error, SENTINEL);
    expect(strayName.error.message).toContain('<root> (unrecognized_keys keys=<name>…)');
    expectNoEcho(strayName.error, CREDENTIAL_PLACEHOLDER);
  });
});

describe('decodeMessage — text that is not JSON', () => {
  it('rejects malformed JSON without quoting it', () => {
    // V8's SyntaxError quotes the text around the fault, which here is the
    // sentinel, so the constant message is what keeps it out.
    const malformed = `{"id":"${MESSAGE_ID}","type":"session.unbind","ts":${SENTINEL},`;

    const parsed = decodeMessage(malformed);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toBe('Invalid protocol message: the frame is not valid JSON');
    expectNoEcho(parsed.error, SENTINEL);
    expectNoEcho(parsed.error, MESSAGE_ID);
  });

  it('rejects valid JSON that is not a frame', () => {
    const parsed = decodeMessage('{"hello":"world"}');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('type (invalid_union');
  });

  it('rejects a binary frame rather than decoding it', () => {
    // `{}` as bytes: a text transport is the only one this protocol defines.
    const parsed = decodeMessage(new Uint8Array([0x7b, 0x7d]));

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
    expect(parsed.error.message).toContain('<root> (unrecognized_keys keys=__proto__)');
    expect(Object.prototype).not.toHaveProperty('polluted');
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

  it('mints a fresh id and stamps the current time when none is injected', () => {
    // Only `Date` is faked, and to a fixed instant, so the stamped time is an
    // exact value rather than a window around the wall clock.
    const now = SENT_AT + 42;
    vi.useFakeTimers({ now, toFake: ['Date'] });

    try {
      const first = createEnvelope('session.unbind', { tabId: TAB_ID });
      const second = createEnvelope('session.unbind', { tabId: TAB_ID });

      expect(first.ts).toBe(now);
      expect(second.ts).toBe(now);
      expect(first.id).toMatch(MINTED_MESSAGE_ID_PATTERN);
      expect(second.id).toMatch(MINTED_MESSAGE_ID_PATTERN);
      // One id per frame: a receiver correlates replies and drops duplicates by
      // it, so a reused id would silently discard a real frame.
      expect(second.id).not.toBe(first.id);
      expect(parseMessage(first).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lifts a sessionId off the payload so a call site cannot break routing', () => {
    const frame = frameFor('session.progress');

    expect(frame.sessionId).toBe(SESSION_ID);
    expect(frame.payload.sessionId).toBe(SESSION_ID);
  });

  it('treats an explicitly undefined sessionId option as absent, and still lifts', () => {
    const frame = createEnvelope('session.progress', VALID_PAYLOADS['session.progress'], {
      sessionId: undefined,
      id: MESSAGE_ID,
      ts: SENT_AT,
    });

    expect(frame.sessionId).toBe(SESSION_ID);
  });

  it('routes a payload with no sessionId of its own by the supplied option alone', () => {
    const payload = VALID_PAYLOADS['tab.navigated'];

    const frame = createEnvelope('tab.navigated', payload, {
      sessionId: SESSION_ID,
      id: MESSAGE_ID,
      ts: SENT_AT,
    });

    expect(frame.sessionId).toBe(SESSION_ID);
    expect(frame.payload).toStrictEqual({ tabId: TAB_ID, url: PAGE_URL });
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
    // Deep-frozen, so a write anywhere inside the payload — or to the options —
    // throws in this strict-mode module instead of passing unnoticed.
    const payload = deepFreeze(structuredClone(VALID_PAYLOADS['session.progress']));
    const options = deepFreeze({ id: MESSAGE_ID, ts: SENT_AT });
    const snapshot = structuredClone(payload);

    const frame = createEnvelope('session.progress', payload, options);

    expect(frame.payload).toBe(payload);
    expect(payload).toStrictEqual(snapshot);
    expect(options).toStrictEqual({ id: MESSAGE_ID, ts: SENT_AT });
  });

  it('serialises the envelope fields in the documented order', () => {
    expect(Object.keys(frameFor('session.progress'))).toEqual([
      'id',
      'type',
      'sessionId',
      'ts',
      'payload',
    ]);
    expect(Object.keys(frameFor('client.hello'))).toEqual(['id', 'type', 'ts', 'payload']);
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

    // Exact type equality, checked by `tsc -b` over this file: the narrowed
    // frame is that one member of the union, and its payload is the session
    // module's own payload type — neither `any` nor the union of all payloads.
    expectTypeOf(frame).toEqualTypeOf<MessageByType<'session.progress'>>();
    expectTypeOf(frame.payload).toEqualTypeOf<SessionProgressPayload>();
    expect([frame.payload.stage, frame.payload.status]).toEqual(['investigate', 'done']);
  });

  it('throws for a message type a switch did not handle, without echoing the frame', () => {
    const rogue = {
      ...baseFrame(),
      type: SENTINEL,
      payload: { note: SENTINEL },
    } as unknown as never;

    let thrown: unknown;
    try {
      assertExhaustiveMessage(rogue);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DebuggenError);
    if (!(thrown instanceof DebuggenError)) {
      return;
    }
    expect(thrown.code).toBe('INTERNAL');
    expect(thrown.message).toMatch(/^Unhandled protocol message type: /);
    expectNoEcho(thrown, SENTINEL);
  });
});

describe('type-level guarantees', () => {
  // `expectTypeOf(…).toEqualTypeOf<…>()` is exact equality and is enforced by
  // `tsc -b` over this file (`pnpm --filter @debuggen/protocol typecheck`). An
  // `extends` check is not enough here: `never` and `any` satisfy it, so a
  // registry that resolved a payload to either would pass one.
  it('resolves a payload type from the registry and keeps the discriminant literal', () => {
    expectTypeOf<MessagePayload<'panel.generated'>>().not.toBeAny();
    expectTypeOf<MessagePayload<'panel.generated'>>().toEqualTypeOf<PanelGeneratedPayload>();
    // One direction by design: the parsed panel is the schema's output, which
    // satisfies the owner's `readonly` `PanelSpec` interface without being
    // identical to it (see `PanelSpecTypePreserved` in `../messages/panel.ts`).
    expectTypeOf<MessagePayload<'panel.generated'>['panel']>().not.toBeAny();
    expectTypeOf<MessagePayload<'panel.generated'>['panel']>().not.toBeUnknown();
    expectTypeOf<MessagePayload<'panel.generated'>['panel']>().toExtend<PanelSpec>();
    expectTypeOf<MessageByType<'panel.generated'>['type']>().toEqualTypeOf<'panel.generated'>();
    expectTypeOf<ProtocolMessageMap['source.open']>().toEqualTypeOf<MessageByType<'source.open'>>();
    expectTypeOf<
      MessageTypeOf<MessageByType<'cleanup.completed'>>
    >().toEqualTypeOf<'cleanup.completed'>();
    expectTypeOf<ProtocolMessage['type']>().toEqualTypeOf<MessageType>();

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

// ---------------------------------------------------------------------------
// The primitives underneath — `../version.ts`
//
// Every frame's `ts`, every rejection's text and every embedded upstream shape
// passes through this module, so each export is exercised directly here rather
// than only through the envelope.
// ---------------------------------------------------------------------------

/** An upstream-owned shape with no Zod schema, as `opaqueSchema` embeds one. */
interface SampleShape {
  readonly captureId: string;
}

describe('version.ts — the wire version and the handshake predicate', () => {
  it('states a pattern-valid version whose major PROTOCOL_VERSION_MAJOR repeats', () => {
    const [major] = PROTOCOL_VERSION.split('.');

    expect(PROTOCOL_VERSION_PATTERN.test(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION_MAJOR).toBe(Number.parseInt(major ?? '', 10));

    const parsed = parseProtocolVersion(PROTOCOL_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value).toBe(PROTOCOL_VERSION);
  });

  it.each(['0.0.0', '1.0.0', '10.20.30'])('accepts %s', (version) => {
    expect(PROTOCOL_VERSION_PATTERN.test(version)).toBe(true);
    expect(protocolVersionSchema.safeParse(version).success).toBe(true);
  });

  it.each([
    '1.0',
    '1.0.0.0',
    '01.0.0',
    '1.00.0',
    '1.0.01',
    '1.0.0-beta.1',
    '1.0.0+build',
    'v1.0.0',
    ' 1.0.0',
    '1.0.0 ',
    '1..0',
    '',
  ])('refuses %j', (version) => {
    expect(PROTOCOL_VERSION_PATTERN.test(version)).toBe(false);
    expect(protocolVersionSchema.safeParse(version).success).toBe(false);
  });

  it('matches statelessly, so a shared pattern answers the same on every call', () => {
    expect(PROTOCOL_VERSION_PATTERN.global).toBe(false);
    expect(PROTOCOL_VERSION_PATTERN.sticky).toBe(false);
    expect([1, 2, 3].map(() => PROTOCOL_VERSION_PATTERN.test(PROTOCOL_VERSION))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('bounds a version at 32 characters before matching it', () => {
    const longest = `1.0.${'1'.repeat(28)}`;
    const tooLong = `1.0.${'1'.repeat(29)}`;

    expect(longest).toHaveLength(32);
    expect(protocolVersionSchema.safeParse(longest).success).toBe(true);
    expect(PROTOCOL_VERSION_PATTERN.test(tooLong)).toBe(true);
    expect(describeZodIssues(issuesOf(protocolVersionSchema, tooLong))).toBe(
      '<root> (too_big origin=string max=32)',
    );
  });

  it('rejects a claimed version without echoing it', () => {
    const parsed = parseProtocolVersion(`9.9.9-${SENTINEL}`);
    const notAString = parseProtocolVersion(42);

    expect(parsed.ok).toBe(false);
    expect(notAString.ok).toBe(false);
    if (parsed.ok || notAString.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toBe(
      'Invalid protocol version: <root> (invalid_format format=regex)',
    );
    expectNoEcho(parsed.error, SENTINEL);
    expect(notAString.error.message).toBe(
      'Invalid protocol version: <root> (invalid_type expected=string)',
    );
  });

  it.each([
    ['the same version', PROTOCOL_VERSION, undefined, true],
    [
      'a later minor and patch of the same major',
      `${String(PROTOCOL_VERSION_MAJOR)}.99.7`,
      undefined,
      true,
    ],
    ['the next major', `${String(PROTOCOL_VERSION_MAJOR + 1)}.0.0`, undefined, false],
    ['a supplied current version of the same major', '2.3.4', '2.0.0', true],
    ['a supplied current version of another major', '0.9.9', '1.0.0', false],
    ['a string that is no version', 'nope', undefined, false],
    ['an empty string', '', undefined, false],
    ['a zero-padded major', `0${String(PROTOCOL_VERSION_MAJOR)}.0.0`, undefined, false],
    [
      'an over-long but well-formed version',
      `${String(PROTOCOL_VERSION_MAJOR)}.0.${'1'.repeat(40)}`,
      undefined,
      false,
    ],
    [
      'a major beyond safe-integer range',
      '99999999999999999999.0.0',
      '99999999999999999999.0.0',
      false,
    ],
    ['a malformed current version', PROTOCOL_VERSION, 'garbage', false],
  ])('answers %s with %s', (_label, claimed, current, expected) => {
    expect(isCompatibleProtocolVersion(claimed, current)).toBe(expected);
  });
});

describe('version.ts — the epoch-millisecond timestamp primitive', () => {
  it('is the very schema the envelope stamps every frame with', () => {
    expect(envelopeBaseShape.ts).toBe(epochMsSchema);
  });

  it('accepts both telemetry bounds inclusively and keeps a fraction exactly', () => {
    for (const value of [MIN_EPOCH_MS, MAX_EPOCH_MS, SENT_AT + 0.375]) {
      const parsed = epochMsSchema.safeParse(value);

      expect(parsed.success).toBe(true);
      expect(parsed.data).toBe(value);
    }
  });

  it.each([
    ['one millisecond before the lower bound', MIN_EPOCH_MS - 1, 'too_small'],
    ['one millisecond after the upper bound', MAX_EPOCH_MS + 1, 'too_big'],
    ['NaN', Number.NaN, 'invalid_type'],
    ['positive infinity', Number.POSITIVE_INFINITY, 'invalid_type'],
    ['negative infinity', Number.NEGATIVE_INFINITY, 'invalid_type'],
    ['a numeric string', String(SENT_AT), 'invalid_type'],
    ['undefined', undefined, 'invalid_type'],
  ])('refuses %s', (_label, value, code) => {
    const [issue] = issuesOf(epochMsSchema, value);

    expect(issue?.code).toBe(code);
  });
});

describe('version.ts — leak-free issue rendering', () => {
  it('answers a constant for an empty issue list', () => {
    expect(describeZodIssues([])).toBe('no issues reported');
  });

  it('renders field paths with indices, and the schema-declared bound', () => {
    const schema = z.strictObject({
      events: z.array(z.strictObject({ startTime: epochMsSchema })),
    });

    expect(
      describeZodIssues(issuesOf(schema, { events: [{ startTime: SENT_AT }, { startTime: 5 }] })),
    ).toBe(`events[1].startTime (too_small origin=number min=${String(MIN_EPOCH_MS)})`);
  });

  it('never renders an issue message or input, whatever they hold', () => {
    const planted: z.core.$ZodIssue = {
      code: 'invalid_type',
      expected: 'string',
      path: ['token'],
      message: SENTINEL,
      input: SENTINEL,
    };

    expect(describeZodIssues([planted])).toBe('token (invalid_type expected=string)');
  });

  it('renders a symbol path segment by kind and redacts a label that is not a name', () => {
    const planted: z.core.$ZodIssue = {
      code: 'custom',
      path: [Symbol(SENTINEL)],
      message: SENTINEL,
      params: { label: `${SENTINEL} value` },
    };

    expect(describeZodIssues([planted])).toBe('[symbol] (custom label=<name>…)');
  });

  it('renders at most ten issues and counts the rest', () => {
    const issues = issuesOf(
      z.array(z.string()),
      Array.from({ length: 12 }, (_, index) => index),
    );
    const rendered = Array.from(
      { length: 10 },
      (_, index) => `[${String(index)}] (invalid_type expected=string)`,
    ).join('; ');

    expect(issues).toHaveLength(12);
    expect(describeZodIssues(issues)).toBe(`${rendered}; …and 2 more`);
  });

  it('renders at most eight path segments and marks the elision', () => {
    const depth = 9;
    const keys = Array.from({ length: depth }, (_, index) => `level${String(index)}`);
    let schema: z.ZodType = z.string();
    let value: unknown = 0;
    for (const key of [...keys].reverse()) {
      schema = z.strictObject({ [key]: schema });
      value = { [key]: value };
    }

    expect(describeZodIssues(issuesOf(schema, value))).toBe(
      `${keys.slice(0, 8).join('.')}… (invalid_type expected=string)`,
    );
  });

  it('replaces a record key that is not a field name and shortens a long one', () => {
    const schema = z.record(z.string(), z.number());
    const longName = 'k'.repeat(50);
    const overlongName = 'k'.repeat(65);

    expect(describeZodIssues(issuesOf(schema, { [`Bearer ${CREDENTIAL_PLACEHOLDER}`]: 'x' }))).toBe(
      '<name>… (invalid_type expected=number)',
    );
    expect(describeZodIssues(issuesOf(schema, { [longName]: 'x' }))).toBe(
      `${'k'.repeat(40)}… (invalid_type expected=number)`,
    );
    expect(describeZodIssues(issuesOf(schema, { [overlongName]: 'x' }))).toBe(
      '<name>… (invalid_type expected=number)',
    );
  });

  it('builds a DebuggenError whose details repeat the rendering in structured form', () => {
    const planted: z.core.$ZodIssue = {
      code: 'invalid_type',
      expected: 'string',
      path: ['payload', 'token'],
      message: SENTINEL,
      input: SENTINEL,
    };

    const bare = protocolParseError('PROTOCOL_INVALID_MESSAGE', 'Invalid sample', [planted]);
    const hinted = protocolParseError('STORE_ERROR', 'Invalid row', [planted], 'Constant hint.');

    expect(bare).toBeInstanceOf(DebuggenError);
    expect(bare.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(bare.message).toBe('Invalid sample: payload.token (invalid_type expected=string)');
    expect(bare.details).toStrictEqual({
      issueCount: 1,
      issues: [{ path: 'payload.token', code: 'invalid_type' }],
    });
    expect('hint' in bare).toBe(false);
    expect(bare.toPayload()).toStrictEqual({ code: bare.code, message: bare.message });
    expectNoEcho(bare, SENTINEL);

    expect(hinted.code).toBe('STORE_ERROR');
    expect(hinted.toPayload()).toStrictEqual({
      code: 'STORE_ERROR',
      message: 'Invalid row: payload.token (invalid_type expected=string)',
      hint: 'Constant hint.',
    });
  });

  it('caps structured details at ten issues while counting all of them', () => {
    const issues = issuesOf(
      z.array(z.string()),
      Array.from({ length: 12 }, (_, index) => index),
    );

    const error = protocolParseError('PROTOCOL_INVALID_MESSAGE', 'Invalid sample', issues);

    expect(error.details).toMatchObject({ issueCount: 12 });
    expect(error.details?.['issues']).toHaveLength(10);
  });
});

describe('version.ts — embedding an upstream type that owns no schema', () => {
  it('isPlainRecord admits objects and refuses null, arrays and primitives', () => {
    const nullPrototype: unknown = Object.create(null);

    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord(nullPrototype)).toBe(true);
    for (const value of [null, undefined, [], 'text', 0, true]) {
      expect(isPlainRecord(value)).toBe(false);
    }
  });

  it('recordWithKeys requires every named key as an own property', () => {
    const guard = recordWithKeys('captureId', 'available');
    const inherited: unknown = Object.create({ captureId: CAPTURE_ID, available: true });

    expect(guard({ captureId: CAPTURE_ID, available: true, extra: 1 })).toBe(true);
    expect(guard({ captureId: CAPTURE_ID })).toBe(false);
    expect(guard(inherited)).toBe(false);
    expect(guard([])).toBe(false);
    expect(guard(null)).toBe(false);
    expect(guard(undefined)).toBe(false);
  });

  it('opaqueSchema refuses the undefined a bare z.custom accepts', () => {
    // The control: in this Zod, `z.custom<T>()` with no check lets an absent
    // value through as a valid `T`. That is the trap `opaqueSchema` closes.
    expect(z.custom<SampleShape>().safeParse(undefined).success).toBe(true);

    const schema = opaqueSchema<SampleShape>('SampleShape');

    for (const value of [undefined, null, [], 'text', 0, true]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<SampleShape>();
  });

  it('opaqueSchema validates without rewriting, and names the shape on refusal', () => {
    const schema = opaqueSchema<SampleShape>('SampleShape', recordWithKeys('captureId'));
    const accepted: SampleShape = { captureId: CAPTURE_ID };

    const parsed = schema.safeParse(accepted);
    const [issue] = issuesOf(schema, { note: SENTINEL });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe(accepted);
    expect(issue?.code).toBe('custom');
    expect(issue?.message).toBe('expected SampleShape');
    expect(describeZodIssues(issuesOf(schema, { note: SENTINEL }))).toBe(
      '<root> (custom label=SampleShape)',
    );
  });

  it('refuses an absent embedded summary inside a real frame', () => {
    // `capture.stopped` embeds `CaptureSummary` through `opaqueSchema`; this is
    // the trap at the boundary where it would have mattered.
    const missing = parseMessage({
      id: MESSAGE_ID,
      type: 'capture.stopped',
      ts: SENT_AT,
      payload: { sessionId: SESSION_ID, captureId: CAPTURE_ID },
    });
    const undefinedSummary = parseMessage({
      id: MESSAGE_ID,
      type: 'capture.stopped',
      ts: SENT_AT,
      payload: { sessionId: SESSION_ID, captureId: CAPTURE_ID, summary: undefined },
    });

    expect(missing.ok).toBe(false);
    expect(undefinedSummary.ok).toBe(false);
    if (missing.ok || undefinedSummary.ok) {
      return;
    }
    expect(missing.error.message).toContain('payload.summary (custom label=CaptureSummary)');
    expect(undefinedSummary.error.message).toContain(
      'payload.summary (custom label=CaptureSummary)',
    );
  });

  it('opaqueArraySchema reports the failing element by index', () => {
    const schema = opaqueArraySchema<SampleShape>('SampleShape', recordWithKeys('captureId'));

    expect(schema.safeParse([]).success).toBe(true);
    expect(schema.safeParse([{ captureId: CAPTURE_ID }]).success).toBe(true);
    expect(describeZodIssues(issuesOf(schema, [{ captureId: CAPTURE_ID }, {}]))).toBe(
      '[1] (custom label=SampleShape)',
    );
    expect(describeZodIssues(issuesOf(schema, [undefined]))).toBe('[0] (custom label=SampleShape)');
    expect(describeZodIssues(issuesOf(schema, {}))).toBe('<root> (invalid_type expected=array)');
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<SampleShape[]>();
  });
});

// ---------------------------------------------------------------------------
// The package barrel — `../index.ts`
//
// This package publishes exactly one export condition, `"."`, so the barrel is
// not a convenience: it is the entire visible surface of the contract layer.
// The cases below are the properties an app depends on and that no compiler
// checks on its behalf.
// ---------------------------------------------------------------------------

/**
 * The package's own modules, each as the namespace a direct import gives.
 *
 * The forwarding case below holds every value these export to reaching the
 * barrel unchanged. A module added behind `../index.ts` joins this table so that
 * its values are held to the same rule; whether a barrel value is borrowed from
 * upstream is decided against {@link UPSTREAM_PACKAGES} instead, so that verdict
 * never depends on this list being complete.
 */
const OWN_MODULES = {
  'version.ts': versionModule,
  'analysis.ts': analysisModule,
  'session-record.ts': sessionRecordModule,
  'messages/index.ts': messagesModule,
  'envelope.ts': envelopeModule,
  'http.ts': httpModule,
  'client/ws-client.ts': wsClientModule,
  'client/http-client.ts': httpClientModule,
} as const;

/**
 * The only upstream **values** `../index.ts` may forward: closed, frozen
 * vocabularies and paging bounds a user interface iterates or enforces, which
 * the two extension apps can reach no other way (AAP 0.2.2).
 */
const SANCTIONED_UPSTREAM_VALUES = [
  'CONFIDENCE_LEVELS',
  'DATA_QUERY_DEFAULT_LIMIT',
  'DATA_QUERY_DEFAULT_OFFSET',
  'DATA_QUERY_MAX_LIMIT',
  'DATA_QUERY_SORTS',
  'DATA_QUERY_SOURCES',
  'METRIC_IDS',
  'MODIFICATION_STATUSES',
  'TELEMETRY_KINDS',
  'TELEMETRY_TIERS',
] as const;

/**
 * Every package `../index.ts` is layered above, as the namespace its public
 * entry gives — the four `@debuggen` owners of the embedded shapes, and `zod`.
 *
 * `@debuggen/instrumentation` is read through its root, which re-exports the
 * `./schema` entry the protocol imports (one module, so one set of values), and
 * adds the adapter, installer and patch layer whose leak would matter most.
 */
const UPSTREAM_PACKAGES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  '@debuggen/shared': sharedPackage,
  '@debuggen/telemetry': telemetryPackage,
  '@debuggen/instrumentation': instrumentationPackage,
  '@debuggen/panel-schema': panelSchemaPackage,
  zod: zodPackage,
};

/**
 * Whether the barrel forwards an upstream export as it is: an owner publishes
 * the same name bound to the same value.
 *
 * Name *and* identity, because each alone misjudges a legitimate case. Identity
 * alone would flag a protocol-owned name deliberately bound to an upstream
 * object — `panelDataRequestSchema` *is* panel-schema's `dataQuerySchema`, by
 * contract — and could not tell a borrowed primitive from an equal own
 * constant. A name alone would flag an own export that merely shares a
 * spelling with something upstream.
 *
 * @param name The barrel export's name.
 * @param value The barrel export's value.
 * @returns The owning package, or `undefined` when no upstream package
 * publishes that name with that value.
 */
function upstreamOwnerOf(name: string, value: unknown): string | undefined {
  for (const [owner, namespace] of Object.entries(UPSTREAM_PACKAGES)) {
    if (Object.hasOwn(namespace, name) && namespace[name] === value) {
      return owner;
    }
  }
  return undefined;
}

/** The barrel's runtime exports, by name, as a consumer's import sees them. */
const BARREL_EXPORTS: ReadonlyMap<string, unknown> = new Map(Object.entries(protocol));

describe('the package barrel — the only door into @debuggen/protocol', () => {
  it('exposes every load-bearing symbol the three apps are documented to consume', () => {
    // One name per group of `../index.ts`, chosen from what the apps actually
    // call: the handshake version, the envelope's schema and its four
    // functions, the registry both transports dispatch on, the two stored
    // artifacts, the route table with its auth exemptions and the upgrade path,
    // the panel-data union, and the two transport clients. A missing name here
    // is a consumer that cannot be written, however complete `src/**` is.
    const required = [
      'PROTOCOL_VERSION',
      'protocolMessageSchema',
      'parseMessage',
      'createEnvelope',
      'MESSAGE_TYPES',
      'MESSAGE_PAYLOAD_SCHEMAS',
      'sessionRecordSchema',
      'analysisResultSchema',
      'HTTP_ROUTES',
      'HTTP_OPERATIONS',
      'AUTH_EXEMPT_OPERATIONS',
      'WS_PATH',
      'dataResultSchema',
      'ReconnectingWsClient',
      'HttpClient',
      // The borrowed vocabularies, which a user interface iterates rather than
      // merely names: `apps/vscode-extension` and `apps/chrome-extension`
      // declare no dependency on the packages that own them (AAP 0.2.2), so
      // this barrel is the only way they arrive.
      'METRIC_IDS',
      'TELEMETRY_KINDS',
      'MODIFICATION_STATUSES',
      'DATA_QUERY_SOURCES',
    ] as const;

    // Present *and defined*: `name in` alone is satisfied by an export bound to
    // `undefined`, which is a consumer that compiles and then crashes.
    const missing = required.filter((name) => BARREL_EXPORTS.get(name) === undefined);

    expect(missing).toEqual([]);
    expect(typeof protocol.ReconnectingWsClient).toBe('function');
    expect(typeof protocol.HttpClient).toBe('function');
  });

  it('forwards every value its own modules export, as that same value', () => {
    // The registry the envelope dispatches on must be the object a direct
    // import gives, or two layers would validate against two registries; and a
    // value two modules both export would be silently dropped by `export *`.
    const mismatched = Object.entries(OWN_MODULES).flatMap(([module, namespace]) =>
      Object.entries(namespace)
        .filter(([name, value]) => BARREL_EXPORTS.get(name) !== value)
        .map(([name]) => `${module}: ${name}`),
    );

    expect(mismatched).toEqual([]);
  });

  it('borrows no upstream value beyond the sanctioned closed vocabularies', () => {
    // `../index.ts` re-exports upstream *types* freely — they are erased — but
    // a borrowed function, Zod schema, class or mutable object would hand an
    // upstream package's runtime to three browser bundles through a package
    // that is meant to be a contract. Each barrel value is traced to the package
    // that publishes it, so the verdict holds for every module behind the
    // barrel, including one added after this suite was written.
    const borrowed = [...BARREL_EXPORTS]
      .map(([name, value]) => ({ name, owner: upstreamOwnerOf(name, value) }))
      .filter((entry) => entry.owner !== undefined)
      .map((entry) => entry.name)
      .sort();

    expect(borrowed).toEqual([...SANCTIONED_UPSTREAM_VALUES].sort());

    // The detector is not vacuous: each sanctioned vocabulary is traced to the
    // package that owns it, and a known upstream function would be caught.
    expect(upstreamOwnerOf('MODIFICATION_STATUSES', protocol.MODIFICATION_STATUSES)).toBe(
      '@debuggen/instrumentation',
    );
    expect(upstreamOwnerOf('METRIC_IDS', protocol.METRIC_IDS)).toBe('@debuggen/telemetry');
    expect(upstreamOwnerOf('DATA_QUERY_SOURCES', protocol.DATA_QUERY_SOURCES)).toBe(
      '@debuggen/panel-schema',
    );
    expect(upstreamOwnerOf('normalizePlan', instrumentationPackage.normalizePlan)).toBe(
      '@debuggen/instrumentation',
    );

    for (const name of SANCTIONED_UPSTREAM_VALUES) {
      const value = BARREL_EXPORTS.get(name);

      if (typeof value === 'number') {
        expect(Number.isSafeInteger(value), name).toBe(true);
        continue;
      }
      expect(Array.isArray(value), name).toBe(true);
      expect(Object.isFrozen(value), name).toBe(true);
      expect(Array.isArray(value) && value.every((entry) => typeof entry === 'string'), name).toBe(
        true,
      );
    }

    // Each is its owner's own value, not a copy that could drift from it.
    expect(protocol.METRIC_IDS).toBe(METRIC_IDS);
    expect(protocol.TELEMETRY_KINDS).toBe(TELEMETRY_KINDS);
    expect(protocol.TELEMETRY_TIERS).toBe(TELEMETRY_TIERS);
    expect(protocol.CONFIDENCE_LEVELS).toBe(CONFIDENCE_LEVELS);
    expect(protocol.DATA_QUERY_SORTS).toBe(DATA_QUERY_SORTS);
    expect(protocol.DATA_QUERY_SOURCES).toBe(DATA_QUERY_SOURCES);
    expect(protocol.DATA_QUERY_DEFAULT_LIMIT).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(protocol.DATA_QUERY_DEFAULT_OFFSET).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(protocol.DATA_QUERY_MAX_LIMIT).toBe(DATA_QUERY_MAX_LIMIT);

    // And the values AAP 0.4.2 states outright: the five modification states
    // and the panel-data paging bounds (default 200, maximum 5 000, offset 0).
    expect(protocol.MODIFICATION_STATUSES).toEqual([
      'pending',
      'applied',
      'reverted',
      'conflict',
      'failed',
    ]);
    expect([
      protocol.DATA_QUERY_DEFAULT_LIMIT,
      protocol.DATA_QUERY_MAX_LIMIT,
      protocol.DATA_QUERY_DEFAULT_OFFSET,
    ]).toEqual([200, 5000, 0]);
  });

  it('has no default export, so every import is by name', () => {
    // A default export would give the same symbol two spellings across four
    // processes, and `export *` deliberately does not forward one.
    expect('default' in protocol).toBe(false);
  });

  it('leaks no upstream function: each owner keeps its own front door', () => {
    // `../index.ts` re-exports upstream *types* freely — they are erased, which
    // is what lets the two extension apps name a `ModificationRecord` or a
    // `TelemetryEvent` without declaring a dependency on its owner — but never
    // an upstream *function*. One of these would make this package a second
    // front door to a package it merely layers above and would put that
    // package's runtime, including a ts-morph-backed patch layer, inside three
    // browser bundles. Only the local service declares those dependencies, and
    // it imports each owner directly.
    const forbidden = [
      'normalizePlan',
      'normalizePanel',
      'validatePanelSpec',
      'validateAgainstCapture',
      'correlateEvents',
    ] as const;

    const leaked = forbidden.filter((name) => BARREL_EXPORTS.has(name));

    expect(leaked).toEqual([]);
  });

  it('loads with no observable side effect', async () => {
    // `package.json` declares `sideEffects: false`, which lets every consumer's
    // bundler drop the message modules it does not reach; a single statement
    // that ran at load time would make that declaration false. The service
    // imports this package during start-up and three browser bundles inline it,
    // so a stray log line would also appear in a developer's console for
    // reasons unrelated to their session.
    //
    // The static namespace above was evaluated before any spy existed, so the
    // module registry is reset and the barrel is re-evaluated under the spies.
    const methods = ['debug', 'error', 'info', 'log', 'trace', 'warn'] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const globalsBefore = Object.getOwnPropertyNames(globalThis).sort();

    try {
      vi.resetModules();

      const reloaded = await import('../index.js');

      // The reload really re-evaluated the package — a cached module would make
      // every spy assertion below vacuous — and produced the same contract
      // without throwing.
      expect(reloaded.protocolMessageSchema).not.toBe(protocolMessageSchema);
      expect(reloaded.MESSAGE_TYPES).toEqual(MESSAGE_TYPES);
      expect(reloaded.PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
      expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
      // Nothing was installed on the global object.
      expect(Object.getOwnPropertyNames(globalThis).sort()).toEqual(globalsBefore);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
