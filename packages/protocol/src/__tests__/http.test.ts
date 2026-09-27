/**
 * Tests for `../http.ts`, the service's HTTP route surface, in the directory
 * `packages/protocol/tsconfig.json` names for this package's suites.
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
 * - **The table itself.** All twenty-two `(operation, method, pattern)` triples
 *   are written out literally below and compared against `HTTP_ROUTES`, so that
 *   adding, renaming or re-pathing a route is a deliberate edit in two places
 *   rather than an accident in one. A duplicated `(method, pattern)` pair is
 *   checked for separately: `/sessions` legitimately appears twice, under
 *   different methods, which is exactly the shape a second collision could hide
 *   in.
 * - **The operation-id type.** `HttpOperationId` is the key type the service's
 *   `Record<HttpOperationId, RouteHandler>` handler map is written against, so
 *   the cases prove at compile time that it is exactly the `HTTP_OPERATIONS`
 *   member union, that `HttpOperation` is the same type, that the package
 *   barrel publishes both names, and that a handler map missing one operation —
 *   or naming one the table does not hold — does not type-check.
 * - **The authentication exemption.** Exactly two routes are reachable
 *   without a bearer credential. The module states that twice — as a
 *   tuple and as a per-route flag — and although a compile-time proof ties them
 *   together, the cases here assert the agreement from both directions at run
 *   time as well, because a widened exemption is the one defect in this file
 *   that is a security bug rather than a bug.
 * - **The acting-tab header.** One paired DevTools credential serves every
 *   inspected tab, so `x-debuggen-tab` is what lets the service hold a DevTools
 *   request to the session bound to its tab. The cases pin its
 *   lowercase name, accept only one tab id in canonical decimal — refusing an
 *   empty value, a sign, a leading zero, whitespace, a joined duplicate and the
 *   first unsafe integer, each without quoting it — and prove the formatter
 *   writes exactly what the parser reads back.
 * - **Identity, not similarity.** Every query field of the panel-data body must
 *   be `@debuggen/panel-schema`'s own `dataQuerySchema` field schema *itself*,
 *   beside the one protocol-owned `panelId`, and the session and
 *   capture bodies must be the very schema objects `../messages/session.ts` and
 *   `../messages/capture.ts` declare. The modification journal's element schema
 *   must be `@debuggen/instrumentation`'s `modificationRecordSchema` as both of
 *   that package's entries export it — the browser-safe `./schema` entry this
 *   package imports and the root the local service imports — which is what
 *   proves the two entries share one module rather than each carrying a copy.
 *   A structural comparison would pass for a hand-written copy, which is a
 *   second definition free to drift from the first, so these are `toBe`
 *   assertions.
 * - **The `DataResult` union.** `DATA_QUERY_SOURCES` states that its ten members
 *   are "exactly the discriminants" of this union; the cases check that as a set,
 *   in order, with one member each, and then parse a real aggregate for every
 *   source — produced by `@debuggen/telemetry`'s own builders rather than
 *   hand-written — because the payload guards are shallow and a guard that
 *   refused a real value would be worse than no guard at all. Which sources page
 *   is checked from both sides: the echo is required on all seven array-valued
 *   ones and refused on the three that answer with a single value, and the two
 *   lists are proved to cover the vocabulary so a new source cannot slip in
 *   unclassified. Metrics page by the same rule as the rest: a walk that follows
 *   `nextOffset` reassembles the complete set, and a page that ignores its
 *   window — every value whatever the limit — is refused.
 * - **The administrative operations.** `devServer.credential`,
 *   `credentials.release`, `credentials.rotate` and `session.purge` are table
 *   rows like any other, so no process registers or calls a route this module
 *   does not declare. Their bodies are checked at their bounds: the credential
 *   request names one project and nothing else, the release request names one
 *   token and nothing else and is answered with one flag, the two report
 *   bodies refuse a negative count, and the purge report's retained-session
 *   list must be the truncation of its total at
 *   `SESSION_PURGE_MAX_REPORTED_SESSIONS`.
 * - **The shared error body.** A non-2xx reply carries `./messages/error.ts`'s
 *   payload unchanged — a code from the closed vocabulary, a message, an
 *   optional `ref`, and no `hint` — so one renderer serves a failed request and
 *   an `error` frame alike.
 * - **Ingress versus persisted events.** The ingest body must refuse an event
 *   carrying `sessionId`, `captureId` or `ingestSeq`: attribution is the
 *   service's to assign, and a producer that could claim a session could write
 *   into someone else's capture. The body's optional delivery context — the
 *   refusal-only `armedCaptureId` and the `droppedCount` loss report — is held
 *   to the WebSocket payload's own rules, issue for issue, and an event-less
 *   body is accepted only as a loss-only report. The body's own `lossReportId`,
 *   the identity a retried loss report keeps, is held to the identifier rule
 *   `armedCaptureId` applies and accepted only beside a loss.
 * - **Leak freedom.** A rejected body is unvalidated data from another process
 *   and holds project paths, the developer's question, redacted URLs and
 *   parameterized SQL. None of it may appear in the error, and the
 *   sentinel cases check the message, the hint, the details and the wire payload.
 * - **JSON survival.** Every response body is built, parsed, serialised,
 *   deserialised and parsed again, because `undefined` does not survive a round
 *   trip and a schema that relied on an absent key to mean something would fail
 *   in production rather than here.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ZodType } from 'zod';

// Both entries of the owning package, on purpose: the root is what the local
// service imports and `./schema` is what this package's modules import, and the
// identity case below holds the two to one schema instance.
import { modificationRecordSchema as rootModificationRecordSchema } from '@debuggen/instrumentation';
import { modificationRecordSchema } from '@debuggen/instrumentation/schema';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SOURCES,
  dataQuerySchema,
} from '@debuggen/panel-schema';
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
  ACTING_TAB_HEADER,
  AUTH_EXEMPT_OPERATIONS,
  AUTHORIZATION_HEADER,
  CAPTURE_CONFLICT_ERROR_CODE,
  HTTP_METHODS,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  SESSION_PURGE_MAX_REPORTED_SESSIONS,
  WS_PATH,
  buildPath,
  captureStartConflictResponseSchema,
  captureStartRequestSchema,
  captureStartResponseSchema,
  captureStopRequestSchema,
  captureStopResponseSchema,
  captureStartPath,
  captureStopPath,
  credentialsReleasePath,
  credentialsReleaseRequestSchema,
  credentialsReleaseResponseSchema,
  credentialsRotatePath,
  credentialsRotateRequestSchema,
  credentialsRotateResponseSchema,
  dataPageSchema,
  dataResultSchema,
  devServerCredentialPath,
  devServerCredentialRequestSchema,
  devServerCredentialResponseSchema,
  devServerLaunchPath,
  devServerStopPath,
  devServerStopRequestSchema,
  formatActingTabHeader,
  formatBearer,
  healthPath,
  healthResponseSchema,
  httpErrorResponseSchema,
  isAuthExemptOperation,
  modificationsPath,
  pairCompletePath,
  READ_PROOF_LENGTH,
  pairCompleteResponseSchema,
  pairStartPath,
  pairStartResponseSchema,
  panelByIdPath,
  panelByIdResponseSchema,
  panelDataPath,
  panelDataRequestSchema,
  panelPath,
  panelResponseSchema,
  parseActingTabHeader,
  parseDataResult,
  parseHttpRequest,
  parseHttpResponse,
  sessionCreateRequestSchema,
  sessionEndPath,
  sessionEndRequestSchema,
  sessionPath,
  sessionPurgePath,
  sessionPurgeRequestSchema,
  sessionPurgeResponseSchema,
  sessionQuestionPath,
  sessionQuestionRequestSchema,
  sessionsPath,
  targetRequestPath,
  targetRequestRequestSchema,
  targetRequestResponseSchema,
  telemetryIngestPath,
  telemetryIngestRequestSchema,
} from '../http.js';
import type {
  DataResult,
  DataResultFor,
  HttpOperation,
  HttpOperationId,
  HttpRequestBody,
  HttpResponseBody,
  TelemetryIngestRequest,
} from '../http.js';
// Type-only, so the barrel is never loaded at run time: what is on trial is
// that a consumer importing from the package's one door can name the type.
import type {
  HttpOperation as BarrelHttpOperation,
  HttpOperationId as BarrelHttpOperationId,
} from '../index.js';
import { sessionBindPayloadSchema } from '../messages/binding.js';
// The WebSocket half of `telemetry.event`, so the ingest body's delivery
// context can be held to the very rules that payload applies.
import { telemetryEventPayloadSchema } from '../messages/telemetry.js';
import type { TelemetryEventPayload } from '../messages/telemetry.js';
import { CLEANUP_STATUSES } from '../session-record.js';
import { PROTOCOL_VERSION } from '../version.js';
// The paged listings' contract, Section C.1 of `../http.ts`.
import {
  LIST_PAGE_MAX_LIMITS,
  LIST_PAGE_MAX_OFFSET,
  LIST_PAGE_OPERATIONS,
  MODIFICATION_DIFF_MAX_BYTES,
  MODIFICATIONS_PAGE_DEFAULT_LIMIT,
  MODIFICATIONS_PAGE_DIFF_BUDGET,
  MODIFICATIONS_PAGE_MAX_LIMIT,
  SESSION_LIST_DEFAULT_LIMIT,
  SESSION_LIST_MAX_LIMIT,
  formatListPageQuery,
  isListPageOperation,
  modificationsDiffBytes,
  parseListPageQuery,
  sessionListItemSchema,
  toSessionListItem,
  utf8ByteLength,
} from '../http.js';

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

/**
 * The identity of one ingest body's loss report, kept across its retries.
 * Opaque: the producer chooses its spelling, so no product prefix is implied.
 */
const LOSS_REPORT_ID = 'loss-report-7c2e9a41';

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

/** The Chrome tab the fixture session is bound to, as `chrome.tabs.Tab.id` reports it. */
const TAB_ID = 7;

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

/** An empty first page of the session list: nothing stored, nothing to follow. */
const EMPTY_SESSION_PAGE: HttpResponseBody<'session.list'> = {
  sessions: [],
  total: 0,
  limit: SESSION_LIST_DEFAULT_LIMIT,
  offset: 0,
  nextOffset: null,
};

/** An empty first page of the modification journal. */
const EMPTY_JOURNAL_PAGE: HttpResponseBody<'modifications.list'> = {
  modifications: [],
  total: 0,
  limit: MODIFICATIONS_PAGE_DEFAULT_LIMIT,
  offset: 0,
  nextOffset: null,
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

/** One day, in milliseconds: the unit `DEBUGGEN_RETENTION_DAYS` is counted in. */
const MS_PER_DAY = 86_400_000;

/** An aged session an unresolved conflict kept past the retention window. */
const CONFLICTED_SESSION_ID = 'ses_9w3e5r7t1y2u4i6o';

/** The server-agent credential `devServer.credential` hands over; low-entropy on purpose. */
const SERVER_AGENT_TOKEN = 'server-agent-credential-placeholder';

/** The read proof `pair.complete` hands over beside the credential; low-entropy on purpose. */
const READ_PROOF_PLACEHOLDER = 'r'.repeat(READ_PROOF_LENGTH);

/**
 * Distinct session ids of the product's shape, for the purge report's bound.
 *
 * Zero-padded counters rather than random text, for the reason the fixture
 * note above gives: they satisfy the schema and stay low-entropy.
 *
 * @param count How many ids to build.
 * @returns `count` distinct twenty-character session ids, sorted.
 */
function retainedSessionIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `ses_${String(index).padStart(16, '0')}`);
}

/**
 * A purge report from a sweep over the default thirty-day window: two sessions
 * and what they held removed, one kept for a conflict, nothing stepped over.
 */
const SESSION_PURGE_REPORT: HttpResponseBody<'session.purge'> = {
  cutoff: START_TIME - 30 * MS_PER_DAY,
  sessionsDeleted: 2,
  telemetryEventsDeleted: EVENTS.length,
  panelsDeleted: 1,
  analysesDeleted: 1,
  modificationsDeleted: 1,
  backupDirsDeleted: 2,
  orphanBackupsDeleted: 0,
  indexCachesDeleted: 1,
  sessionsRetainedForConflicts: [CONFLICTED_SESSION_ID],
  sessionsRetainedForConflictsTotal: 1,
  issueCount: 0,
  durationMs: 42.5,
};

/**
 * A valid request body for every operation, keyed by operation.
 *
 * The mapped type is the point: a missing key or a body of the wrong shape is a
 * compile error, so this table cannot fall behind the route table it mirrors.
 * The `GET` routes hold `undefined`, which is their request body type.
 */
const VALID_REQUESTS: { readonly [O in HttpOperationId]: HttpRequestBody<O> } = {
  'session.create': { projectRoot: PROJECT_ROOT, question: 'Why does this action take so long?' },
  'session.list': undefined,
  'session.get': undefined,
  'session.question': { question: 'Why did that step run twice?' },
  'session.end': {},
  'session.purge': {},
  'capture.start': {},
  'capture.stop': {},
  'target.request': {},
  'panel.data': { source: 'spans', sort: 'duration_desc', limit: 25, offset: 0 },
  'panel.get': undefined,
  'panel.getById': undefined,
  'modifications.list': undefined,
  'telemetry.event': { projectRoot: PROJECT_ROOT, events: [INGRESS_EVENT] },
  'devServer.launch': { projectRoot: PROJECT_ROOT },
  'devServer.stop': { projectRoot: PROJECT_ROOT },
  'devServer.credential': { projectRoot: PROJECT_ROOT },
  health: undefined,
  'pair.start': {},
  'pair.complete': { code: 'PAIR2X7Q' },
  'credentials.rotate': {},
  'credentials.release': { token: SERVER_AGENT_TOKEN },
};

/**
 * A valid success response body for every operation, keyed by operation.
 *
 * Exhaustive by construction for the same reason {@link VALID_REQUESTS} is, and
 * the input to the JSON round-trip cases: each one is serialised, parsed back and
 * re-validated, which is what catches a body that only works in memory.
 */
