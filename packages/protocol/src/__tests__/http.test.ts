/**
 * Tests for `../http.ts`, the service's HTTP route surface, in the directory
 * `packages/protocol/tsconfig.json` names for this package's suites
 * (AAP §0.8.3).
 *
 * What is on trial is the **route contract**, not the schema library. Three
 * processes agree on nothing except what that module declares — the service
 * registers its handlers from the table, the extension host and the Chrome
 * service worker call them from the same table — so every assertion below exists
 * because a producer and a consumer live in different bundles and can only
 * disagree at run time, in the process that receives a body.
 *
 * The cases group into what can actually go wrong:
 *
 * - **The table itself.** All seventeen `(operation, method, pattern)` triples
 *   are written out literally below and compared against `HTTP_ROUTES`, so that
 *   adding, renaming or re-pathing a route is a deliberate edit in two places
 *   rather than an accident in one. A duplicated `(method, pattern)` pair is
 *   checked for separately: `/sessions` legitimately appears twice, under
 *   different methods, which is exactly the shape a second collision could hide
 *   in.
 * - **The authentication exemption.** AAP §0.5.6 makes exactly two routes
 *   reachable without a bearer credential. The module states that twice — as a
 *   tuple and as a per-route flag — and although a compile-time proof ties them
 *   together, the cases here assert the agreement from both directions at run
 *   time as well, because a widened exemption is the one defect in this file
 *   that is a security bug rather than a bug.
 * - **Identity, not similarity.** The panel-data body must be
 *   `@debuggen/panel-schema`'s `dataQuerySchema` *itself*, and the session and
 *   capture bodies must be the very schema objects `../messages/session.ts` and
 *   `../messages/capture.ts` declare. A structural comparison would pass for a
 *   hand-written copy, which is the duplicate definition AAP §0.9.1 forbids, so
 *   these are `toBe` assertions.
 * - **The `DataResult` union.** `DATA_QUERY_SOURCES` states that its ten members
 *   are "exactly the discriminants" of this union; the cases check that as a set,
 *   in order, with one member each, and then parse a real aggregate for every
 *   source — produced by `@debuggen/telemetry`'s own builders rather than
 *   hand-written — because the payload guards are shallow and a guard that
 *   refused a real value would be worse than no guard at all.
 * - **Ingress versus persisted events.** The ingest body must refuse an event
 *   carrying `sessionId`, `captureId` or `ingestSeq`: attribution is the
 *   service's to assign, and a producer that could claim a session could write
 *   into someone else's capture.
 * - **Leak freedom.** A rejected body is unvalidated data from another process
 *   and holds project paths, the developer's question, redacted URLs and
 *   parameterized SQL. AAP §0.5.2 keeps all of it out of the error, and the
 *   sentinel cases check the message, the hint, the details and the wire payload.
 * - **JSON survival.** Every response body is built, parsed, serialised,
 *   deserialised and parsed again, because `undefined` does not survive a round
 *   trip and a schema that relied on an absent key to mean something would fail
 *   in production rather than here.
 */

import { describe, expect, it } from 'vitest';

import { DATA_QUERY_MAX_LIMIT, DATA_QUERY_SOURCES, dataQuerySchema } from '@debuggen/panel-schema';
import type { DataQuerySource } from '@debuggen/panel-schema';
import { DEBUGGEN_ERROR_CODES, DebuggenError } from '@debuggen/shared';
import {
  METRIC_IDS,
  aggregateQueries,
  aggregateRenders,
  aggregateRequests,
  aggregateStateTransitions,
  buildComponentTreeSnapshot,
  buildDependencyGraph,
  buildTraceTree,
  computeCaptureSummary,
  createTraceNode,
} from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryEventIngress } from '@debuggen/telemetry';

import {
  AUTH_EXEMPT_OPERATIONS,
  AUTHORIZATION_HEADER,
  CAPTURE_CONFLICT_ERROR_CODE,
  HTTP_METHODS,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  WS_PATH,
  buildPath,
  captureStartConflictResponseSchema,
  captureStartRequestSchema,
  captureStartResponseSchema,
  captureStopRequestSchema,
  captureStopResponseSchema,
  captureStartPath,
  captureStopPath,
  dataPageSchema,
  dataResultSchema,
  devServerLaunchPath,
  devServerStopPath,
  formatBearer,
  healthPath,
  healthResponseSchema,
  httpErrorResponseSchema,
  isAuthExemptOperation,
  modificationsPath,
  pairCompletePath,
  pairStartPath,
  panelByIdPath,
  panelByIdResponseSchema,
  panelDataPath,
  panelDataRequestSchema,
  panelPath,
  panelResponseSchema,
  parseDataResult,
  parseHttpRequest,
  parseHttpResponse,
  sessionCreateRequestSchema,
  sessionEndPath,
  sessionEndRequestSchema,
  sessionPath,
  sessionQuestionPath,
  sessionQuestionRequestSchema,
  sessionsPath,
  telemetryIngestPath,
  telemetryIngestRequestSchema,
} from '../http.js';
import type { DataResultFor, HttpOperation, HttpRequestBody, HttpResponseBody } from '../http.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// Ids follow the product's `<prefix>_<sixteen alphanumerics>` shape without
// being asserted against it — `@debuggen/shared` owns that grammar. Digests and
// trace ids are built from repeating seeds so they satisfy their schemas while
// staying low-entropy: `scripts/check-secrets.mjs` scans every tracked file for
// high-entropy strings, and a test fixture is not worth a false positive.
// ---------------------------------------------------------------------------

/** The session every fixture below belongs to. */
const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

/** The capture window those events were recorded in. */
const CAPTURE_ID = 'cap_7f3q0m2zk1x8ab9c';

/** The panel generated from it. */
const PANEL_ID = 'pan_6h2j8k4l0z5x1c7v';

/** A modification id of the shape the journal carries. */
const MODIFICATION_ID = 'mod_5b1n7m3q9w2e4r6t';

/** The producer that emitted every event fixture: one page document's agent. */
const PRODUCER_ID = 'prd_8x4c2v6b0n1m5q3w';

/** A 32-character lowercase hexadecimal trace id, from a repeating seed. */
const TRACE_ID = '3f2a'.repeat(8);

/** A 16-character lowercase hexadecimal span id. */
const SPAN_ID = '1b2c3d4e5f60718a';

/** The child span id used where a fixture needs two distinct spans. */
const CHILD_SPAN_ID = '2c3d4e5f60718a9b';

/** The developer's workspace folder: absolute, POSIX, on their own machine. */
const PROJECT_ROOT = '/home/example/workspace/site';

/** A project-relative source path, the only spelling a modification's `file` accepts. */
const SOURCE_FILE = 'src/lib/thing.ts';

/** The dev server the fixture session is bound to. */
const DEV_SERVER_URL = 'http://localhost:3000';

/** A fixed point in time, so no assertion depends on the clock. */
const START_TIME = 1_758_000_000_000;

/**
 * A 64-character lowercase hexadecimal digest, built from a repeating seed.
 *
 * @param seed Two characters, repeated to fill the digest.
 * @returns A value the modification record's hash fields accept.
 */
function hashFixture(seed: string): string {
  return seed.repeat(32).slice(0, 64);
}

/**
 * One event as a producer sends it: no `sessionId`, no `captureId`, no
 * `ingestSeq`.
 *
 * The shape the ingest route accepts, and the shape whose three absent fields
 * the cases below prove are absent by construction rather than by convention.
 */