const VALID_RESPONSES: { readonly [O in HttpOperationId]: HttpResponseBody<O> } = {
  'session.create': SESSION_RECORD,
  'session.list': {
    sessions: [toSessionListItem(SESSION_RECORD)],
    total: 1,
    limit: SESSION_LIST_DEFAULT_LIMIT,
    offset: 0,
    nextOffset: null,
  },
  'session.get': SESSION_RECORD,
  'session.question': SESSION_RECORD,
  'session.end': { cleanup: 'clean' },
  'session.purge': SESSION_PURGE_REPORT,
  'capture.start': { captureId: CAPTURE_ID },
  'capture.stop': { summary: CAPTURE_SUMMARY },
  'target.request': { sessionId: SESSION_ID, tabId: TAB_ID },
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
  'modifications.list': {
    modifications: [MODIFICATION],
    total: 1,
    limit: MODIFICATIONS_PAGE_DEFAULT_LIMIT,
    offset: 0,
    nextOffset: null,
  },
  'telemetry.event': { accepted: 1 },
  'devServer.launch': { devServerUrl: DEV_SERVER_URL, pid: 4242 },
  'devServer.stop': { stopped: true },
  'devServer.credential': { token: SERVER_AGENT_TOKEN, expiresAt: START_TIME + 43_200_000 },
  health: { version: '0.1.0', protocolVersion: '1.0.0', pairingAvailable: true },
  'pair.start': { code: 'PAIR2X7Q', expiresAt: START_TIME + 300_000 },
  'pair.complete': { token: 'devtools-credential-placeholder', readProof: READ_PROOF_PLACEHOLDER },
  'credentials.rotate': { credentialsDeleted: 3, socketsClosed: 2 },
  'credentials.release': { released: true },
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
    total: CAPTURE_SUMMARY.metrics.length,
    limit: 200,
    offset: 0,
    nextOffset: null,
  },
};

/**
 * The sources whose result is a page of items and therefore carries the echo.
 *
 * Written out literally, like the route table: which sources page is a contract
 * the service's resolver and every client's paging loop both depend on, so it is
 * stated here rather than read back off the union under test. The case
 * `classifies every source as paged or single-valued` proves the two lists
 * together cover the vocabulary, so a source added without being classified
 * fails rather than going untested.
 */
const PAGED_SOURCES = [
  'spans',
  'events',
  'renders',
  'requests',
  'queries',
  'stateTransitions',
  'metrics',
] as const satisfies readonly DataQuerySource[];

/** The sources whose result is one value: a tree, a snapshot, a graph. */
const SINGLE_VALUE_SOURCES = [
  'trace',
  'componentTree',
  'graph',
] as const satisfies readonly DataQuerySource[];

/**
 * The two sources whose payload may be `null`.
 *
 * `null` is the empty answer rather than an error for both: no trace matched the
 * filter, and no render evidence was captured to build a tree from.
 */
const NULLABLE_SOURCES: readonly DataQuerySource[] = ['trace', 'componentTree'];

/** The four fields of the paging echo, by name. */
const PAGING_ECHO_KEYS: readonly string[] = ['total', 'limit', 'offset', 'nextOffset'];

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

/**
 * Copies a result without its paging echo, leaving the payload untouched.
 *
 * Built by filtering rather than by hand so the stripped value is the very
 * payload the union accepted a moment earlier — which is what makes the
 * rejection attributable to the missing echo and to nothing else.
 *
 * @param result A valid result for a paged source.
 * @returns The same object with `total`, `limit`, `offset` and `nextOffset`
 * removed.
 */
function withoutPagingEcho(result: DataResult): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result as unknown as Record<string, unknown>).filter(
      ([key]) => !PAGING_ECHO_KEYS.includes(key),
    ),
  );
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

describe('HTTP_ROUTES — the twenty-two routes, pinned', () => {
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
    ['session.purge', 'POST', '/sessions/purge'],
    ['capture.start', 'POST', '/sessions/:id/capture/start'],
    ['capture.stop', 'POST', '/sessions/:id/capture/stop'],
    ['target.request', 'POST', '/sessions/:id/target/request'],
    ['panel.data', 'POST', '/sessions/:id/panel-data'],
    ['panel.get', 'GET', '/sessions/:id/panel'],
    ['panel.getById', 'GET', '/sessions/:id/panels/:panelId'],
    ['modifications.list', 'GET', '/sessions/:id/modifications'],
    ['telemetry.event', 'POST', '/telemetry/ingest'],
    ['devServer.launch', 'POST', '/dev-server/launch'],
    ['devServer.stop', 'POST', '/dev-server/stop'],
    ['devServer.credential', 'POST', '/dev-server/credential'],
    ['health', 'GET', '/health'],
    ['pair.start', 'POST', '/pair/start'],
    ['pair.complete', 'POST', '/pair/complete'],
    ['credentials.rotate', 'POST', '/credentials/rotate'],
    ['credentials.release', 'POST', '/credentials/release'],
  ];

  it('holds exactly those twenty-two operations, with those methods and paths', () => {
    expect(
      Object.entries(HTTP_ROUTES).map(([operation, route]) => [
        operation,
        route.method,
        route.pattern,
      ]),
    ).toEqual(EXPECTED.map((triple) => [...triple]));
    expect(Object.keys(HTTP_ROUTES)).toHaveLength(22);
  });

  it('lists every route in HTTP_OPERATIONS, once, in the table’s order', () => {
    expect([...HTTP_OPERATIONS]).toEqual(Object.keys(HTTP_ROUTES));
    expect(new Set(HTTP_OPERATIONS).size).toBe(22);
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
// The operation-id type
//
// Compile-time proofs, checked by `pnpm typecheck` (this suite is part of the
// package's `tsc -b` program): `expectTypeOf` and `@ts-expect-error` fail that
// gate, not the Vitest run, when the relationship they state stops holding. Each
// case also asserts the run-time fact the type stands for, so the suite is not a
// set of empty bodies to a reader of the Vitest report.
// ---------------------------------------------------------------------------

describe('HttpOperationId — the canonical operation-id type', () => {
  it('is exactly the HTTP_OPERATIONS member union, which is exactly the table keys', () => {
    expectTypeOf<HttpOperationId>().toEqualTypeOf<(typeof HTTP_OPERATIONS)[number]>();
    expectTypeOf<HttpOperationId>().toEqualTypeOf<keyof typeof HTTP_ROUTES>();

    expect([...HTTP_OPERATIONS].sort()).toEqual(Object.keys(HTTP_ROUTES).sort());
  });

  it('is the same type HttpOperation names, in both directions', () => {
    expectTypeOf<HttpOperation>().toEqualTypeOf<HttpOperationId>();

    const viaAlias: HttpOperation = 'session.create';
    const viaCanonical: HttpOperationId = viaAlias;
    const backViaAlias: HttpOperation = viaCanonical;
    expect(backViaAlias).toBe('session.create');
  });

  it('is published through the package barrel under both names', () => {
    expectTypeOf<BarrelHttpOperationId>().toEqualTypeOf<HttpOperationId>();
    expectTypeOf<BarrelHttpOperation>().toEqualTypeOf<HttpOperationId>();

    const fromBarrel: BarrelHttpOperationId = 'health';
    expect(HTTP_OPERATIONS).toContain(fromBarrel);
  });

  it('keys an exhaustive handler map: a missing or an unknown operation is a type error', () => {
    // The shape `apps/local-service/src/server/http.ts` declares its handlers
    // in, with each handler reduced to the method it serves.
    const handlers: Record<HttpOperationId, string> = {
      'session.create': 'POST',
      'session.list': 'GET',
      'session.get': 'GET',
      'session.question': 'POST',
      'session.end': 'POST',
      'session.purge': 'POST',
      'capture.start': 'POST',
      'capture.stop': 'POST',
      'target.request': 'POST',
      'panel.data': 'POST',
      'panel.get': 'GET',
      'panel.getById': 'GET',
      'modifications.list': 'GET',
      'telemetry.event': 'POST',
      'devServer.launch': 'POST',
      'devServer.stop': 'POST',
      'devServer.credential': 'POST',
      health: 'GET',
      'pair.start': 'POST',
      'pair.complete': 'POST',
      'credentials.rotate': 'POST',
      'credentials.release': 'POST',
    };

    for (const operation of HTTP_OPERATIONS) {
      expect(handlers[operation]).toBe(HTTP_ROUTES[operation].method);
    }

    const { 'pair.complete': omitted, ...withoutPairComplete } = handlers;
    // @ts-expect-error - a handler map that omits one operation does not satisfy Record<HttpOperationId, …>.
    const incomplete: Record<HttpOperationId, string> = withoutPairComplete;
    expect(omitted).toBe('POST');
    expect(Object.keys(incomplete)).toHaveLength(HTTP_OPERATIONS.length - 1);

    const stale: Record<HttpOperationId, string> = {
      ...handlers,
      // @ts-expect-error - a handler for an operation the table does not hold is refused.
      'session.rename': 'POST',
    };
    expect(Object.keys(stale)).toHaveLength(HTTP_OPERATIONS.length + 1);
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

  it('answers isAuthExemptOperation from the route flag for all twenty-two', () => {
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
    // Asking a panel to pick is a state change on a bound tab, so it carries
    // the editor credential like every other session route.
    expect(isAuthExemptOperation('target.request')).toBe(false);
    expect(HTTP_OPERATIONS.filter((operation) => !isAuthExemptOperation(operation))).toHaveLength(
      20,
    );
  });

  it('requires a credential on the four administrative operations', () => {
    // Minting a server-agent credential, revoking one or every credential and
    // purging the store are the most consequential calls in the table; an
    // exemption on any of them would hand a local web page the machine's
    // debugging state, or a way to cut a running dev server's telemetry off.
    for (const operation of [
      'devServer.credential',
      'credentials.release',
      'credentials.rotate',
      'session.purge',
    ] as const) {
      expect(isAuthExemptOperation(operation)).toBe(false);
      expect(HTTP_ROUTES[operation].authExempt).toBe(false);
      expect(AUTH_EXEMPT_OPERATIONS).not.toContain(operation);
    }
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

// One paired DevTools credential is presented for every inspected tab, so a
// DevTools request says which tab it acts for in this header, and the service
// verifies it against its live binding table. The value is unvalidated data
// from another process until it parses, so no rejection may quote it.
describe('the acting-tab header', () => {
  /**
   * The strings of a rejection that could carry a value: message, hint,
   * details and the wire payload.
   *
   * @param error The rejection.
   * @returns Those surfaces as one string.
   */
  function surfacesOf(error: DebuggenError): string {
    return JSON.stringify({
      message: error.message,
      hint: error.hint,
      details: error.details,
      payload: error.toPayload(),
    });
  }

  it('is named in lowercase, matching Headers normalisation', () => {
    expect(ACTING_TAB_HEADER).toBe('x-debuggen-tab');
    expect(ACTING_TAB_HEADER).toBe(ACTING_TAB_HEADER.toLowerCase());
  });

  it.each([
    ['0', 0],
    ['7', 7],
    ['42', 42],
    ['1234567', 1_234_567],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('parses %s as one tab id', (value, expected) => {
    const parsed = parseActingTabHeader(value);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toBe(expected);
    }
  });

  it.each([null, undefined])('answers an absent header (%s) as no tab, not a failure', (value) => {
    const parsed = parseActingTabHeader(value);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toBeUndefined();
    }
  });

  it.each([
    ['an empty value', ''],
    ['a negative id', '-1'],
    ['a leading zero', '01'],
    ['a fraction', '1.5'],
    ['an explicit sign', '+3'],
    ['leading whitespace', ' 4'],
    ['trailing whitespace', '4 '],
    ['a duplicated header, as Headers.get joins it', '4, 5'],
    ['the first integer beyond the safe range', '9007199254740992'],
    ['sixteen nines', '9999999999999999'],
    ['seventeen digits', '12345678901234567'],
    ['an exponent', '1e3'],
    ['a hexadecimal literal', '0x4'],
    ['a word', 'abc'],
    ['a planted value', 'do-not-echo-this-tab-value'],
  ])('refuses %s without quoting it', (_label, value) => {
    const parsed = parseActingTabHeader(value);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error).toBeInstanceOf(DebuggenError);
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toBe(
      'Invalid x-debuggen-tab header: expected the decimal id of exactly one Chrome tab',
    );
    expect(parsed.error.hint).toContain('canonical decimal');
    expect(parsed.error.details).toStrictEqual({ header: ACTING_TAB_HEADER });
    expect(parsed.error.cause).toBeUndefined();
    // A constant message for every refusal is the leak-freedom guarantee; the
    // literal search below adds nothing for the empty value, which every string
    // contains.
    if (value !== '') {
      expect(surfacesOf(parsed.error)).not.toContain(value);
    }
  });

  it.each([
    [0, '0'],
    [42, '42'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
  ])('formats tab %s as %s, which parses back to the same tab', (tabId, expected) => {
    const formatted = formatActingTabHeader(tabId);

    expect(formatted.ok).toBe(true);
    if (!formatted.ok) {
      return;
    }
    expect(formatted.value).toBe(expected);

    const parsed = parseActingTabHeader(formatted.value);

    expect(parsed.ok && parsed.value).toBe(tabId);
  });

  it.each([
    ['chrome.tabs.TAB_ID_NONE', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['an infinite value', Number.POSITIVE_INFINITY],
    ['the first integer beyond the safe range', Number.MAX_SAFE_INTEGER + 1],
    ['a string from untyped code', '7' as unknown as number],
  ])('refuses to format %s', (_label, tabId) => {
    const formatted = formatActingTabHeader(tabId);

    expect(formatted.ok).toBe(false);
    if (formatted.ok) {
      return;
    }
    expect(formatted.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(formatted.error.message).toBe(
      'Cannot send the x-debuggen-tab header: the value is not a non-negative safe-integer Chrome tab id',
    );
    expect(formatted.error.details).toStrictEqual({ header: ACTING_TAB_HEADER });
    expect(formatted.error.cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Identity of the imported schemas
// ---------------------------------------------------------------------------

describe('the route table binds imported schemas by identity, never by copy', () => {
  it('builds the panel-data body from panel-schema’s own query field schemas, plus panelId', () => {
    expect(HTTP_ROUTES['panel.data'].request).toBe(panelDataRequestSchema);

    const queryShape: Readonly<Record<string, unknown>> = dataQuerySchema.shape;
    const bodyShape: Readonly<Record<string, unknown>> = panelDataRequestSchema.shape;
    const queryKeys = Object.keys(queryShape);

    // Each query field is the upstream schema object itself, never a copy.
    expect(queryKeys.length).toBeGreaterThan(0);
    for (const key of queryKeys) {
      expect(bodyShape[key], key).toBe(queryShape[key]);
    }
    // The body adds exactly one field of its own: the panel's identity.
    expect(Object.keys(bodyShape).filter((key) => !queryKeys.includes(key))).toEqual(['panelId']);
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

  it('binds the target-request bodies and takes the reply’s tab id from the binding messages', () => {
    expect(HTTP_ROUTES['target.request'].request).toBe(targetRequestRequestSchema);
    expect(HTTP_ROUTES['target.request'].response).toBe(targetRequestResponseSchema);
    // The tab-id rule is `../messages/binding.ts`'s own schema, so a tab the
    // binding messages refuse (`-1`, a fraction, a string) is refused here too.
    expect(targetRequestResponseSchema.shape.tabId).toBe(sessionBindPayloadSchema.shape.tabId);
  });

  it('uses instrumentation’s modificationRecordSchema itself as the journal element, from either entry', () => {
    const element = HTTP_ROUTES['modifications.list'].response.shape.modifications.element;

    expect(element).toBe(modificationRecordSchema);
    expect(element).toBe(rootModificationRecordSchema);
    // The two entries are one module: `./schema` is not a second build of the
    // schema layer, so a record the service validated through the root is the
    // same schema's output that a protocol message embeds.
    expect(rootModificationRecordSchema).toBe(modificationRecordSchema);
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

  it('requires both a project root and a question on session.create', () => {
    // Neither field has a defensible default. Without the root there is no tree
    // to index, instrument or contain a later source-open request within, and
    // without the question the first pipeline stage has no input at all — so the
    // body is refused here rather than accepted into a session that cannot run.
    expect(sessionCreateRequestSchema.safeParse({ question: 'Why is this slow?' }).success).toBe(
      false,
    );
    expect(sessionCreateRequestSchema.safeParse({ projectRoot: PROJECT_ROOT }).success).toBe(false);
    expect(sessionCreateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      sessionCreateRequestSchema.safeParse({ projectRoot: '', question: 'Why is this slow?' })
        .success,
    ).toBe(false);
    expect(
      sessionCreateRequestSchema.safeParse({ projectRoot: PROJECT_ROOT, question: '' }).success,
    ).toBe(false);
  });

  it('accepts an optional selected target and refuses a malformed one', () => {
    // Optional, not nullable: a session created with no target is answered from
    // the bound tab's current URL instead, and an absent key is how the body
    // says so. A present one is the imported target descriptor in full, so a
    // half-built selector cannot enter the pipeline as a real selection.
    const body = {
      projectRoot: PROJECT_ROOT,
      question: 'Why is this slow?',
      target: {
        selector: 'main > button.primary',
        tagName: 'button',
        text: 'Primary action',
        componentChain: ['PrimaryAction', 'ActionPanel'],
        url: `${DEV_SERVER_URL}/step`,
      },
    } satisfies HttpRequestBody<'session.create'>;

    expect(parseHttpRequest('session.create', body).ok).toBe(true);
    expect(sessionCreateRequestSchema.safeParse({ ...body, target: undefined }).success).toBe(true);
    expect(sessionCreateRequestSchema.safeParse({ ...body, target: null }).success).toBe(false);
    expect(
      sessionCreateRequestSchema.safeParse({ ...body, target: { selector: 'button' } }).success,
    ).toBe(false);
  });

  it('refuses a session.question body with no question', () => {
    expect(sessionQuestionRequestSchema.safeParse({}).success).toBe(false);
    expect(sessionQuestionRequestSchema.safeParse({ question: '' }).success).toBe(false);
    expect(
      sessionQuestionRequestSchema.safeParse({ attemptId: 'fua_4k2p9dq7m1zx0c3v' }).success,
    ).toBe(false);
  });

  it('accepts a session.question body with or without the attempt id that keys its idempotency', () => {
    const question = 'Why did that step run twice?';
    const attemptId = 'fua_4k2p9dq7m1zx0c3v';

    expect(parseHttpRequest('session.question', { question }).ok).toBe(true);
    const keyed = parseHttpRequest('session.question', {
      question,
      attemptId,
    } satisfies HttpRequestBody<'session.question'>);
    expect(keyed.ok).toBe(true);
    if (keyed.ok) {
      // Byte-faithful: the id the client sent is the id the service reads.
      expect(keyed.value).toEqual({ question, attemptId });
    }
  });

  it('refuses a malformed attempt id, and a null standing in for an absent one', () => {
    const question = 'Why did that step run twice?';

    for (const attemptId of ['', ' ', 'fua_\u0007bell', 'x'.repeat(65), 42, null]) {
      expect(
        sessionQuestionRequestSchema.safeParse({ question, attemptId }).success,
        JSON.stringify(attemptId),
      ).toBe(false);
    }
    expect(sessionQuestionRequestSchema.safeParse({ question, retry: true }).success).toBe(false);
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

  it('draws those four statuses from the session record’s own vocabulary', () => {
    // The literal list above is written out so a widened vocabulary is a
    // deliberate edit; this is the other half of that — it proves the four
    // literals are exactly `./session-record.ts`'s `CLEANUP_STATUSES`, so the
    // list cannot quietly fall behind the enum the reply is validated against.
    expect(['pending', 'clean', 'partial', 'conflict']).toEqual([...CLEANUP_STATUSES]);

    for (const status of CLEANUP_STATUSES) {
      expect(parseHttpResponse('session.end', { cleanup: status }).ok).toBe(true);
    }

    // A status the record does not know is refused, whatever it reads like.
    expect(parseHttpResponse('session.end', { cleanup: 'reverted' }).ok).toBe(false);
    expect(parseHttpResponse('session.end', { cleanup: null }).ok).toBe(false);
  });

  it('answers the session list as an object, never as a bare array', () => {
    expect(parseHttpResponse('session.list', EMPTY_SESSION_PAGE).ok).toBe(true);
    expect(parseHttpResponse('session.list', [SESSION_RECORD]).ok).toBe(false);
  });
});

describe('the session.purge bodies — the on-demand retention sweep', () => {
  /** Every count field of the report, each a non-negative integer. */
  const COUNT_FIELDS = [
    'sessionsDeleted',
    'telemetryEventsDeleted',
    'panelsDeleted',
    'analysesDeleted',
    'modificationsDeleted',
    'backupDirsDeleted',
    'orphanBackupsDeleted',
    'indexCachesDeleted',
    'sessionsRetainedForConflictsTotal',
    'issueCount',
  ] as const satisfies readonly (keyof HttpResponseBody<'session.purge'>)[];

  /**
   * The report with its conflict list and total replaced together.
   *
   * @param listed The retained-session ids the report lists.
   * @param total The count the report claims.
   * @returns A report that differs from the fixture only in those two fields.
   */
  function reportRetaining(listed: readonly string[], total: number): Record<string, unknown> {
    return {
      ...SESSION_PURGE_REPORT,
      sessionsRetainedForConflicts: [...listed],
      sessionsRetainedForConflictsTotal: total,
    };
  }

  it('binds the route to its own two schemas, bodiless of any caller choice', () => {
    expect(HTTP_ROUTES['session.purge'].request).toBe(sessionPurgeRequestSchema);
    expect(HTTP_ROUTES['session.purge'].response).toBe(sessionPurgeResponseSchema);
    expect(sessionPurgePath()).toBe('/sessions/purge');
  });

  it('accepts an empty request and refuses a key or a missing body', () => {
    expect(parseHttpRequest('session.purge', {}).ok).toBe(true);
    // The window is the developer's configuration, never the caller's.
    expect(parseHttpRequest('session.purge', { retentionDays: 0 }).ok).toBe(false);
    expect(parseHttpRequest('session.purge', { dryRun: true }).ok).toBe(false);
    expect(parseHttpRequest('session.purge', undefined).ok).toBe(false);
  });

  it('round-trips a report through JSON unchanged', () => {
    const parsed = parseHttpResponse('session.purge', throughJson(SESSION_PURGE_REPORT));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(SESSION_PURGE_REPORT);
    }

    const request = parseHttpRequest('session.purge', throughJson({}));
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.value).toEqual({});
    }
  });

  it.each(COUNT_FIELDS)('refuses a negative, fractional or missing %s', (field) => {
    const { [field]: omitted, ...without } = SESSION_PURGE_REPORT;

    expect(omitted).toBeGreaterThanOrEqual(0);
    expect(parseHttpResponse('session.purge', without).ok).toBe(false);
    expect(parseHttpResponse('session.purge', { ...SESSION_PURGE_REPORT, [field]: -1 }).ok).toBe(
      false,
    );
    expect(parseHttpResponse('session.purge', { ...SESSION_PURGE_REPORT, [field]: 1.5 }).ok).toBe(
      false,
    );
    expect(parseHttpResponse('session.purge', { ...SESSION_PURGE_REPORT, [field]: '1' }).ok).toBe(
      false,
    );
  });

  it('accepts a fractional duration and refuses a negative or non-finite one', () => {
    expect(parseHttpResponse('session.purge', { ...SESSION_PURGE_REPORT, durationMs: 0 }).ok).toBe(
      true,
    );
    for (const durationMs of [-0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(parseHttpResponse('session.purge', { ...SESSION_PURGE_REPORT, durationMs }).ok).toBe(
        false,
      );
    }
  });

  it('accepts a cutoff a window of years puts before 2020, and refuses a non-finite or mis-scaled one', () => {
    // `DEBUGGEN_RETENTION_DAYS` is any whole number of days, so a developer who
    // keeps sessions for ten years — or effectively forever — gets a cutoff an
    // event-timestamp bound would refuse. The sweep still ran, and its report
    // must still parse.
    for (const days of [0, 30, 3_650, 1_000_000]) {
      const cutoff = START_TIME - days * MS_PER_DAY;

      expect(parseHttpResponse('session.purge', { ...SESSION_PURGE_REPORT, cutoff }).ok).toBe(true);
    }

    for (const cutoff of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      START_TIME * 1_000,
      '2025-01-01',
    ]) {
      expect(parseHttpResponse('session.purge', { ...SESSION_PURGE_REPORT, cutoff }).ok).toBe(
        false,
      );
    }
  });

  it('lists at most SESSION_PURGE_MAX_REPORTED_SESSIONS ids and carries the true count beside them', () => {
    expect(SESSION_PURGE_MAX_REPORTED_SESSIONS).toBe(100);

    const bounded = retainedSessionIds(SESSION_PURGE_MAX_REPORTED_SESSIONS);
    expect(parseHttpResponse('session.purge', reportRetaining(bounded, bounded.length)).ok).toBe(
      true,
    );
    // Truncated: a hundred listed, the real two hundred and fifty counted.
    expect(parseHttpResponse('session.purge', reportRetaining(bounded, 250)).ok).toBe(true);

    const overBound = retainedSessionIds(SESSION_PURGE_MAX_REPORTED_SESSIONS + 1);
    expect(
      parseHttpResponse('session.purge', reportRetaining(overBound, overBound.length)).ok,
    ).toBe(false);
  });

  it('refuses a list that is not the truncation of its total', () => {
    const [first, second] = retainedSessionIds(2);
    const listedOne = [first ?? CONFLICTED_SESSION_ID];
    const listedTwo = [first ?? CONFLICTED_SESSION_ID, second ?? SESSION_ID];

    expect(parseHttpResponse('session.purge', reportRetaining([], 0)).ok).toBe(true);
    // Partial below the bound: the report claims two and names one.
    expect(parseHttpResponse('session.purge', reportRetaining(listedOne, 2)).ok).toBe(false);
    // More names than the count admits.
    expect(parseHttpResponse('session.purge', reportRetaining(listedTwo, 1)).ok).toBe(false);
    // Short of the bound while the total is past it.
    expect(
      parseHttpResponse(
        'session.purge',
        reportRetaining(retainedSessionIds(SESSION_PURGE_MAX_REPORTED_SESSIONS - 1), 250),
      ).ok,
    ).toBe(false);

    const rejected = parseHttpResponse('session.purge', reportRetaining(listedOne, 2));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(rejected.error.message).toContain('sessionsRetainedForConflicts');
      expect(rejected.error.message).not.toContain(listedOne[0]);
    }
  });

  it('refuses a list that names one session twice, at the repeating index', () => {
    const rejected = parseHttpResponse(
      'session.purge',
      reportRetaining([CONFLICTED_SESSION_ID, CONFLICTED_SESSION_ID], 2),
    );

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.message).toContain('sessionsRetainedForConflicts[1]');
      expect(rejected.error.message).not.toContain(CONFLICTED_SESSION_ID);
    }
  });

  it('refuses a malformed retained id and a key the report does not declare', () => {
    expect(parseHttpResponse('session.purge', reportRetaining([''], 1)).ok).toBe(false);
    expect(parseHttpResponse('session.purge', reportRetaining(['s'.repeat(65)], 1)).ok).toBe(false);
    // No path and no message rides along: the report is counts, not a listing
    // of the developer's file layout.
    expect(
      parseHttpResponse('session.purge', {
        ...SESSION_PURGE_REPORT,
        errors: [{ scope: 'backup', target: 'backups/x', message: 'x' }],
      }).ok,
    ).toBe(false);
    expect(
      parseHttpResponse('session.purge', { ...SESSION_PURGE_REPORT, sessionIdsDeleted: [] }).ok,
    ).toBe(false);
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

describe('the target-request bodies', () => {
  it('is a POST to the session’s own target/request path that requires a credential', () => {
    const route = HTTP_ROUTES['target.request'];

    expect({
      operation: route.operation,
      method: route.method,
      pattern: route.pattern,
      params: [...route.params],
      authExempt: route.authExempt,
    }).toEqual({
      operation: 'target.request',
      method: 'POST',
      pattern: '/sessions/:id/target/request',
      params: ['id'],
      authExempt: false,
    });
  });

  it('accepts an empty request body and refuses any key in it', () => {
    expect(parseHttpRequest('target.request', {}).ok).toBe(true);
    expect(targetRequestRequestSchema.safeParse({}).success).toBe(true);

    // The binding, not the caller, decides which tab enters picker mode, and
    // picker policy is the panel's: a caller that names a tab, restates the
    // session or attaches a mode has misread the contract.
    for (const body of [{ tabId: TAB_ID }, { sessionId: SESSION_ID }, { mode: 'picker' }]) {
      const refused = parseHttpRequest('target.request', body);

      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
        expect(refused.error.message).toContain('target.request');
      }
    }

    expect(parseHttpRequest('target.request', undefined).ok).toBe(false);
    expect(parseHttpRequest('target.request', null).ok).toBe(false);
  });

  it('answers with the session and the bound tab the push was handed to', () => {
    const parsed = parseHttpResponse('target.request', { sessionId: SESSION_ID, tabId: TAB_ID });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ sessionId: SESSION_ID, tabId: TAB_ID });
    }
    expect(parseHttpResponse('target.request', { sessionId: SESSION_ID, tabId: 0 }).ok).toBe(true);
  });

  it('refuses a reply without the tab, without the session, or with anything more', () => {
    expect(parseHttpResponse('target.request', { sessionId: SESSION_ID }).ok).toBe(false);
    expect(parseHttpResponse('target.request', { tabId: TAB_ID }).ok).toBe(false);
    expect(parseHttpResponse('target.request', {}).ok).toBe(false);
    expect(
      parseHttpResponse('target.request', {
        sessionId: SESSION_ID,
        tabId: TAB_ID,
        url: DEV_SERVER_URL,
      }).ok,
    ).toBe(false);
    expect(parseHttpResponse('target.request', { sessionId: '', tabId: TAB_ID }).ok).toBe(false);
  });

  it('refuses a tab id the binding messages refuse', () => {
    // `-1` is `chrome.tabs.TAB_ID_NONE`, not a tab; a fraction and a string
    // are producer bugs, and nothing in this package coerces.
    for (const tabId of [-1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseHttpResponse('target.request', { sessionId: SESSION_ID, tabId }).ok).toBe(false);
    }
  });

  it('keeps the success reply apart from the error contract the service answers with', () => {
    // Each failure the route documents is the shared error body, with a code
    // from the closed vocabulary — and none of them parses as a success.
    for (const code of [
      'SESSION_NOT_FOUND',
      'SESSION_INVALID_STATE',
      'TAB_NOT_BOUND',
      'TRANSPORT_DISCONNECTED',
      'UNAUTHORIZED',
    ] as const) {
      const failure = { code, message: 'The panel could not be asked to pick an element.' };

      expect(DEBUGGEN_ERROR_CODES).toContain(code);
      expect(httpErrorResponseSchema.safeParse(failure).success).toBe(true);
      expect(parseHttpResponse('target.request', failure).ok).toBe(false);
    }
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
    expect(parseHttpResponse('modifications.list', EMPTY_JOURNAL_PAGE).ok).toBe(true);
    expect(
      parseHttpResponse('modifications.list', { ...EMPTY_JOURNAL_PAGE, modifications: [{}] }).ok,
    ).toBe(false);
  });
});

describe('the paged listings: GET /sessions and GET /sessions/:id/modifications', () => {
  /** A journal record carrying `diff`. */
  function recordWithDiff(index: number, diff: string): typeof MODIFICATION {
    return {
      ...MODIFICATION,
      id: `mod_${String(index).padStart(16, '0')}`,
      diff,
    };
  }

  /** The largest diff the journal accepts, in UTF-16 code units. */
  const MAX_DIFF_UNITS = MODIFICATION_DIFF_MAX_BYTES / 3;

  it('lists rows, never whole records: a record-only member is refused', () => {
    const row = toSessionListItem(SESSION_RECORD);

    expect(sessionListItemSchema.safeParse(row).success).toBe(true);
    expect(Object.keys(row).sort()).toEqual([
      'cleanup',
      'createdAt',
      'id',
      'projectName',
      'projectRoot',
      'question',
      'status',
      'updatedAt',
    ]);
    expect(sessionListItemSchema.safeParse(SESSION_RECORD).success).toBe(false);
    expect(
      parseHttpResponse('session.list', {
        ...EMPTY_SESSION_PAGE,
        sessions: [SESSION_RECORD],
        total: 1,
      }).ok,
    ).toBe(false);
  });

  it('summarises cleanup as a count, so no conflict diff reaches a row', () => {
    const conflicted: typeof SESSION_RECORD = {
      ...SESSION_RECORD,
      cleanup: {
        status: 'conflict',
        completedAt: START_TIME + 119_000,
        conflicts: [
          {
            recordId: MODIFICATION_ID,
            sessionId: SESSION_ID,
            file: SOURCE_FILE,
            reason: 'content-changed',
            expectedHash: hashFixture('2b'),
            actualHash: hashFixture('3c'),
            backupPath: MODIFICATION.backupPath,
            detectedAt: START_TIME + 118_000,
            message: 'The file was edited while instrumented; the original is kept.',
            diffs: { instrumentedToCurrent: '@@ -1 +1 @@\n-a\n+b\n' },
          },
        ],
      },
    };
    const row = toSessionListItem(conflicted);

    expect(row.cleanup).toEqual({
      status: 'conflict',
      completedAt: START_TIME + 119_000,
      conflictCount: 1,
    });
    expect(sessionListItemSchema.safeParse(row).success).toBe(true);
    expect(JSON.stringify(row)).not.toContain('@@');
    expect(sessionListItemSchema.safeParse({ ...row, cleanup: conflicted.cleanup }).success).toBe(
      false,
    );
  });

  it('lets nextOffset move past what a page consumed, never back or beyond its window', () => {
    const row = toSessionListItem(SESSION_RECORD);
    const firstOfTwo = { sessions: [row], total: 2, limit: 1, offset: 0, nextOffset: 1 };

    expect(parseHttpResponse('session.list', firstOfTwo).ok).toBe(true);
    // A full page with sessions beyond its window is not the last page.
    expect(parseHttpResponse('session.list', { ...firstOfTwo, nextOffset: null }).ok).toBe(false);
    // Past the listing's end, back onto the page, and beyond the window are refused.
    expect(parseHttpResponse('session.list', { ...firstOfTwo, nextOffset: 2 }).ok).toBe(false);
    expect(parseHttpResponse('session.list', { ...firstOfTwo, nextOffset: 0 }).ok).toBe(false);
    expect(
      parseHttpResponse('session.list', { ...firstOfTwo, total: 5, limit: 2, nextOffset: 3 }).ok,
    ).toBe(false);
    // A page that consumed an unreadable row moves past it: fewer rows, same window.
    expect(
      parseHttpResponse('session.list', {
        sessions: [row],
        total: 3,
        limit: 2,
        offset: 0,
        nextOffset: 2,
      }).ok,
    ).toBe(true);
    expect(
      parseHttpResponse('session.list', {
        ...EMPTY_SESSION_PAGE,
        total: 3,
        limit: 2,
        nextOffset: 2,
      }).ok,
    ).toBe(true);
    // A count-only page is always the last.
    expect(
      parseHttpResponse('session.list', {
        ...EMPTY_SESSION_PAGE,
        total: 5,
        limit: 0,
        nextOffset: 0,
      }).ok,
    ).toBe(false);
    // The last page, and a count-only page, both end the loop.
    expect(
      parseHttpResponse('session.list', { ...firstOfTwo, offset: 1, nextOffset: null }).ok,
    ).toBe(true);
    expect(
      parseHttpResponse('session.list', { ...EMPTY_SESSION_PAGE, total: 5, limit: 0 }).ok,
    ).toBe(true);
    // A page longer than its limit, or than what remains, is refused.
    expect(
      parseHttpResponse('session.list', {
        sessions: [row, row],
        total: 2,
        limit: 1,
        offset: 0,
        nextOffset: null,
      }).ok,
    ).toBe(false);
    expect(
      parseHttpResponse('session.list', {
        sessions: [row],
        total: 1,
        limit: 5,
        offset: 1,
        nextOffset: null,
      }).ok,
    ).toBe(false);
    expect(
      parseHttpResponse('session.list', {
        ...EMPTY_SESSION_PAGE,
        limit: SESSION_LIST_MAX_LIMIT + 1,
      }).ok,
    ).toBe(false);
  });

  it('bounds a journal page by its diff budget in UTF-8 bytes, and lets a page end early', () => {
    // Three ASCII diffs at the per-diff cap: 6 MiB of UTF-8, exactly the budget.
    const ascii = [1, 2, 3].map((index) => recordWithDiff(index, 'x'.repeat(MAX_DIFF_UNITS)));
    // One diff of three-byte characters at the same cap fills the budget alone.
    const wide = recordWithDiff(4, '\u20ac'.repeat(MAX_DIFF_UNITS));
    const page = (modifications: readonly (typeof MODIFICATION)[], nextOffset: number | null) =>
      parseHttpResponse('modifications.list', {
        modifications,
        total: 5,
        limit: MODIFICATIONS_PAGE_DEFAULT_LIMIT,
        offset: 0,
        nextOffset,
      }).ok;

    expect(MODIFICATIONS_PAGE_DIFF_BUDGET).toBe(MODIFICATION_DIFF_MAX_BYTES);
    expect(modificationsDiffBytes(ascii)).toBe(MODIFICATIONS_PAGE_DIFF_BUDGET);
    expect(modificationsDiffBytes([wide])).toBe(MODIFICATIONS_PAGE_DIFF_BUDGET);
    expect(page(ascii, 3)).toBe(true);
    expect(page([wide], 1)).toBe(true);
    // Measured in bytes, not characters: one more ASCII byte past a full page is refused,
    // although the page holds far fewer characters than the old character budget.
    expect(page([wide, recordWithDiff(5, 'x')], null)).toBe(false);
    expect(page([...ascii, recordWithDiff(5, 'x')], null)).toBe(false);
    expect(MODIFICATIONS_PAGE_DEFAULT_LIMIT).toBe(MODIFICATIONS_PAGE_MAX_LIMIT);
  });

  it('counts UTF-8 bytes exactly as an encoder would, without encoding', () => {
    const encoder = new TextEncoder();
    const samples = [
      '',
      'plain ascii',
      'caf\u00e9',
      '\u20ac and \u4e2d\u6587',
      'emoji \ud83d\ude00 pair',
      'lone high \ud800 surrogate',
      'lone low \udc00 surrogate',
      'trailing high \ud83d',
      '+  const __dbg = globalThis.__DEBUGGEN__;\n-  return total;\n',
    ];

    for (const sample of samples) {
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(encoder.encode(sample).length);
    }
    expect(utf8ByteLength('\u20ac'.repeat(MAX_DIFF_UNITS))).toBe(MODIFICATION_DIFF_MAX_BYTES);
  });

  it('encodes a page window as exactly the query string the service parses', () => {
    expect(LIST_PAGE_OPERATIONS).toEqual(['session.list', 'modifications.list']);
    expect(LIST_PAGE_MAX_LIMITS).toEqual({
      'session.list': SESSION_LIST_MAX_LIMIT,
      'modifications.list': MODIFICATIONS_PAGE_MAX_LIMIT,
    });
    expect(isListPageOperation('session.list')).toBe(true);
    expect(isListPageOperation('session.get')).toBe(false);

    expect(formatListPageQuery('session.list', {})).toEqual({ ok: true, value: '' });
    expect(formatListPageQuery('session.list', { limit: undefined, offset: undefined })).toEqual({
      ok: true,
      value: '',
    });
    expect(formatListPageQuery('modifications.list', { limit: 0 })).toEqual({
      ok: true,
      value: '?limit=0',
    });
    expect(formatListPageQuery('session.list', { offset: 40 })).toEqual({
      ok: true,
      value: '?offset=40',
    });

    for (const operation of LIST_PAGE_OPERATIONS) {
      const window = { limit: LIST_PAGE_MAX_LIMITS[operation], offset: LIST_PAGE_MAX_OFFSET };
      const encoded = formatListPageQuery(operation, window);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) {
        continue;
      }
      expect(encoded.value).toBe(
        `?limit=${String(window.limit)}&offset=${String(LIST_PAGE_MAX_OFFSET)}`,
      );
      // The round trip: what a client sends is what the service accepts, unchanged.
      const query = Object.fromEntries(new URLSearchParams(encoded.value));
      expect(parseListPageQuery(query, { maxLimit: LIST_PAGE_MAX_LIMITS[operation] })).toEqual({
        ok: true,
        value: window,
      });
    }
  });

  it('refuses a window the service would refuse, naming the parameter and never its value', () => {
    const refusals: readonly [Parameters<typeof formatListPageQuery>[0], object][] = [
      ['session.list', { limit: SESSION_LIST_MAX_LIMIT + 1 }],
      ['modifications.list', { limit: MODIFICATIONS_PAGE_MAX_LIMIT + 1 }],
      ['session.list', { limit: -1 }],
      ['session.list', { limit: 1.5 }],
      ['session.list', { limit: Number.NaN }],
      ['session.list', { offset: -1 }],
      ['session.list', { offset: LIST_PAGE_MAX_OFFSET + 2 }],
      ['session.list', { offset: Number.POSITIVE_INFINITY }],
      ['session.list', { limit: 987654321 }],
      ['session.get', { limit: 1 }],
      ['panel.data', { offset: 0 }],
    ];

    for (const [operation, window] of refusals) {
      const encoded = formatListPageQuery(operation, window);
      expect(encoded.ok, `${operation} ${JSON.stringify(window)}`).toBe(false);
      if (!encoded.ok) {
        expect(encoded.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
        expect(encoded.error.message).not.toContain('987654321');
        expect(JSON.stringify(encoded.error.toPayload())).not.toContain('987654321');
      }
    }
  });

  it('parses a page window from the query string and refuses anything else', () => {
    const bounds = { maxLimit: SESSION_LIST_MAX_LIMIT };

    expect(parseListPageQuery({}, bounds)).toEqual({ ok: true, value: {} });
    expect(parseListPageQuery({ limit: '0', offset: '40' }, bounds)).toEqual({
      ok: true,
      value: { limit: 0, offset: 40 },
    });
    expect(parseListPageQuery({ limit: String(SESSION_LIST_MAX_LIMIT) }, bounds).ok).toBe(true);

    for (const refused of [
      { limit: String(SESSION_LIST_MAX_LIMIT + 1) },
      { limit: '-1' },
      { limit: '05' },
      { limit: '1e3' },
      { limit: ' 5' },
      { offset: String(LIST_PAGE_MAX_OFFSET + 1) },
      { offset: '9999999999999999' },
      { page: '2' },
      { limit: 'SENTINEL-LEAK' },
    ]) {
      const parsed = parseListPageQuery(refused, bounds);
      expect(parsed.ok, JSON.stringify(refused)).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
        // Paths and codes only: the rejected text never reaches the error.
        expect(JSON.stringify(parsed.error.toPayload())).not.toContain('SENTINEL');
        expect(parsed.error.message).not.toContain('SENTINEL');
      }
    }
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

  /** One refused issue as `[code, dotted path, message]`: what a producer is told. */
  type IssueRow = readonly [code: string, path: string, message: string];

  /**
   * The issues a schema raises for a value, or `undefined` when it accepts it.
   *
   * @param schema The body schema on trial.
   * @param value The body to parse.
   * @returns Each issue's code, path and message, in the order they were raised.
   */
  function issuesOf(schema: ZodType, value: unknown): IssueRow[] | undefined {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? undefined
      : parsed.error.issues.map((issue): IssueRow => [
          issue.code,
          issue.path.map(String).join('.'),
          issue.message,
        ]);
  }

  it('accepts each optional field of delivery context beside a batch of events', () => {
    // The capture the preload was armed for, and the spans it lost for it: both
    // optional, each on its own and together, and returned exactly as sent.
    for (const context of [
      { armedCaptureId: CAPTURE_ID },
      { droppedCount: 0 },
      { droppedCount: 7 },
      { droppedCount: Number.MAX_SAFE_INTEGER },
      { armedCaptureId: 'c'.repeat(64), droppedCount: 7 },
    ]) {
      const body = { projectRoot: PROJECT_ROOT, events: [INGRESS_EVENT], ...context };

      expect(issuesOf(telemetryIngestRequestSchema, body), JSON.stringify(context)).toBeUndefined();
      expect(telemetryIngestRequestSchema.parse(body)).toStrictEqual(body);
    }
  });

  it('accepts an event-less body as a loss-only report, and round-trips it through JSON', () => {
    // What the preload posts when no later batch will carry its loss — at a
    // capture's end, say — so the count still reaches the capture's ledger.
    const lossOnly = { projectRoot: PROJECT_ROOT, events: [], droppedCount: 3 };
    const armedLossOnly = { ...lossOnly, armedCaptureId: CAPTURE_ID };

    for (const body of [lossOnly, armedLossOnly]) {
      const parsed = telemetryIngestRequestSchema.parse(body);

      expect(parsed).toStrictEqual(body);
      // Every field is a JSON primitive or a plain array, so the body arrives
      // at the service exactly as the preload built it.
      expect(throughJson(parsed)).toStrictEqual(body);
      expect(telemetryIngestRequestSchema.parse(throughJson(parsed))).toStrictEqual(body);
    }
  });

  it('refuses an empty batch that reports no loss by the rule the WebSocket payload applies', () => {
    // Naming the capture adds nothing, and a zero count is no loss at all. The
    // one issue is the loss-only rule under `events`, in the words the
    // WebSocket payload uses for the same batch.
    for (const context of [
      {},
      { droppedCount: 0 },
      { armedCaptureId: CAPTURE_ID },
      { armedCaptureId: CAPTURE_ID, droppedCount: 0 },
    ]) {
      const issues = issuesOf(telemetryIngestRequestSchema, {
        projectRoot: PROJECT_ROOT,
        events: [],
        ...context,
      });

      expect(
        issues?.map(([code, path]) => [code, path]),
        JSON.stringify(context),
      ).toEqual([['custom', 'events']]);
      expect(issues).toEqual(issuesOf(telemetryEventPayloadSchema, { events: [], ...context }));
    }
  });

  it('refuses a malformed armed capture id exactly as the WebSocket payload does', () => {
    for (const armedCaptureId of [
      '',
      'c'.repeat(65),
      ` ${CAPTURE_ID}`,
      `${CAPTURE_ID}\n`,
      42,
      null,
      { id: CAPTURE_ID },
    ]) {
      const issues = issuesOf(telemetryIngestRequestSchema, {
        projectRoot: PROJECT_ROOT,
        events: [INGRESS_EVENT],
        armedCaptureId,
      });

      expect(issues, JSON.stringify(armedCaptureId)).toBeDefined();
      expect(issues?.every(([, path]) => path === 'armedCaptureId')).toBe(true);
      // The same factory, so the same issues in the same words.
      expect(issues).toEqual(
        issuesOf(telemetryEventPayloadSchema, { events: [INGRESS_EVENT], armedCaptureId }),
      );
    }
  });

  it('refuses a malformed loss count exactly as the WebSocket payload does, by its own issue', () => {
    for (const droppedCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', null, Number.NaN]) {
      for (const events of [[INGRESS_EVENT], []]) {
        const label = `${String(droppedCount)} with ${String(events.length)} events`;
        const issues = issuesOf(telemetryIngestRequestSchema, {
          projectRoot: PROJECT_ROOT,
          events,
          droppedCount,
        });

        expect(issues, label).toBeDefined();
        // Reported once, where it is: on an event-less body the loss-only rule
        // does not pile a second, derived issue on top.
        expect(
          issues?.every(([, path]) => path === 'droppedCount'),
          label,
        ).toBe(true);
        expect(issues).toEqual(issuesOf(telemetryEventPayloadSchema, { events, droppedCount }));
      }
    }
  });

  it('accepts a loss-report identity beside a droppedCount above zero, and round-trips it', () => {
    // The identity a retried body keeps for its loss report: beside a batch of
    // events or on a loss-only report, with or without the armed capture, at
    // the identifier bound, and returned exactly as sent — by the schema,
    // through JSON, and through the route table the service reads.
    const lossReport = { projectRoot: PROJECT_ROOT, droppedCount: 7, lossReportId: LOSS_REPORT_ID };

    for (const body of [
      { ...lossReport, events: [INGRESS_EVENT] },
      { ...lossReport, events: [INGRESS_EVENT], armedCaptureId: CAPTURE_ID },
      { ...lossReport, events: [] },
      { ...lossReport, events: [], armedCaptureId: CAPTURE_ID },
      { ...lossReport, events: [INGRESS_EVENT], lossReportId: 'r'.repeat(64) },
      { ...lossReport, events: [], droppedCount: Number.MAX_SAFE_INTEGER },
    ]) {
      const label = JSON.stringify({ ...body, events: body.events.length });

      expect(issuesOf(telemetryIngestRequestSchema, body), label).toBeUndefined();

      const parsed = telemetryIngestRequestSchema.parse(body);

      expect(parsed, label).toStrictEqual(body);
      expect(throughJson(parsed), label).toStrictEqual(body);
      expect(telemetryIngestRequestSchema.parse(throughJson(parsed)), label).toStrictEqual(body);

      const routed = parseHttpRequest('telemetry.event', body);

      expect(routed.ok ? routed.value : routed.error.message, label).toStrictEqual(body);
    }
  });

  it('refuses a loss-report identity on a body that reports no loss, by one constant rule', () => {
    // An identity names a loss report, so a body without a droppedCount above
    // zero has nothing for it to name — alone, beside a zero count, beside the
    // armed capture. One issue, under `lossReportId`, whose message is the same
    // whichever identity was sent and quotes none of them.
    const messages = new Set<string>();

    for (const lossReportId of [LOSS_REPORT_ID, 'r'.repeat(64)]) {
      for (const context of [
        {},
        { droppedCount: 0 },
        { armedCaptureId: CAPTURE_ID },
        { armedCaptureId: CAPTURE_ID, droppedCount: 0 },
      ]) {
        const label = JSON.stringify({ lossReportId, ...context });
        const issues = issuesOf(telemetryIngestRequestSchema, {
          projectRoot: PROJECT_ROOT,
          events: [INGRESS_EVENT],
          lossReportId,
          ...context,
        });

        expect(
          issues?.map(([code, path]) => [code, path]),
          label,
        ).toEqual([['custom', 'lossReportId']]);

        for (const [, , message] of issues ?? []) {
          expect(message, label).not.toContain(lossReportId);
          messages.add(message);
        }
      }
    }

    expect(messages.size).toBe(1);

    // An event-less body that names a report but reports no loss breaks the
    // loss-only rule first, and is refused by that rule alone: no second,
    // derived issue under `lossReportId`.
    for (const context of [{}, { droppedCount: 0 }, { armedCaptureId: CAPTURE_ID }]) {
      expect(
        issuesOf(telemetryIngestRequestSchema, {
          projectRoot: PROJECT_ROOT,
          events: [],
          lossReportId: LOSS_REPORT_ID,
          ...context,
        })?.map(([code, path]) => [code, path]),
        JSON.stringify(context),
      ).toEqual([['custom', 'events']]);
    }

    // Through the route table the rule is named by its label, never a value.
    const refused = parseHttpRequest('telemetry.event', {
      projectRoot: PROJECT_ROOT,
      events: [INGRESS_EVENT],
      lossReportId: LOSS_REPORT_ID,
    });

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(refused.error.message).toContain(
        'lossReportId (custom label=loss-report-id-requires-loss)',
      );
      expect(refused.error.message).not.toContain(LOSS_REPORT_ID);
    }
  });

  it('refuses a malformed loss-report identity by the identifier rule armedCaptureId applies', () => {
    for (const lossReportId of [
      '',
      'r'.repeat(65),
      ` ${LOSS_REPORT_ID}`,
      `${LOSS_REPORT_ID}\n`,
      42,
      null,
      { id: LOSS_REPORT_ID },
    ]) {
      // The same rule, so the same issues in the same words: only the path
      // differs from the armed capture id's refusal of the same value.
      const armedIssues = issuesOf(telemetryIngestRequestSchema, {
        projectRoot: PROJECT_ROOT,
        events: [INGRESS_EVENT],
        armedCaptureId: lossReportId,
      });

      expect(armedIssues, JSON.stringify(lossReportId)).toBeDefined();

      for (const events of [[INGRESS_EVENT], []]) {
        for (const context of [{ droppedCount: 3 }, { droppedCount: 0 }, {}]) {
          const label = JSON.stringify({ lossReportId, events: events.length, ...context });
          const issues = issuesOf(telemetryIngestRequestSchema, {
            projectRoot: PROJECT_ROOT,
            events,
            lossReportId,
            ...context,
          });

          // Reported once, where it is: neither cross-field rule piles a
          // derived issue on top of the malformed field.
          expect(
            issues?.map(([code, path, message]) => [
              code,
              path.replace('lossReportId', ''),
              message,
            ]),
            label,
          ).toEqual(
            armedIssues?.map(([code, path, message]) => [
              code,
              path.replace('armedCaptureId', ''),
              message,
            ]),
          );
          expect(
            issues?.every(([, path]) => path === 'lossReportId'),
            label,
          ).toBe(true);
        }
      }
    }
  });

  it('is the ingest body’s own field: the WebSocket payload refuses a loss-report identity', () => {
    // The HTTP transport is the one that retries a body in place, so only its
    // body names a loss report; the strict WebSocket payload refuses the key.
    expect(Object.keys(telemetryEventPayloadSchema.shape)).not.toContain('lossReportId');
    expect(
      issuesOf(telemetryEventPayloadSchema, {
        events: [INGRESS_EVENT],
        droppedCount: 3,
        lossReportId: LOSS_REPORT_ID,
      })?.map(([code, path]) => [code, path]),
    ).toEqual([['unrecognized_keys', '']]);
  });

  it('stays strict: a key beside the five it declares is refused, attribution above all', () => {
    // A producer that could name the capture or the session outright would be
    // attributing its own batch, which is the service's job alone.
    for (const extra of [{ captureId: CAPTURE_ID }, { sessionId: SESSION_ID }, { dropped: 3 }]) {
      const issues = issuesOf(telemetryIngestRequestSchema, {
        projectRoot: PROJECT_ROOT,
        events: [INGRESS_EVENT],
        armedCaptureId: CAPTURE_ID,
        droppedCount: 1,
        lossReportId: LOSS_REPORT_ID,
        ...extra,
      });

      expect(
        issues?.map(([code, path]) => [code, path]),
        JSON.stringify(extra),
      ).toEqual([['unrecognized_keys', '']]);
    }
  });

  it('keeps its shape and its batch bound readable where the service reads them', () => {
    // The service reads `shape.events` for the batch bound and each field's
    // schema from `shape`, so both cross-field rules must be checks on the
    // object that leave every field where it was — with no minimum left on the
    // array to contradict the loss-only rule.
    expect(Object.keys(telemetryIngestRequestSchema.shape)).toEqual([
      'projectRoot',
      'events',
      'armedCaptureId',
      'droppedCount',
      'lossReportId',
    ]);
    expect(telemetryIngestRequestSchema.shape.lossReportId.safeParse(LOSS_REPORT_ID).success).toBe(
      true,
    );
    expect(telemetryIngestRequestSchema.shape.lossReportId.safeParse(undefined).success).toBe(true);

    const checks = telemetryIngestRequestSchema.shape.events.def.checks ?? [];
    const maxima = checks.flatMap((check) =>
      check._zod.def.check === 'max_length' && 'maximum' in check._zod.def
        ? [check._zod.def.maximum]
        : [],
    );

    expect(maxima).toEqual([5000]);
    expect(checks.some((check) => check._zod.def.check === 'min_length')).toBe(false);
    expect(telemetryIngestRequestSchema.shape.projectRoot.safeParse(PROJECT_ROOT).success).toBe(
      true,
    );

    // An oversized batch is refused by its bound alone, loss report or not.
    const oversized = Array.from({ length: 5001 }, () => INGRESS_EVENT);

    expect(
      issuesOf(telemetryIngestRequestSchema, {
        projectRoot: PROJECT_ROOT,
        events: oversized,
        droppedCount: 3,
      })?.map(([code, path]) => [code, path]),
    ).toEqual([['too_big', 'events']]);
  });

  it('types the delivery context exactly as the WebSocket payload does', () => {
    expectTypeOf<TelemetryIngestRequest['armedCaptureId']>().toEqualTypeOf<
      TelemetryEventPayload['armedCaptureId']
    >();
    expectTypeOf<TelemetryIngestRequest['droppedCount']>().toEqualTypeOf<
      TelemetryEventPayload['droppedCount']
    >();
    expectTypeOf<TelemetryIngestRequest['armedCaptureId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TelemetryIngestRequest['droppedCount']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<TelemetryIngestRequest['events']>().toEqualTypeOf<TelemetryEventIngress[]>();
  });

  it('types the loss-report identity as an optional string only the ingest body has', () => {
    expectTypeOf<TelemetryIngestRequest['lossReportId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TelemetryIngestRequest>().toHaveProperty('lossReportId');
    expectTypeOf<TelemetryEventPayload>().not.toHaveProperty('lossReportId');
  });

  it('is what parseHttpRequest validates telemetry.event against', () => {
    // The service reads its body through the route table, so the new shapes
    // must pass there, and the loss-only rule must be enforced there too.
    for (const body of [
      { projectRoot: PROJECT_ROOT, events: [INGRESS_EVENT], armedCaptureId: CAPTURE_ID },
      { projectRoot: PROJECT_ROOT, events: [INGRESS_EVENT], droppedCount: 2 },
      { projectRoot: PROJECT_ROOT, events: [], droppedCount: 3 },
      { projectRoot: PROJECT_ROOT, events: [], droppedCount: 3, armedCaptureId: CAPTURE_ID },
      { projectRoot: PROJECT_ROOT, events: [], droppedCount: 3, lossReportId: LOSS_REPORT_ID },
      {
        projectRoot: PROJECT_ROOT,
        events: [INGRESS_EVENT],
        armedCaptureId: CAPTURE_ID,
        droppedCount: 2,
        lossReportId: LOSS_REPORT_ID,
      },
    ]) {
      const parsed = parseHttpRequest('telemetry.event', body);

      expect(parsed.ok ? parsed.value : parsed.error.message).toStrictEqual(body);
    }

    const refused = parseHttpRequest('telemetry.event', { projectRoot: PROJECT_ROOT, events: [] });

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(refused.error.message).toContain('events (custom label=empty-batch-reports-loss)');
    }
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

  it('answers the health check with the protocol version this build speaks', () => {
    // Not a literal: the field exists so a client can compare the service's wire
    // version against its own before it opens a socket, and a fixture that
    // pinned a different string would pass while the comparison it stands for
    // could never succeed.
    expect(VALID_RESPONSES.health.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(
      healthResponseSchema.safeParse({
        ...VALID_RESPONSES.health,
        protocolVersion: PROTOCOL_VERSION,
      }).success,
    ).toBe(true);
    expect(healthResponseSchema.safeParse({ ...VALID_RESPONSES.health, version: '' }).success).toBe(
      false,
    );
    expect(
      healthResponseSchema.safeParse({ ...VALID_RESPONSES.health, pairingAvailable: 'yes' })
        .success,
    ).toBe(false);
  });

  it('carries a code and an expiry out of pair.start, and a credential out of pair.complete', () => {
    // The response side of the pairing flow, and the one reply that hands over a
    // capability. Both fields of the first are load-bearing — a code with no
    // expiry is a code the editor keeps offering after the service stopped
    // accepting it — and the second carries nothing but the credential.
    expect(
      pairStartResponseSchema.safeParse({ code: 'PAIR2X7Q', expiresAt: START_TIME + 300_000 })
        .success,
    ).toBe(true);
    expect(pairStartResponseSchema.safeParse({ code: 'PAIR2X7Q' }).success).toBe(false);
    expect(pairStartResponseSchema.safeParse({ expiresAt: START_TIME + 300_000 }).success).toBe(
      false,
    );
    expect(pairStartResponseSchema.safeParse({ code: '', expiresAt: START_TIME }).success).toBe(
      false,
    );

    expect(
      pairCompleteResponseSchema.safeParse({
        token: 'devtools-credential-placeholder',
        readProof: READ_PROOF_PLACEHOLDER,
      }).success,
    ).toBe(true);
    expect(pairCompleteResponseSchema.safeParse({}).success).toBe(false);
    expect(
      pairCompleteResponseSchema.safeParse({ token: '', readProof: READ_PROOF_PLACEHOLDER })
        .success,
    ).toBe(false);
    // The read proof is issued with the credential, never optional.
    expect(
      pairCompleteResponseSchema.safeParse({ token: 'devtools-credential-placeholder' }).success,
    ).toBe(false);
    // Nothing else rides along with the credential: a role or a scope echoed
    // here would be a client's word for what it was granted.
    expect(
      pairCompleteResponseSchema.safeParse({
        token: 'devtools-credential-placeholder',
        readProof: READ_PROOF_PLACEHOLDER,
        role: 'devtools',
      }).success,
    ).toBe(false);
  });
});

describe('the devServer.credential bodies — a project-scoped server-agent credential', () => {
  /** The longest project root the transport admits, matching every other path field. */
  const LONGEST_PROJECT_ROOT = `/${'p'.repeat(4095)}`;

  /** A valid reply: the credential and an expiry twelve hours after the fixture instant. */
  const CREDENTIAL_REPLY = VALID_RESPONSES['devServer.credential'];

  it('binds the route to its own two schemas, behind a credential', () => {
    expect(HTTP_ROUTES['devServer.credential'].request).toBe(devServerCredentialRequestSchema);
    expect(HTTP_ROUTES['devServer.credential'].response).toBe(devServerCredentialResponseSchema);
    expect(devServerCredentialPath()).toBe('/dev-server/credential');
    // Declared by the table, so the collision a folder-owned literal could hide
    // — two owners of one path — cannot exist: exactly one row claims it.
    expect(
      HTTP_OPERATIONS.filter(
        (operation) => HTTP_ROUTES[operation].pattern === '/dev-server/credential',
      ),
    ).toEqual(['devServer.credential']);
  });

  it('accepts a project root, checked exactly as devServer.stop checks one', () => {
    expect(parseHttpRequest('devServer.credential', { projectRoot: PROJECT_ROOT }).ok).toBe(true);
    expect(parseHttpRequest('devServer.credential', { projectRoot: LONGEST_PROJECT_ROOT }).ok).toBe(
      true,
    );
    // Shape only, like every path field here: whether the root is absolute and
    // inside an announced workspace folder is the service's question, answered
    // where a real path can be resolved.
    expect(parseHttpRequest('devServer.credential', { projectRoot: 'relative/site' }).ok).toBe(
      true,
    );

    for (const body of [
      { projectRoot: PROJECT_ROOT },
      { projectRoot: '' },
      { projectRoot: `${LONGEST_PROJECT_ROOT}x` },
    ]) {
      expect(devServerCredentialRequestSchema.safeParse(body).success).toBe(
        devServerStopRequestSchema.safeParse(body).success,
      );
    }
  });

  it('refuses an extra key, an empty or over-long project root, and a missing one', () => {
    // A role or a TTL named here would be the caller choosing what it is granted.
    expect(
      parseHttpRequest('devServer.credential', { projectRoot: PROJECT_ROOT, role: 'vscode' }).ok,
    ).toBe(false);
    expect(
      parseHttpRequest('devServer.credential', { projectRoot: PROJECT_ROOT, ttlMs: 1_000 }).ok,
    ).toBe(false);
    expect(parseHttpRequest('devServer.credential', { projectRoot: '' }).ok).toBe(false);
    expect(
      parseHttpRequest('devServer.credential', { projectRoot: `${LONGEST_PROJECT_ROOT}x` }).ok,
    ).toBe(false);
    expect(parseHttpRequest('devServer.credential', {}).ok).toBe(false);
    expect(parseHttpRequest('devServer.credential', undefined).ok).toBe(false);
  });

  it('answers with the credential and its expiry, and nothing else', () => {
    expect(parseHttpResponse('devServer.credential', CREDENTIAL_REPLY).ok).toBe(true);
    expect(
      parseHttpResponse('devServer.credential', { ...CREDENTIAL_REPLY, token: 't'.repeat(512) }).ok,
    ).toBe(true);

    expect(parseHttpResponse('devServer.credential', { token: SERVER_AGENT_TOKEN }).ok).toBe(false);
    expect(
      parseHttpResponse('devServer.credential', { expiresAt: CREDENTIAL_REPLY.expiresAt }).ok,
    ).toBe(false);
    expect(parseHttpResponse('devServer.credential', { ...CREDENTIAL_REPLY, token: '' }).ok).toBe(
      false,
    );
    expect(
      parseHttpResponse('devServer.credential', { ...CREDENTIAL_REPLY, token: 't'.repeat(513) }).ok,
    ).toBe(false);
    // A seconds-precision expiry is a unit mistake, refused like any timestamp.
    expect(
      parseHttpResponse('devServer.credential', {
        ...CREDENTIAL_REPLY,
        expiresAt: Math.floor(CREDENTIAL_REPLY.expiresAt / 1_000),
      }).ok,
    ).toBe(false);
    expect(
      parseHttpResponse('devServer.credential', {
        ...CREDENTIAL_REPLY,
        scope: PROJECT_ROOT,
      }).ok,
    ).toBe(false);
  });

  it('round-trips both bodies through JSON unchanged', () => {
    const request = parseHttpRequest(
      'devServer.credential',
      throughJson({ projectRoot: PROJECT_ROOT }),
    );
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.value).toEqual({ projectRoot: PROJECT_ROOT });
    }

    const response = parseHttpResponse('devServer.credential', throughJson(CREDENTIAL_REPLY));
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.value).toEqual(CREDENTIAL_REPLY);
    }
  });

  it('never echoes a rejected credential', () => {
    const rejected = parseHttpResponse('devServer.credential', {
      token: SERVER_AGENT_TOKEN,
      expiresAt: SERVER_AGENT_TOKEN,
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.message).toContain('expiresAt');
      expect(
        JSON.stringify({ message: rejected.error.message, details: rejected.error.details }),
      ).not.toContain(SERVER_AGENT_TOKEN);
      expect(JSON.stringify(rejected.error.toPayload())).not.toContain(SERVER_AGENT_TOKEN);
    }
  });
});

describe('the credentials.rotate bodies — revoke everything, name nothing', () => {
  it('binds the route to its own two schemas, behind a credential', () => {
    expect(HTTP_ROUTES['credentials.rotate'].request).toBe(credentialsRotateRequestSchema);
    expect(HTTP_ROUTES['credentials.rotate'].response).toBe(credentialsRotateResponseSchema);
    expect(credentialsRotatePath()).toBe('/credentials/rotate');
  });

  it('accepts an empty request and refuses any key or a missing body', () => {
    expect(parseHttpRequest('credentials.rotate', {}).ok).toBe(true);
    // All or nothing: a body that could spare one credential would defeat it.
    expect(parseHttpRequest('credentials.rotate', { keep: ['vscode'] }).ok).toBe(false);
    expect(parseHttpRequest('credentials.rotate', { role: 'vscode' }).ok).toBe(false);
    expect(parseHttpRequest('credentials.rotate', undefined).ok).toBe(false);
  });

  it('answers with two counts, zero included', () => {
    expect(
      parseHttpResponse('credentials.rotate', { credentialsDeleted: 0, socketsClosed: 0 }).ok,
    ).toBe(true);
    expect(parseHttpResponse('credentials.rotate', VALID_RESPONSES['credentials.rotate']).ok).toBe(
      true,
    );
  });

  it.each(['credentialsDeleted', 'socketsClosed'] as const)(
    'refuses a negative, fractional or missing %s',
    (field) => {
      const reply = VALID_RESPONSES['credentials.rotate'];
      const { [field]: omitted, ...without } = reply;

      expect(omitted).toBeGreaterThan(0);
      expect(parseHttpResponse('credentials.rotate', without).ok).toBe(false);
      expect(parseHttpResponse('credentials.rotate', { ...reply, [field]: -1 }).ok).toBe(false);
      expect(parseHttpResponse('credentials.rotate', { ...reply, [field]: 0.5 }).ok).toBe(false);
    },
  );

  it('carries no credential on the wire: the new editor token lives in auth.json only', () => {
    expect(
      parseHttpResponse('credentials.rotate', {
        ...VALID_RESPONSES['credentials.rotate'],
        token: 'editor-credential-placeholder',
      }).ok,
    ).toBe(false);
  });

  it('round-trips both bodies through JSON unchanged', () => {
    const request = parseHttpRequest('credentials.rotate', throughJson({}));
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.value).toEqual({});
    }

    const reply = VALID_RESPONSES['credentials.rotate'];
    const response = parseHttpResponse('credentials.rotate', throughJson(reply));
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.value).toEqual(reply);
    }
  });
});

describe('the credentials.release bodies — one token in, one flag out', () => {
  /** The longest token the transport admits, matching every other opaque token field. */
  const LONGEST_TOKEN = 't'.repeat(512);

  it('binds the route to its own two schemas, behind a credential', () => {
    expect(HTTP_ROUTES['credentials.release'].request).toBe(credentialsReleaseRequestSchema);
    expect(HTTP_ROUTES['credentials.release'].response).toBe(credentialsReleaseResponseSchema);
    expect(HTTP_ROUTES['credentials.release'].params).toEqual([]);
    expect(HTTP_ROUTES['credentials.release'].authExempt).toBe(false);
    expect(credentialsReleasePath()).toBe('/credentials/release');
    // Exactly one row claims the path, beside the rotation it sits next to.
    expect(
      HTTP_OPERATIONS.filter(
        (operation) => HTTP_ROUTES[operation].pattern === '/credentials/release',
      ),
    ).toEqual(['credentials.release']);
  });

  it('accepts exactly one token, up to the opaque-token bound', () => {
    expect(parseHttpRequest('credentials.release', { token: SERVER_AGENT_TOKEN }).ok).toBe(true);
    expect(parseHttpRequest('credentials.release', { token: LONGEST_TOKEN }).ok).toBe(true);
  });

  it('refuses an extra key, an empty, over-long or non-string token, and a missing one', () => {
    // A project, a role or a wildcard named here would widen the release past
    // the one credential its holder already has.
    expect(
      parseHttpRequest('credentials.release', { token: SERVER_AGENT_TOKEN, projectRoot: '/work' })
        .ok,
    ).toBe(false);
    expect(
      parseHttpRequest('credentials.release', { token: SERVER_AGENT_TOKEN, all: true }).ok,
    ).toBe(false);
    expect(parseHttpRequest('credentials.release', { token: '' }).ok).toBe(false);
    expect(parseHttpRequest('credentials.release', { token: `${LONGEST_TOKEN}t` }).ok).toBe(false);
    expect(parseHttpRequest('credentials.release', { token: 42 }).ok).toBe(false);
    expect(parseHttpRequest('credentials.release', { token: null }).ok).toBe(false);
    expect(parseHttpRequest('credentials.release', {}).ok).toBe(false);
    expect(parseHttpRequest('credentials.release', undefined).ok).toBe(false);
  });

  it('answers with one boolean flag, either value a success', () => {
    expect(parseHttpResponse('credentials.release', { released: true }).ok).toBe(true);
    expect(parseHttpResponse('credentials.release', { released: false }).ok).toBe(true);
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
  ])('refuses a released flag that is %s', (_label, released) => {
    const rejected = parseHttpResponse('credentials.release', { released });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.message).toContain('released');
    }
  });

  it('refuses a missing flag and any field beside it: nothing rides back with the answer', () => {
    expect(parseHttpResponse('credentials.release', {}).ok).toBe(false);
    expect(
      parseHttpResponse('credentials.release', { released: true, token: SERVER_AGENT_TOKEN }).ok,
    ).toBe(false);
    expect(
      parseHttpResponse('credentials.release', { released: true, projectRoot: PROJECT_ROOT }).ok,
    ).toBe(false);
  });

  it('round-trips both bodies through JSON unchanged', () => {
    const body = VALID_REQUESTS['credentials.release'];
    const request = parseHttpRequest('credentials.release', throughJson(body));
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.value).toEqual(body);
    }

    for (const reply of [{ released: true }, { released: false }]) {
      const response = parseHttpResponse('credentials.release', throughJson(reply));
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.value).toEqual(reply);
      }
    }
  });

  it('never echoes the token of a refused request', () => {
    for (const body of [
      { token: SERVER_AGENT_TOKEN, role: 'vscode' },
      { token: `${SERVER_AGENT_TOKEN}${LONGEST_TOKEN}` },
    ]) {
      const rejected = parseHttpRequest('credentials.release', body);

      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(
          JSON.stringify({
            message: rejected.error.message,
            hint: rejected.error.hint,
            details: rejected.error.details,
          }),
        ).not.toContain(SERVER_AGENT_TOKEN);
        expect(JSON.stringify(rejected.error.toPayload())).not.toContain(SERVER_AGENT_TOKEN);
      }
    }
  });
});

describe('the error body of a non-2xx reply', () => {
  it('accepts every code in the shared vocabulary and nothing outside it', () => {
    for (const code of DEBUGGEN_ERROR_CODES) {
      expect(
        httpErrorResponseSchema.safeParse({ code, message: 'Something went wrong.' }).success,
      ).toBe(true);
    }

    expect(
      httpErrorResponseSchema.safeParse({ code: 'SOMETHING_ELSE', message: 'x' }).success,
    ).toBe(false);
    expect(httpErrorResponseSchema.safeParse({ message: 'x' }).success).toBe(false);
    expect(httpErrorResponseSchema.safeParse({ code: 'INTERNAL' }).success).toBe(false);
    expect(httpErrorResponseSchema.safeParse({ code: 'INTERNAL', message: '' }).success).toBe(
      false,
    );
  });

  it('carries an optional correlation ref and no hint', () => {
    expect(
      httpErrorResponseSchema.safeParse({ code: 'INTERNAL', message: 'x', ref: MODIFICATION_ID })
        .success,
    ).toBe(true);

    // AAP §0.4.2 fixes the generic error payload at `{ code, message, ref? }`
    // for both transports. A recovery hint travels on the messages that specify
    // one of their own, so a hint here would be a second error shape that only
    // this transport spoke.
    expect(
      httpErrorResponseSchema.safeParse({ code: 'INTERNAL', message: 'x', hint: 'Retry.' }).success,
    ).toBe(false);
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

  it('classifies every source as paged or single-valued, with nothing unclassified', () => {
    // The two lists below are what the next three cases are driven from, so a
    // source added to the vocabulary without being placed in one of them fails
    // here rather than going untested.
    expect(new Set([...PAGED_SOURCES, ...SINGLE_VALUE_SOURCES])).toEqual(
      new Set(DATA_QUERY_SOURCES),
    );
    expect(PAGED_SOURCES.length + SINGLE_VALUE_SOURCES.length).toBe(DATA_QUERY_SOURCES.length);

    // And the classification matches what the union actually declares.
    for (const source of DATA_QUERY_SOURCES) {
      expect(Object.hasOwn(VALID_DATA_RESULTS[source], 'total')).toBe(
        (PAGED_SOURCES as readonly DataQuerySource[]).includes(source),
      );
    }
  });

  it('requires the paging echo on every array-valued source', () => {
    for (const source of PAGED_SOURCES) {
      const result = VALID_DATA_RESULTS[source];

      expect(parseDataResult(result).ok).toBe(true);
      // Strip the echo and the same payload is refused: a caller cannot page
      // without knowing the total, the applied window and whether more follows.
      expect(parseDataResult(withoutPagingEcho(result)).ok).toBe(false);
    }
  });

  it('refuses the paging echo on the three sources that answer with one value', () => {
    for (const source of SINGLE_VALUE_SOURCES) {
      const result = VALID_DATA_RESULTS[source];

      expect(parseDataResult(result).ok).toBe(true);
      // A tree and a graph are each one value, so a `total` here would be a
      // number nothing computed and a paging loop nothing could terminate.
      expect(
        parseDataResult({
          ...result,
          total: 1,
          limit: DATA_QUERY_DEFAULT_LIMIT,
          offset: DATA_QUERY_DEFAULT_OFFSET,
          nextOffset: null,
        }).ok,
      ).toBe(false);
    }
  });

  it('refuses an absent, null, mistyped or primitive payload for every source', () => {
    for (const source of DATA_QUERY_SOURCES) {
      const echo = (PAGED_SOURCES as readonly DataQuerySource[]).includes(source)
        ? {
            total: 0,
            limit: DATA_QUERY_DEFAULT_LIMIT,
            offset: DATA_QUERY_DEFAULT_OFFSET,
            nextOffset: null,
          }
        : {};

      // The payload field is named after the source and is never optional: an
      // absent or `undefined` payload would reach a component as a missing value
      // and throw on its first property access, far from the cause.
      expect(parseDataResult({ source, ...echo }).ok).toBe(false);
      expect(parseDataResult({ source, [source]: undefined, ...echo }).ok).toBe(false);

      for (const payload of [42, 'text', true]) {
        expect(parseDataResult({ source, [source]: payload, ...echo }).ok).toBe(false);
      }

      if ((SINGLE_VALUE_SOURCES as readonly DataQuerySource[]).includes(source)) {
        // A record slot: an array is not a record, however empty it looks.
        expect(parseDataResult({ source, [source]: [], ...echo }).ok).toBe(false);
        expect(parseDataResult({ source, [source]: {}, ...echo }).ok).toBe(false);
      } else {
        // A page slot: an empty page is an ordinary answer, a record is not.
        expect(parseDataResult({ source, [source]: [], ...echo }).ok).toBe(true);
        expect(parseDataResult({ source, [source]: {}, ...echo }).ok).toBe(false);
      }

      // `null` is the documented empty answer for exactly two sources.
      expect(parseDataResult({ source, [source]: null, ...echo }).ok).toBe(
        NULLABLE_SOURCES.includes(source),
      );
    }
  });

  it('accepts a metric that was not measured, carrying no value at all', () => {
    // AAP §0.6.6: a metric the capture could not observe reports
    // `available: false` and omits `value`, and the card renders "n/a". A schema
    // that demanded a number would force a producer to invent a zero, which a
    // panel would then present as a measurement.
    expect(
      parseDataResult({
        source: 'metrics',
        metrics: [
          { id: 'transferred_bytes', label: 'Transferred', unit: 'bytes', available: false },
          { id: 'total_duration', label: 'Total', unit: 'ms', available: true, value: 1_175 },
        ],
        total: 2,
        limit: DATA_QUERY_DEFAULT_LIMIT,
        offset: DATA_QUERY_DEFAULT_OFFSET,
        nextOffset: null,
      }).ok,
    ).toBe(true);

    // The two fields the guard does insist on, because every card addresses a
    // value by id and decides what to draw from the flag.
    expect(
      parseDataResult({
        source: 'metrics',
        metrics: [{ label: 'Total', unit: 'ms', available: true, value: 1 }],
        total: 1,
        limit: DATA_QUERY_DEFAULT_LIMIT,
        offset: DATA_QUERY_DEFAULT_OFFSET,
        nextOffset: null,
      }).ok,
    ).toBe(false);
    expect(
      parseDataResult({
        source: 'metrics',
        metrics: [{ id: 'total_duration', label: 'Total', unit: 'ms' }],
        total: 1,
        limit: DATA_QUERY_DEFAULT_LIMIT,
        offset: DATA_QUERY_DEFAULT_OFFSET,
        nextOffset: null,
      }).ok,
    ).toBe(false);
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

  it('accepts the window a request that named neither field is answered with', () => {
    // The echo reports what the service actually applied, including the two
    // defaults it filled in for an omitted `limit` and `offset` — so a reply
    // carrying exactly those must be valid, or every unparameterized query
    // would be refused by the client that made it.
    expect(
      dataPageSchema.safeParse({
        total: 3,
        limit: DATA_QUERY_DEFAULT_LIMIT,
        offset: DATA_QUERY_DEFAULT_OFFSET,
        nextOffset: null,
      }).success,
    ).toBe(true);
    expect(page.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(page.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
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

describe('the metrics result — paged by the same rule as every array-valued source', () => {
  /** The capture's complete metric set, computed by its owner: one value per id. */
  const ALL_METRICS = [...CAPTURE_SUMMARY.metrics];

  /** How many values the complete set holds. */
  const TOTAL = ALL_METRICS.length;

  /**
   * The window `[offset, offset + limit)` of the complete set, as a conforming
   * producer answers it.
   *
   * @param offset The offset the producer applied.
   * @param limit The page size the producer applied.
   * @param nextOffset The `nextOffset` the page carries, supplied by the case
   * so that a refusal case can state a wrong one.
   * @returns The metrics result for that window.
   */
  function metricsPage(
    offset: number,
    limit: number,
    nextOffset: number | null,
  ): DataResultFor<'metrics'> {
    return {
      source: 'metrics',
      metrics: ALL_METRICS.slice(offset, offset + limit),
      total: TOTAL,
      limit,
      offset,
      nextOffset,
    };
  }

  /**
   * The paths of the paging-rule issues a metrics result is refused with.
   *
   * @param value The candidate result.
   * @returns Each custom issue's path, in the order the check reported them;
   * empty when the result is accepted.
   */
  function pagingIssuePaths(value: unknown): PropertyKey[][] {
    const parsed = dataResultSchema.safeParse(value);

    return parsed.success
      ? []
      : parsed.error.issues.filter((issue) => issue.code === 'custom').map((issue) => issue.path);
  }

  it('builds its pages from the complete set, one value per metric id', () => {
    // Every case below slices this set, so it has to be the whole vocabulary:
    // a shorter fixture would let a case pass without ever paging past it.
    expect(TOTAL).toBe(METRIC_IDS.length);
    expect(TOTAL).toBe(14);
    expect(ALL_METRICS.map((metric) => metric.id)).toEqual([...METRIC_IDS]);
  });

  it('accepts the first, a middle and the last page of a small limit', () => {
    for (const [offset, nextOffset] of [
      [0, 5],
      [5, 10],
      [10, null],
    ] as const) {
      const page = metricsPage(offset, 5, nextOffset);

      expect(pagingIssuePaths(page)).toEqual([]);
      expect(parseDataResult(page).ok).toBe(true);
      expect(parseDataResult(throughJson(page)).ok).toBe(true);
    }

    // The last page is short, and still the last one.
    expect(metricsPage(10, 5, null).metrics).toHaveLength(4);
  });

  it('accepts a count-only page as the last page, with nextOffset: null', () => {
    // `limit: 0` asks for the total without values. The page is empty and the
    // total is real; a page that returned nothing is the last page, so its
    // `nextOffset` is null even while values remain from its offset.
    for (const offset of [0, 7, TOTAL - 1]) {
      const page = metricsPage(offset, 0, null);

      expect(page.metrics).toEqual([]);
      expect(pagingIssuePaths(page)).toEqual([]);
      expect(parseDataResult(page).ok).toBe(true);
    }

    // At or past the end, nothing remains to point at.
    expect(parseDataResult(metricsPage(TOTAL, 0, null)).ok).toBe(true);
    expect(parseDataResult(metricsPage(TOTAL + 6, 0, null)).ok).toBe(true);
  });

  it('accepts an offset at or past the total as an empty last page', () => {
    for (const offset of [TOTAL, TOTAL + 10]) {
      const page = metricsPage(offset, 5, null);

      expect(page.metrics).toEqual([]);
      expect(pagingIssuePaths(page)).toEqual([]);
    }
  });

  it('reassembles exactly the complete set by following nextOffset', () => {
    const collected: DataResultFor<'metrics'>['metrics'] = [];
    let offset: number | null = 0;
    let pages = 0;

    while (offset !== null) {
      // What arrives over the wire, sliced from the real set by a conforming
      // producer: the page carries the offset of the next one.
      const end = Math.min(offset + 3, TOTAL);
      const parsed = parseDataResult(throughJson(metricsPage(offset, 3, end < TOTAL ? end : null)));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.value.source !== 'metrics') {
        break;
      }

      // A page that returned nothing is never followed, so every page walked
      // here advances the offset.
      expect(parsed.value.metrics.length).toBeGreaterThan(0);
      collected.push(...parsed.value.metrics);
      offset = parsed.value.nextOffset;
      pages += 1;

      // A walk over fourteen values in pages of three ends after five pages.
      expect(pages).toBeLessThanOrEqual(5);
    }

    expect(pages).toBe(5);
    expect(collected).toEqual(ALL_METRICS);
    expect(new Set(collected.map((metric) => metric.id)).size).toBe(METRIC_IDS.length);
  });

  it('refuses the complete set echoed with a smaller limit, whatever the offset', () => {
    // The producer behaviour this schema used to document: every value,
    // whatever window the request asked for. A card reading the page as the
    // window it asked for would double-count or misplace every value.
    expect(pagingIssuePaths({ ...metricsPage(0, 5, null), metrics: [...ALL_METRICS] })).toEqual([
      ['metrics'],
    ]);
    expect(pagingIssuePaths({ ...metricsPage(0, 0, null), metrics: [...ALL_METRICS] })).toEqual([
      ['metrics'],
    ]);
    // From offset 5, fourteen values exceed both the limit and what remains.
    expect(pagingIssuePaths({ ...metricsPage(5, 5, null), metrics: [...ALL_METRICS] })).toEqual([
      ['metrics'],
      ['metrics'],
    ]);
  });

  it('refuses nextOffset: null while values remain', () => {
    expect(pagingIssuePaths(metricsPage(0, 5, null))).toEqual([['nextOffset']]);
    expect(pagingIssuePaths(metricsPage(5, 5, null))).toEqual([['nextOffset']]);
  });

  it('refuses a count-only page whose nextOffset does not advance', () => {
    // A cursor equal to the page's own offset would send a paging loop back to
    // the same empty page forever, so a page that returned nothing names none.
    for (const offset of [0, 7, TOTAL - 1]) {
      expect(pagingIssuePaths(metricsPage(offset, 0, offset))).toEqual([['nextOffset']]);
    }
  });

  it('refuses a nextOffset that skips, overlaps or points past the end', () => {
    expect(pagingIssuePaths(metricsPage(0, 5, 6))).toEqual([['nextOffset']]);
    expect(pagingIssuePaths(metricsPage(0, 5, 4))).toEqual([['nextOffset']]);
    expect(pagingIssuePaths(metricsPage(10, 5, TOTAL))).toEqual([['nextOffset']]);
    // Past the end, even a count-only page has nothing to point at.
    expect(pagingIssuePaths(metricsPage(TOTAL + 6, 0, TOTAL + 6))).toEqual([['nextOffset']]);
  });

  it('refuses a total above the closed metric vocabulary', () => {
    expect(pagingIssuePaths({ ...metricsPage(0, 5, 5), total: METRIC_IDS.length + 1 })).toEqual([
      ['total'],
    ]);
  });

  it('refuses a page that repeats a metric id, at the repeating index', () => {
    expect(
      pagingIssuePaths({
        ...metricsPage(0, 5, 3),
        metrics: [...ALL_METRICS.slice(0, 2), ...ALL_METRICS.slice(0, 1)],
      }),
    ).toEqual([['metrics', 2]]);
  });

  it('refuses a page longer than what remains from its offset', () => {
    // Three values from a source that holds two.
    expect(
      pagingIssuePaths({
        ...metricsPage(0, 5, null),
        metrics: ALL_METRICS.slice(0, 3),
        total: 2,
      }),
    ).toEqual([['metrics']]);
    // A value at an offset where none remain.
    expect(
      pagingIssuePaths({ ...metricsPage(TOTAL, 5, null), metrics: ALL_METRICS.slice(0, 1) }),
    ).toEqual([['metrics']]);
  });

  it('reports a paging breach without carrying the rejected input', () => {
    // `reportInput` asks zod to keep each issue's input; the paging checks
    // never attach one, so even a caller that asks gets none (AAP §0.5.2).
    const secret = 'do-not-echo-this-metric-note';
    const parsed = dataResultSchema.safeParse(
      {
        ...metricsPage(0, 5, null),
        metrics: [
          ...ALL_METRICS.slice(0, 1),
          ...ALL_METRICS.slice(0, 1).map((metric) => ({ ...metric, note: secret })),
        ],
      },
      { reportInput: true },
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const custom = parsed.error.issues.filter((issue) => issue.code === 'custom');

      expect(custom.map((issue) => issue.path)).toEqual([['metrics', 1], ['nextOffset']]);
      for (const issue of custom) {
        expect(issue.input).toBeUndefined();
      }
      expect(JSON.stringify(parsed.error.issues)).not.toContain(secret);
    }
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
      '/sessions/purge',
      `/sessions/${SESSION_ID}/capture/start`,
      `/sessions/${SESSION_ID}/capture/stop`,
      `/sessions/${SESSION_ID}/target/request`,
      `/sessions/${SESSION_ID}/panel-data`,
      `/sessions/${SESSION_ID}/panel`,
      `/sessions/${SESSION_ID}/panels/${PANEL_ID}`,
      `/sessions/${SESSION_ID}/modifications`,
      '/telemetry/ingest',
      '/dev-server/launch',
      '/dev-server/stop',
      '/dev-server/credential',
      '/health',
      '/pair/start',
      '/pair/complete',
      '/credentials/rotate',
      '/credentials/release',
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

  it('fails loudly on an operation the table does not hold', () => {
    // The first guard is the compiler: `HttpOperationId` is derived from the
    // table, so a call naming an operation that does not exist cannot be written
    // without the cast below. The assertion is that the run-time behaviour behind
    // that cast is a throw rather than a path built from nothing — a silent
    // `'undefined'` segment would be a request sent to a route that never
    // existed, answered with a 404 nobody could trace back to a typo.
    const unknownOperation = 'session.rename' as HttpOperationId;

    expect(() => buildPath(unknownOperation, { id: SESSION_ID })).toThrow();
    expect(() => buildPath(unknownOperation)).toThrow();
    expect(HTTP_OPERATIONS).not.toContain(unknownOperation);
    expect(Object.hasOwn(HTTP_ROUTES, unknownOperation)).toBe(false);
  });

  it('agrees with every named builder', () => {
    expect(sessionsPath()).toBe('/sessions');
    expect(sessionPath(SESSION_ID)).toBe(buildPath('session.get', { id: SESSION_ID }));
    expect(sessionQuestionPath(SESSION_ID)).toBe(buildPath('session.question', { id: SESSION_ID }));
    expect(sessionEndPath(SESSION_ID)).toBe(buildPath('session.end', { id: SESSION_ID }));
    expect(sessionPurgePath()).toBe('/sessions/purge');
    expect(sessionPurgePath()).toBe(buildPath('session.purge'));
    expect(captureStartPath(SESSION_ID)).toBe(buildPath('capture.start', { id: SESSION_ID }));
    expect(captureStopPath(SESSION_ID)).toBe(buildPath('capture.stop', { id: SESSION_ID }));
    expect(targetRequestPath(SESSION_ID)).toBe(buildPath('target.request', { id: SESSION_ID }));
    expect(targetRequestPath(SESSION_ID)).toBe(`/sessions/${SESSION_ID}/target/request`);
    expect(panelDataPath(SESSION_ID)).toBe(buildPath('panel.data', { id: SESSION_ID }));
    expect(panelPath(SESSION_ID)).toBe(buildPath('panel.get', { id: SESSION_ID }));
    expect(panelByIdPath(SESSION_ID, PANEL_ID)).toBe(
      buildPath('panel.getById', { id: SESSION_ID, panelId: PANEL_ID }),
    );
    expect(modificationsPath(SESSION_ID)).toBe(buildPath('modifications.list', { id: SESSION_ID }));
    expect(telemetryIngestPath()).toBe('/telemetry/ingest');
    expect(devServerLaunchPath()).toBe('/dev-server/launch');
    expect(devServerStopPath()).toBe('/dev-server/stop');
    expect(devServerCredentialPath()).toBe('/dev-server/credential');
    expect(devServerCredentialPath()).toBe(buildPath('devServer.credential'));
    expect(healthPath()).toBe('/health');
    expect(pairStartPath()).toBe('/pair/start');
    expect(pairCompletePath()).toBe('/pair/complete');
    expect(credentialsRotatePath()).toBe('/credentials/rotate');
    expect(credentialsRotatePath()).toBe(buildPath('credentials.rotate'));
    expect(credentialsReleasePath()).toBe('/credentials/release');
    expect(credentialsReleasePath()).toBe(buildPath('credentials.release'));
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

  it('reports an invalid panel-data query without echoing its filter', () => {
    // A panel-data body carries a component name and a trace id the developer's
    // own runtime produced. The rejection names the field that was wrong —
    // `filter.tier` — and the values that field allows, never the ones the
    // caller sent.
    const rejected = parseHttpRequest('panel.data', {
      source: 'spans',
      filter: { component: SENTINEL, traceId: SENTINEL },
      tier: SENTINEL,
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(exposedText(rejected.error)).not.toContain(SENTINEL);
      expect(rejected.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(DEBUGGEN_ERROR_CODES).toContain(rejected.error.code);
    }
  });

  it('reports an invalid ingest batch without echoing the events', () => {
    // The route the Node preload posts to, and the body that holds the most:
    // span names, redacted URLs, parameterized statements and a project path.
    // The issue path locates the offending event by index and field, which is
    // what a producer needs, and carries none of its content.
    const rejected = parseHttpRequest('telemetry.event', {
      projectRoot: PROJECT_ROOT,
      events: [{ ...INGRESS_EVENT, name: SENTINEL, traceId: 'not-a-trace-id' }],
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(exposedText(rejected.error)).not.toContain(SENTINEL);
      expect(rejected.error.message).toContain('events[0].traceId');
      expect(DEBUGGEN_ERROR_CODES).toContain(rejected.error.code);
    }
  });

  it('reports a refused ingest delivery context without echoing it', () => {
    // The armed capture id is producer-supplied text; a padded or oversized
    // one is named by its field and the rule it broke, never quoted. A
    // well-formed one on an empty batch without a loss is refused by the
    // loss-only rule, which carries no received value at all.
    for (const [body, field] of [
      [{ events: [INGRESS_EVENT], armedCaptureId: ` ${SENTINEL}` }, 'armedCaptureId'],
      [{ events: [INGRESS_EVENT], armedCaptureId: SENTINEL.repeat(3) }, 'armedCaptureId'],
      [{ events: [], armedCaptureId: SENTINEL }, 'events'],
      [{ events: [], armedCaptureId: SENTINEL, droppedCount: SENTINEL }, 'droppedCount'],
      // The loss-report identity is producer-supplied text as well: refused
      // when malformed, when it names no loss, and on an event-less body
      // without one, each time by field and rule alone.
      [{ events: [INGRESS_EVENT], droppedCount: 3, lossReportId: ` ${SENTINEL}` }, 'lossReportId'],
      [{ events: [], droppedCount: 3, lossReportId: SENTINEL.repeat(3) }, 'lossReportId'],
      [{ events: [INGRESS_EVENT], lossReportId: SENTINEL }, 'lossReportId'],
      [{ events: [INGRESS_EVENT], droppedCount: 0, lossReportId: SENTINEL }, 'lossReportId'],
      [{ events: [], lossReportId: SENTINEL }, 'events'],
    ] as const) {
      const rejected = parseHttpRequest('telemetry.event', { projectRoot: PROJECT_ROOT, ...body });

      expect(rejected.ok, JSON.stringify(body)).toBe(false);
      if (!rejected.ok) {
        expect(exposedText(rejected.error)).not.toContain(SENTINEL);
        expect(rejected.error.message).toContain(field);
        expect(rejected.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      }
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

  it('reports a metrics page that breaks the paging rule without echoing its values', () => {
    // Every value is well formed; only the page is inconsistent — one id twice
    // and a last-page marker while values remain. The rejection names the two
    // fields, never the metric carrying the sentinel.
    const [metric] = CAPTURE_SUMMARY.metrics;
    const rejected = parseDataResult({
      source: 'metrics',
      metrics: [metric, { ...metric, note: SENTINEL }],
      total: CAPTURE_SUMMARY.metrics.length,
      limit: 5,
      offset: 0,
      nextOffset: null,
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(exposedText(rejected.error)).not.toContain(SENTINEL);
      expect(rejected.error.message).toContain('metrics[1]');
      expect(rejected.error.message).toContain('nextOffset');
      expect(rejected.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
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

  it('reports a target-request body or reply that names too much without echoing it', () => {
    const request = parseHttpRequest('target.request', { selector: SENTINEL });
    const response = parseHttpResponse('target.request', {
      sessionId: SESSION_ID,
      tabId: SENTINEL,
    });

    expect(request.ok).toBe(false);
    expect(response.ok).toBe(false);
    for (const rejected of [request, response]) {
      if (!rejected.ok) {
        expect(exposedText(rejected.error)).not.toContain(SENTINEL);
        expect(rejected.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      }
    }
  });
});