const INGRESS_EVENT: TelemetryEventIngress = {
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

/**
 * The same event as the store holds it, with the three attribution fields the
 * service assigns at ingest.
 */
const INTERACTION_EVENT: TelemetryEvent = {
  ...INGRESS_EVENT,
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  ingestSeq: 1,
};

/** A browser fetch span, which the request aggregate and the graph both read. */
const FETCH_EVENT: TelemetryEvent = {
  id: 'evt_2b3c4d5e6f7g8h9i',
  traceId: TRACE_ID,
  spanId: CHILD_SPAN_ID,
  parentSpanId: SPAN_ID,
  kind: 'fetch',
  name: 'POST /api/session-action',
  startTime: START_TIME + 8,
  duration: 640,
  tier: 'browser',
  attributes: {
    'http.method': 'POST',
    url: `${DEV_SERVER_URL}/api/session-action?id=%3F`,
    'http.status_code': 200,
    initiator: SOURCE_FILE,
  },
  status: 'ok',
  producerId: PRODUCER_ID,
  seq: 1,
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  ingestSeq: 2,
};

/** A React commit-phase render, which the render aggregate and component tree read. */
const RENDER_EVENT: TelemetryEvent = {
  id: 'evt_3c4d5e6f7g8h9i0j',
  traceId: TRACE_ID,
  spanId: '3d4e5f60718a9b2c',
  parentSpanId: SPAN_ID,
  kind: 'render',
  name: 'render PrimaryAction',
  startTime: START_TIME + 1_128,
  duration: 47,
  tier: 'browser',
  attributes: { component: 'PrimaryAction', phase: 'update', renderCount: 4, trigger: 'context' },
  status: 'ok',
  producerId: PRODUCER_ID,
  seq: 2,
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  ingestSeq: 3,
};

/** A hook state change, which the state-transition aggregate reads. */
const STATE_EVENT: TelemetryEvent = {
  id: 'evt_4d5e6f7g8h9i0j1k',
  traceId: TRACE_ID,
  spanId: '4e5f60718a9b2c3d',
  parentSpanId: SPAN_ID,
  kind: 'state',
  name: 'state PrimaryAction',
  startTime: START_TIME + 4,
  duration: 0,
  tier: 'browser',
  attributes: {
    component: 'PrimaryAction',
    hookIndex: 0,
    previousValue: 'false',
    nextValue: 'true',
    changed: true,
  },
  status: 'ok',
  producerId: PRODUCER_ID,
  seq: 3,
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  ingestSeq: 4,
};

/** A database statement, redacted to its parameterized form, on the `db` tier. */
const QUERY_EVENT: TelemetryEvent = {
  id: 'evt_5e6f7g8h9i0j1k2l',
  traceId: TRACE_ID,
  spanId: '5f60718a9b2c3d4e',
  parentSpanId: CHILD_SPAN_ID,
  kind: 'db.query',
  name: 'SELECT',
  startTime: START_TIME + 18,
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
  ingestSeq: 5,
};

/** Every event fixture, in the order a capture would have recorded them. */
const EVENTS: readonly TelemetryEvent[] = [
  INTERACTION_EVENT,
  STATE_EVENT,
  FETCH_EVENT,
  QUERY_EVENT,
  RENDER_EVENT,
];

/** A minimal session record: every required field, nothing invented. */
const SESSION_RECORD: HttpResponseBody<'session.get'> = {
  id: SESSION_ID,
  projectRoot: PROJECT_ROOT,
  projectName: 'site',
  devServerUrl: DEV_SERVER_URL,
  createdAt: START_TIME,
  updatedAt: START_TIME + 120_000,
  status: 'generated',
  question: 'Why does this action take so long?',
  followUps: [],
  relevantFiles: [],
  plans: [],
  modifications: [],
  captures: [],
  panelIds: [PANEL_ID],
  analyses: [],
  cleanup: { status: 'clean', completedAt: START_TIME + 119_000, conflicts: [] },
  promptVersions: {},
  provider: { id: 'deterministic' },
};

/** One reverted modification: the journal entry the reversibility promise is made of. */
const MODIFICATION: HttpResponseBody<'modifications.list'>['modifications'][number] = {
  id: MODIFICATION_ID,
  sessionId: SESSION_ID,
  planVersion: 1,
  file: SOURCE_FILE,
  originalHash: hashFixture('1a'),
  backupPath: `/home/example/.debuggen/backups/${SESSION_ID}/${hashFixture('1a')}`,
  instrumentedHash: hashFixture('2b'),
  appliedAt: START_TIME + 500,
  status: 'reverted',
  diff: `--- a/${SOURCE_FILE}\n+++ b/${SOURCE_FILE}\n`,
};

/** A validated panel specification, as `panel.get` and `panel.getById` return one. */
const PANEL_SPEC: HttpResponseBody<'panel.getById'>['panel'] = {
  version: 1,
  id: PANEL_ID,
  sessionId: SESSION_ID,
  panelVersion: 1,
  title: 'Where the time went',
  summary: { observed: [], likelyCauses: [] },
  layout: [],
};

/** The summary a stopped capture answers with, computed by its owner. */
const CAPTURE_SUMMARY = computeCaptureSummary(EVENTS, {
  captureId: CAPTURE_ID,
  sessionId: SESSION_ID,
});

/**
 * A valid request body for every operation, keyed by operation.
 *
 * The mapped type is the point: a missing key or a body of the wrong shape is a
 * compile error, so this table cannot fall behind the route table it mirrors.
 * The `GET` routes hold `undefined`, which is their request body type.
 */
const VALID_REQUESTS: { readonly [O in HttpOperation]: HttpRequestBody<O> } = {
  'session.create': { projectRoot: PROJECT_ROOT, question: 'Why does this action take so long?' },
  'session.list': undefined,
  'session.get': undefined,
  'session.question': { question: 'Why did that step run twice?' },
  'session.end': {},
  'capture.start': {},
  'capture.stop': {},
  'panel.data': { source: 'spans', sort: 'duration_desc', limit: 25, offset: 0 },
  'panel.get': undefined,
  'panel.getById': undefined,
  'modifications.list': undefined,
  'telemetry.event': { projectRoot: PROJECT_ROOT, events: [INGRESS_EVENT] },
  'devServer.launch': { projectRoot: PROJECT_ROOT },
  'devServer.stop': { projectRoot: PROJECT_ROOT },
  health: undefined,
  'pair.start': {},
  'pair.complete': { code: 'PAIR2X7Q' },
};

/**
 * A valid success response body for every operation, keyed by operation.
 *
 * Exhaustive by construction for the same reason {@link VALID_REQUESTS} is, and
 * the input to the JSON round-trip cases: each one is serialised, parsed back and
 * re-validated, which is what catches a body that only works in memory.
 */
const VALID_RESPONSES: { readonly [O in HttpOperation]: HttpResponseBody<O> } = {
  'session.create': SESSION_RECORD,
  'session.list': { sessions: [SESSION_RECORD] },
  'session.get': SESSION_RECORD,
  'session.question': SESSION_RECORD,
  'session.end': { cleanup: 'clean' },
  'capture.start': { captureId: CAPTURE_ID },
  'capture.stop': { summary: CAPTURE_SUMMARY },
  'panel.data': {
    source: 'spans',
    spans: [...EVENTS],
    total: EVENTS.length,
    limit: 25,
    offset: 0,
    nextOffset: null,
  },
  'panel.get': { panel: PANEL_SPEC },
  'panel.getById': { panel: PANEL_SPEC },
  'modifications.list': { modifications: [MODIFICATION] },
  'telemetry.event': { accepted: 1 },
  'devServer.launch': { devServerUrl: DEV_SERVER_URL, pid: 4242 },
  'devServer.stop': { stopped: true },
  health: { version: '0.1.0', protocolVersion: '1.0.0', pairingAvailable: true },
  'pair.start': { code: 'PAIR2X7Q', expiresAt: START_TIME + 300_000 },
  'pair.complete': { token: 'devtools-credential-placeholder' },
};

/**
 * One real result for every query source, keyed by source.
 *
 * Built with `@debuggen/telemetry`'s own aggregate builders rather than by hand,
 * because the union's payload guards are shallow and the failure worth catching
 * is a guard that refuses a value its producer actually emits. The mapped type
 * makes the table exhaustive: a source added to the vocabulary without a member
 * added to the union — or to this table — is a compile error.
 */
const VALID_DATA_RESULTS: { readonly [S in DataQuerySource]: DataResultFor<S> } = {
  trace: {
    source: 'trace',
    trace: buildTraceTree(TRACE_ID, [
      createTraceNode(INTERACTION_EVENT, [createTraceNode(FETCH_EVENT, [], 1)], 0),
    ]),
  },
  spans: {
    source: 'spans',
    spans: [...EVENTS],
    total: EVENTS.length,
    limit: 200,
    offset: 0,
    nextOffset: null,
  },
  events: {
    source: 'events',
    events: [...EVENTS],
    total: EVENTS.length,
    limit: 200,
    offset: 0,
    nextOffset: null,
  },
  renders: {
    source: 'renders',
    renders: aggregateRenders(EVENTS),
    total: aggregateRenders(EVENTS).length,
    limit: 200,
    offset: 0,
    nextOffset: null,
  },
  componentTree: {
    source: 'componentTree',
    componentTree: buildComponentTreeSnapshot(EVENTS) ?? null,
  },
  requests: {
    source: 'requests',
    requests: aggregateRequests(EVENTS),
    total: aggregateRequests(EVENTS).length,
    limit: 200,
    offset: 0,
    nextOffset: null,
  },
  queries: {
    source: 'queries',
    queries: aggregateQueries(EVENTS),
    total: aggregateQueries(EVENTS).length,
    limit: 200,
    offset: 0,
    nextOffset: null,
  },
  stateTransitions: {
    source: 'stateTransitions',
    stateTransitions: aggregateStateTransitions(EVENTS),
    total: aggregateStateTransitions(EVENTS).length,
    limit: 200,
    offset: 0,
    nextOffset: null,
  },
  graph: { source: 'graph', graph: buildDependencyGraph(EVENTS) },
  metrics: {
    source: 'metrics',
    metrics: [...CAPTURE_SUMMARY.metrics],
    total: METRIC_IDS.length,
    limit: 200,
    offset: 0,
    nextOffset: null,
  },
};

/**
 * Serialises a value the way a transport does and parses it back.
 *
 * @param value The body to round-trip.
 * @returns The value as it arrives at the other end, with every `undefined`
 * key dropped.
 */
function throughJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

describe('HTTP_ROUTES — the seventeen routes, pinned', () => {
  /**
   * The expected table, written out literally.
   *
   * Duplicated from the module on purpose: this is the one assertion that has to
   * disagree with a careless edit, and a test that derived its expectation from
   * the same object would agree with anything.
   */
  const EXPECTED: readonly (readonly [string, string, string])[] = [
    ['session.create', 'POST', '/sessions'],
    ['session.list', 'GET', '/sessions'],
    ['session.get', 'GET', '/sessions/:id'],
    ['session.question', 'POST', '/sessions/:id/question'],
    ['session.end', 'POST', '/sessions/:id/end'],
    ['capture.start', 'POST', '/sessions/:id/capture/start'],
    ['capture.stop', 'POST', '/sessions/:id/capture/stop'],
    ['panel.data', 'POST', '/sessions/:id/panel-data'],
    ['panel.get', 'GET', '/sessions/:id/panel'],
    ['panel.getById', 'GET', '/sessions/:id/panels/:panelId'],
    ['modifications.list', 'GET', '/sessions/:id/modifications'],
    ['telemetry.event', 'POST', '/telemetry/ingest'],
    ['devServer.launch', 'POST', '/dev-server/launch'],
    ['devServer.stop', 'POST', '/dev-server/stop'],
    ['health', 'GET', '/health'],
    ['pair.start', 'POST', '/pair/start'],
    ['pair.complete', 'POST', '/pair/complete'],
  ];

  it('holds exactly those seventeen operations, with those methods and paths', () => {
    expect(
      Object.entries(HTTP_ROUTES).map(([operation, route]) => [
        operation,
        route.method,
        route.pattern,
      ]),
    ).toEqual(EXPECTED.map((triple) => [...triple]));
    expect(Object.keys(HTTP_ROUTES)).toHaveLength(17);
  });

  it('lists every route in HTTP_OPERATIONS, once, in the table’s order', () => {
    expect([...HTTP_OPERATIONS]).toEqual(Object.keys(HTTP_ROUTES));
    expect(new Set(HTTP_OPERATIONS).size).toBe(17);
  });

  it('registers no method and path twice', () => {
    const registrations = HTTP_OPERATIONS.map(
      (operation) => `${HTTP_ROUTES[operation].method} ${HTTP_ROUTES[operation].pattern}`,
    );

    // `/sessions` appears under both verbs, which is legitimate and is exactly
    // the shape a genuine collision could hide behind — so the key is the pair.
    expect(new Set(registrations).size).toBe(registrations.length);
    expect(registrations.filter((registration) => registration.endsWith(' /sessions'))).toEqual([
      'POST /sessions',
      'GET /sessions',
    ]);
  });

  it('uses only GET and POST', () => {
    expect([...HTTP_METHODS]).toEqual(['GET', 'POST']);

    for (const operation of HTTP_OPERATIONS) {
      expect(HTTP_METHODS).toContain(HTTP_ROUTES[operation].method);
    }
  });

  it('declares the parameters its pattern actually contains, in order', () => {
    for (const operation of HTTP_OPERATIONS) {
      const route = HTTP_ROUTES[operation];
      const inPattern = [...route.pattern.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]);

      expect([...route.params]).toEqual(inPattern);
    }
  });

  it('repeats each operation id on its own definition', () => {
    for (const [operation, route] of Object.entries(HTTP_ROUTES)) {
      expect(route.operation).toBe(operation);
    }
  });

  it('declares a request schema for every POST and none for any GET', () => {
    for (const operation of HTTP_OPERATIONS) {
      const route = HTTP_ROUTES[operation];

      if (route.method === 'GET') {
        expect(route.request).toBeUndefined();
      } else {
        expect(route.request).toBeDefined();
      }

      expect(route.response).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('AUTH_EXEMPT_OPERATIONS — exactly GET /health and POST /pair/complete', () => {
  it('names those two operations and no others', () => {
    expect([...AUTH_EXEMPT_OPERATIONS]).toEqual(['health', 'pair.complete']);
    expect(AUTH_EXEMPT_OPERATIONS).toHaveLength(2);
  });

  it('agrees with the per-route flags in both directions', () => {
    const flagged = HTTP_OPERATIONS.filter((operation) => HTTP_ROUTES[operation].authExempt);

    expect(flagged).toEqual([...AUTH_EXEMPT_OPERATIONS]);
    expect(new Set(flagged)).toEqual(new Set(AUTH_EXEMPT_OPERATIONS));
  });

  it('is those two routes by method and path, not merely by name', () => {
    expect(
      AUTH_EXEMPT_OPERATIONS.map(
        (operation) => `${HTTP_ROUTES[operation].method} ${HTTP_ROUTES[operation].pattern}`,
      ),
    ).toEqual(['GET /health', 'POST /pair/complete']);
  });

  it('answers isAuthExemptOperation from the route flag for all seventeen', () => {
    for (const operation of HTTP_OPERATIONS) {
      expect(isAuthExemptOperation(operation)).toBe(HTTP_ROUTES[operation].authExempt);
    }

    expect(isAuthExemptOperation('health')).toBe(true);
    expect(isAuthExemptOperation('pair.complete')).toBe(true);
    // The route that mints a code is not exempt: the editor credential is what
    // authorises minting one, and only redeeming it is unauthenticated.
    expect(isAuthExemptOperation('pair.start')).toBe(false);
    expect(isAuthExemptOperation('session.create')).toBe(false);
    expect(isAuthExemptOperation('telemetry.event')).toBe(false);
  });
});

describe('the Authorization header', () => {
  it('is named in lowercase, matching Headers normalisation', () => {
    expect(AUTHORIZATION_HEADER).toBe('authorization');
  });

  it('formats a credential as a bearer value', () => {
    expect(formatBearer('devtools-credential-placeholder')).toBe(
      'Bearer devtools-credential-placeholder',
    );
  });
});

// ---------------------------------------------------------------------------
// Identity of the imported schemas
// ---------------------------------------------------------------------------

describe('the route table binds imported schemas by identity, never by copy', () => {
  it('uses panel-schema’s dataQuerySchema itself as the panel-data body', () => {
    expect(HTTP_ROUTES['panel.data'].request).toBe(dataQuerySchema);
    expect(panelDataRequestSchema).toBe(dataQuerySchema);
  });

  it('uses the session message module’s three request schemas', () => {
    expect(HTTP_ROUTES['session.create'].request).toBe(sessionCreateRequestSchema);
    expect(HTTP_ROUTES['session.question'].request).toBe(sessionQuestionRequestSchema);
    expect(HTTP_ROUTES['session.end'].request).toBe(sessionEndRequestSchema);
  });

  it('uses the capture message module’s four bodies', () => {
    expect(HTTP_ROUTES['capture.start'].request).toBe(captureStartRequestSchema);
    expect(HTTP_ROUTES['capture.start'].response).toBe(captureStartResponseSchema);
    expect(HTTP_ROUTES['capture.stop'].request).toBe(captureStopRequestSchema);
    expect(HTTP_ROUTES['capture.stop'].response).toBe(captureStopResponseSchema);
  });

  it('reports a capture conflict with a code from the shared vocabulary', () => {
    expect(DEBUGGEN_ERROR_CODES).toContain(CAPTURE_CONFLICT_ERROR_CODE);
    expect(CAPTURE_CONFLICT_ERROR_CODE).toBe('CAPTURE_ALREADY_ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// Per-route bodies: the happy path, the JSON round trip, and a rejection each
// ---------------------------------------------------------------------------

describe('every route accepts its own bodies and survives a JSON round trip', () => {
  for (const operation of HTTP_OPERATIONS) {
    it(`validates the ${operation} request and response`, () => {
      const request = parseHttpRequest(operation, VALID_REQUESTS[operation]);
      expect(request.ok).toBe(true);

      const response = parseHttpResponse(operation, VALID_RESPONSES[operation]);
      expect(response.ok).toBe(true);

      // Serialised and parsed back: an `undefined` optional key is dropped on
      // the way, so a body that depended on one would fail here.
      const roundTripped = parseHttpResponse(operation, throughJson(VALID_RESPONSES[operation]));
      expect(roundTripped.ok).toBe(true);
    });
  }

  it('returns the parsed value, not the input object, for a request with a body', () => {
    const parsed = parseHttpRequest('session.create', VALID_REQUESTS['session.create']);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(VALID_REQUESTS['session.create']);
    }
  });

  it('accepts no body for a GET and refuses one', () => {
    const empty = parseHttpRequest('session.list', undefined);
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value).toBeUndefined();
    }

    const withBody = parseHttpRequest('session.list', { unexpected: true });
    expect(withBody.ok).toBe(false);
    if (!withBody.ok) {
      expect(withBody.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(withBody.error.message).toContain('session.list');
    }
  });
});

describe('the session bodies', () => {
  it('refuses a session.create body carrying a fourth key', () => {
    expect(
      sessionCreateRequestSchema.safeParse({
        projectRoot: PROJECT_ROOT,
        question: 'Why is this slow?',
        provider: 'anthropic',
      }).success,
    ).toBe(false);
  });

  it('refuses a session.question body with no question', () => {
    expect(sessionQuestionRequestSchema.safeParse({}).success).toBe(false);
    expect(sessionQuestionRequestSchema.safeParse({ question: '' }).success).toBe(false);
  });

  it('accepts an empty session.end body and refuses an unknown key in it', () => {
    expect(sessionEndRequestSchema.safeParse({}).success).toBe(true);
    // A client that sent `{ force: true }` believes it can change what cleanup
    // does, and silence would leave it believing that.
    expect(sessionEndRequestSchema.safeParse({ force: true }).success).toBe(false);
    expect(sessionEndRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
  });

  it('answers session.end with one of the four cleanup statuses', () => {
    for (const status of ['pending', 'clean', 'partial', 'conflict'] as const) {
      expect(parseHttpResponse('session.end', { cleanup: status }).ok).toBe(true);
    }

    expect(parseHttpResponse('session.end', { cleanup: 'clean-ish' }).ok).toBe(false);
    expect(parseHttpResponse('session.end', {}).ok).toBe(false);
  });

  it('answers the session list as an object, never as a bare array', () => {
    expect(parseHttpResponse('session.list', { sessions: [] }).ok).toBe(true);
    expect(parseHttpResponse('session.list', [SESSION_RECORD]).ok).toBe(false);
  });
});

describe('the capture bodies', () => {
  it('requires the summary on a capture.stop response', () => {
    expect(captureStopResponseSchema.safeParse({}).success).toBe(false);
    expect(captureStopResponseSchema.safeParse({ summary: CAPTURE_SUMMARY }).success).toBe(true);
  });

  it('requires the capture id on a capture.start response', () => {
    expect(captureStartResponseSchema.safeParse({}).success).toBe(false);
    expect(captureStartResponseSchema.safeParse({ captureId: CAPTURE_ID }).success).toBe(true);
  });

  it('requires owningSessionId on the 409 body, alongside the error fields', () => {
    const conflict = {
      code: CAPTURE_CONFLICT_ERROR_CODE,
      message: 'Another session is capturing this project.',
      owningSessionId: SESSION_ID,
    };

    expect(captureStartConflictResponseSchema.safeParse(conflict).success).toBe(true);

    // Without the field there is nothing for a client to act on, which is the
    // whole reason AAP §0.4.2 names it.
    const { owningSessionId, ...withoutOwner } = conflict;
    expect(owningSessionId).toBe(SESSION_ID);
    expect(captureStartConflictResponseSchema.safeParse(withoutOwner).success).toBe(false);

    // The error fields still apply: the code comes from the shared vocabulary.
    expect(
      captureStartConflictResponseSchema.safeParse({ ...conflict, code: 'NOT_A_CODE' }).success,
    ).toBe(false);
  });

  it('leaves a 409 that is not an ownership conflict parseable as a plain error', () => {
    const stateError = { code: 'SESSION_INVALID_STATE', message: 'The session holds no capture.' };

    expect(httpErrorResponseSchema.safeParse(stateError).success).toBe(true);
    expect(captureStartConflictResponseSchema.safeParse(stateError).success).toBe(false);
  });
});

describe('the panel bodies', () => {
  it('lets panel.get answer null and refuses null from panel.getById', () => {
    expect(panelResponseSchema.safeParse({ panel: null }).success).toBe(true);
    expect(panelByIdResponseSchema.safeParse({ panel: null }).success).toBe(false);
    expect(panelByIdResponseSchema.safeParse({ panel: PANEL_SPEC }).success).toBe(true);
  });

  it('treats a fallback panel as a successful response', () => {
    // AAP §0.5.5: an invalid generated panel is replaced by a deterministic one
    // carrying `meta.fallback`, which the host renders under a banner. It is a
    // rendering state, never an error reply.
    expect(
      panelResponseSchema.safeParse({ panel: { ...PANEL_SPEC, meta: { fallback: true } } }).success,
    ).toBe(true);
  });

  it('refuses a panel-data query whose source is outside the vocabulary', () => {
    expect(parseHttpRequest('panel.data', { source: 'everything' }).ok).toBe(false);
    expect(parseHttpRequest('panel.data', { source: 'spans' }).ok).toBe(true);
  });

  it('answers the modification journal as an object of records', () => {
    expect(parseHttpResponse('modifications.list', { modifications: [] }).ok).toBe(true);
    expect(parseHttpResponse('modifications.list', { modifications: [{}] }).ok).toBe(false);
  });
});

describe('the telemetry ingest body', () => {
  it('accepts a producer event and rejects one that claims attribution', () => {
    expect(
      telemetryIngestRequestSchema.safeParse({
        projectRoot: PROJECT_ROOT,
        events: [INGRESS_EVENT],
      }).success,
    ).toBe(true);

    // The persisted event carries `sessionId`, `captureId` and `ingestSeq`,
    // which the service assigns at ingest — a producer that sent them would be
    // claiming a capture it does not own.
    expect(
      telemetryIngestRequestSchema.safeParse({
        projectRoot: PROJECT_ROOT,
        events: [INTERACTION_EVENT],
      }).success,
    ).toBe(false);

    for (const claimed of [
      { sessionId: SESSION_ID },
      { captureId: CAPTURE_ID },
      { ingestSeq: 1 },
    ]) {
      expect(
        telemetryIngestRequestSchema.safeParse({
          projectRoot: PROJECT_ROOT,
          events: [{ ...INGRESS_EVENT, ...claimed }],
        }).success,
      ).toBe(false);
    }
  });

  it('refuses an empty batch and a missing project root', () => {
    expect(
      telemetryIngestRequestSchema.safeParse({ projectRoot: PROJECT_ROOT, events: [] }).success,
    ).toBe(false);
    expect(telemetryIngestRequestSchema.safeParse({ events: [INGRESS_EVENT] }).success).toBe(false);
  });

  it('answers with an accepted count and an optional rejected count', () => {
    expect(parseHttpResponse('telemetry.event', { accepted: 0 }).ok).toBe(true);
    expect(parseHttpResponse('telemetry.event', { accepted: 3, rejected: 1 }).ok).toBe(true);
    expect(parseHttpResponse('telemetry.event', { accepted: -1 }).ok).toBe(false);
    expect(parseHttpResponse('telemetry.event', {}).ok).toBe(false);
  });
});

describe('the dev-server, health and pairing bodies', () => {
  it('accepts a launch request with and without a command override', () => {
    expect(parseHttpRequest('devServer.launch', { projectRoot: PROJECT_ROOT }).ok).toBe(true);
    expect(
      parseHttpRequest('devServer.launch', { projectRoot: PROJECT_ROOT, command: 'npm run dev' })
        .ok,
    ).toBe(true);
    expect(parseHttpRequest('devServer.launch', { command: 'npm run dev' }).ok).toBe(false);
  });

  it('requires an absolute URL and a positive pid from a launch', () => {
    expect(parseHttpResponse('devServer.launch', { devServerUrl: '/', pid: 1 }).ok).toBe(false);
    expect(parseHttpResponse('devServer.launch', { devServerUrl: DEV_SERVER_URL, pid: 0 }).ok).toBe(
      false,
    );
  });

  it('reports a stop that found nothing as a success', () => {
    expect(parseHttpResponse('devServer.stop', { stopped: false }).ok).toBe(true);
    expect(parseHttpResponse('devServer.stop', {}).ok).toBe(false);
  });

  it('keeps the health body to version and pairing availability', () => {
    expect(healthResponseSchema.safeParse(VALID_RESPONSES.health).success).toBe(true);

    // The unauthenticated endpoint reveals nothing else: a field added here
    // without thought is a field a web page could read about this machine.
    expect(
      healthResponseSchema.safeParse({ ...VALID_RESPONSES.health, projectRoot: PROJECT_ROOT })
        .success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({ ...VALID_RESPONSES.health, sessionCount: 2 }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({ version: '0.1.0', pairingAvailable: false }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({ ...VALID_RESPONSES.health, protocolVersion: '1.0' }).success,
    ).toBe(false);
  });

  it('accepts a pairing exchange and refuses an empty code', () => {
    expect(parseHttpRequest('pair.start', {}).ok).toBe(true);
    expect(parseHttpRequest('pair.start', { role: 'devtools' }).ok).toBe(false);
    expect(parseHttpRequest('pair.complete', { code: 'PAIR2X7Q' }).ok).toBe(true);
    expect(parseHttpRequest('pair.complete', { code: '' }).ok).toBe(false);
    expect(parseHttpRequest('pair.complete', {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The DataResult union
// ---------------------------------------------------------------------------

describe('dataResultSchema — one member per query source', () => {
  it('discriminates on source over exactly the data-query vocabulary, in order', () => {
    const discriminants = dataResultSchema.options.map((option) => option.shape.source.value);

    expect(discriminants).toEqual([...DATA_QUERY_SOURCES]);
    expect(new Set(discriminants).size).toBe(DATA_QUERY_SOURCES.length);
    expect(dataResultSchema.options).toHaveLength(10);
  });

  for (const source of DATA_QUERY_SOURCES) {
    it(`accepts a real ${source} result and round-trips it`, () => {
      const result = VALID_DATA_RESULTS[source];
      const parsed = parseDataResult(result);

      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.source).toBe(source);
      }

      expect(parseDataResult(throughJson(result)).ok).toBe(true);
    });
  }

  it('carries real aggregate elements, not just empty arrays', () => {
    // The payload guards are shallow, so the case that matters is a guard that
    // refuses what its producer emits. These four aggregates are non-empty for
    // the event fixtures above, so the assertions above exercised real elements.
    expect(VALID_DATA_RESULTS.renders.renders.length).toBeGreaterThan(0);
    expect(VALID_DATA_RESULTS.requests.requests.length).toBeGreaterThan(0);
    expect(VALID_DATA_RESULTS.queries.queries.length).toBeGreaterThan(0);
    expect(VALID_DATA_RESULTS.metrics.metrics.length).toBeGreaterThan(0);
    expect(VALID_DATA_RESULTS.componentTree.componentTree).not.toBeNull();
    expect(VALID_DATA_RESULTS.trace.trace?.traceId).toBe(TRACE_ID);
  });

  it('accepts null for the two nullable payloads and refuses it for the graph', () => {
    expect(parseDataResult({ source: 'trace', trace: null }).ok).toBe(true);
    expect(parseDataResult({ source: 'componentTree', componentTree: null }).ok).toBe(true);
    // An empty graph is `{ nodes: [], edges: [] }`, so nothing needs `null` to
    // say it, and a `null` would reach the renderer as a missing value.
    expect(parseDataResult({ source: 'graph', graph: null }).ok).toBe(false);
  });

  it('refuses a payload field that does not match its source', () => {
    expect(
      parseDataResult({
        source: 'spans',
        renders: [],
        total: 0,
        limit: 1,
        offset: 0,
        nextOffset: null,
      }).ok,
    ).toBe(false);
    expect(parseDataResult({ source: 'graph', graph: { nodes: [] } }).ok).toBe(false);
    expect(parseDataResult({ source: 'metrics', metrics: [{ id: 'not_a_metric' }] }).ok).toBe(
      false,
    );
  });

  it('refuses an unknown source and a missing discriminant', () => {
    expect(parseDataResult({ source: 'everything', everything: [] }).ok).toBe(false);
    expect(parseDataResult({ spans: [] }).ok).toBe(false);
    expect(parseDataResult(undefined).ok).toBe(false);
  });

  it('refuses a page that omits its echo', () => {
    expect(parseDataResult({ source: 'spans', spans: [] }).ok).toBe(false);
    expect(
      parseDataResult({
        source: 'spans',
        spans: [],
        total: 0,
        limit: 0,
        offset: 0,
        nextOffset: null,
      }).ok,
    ).toBe(true);
  });
});

describe('dataPageSchema — the paging echo', () => {
  /** The echo a first, complete page carries. */
  const page = { total: 3, limit: 200, offset: 0, nextOffset: null };

  it('accepts a last page and a page with more to come', () => {
    expect(dataPageSchema.safeParse(page).success).toBe(true);
    expect(dataPageSchema.safeParse({ ...page, total: 400, nextOffset: 200 }).success).toBe(true);
  });

  it('accepts a zero limit, which is what an explicit request for no items echoes', () => {
    expect(dataPageSchema.safeParse({ ...page, limit: 0 }).success).toBe(true);
  });

  it('refuses a limit above the query ceiling', () => {
    expect(dataPageSchema.safeParse({ ...page, limit: DATA_QUERY_MAX_LIMIT }).success).toBe(true);
    expect(dataPageSchema.safeParse({ ...page, limit: DATA_QUERY_MAX_LIMIT + 1 }).success).toBe(
      false,
    );
  });

  it('refuses a negative offset and a non-integer total', () => {
    expect(dataPageSchema.safeParse({ ...page, offset: -1 }).success).toBe(false);
    expect(dataPageSchema.safeParse({ ...page, total: 2.5 }).success).toBe(false);
    expect(dataPageSchema.safeParse({ ...page, nextOffset: -1 }).success).toBe(false);
  });

  it('refuses an absent nextOffset, because absence is not the last page', () => {
    expect(dataPageSchema.safeParse({ total: 3, limit: 200, offset: 0 }).success).toBe(false);
    expect(dataPageSchema.safeParse({ ...page, extra: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path construction
// ---------------------------------------------------------------------------

describe('buildPath — substitution, encoding and a loud failure', () => {
  it('builds the concrete path of every operation', () => {
    const params = { id: SESSION_ID, panelId: PANEL_ID };

    expect(HTTP_OPERATIONS.map((operation) => buildPath(operation, params))).toEqual([
      '/sessions',
      '/sessions',
      `/sessions/${SESSION_ID}`,
      `/sessions/${SESSION_ID}/question`,
      `/sessions/${SESSION_ID}/end`,
      `/sessions/${SESSION_ID}/capture/start`,
      `/sessions/${SESSION_ID}/capture/stop`,
      `/sessions/${SESSION_ID}/panel-data`,
      `/sessions/${SESSION_ID}/panel`,
      `/sessions/${SESSION_ID}/panels/${PANEL_ID}`,
      `/sessions/${SESSION_ID}/modifications`,
      '/telemetry/ingest',
      '/dev-server/launch',
      '/dev-server/stop',
      '/health',
      '/pair/start',
      '/pair/complete',
    ]);
  });

  it('encodes every parameter, so a value cannot become another route', () => {
    expect(buildPath('session.get', { id: 'a/../b' })).toBe('/sessions/a%2F..%2Fb');
    expect(buildPath('session.get', { id: 'a?b#c' })).toBe('/sessions/a%3Fb%23c');
    expect(buildPath('panel.getById', { id: 'x y', panelId: 'p&q' })).toBe(
      '/sessions/x%20y/panels/p%26q',
    );
  });

  it('throws a DebuggenError naming the parameter, and no value, when one is missing', () => {
    let thrown: unknown;

    try {
      buildPath('panel.getById', { id: SESSION_ID });
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(DebuggenError);
    if (thrown instanceof DebuggenError) {
      expect(thrown.code).toBe('INTERNAL');
      expect(thrown.message).toContain('panelId');
      expect(thrown.details).toEqual({ operation: 'panel.getById', parameter: 'panelId' });
    }

    expect(() => buildPath('session.get')).toThrow(DebuggenError);
    expect(() => buildPath('session.get', { id: '' })).toThrow(DebuggenError);
    // A route with no parameters needs none.
    expect(() => buildPath('health')).not.toThrow();
  });

  it('agrees with every named builder', () => {
    expect(sessionsPath()).toBe('/sessions');
    expect(sessionPath(SESSION_ID)).toBe(buildPath('session.get', { id: SESSION_ID }));
    expect(sessionQuestionPath(SESSION_ID)).toBe(buildPath('session.question', { id: SESSION_ID }));
    expect(sessionEndPath(SESSION_ID)).toBe(buildPath('session.end', { id: SESSION_ID }));
    expect(captureStartPath(SESSION_ID)).toBe(buildPath('capture.start', { id: SESSION_ID }));
    expect(captureStopPath(SESSION_ID)).toBe(buildPath('capture.stop', { id: SESSION_ID }));
    expect(panelDataPath(SESSION_ID)).toBe(buildPath('panel.data', { id: SESSION_ID }));
    expect(panelPath(SESSION_ID)).toBe(buildPath('panel.get', { id: SESSION_ID }));
    expect(panelByIdPath(SESSION_ID, PANEL_ID)).toBe(
      buildPath('panel.getById', { id: SESSION_ID, panelId: PANEL_ID }),
    );
    expect(modificationsPath(SESSION_ID)).toBe(buildPath('modifications.list', { id: SESSION_ID }));
    expect(telemetryIngestPath()).toBe('/telemetry/ingest');
    expect(devServerLaunchPath()).toBe('/dev-server/launch');
    expect(devServerStopPath()).toBe('/dev-server/stop');
    expect(healthPath()).toBe('/health');
    expect(pairStartPath()).toBe('/pair/start');
    expect(pairCompletePath()).toBe('/pair/complete');
  });

  it('publishes the WebSocket path beside the routes', () => {
    expect(WS_PATH).toBe('/ws');
  });
});

// ---------------------------------------------------------------------------
// Leak freedom (AAP §0.5.2)
// ---------------------------------------------------------------------------

describe('a rejected body never becomes a leak', () => {
  /**
   * A value that must not appear anywhere in an error.
   *
   * Stands in for what a real rejected body holds: a project path, the
   * developer's question, a redacted URL, a parameterized statement.
   */
  const SENTINEL = 'do-not-echo-this-captured-value';

  /**
   * Every string an error exposes: its message, its hint, its structured
   * details and the payload that crosses the wire.
   *
   * @param error The rejection to flatten.
   * @returns One string to search for the sentinel in.
   */
  function exposedText(error: DebuggenError): string {
    return JSON.stringify({
      message: error.message,
      hint: error.hint,
      details: error.details,
      payload: error.toPayload(),
    });
  }

  it('reports an invalid request body without echoing its values', () => {
    const rejected = parseHttpRequest('session.create', {
      projectRoot: PROJECT_ROOT,
      question: SENTINEL,
      target: SENTINEL,
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(exposedText(rejected.error)).not.toContain(SENTINEL);
      // The field name is kept — it is what makes the mistake diagnosable, and
      // AAP §0.5.2 draws the line at the value.
      expect(rejected.error.message).toContain('target');
      expect(DEBUGGEN_ERROR_CODES).toContain(rejected.error.code);
    }
  });

  it('reports an invalid response body without echoing its values', () => {
    const rejected = parseHttpResponse('devServer.launch', {
      devServerUrl: SENTINEL,
      pid: SENTINEL,
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(exposedText(rejected.error)).not.toContain(SENTINEL);
      expect(DEBUGGEN_ERROR_CODES).toContain(rejected.error.code);
    }
  });

  it('reports an invalid panel-data result without echoing its payload', () => {
    const rejected = parseDataResult({
      source: 'queries',
      queries: [{ statement: SENTINEL }],
      total: 1,
      limit: 200,
      offset: 0,
      nextOffset: null,
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(exposedText(rejected.error)).not.toContain(SENTINEL);
      expect(rejected.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(DEBUGGEN_ERROR_CODES).toContain(rejected.error.code);
    }
  });

  it('reports a body sent to a bodiless route without echoing it', () => {
    const rejected = parseHttpRequest('health', { question: SENTINEL });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(exposedText(rejected.error)).not.toContain(SENTINEL);
      expect(DEBUGGEN_ERROR_CODES).toContain(rejected.error.code);
    }
  });
});
