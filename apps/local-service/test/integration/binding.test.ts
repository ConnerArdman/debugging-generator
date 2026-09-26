/**
 * Integration suite `binding` (AAP §0.8.3): tab↔session binding over a live
 * service — bind, replacement, same-origin and cross-origin navigation, unbind,
 * a dropped DevTools socket, and the reopen replay a freshly bound panel
 * receives (AAP §0.2.3 "Tab/session binding", §0.4.2's four binding rows,
 * §0.5.5).
 *
 * ## What this suite proves that no unit suite can
 *
 * `src/server/clients.ts` and `src/server/routes/binding.ts` have colocated
 * unit suites over fake sockets. This one drives the real service through
 * `startService` and real WebSocket connections, and judges every binding
 * change by three independent observations:
 *
 * 1. **Where the tab-bound deliveries land.** The binding is the deterministic
 *    recipient of `agent.config` and of the session's DevTools fan-out, so each
 *    test asserts which connection receives those frames after a change — a
 *    stronger check than inspecting a registry, and the only view of the
 *    in-memory registry a live service offers.
 * 2. **What the announcement said.** Every `session.bound` frame is validated
 *    against protocol's `sessionBoundPayloadSchema` and its `reason` compared
 *    with protocol's `BINDING_REASONS`, so a replacement or a drop that is
 *    applied silently fails here.
 * 3. **What the store holds.** The durable `bindings` row is read back through
 *    the harness's `SessionsRepo` (`getBindingByTab`, `getBindingBySession`)
 *    and the whole table is read raw, so a half-applied replacement — the live
 *    view moved while a stale row stayed, or the reverse — is caught by the
 *    disagreement.
 *
 * The bound-tab routing is asserted through `agent.config`, the session fan-out
 * and `target.request`, which all resolve their recipient through the same
 * binding. `target.request` is produced by the editor's real
 * `POST /sessions/:id/target/request`, which the replacement test calls to
 * prove the request follows the binding to the replacing tab (the harness's
 * client-sent `target.request` is only its ordering barrier, refused like any
 * spoofed service push). A `target.selected` is judged against the bound
 * tab's *current document* as well as its credential: the navigation suite
 * proves a stale selection, a foreign origin and its near misses refused with
 * the session's target untouched, and a query or fragment variant of the
 * current document accepted.
 *
 * ## Fixtures and state
 *
 * One harness serves the whole file. Three copies of the `sample-project`
 * fixture each get a stand-in dev server through the real launcher, so the
 * three sessions have distinct, live dev-server origins on loopback:
 *
 * - `capturing` — planned, ready and holding an open capture, so every bind and
 *   every same-origin navigation must re-arm the page agent for that capture;
 * - `created` — freshly created, a second origin for matching and replacement;
 * - `generated` — a completed session with a stored capture, analysis, panel
 *   and progress history, for the reopen replay.
 *
 * Sessions are advanced through the in-process `SessionManager` rather than the
 * HTTP pipeline: the manager is the only writer of session state either way,
 * and driving it directly keeps the model provider, the code index and the
 * installer out of a suite about routing. Every test binds its own fresh tab
 * ids on its own DevTools connections, so no test depends on another's order.
 *
 * ## Restoration racing `session.end`
 *
 * One block builds `createBindingRoutes` directly, because the interleaving it
 * proves cannot be timed through a live socket: a drop suspended on its record
 * mirror while `SessionManager.end` commits. Each case gets a store of its own
 * in an `fs.mkdtemp` directory, with the real sessions and panels
 * repositories, session manager, progress emitter, reopener and client
 * registry over it and one registered DevTools connection; only the route's
 * manager port is the test's, forwarding `setBoundTab` to the real manager
 * unless the test holds the next call open and answers it by hand. An end
 * that committed while the mirror was held must stand — no row, no live
 * binding, no announcement, the drop answered as ignored — and the same
 * refused mirror on an open session must restore both stores exactly and
 * return the refusal.
 *
 * ## Vocabulary
 *
 * No binding reason, client kind or message type is spelled here: reasons and
 * kinds are destructured from protocol's ordered tuples, the replay's message
 * types from `REPLAY_MESSAGE_ORDER`, error codes from `errorCodeSchema`, and
 * every other message type is resolved from protocol's registry by the payload
 * schema it carries. Credentials come from the harness; nothing secret-shaped
 * appears in this file and `process.env` is never touched.
 */

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DORMANT_AGENT_HOOK_CONFIG,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  createAdapterRegistry,
  deriveAgentHookConfig,
  normalizePlan,
} from '@debuggen/instrumentation';
import type { InstrumentationActionType, InstrumentationPlan } from '@debuggen/instrumentation';
import { normalizePanel, parsePanelSpecInput } from '@debuggen/panel-schema';
import {
  ANALYSIS_VERSION_START,
  BINDING_REASONS,
  CLIENT_KINDS,
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  agentConfigPayloadSchema,
  createAnalysisResult,
  decodeMessage,
  errorCodeSchema,
  isMessageOfType,
  progressStageSchema,
  sessionBindPayloadSchema,
  sessionBoundPayloadSchema,
  sessionUnbindPayloadSchema,
  tabNavigatedPayloadSchema,
  targetRequestPayloadSchema,
  targetSelectedPayloadSchema,
} from '@debuggen/protocol';
import type {
  AgentConfigPayload,
  AnalysisResult,
  BoundTab,
  CreateEnvelopeOptions,
  ErrorPayload,
  HttpOperationId,
  MessagePayload,
  MessageType,
  PanelSpec,
  SelectedTarget,
  SessionBoundPayload,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, newPanelId, newSessionId } from '@debuggen/shared';
import type { CaptureId, Result, SessionId } from '@debuggen/shared';
import { REDACTION_MARKER, computeCaptureSummary, scrub } from '@debuggen/telemetry';

import type { DevtoolsPrincipal } from '../../src/server/auth.js';
import { SOCKET_READY_STATE_OPEN, createClientRegistry } from '../../src/server/clients.js';
import type { ClientRegistry, ClientSocket, TabBindingView } from '../../src/server/clients.js';
import { createBindingRoutes, redactSelectedTarget } from '../../src/server/routes/binding.js';
import type { BindingConnection, BindingRoutes } from '../../src/server/routes/binding.js';
import { createSessionManager } from '../../src/sessions/manager.js';
import type { SessionManager } from '../../src/sessions/manager.js';
import { createSessionProgress } from '../../src/sessions/progress.js';
import { REPLAY_MESSAGE_ORDER, createSessionReopener } from '../../src/sessions/reopen.js';
import { openStore } from '../../src/store/db.js';
import type { Store } from '../../src/store/db.js';
import { createPanelsRepo } from '../../src/store/panels-repo.js';
import { createSessionsRepo } from '../../src/store/sessions-repo.js';
import type { ProgressEntry, SessionsRepo, TabBinding } from '../../src/store/sessions-repo.js';
import {
  randomSecretLike,
  readFixtureJson,
  readTelemetryBatch,
  startHarness,
  waitFor,
  waitUntil,
} from './harness.js';
import type {
  CapturedLogRecord,
  DevtoolsConnection,
  DevtoolsCredential,
  FixtureProjectCopy,
  Harness,
  HarnessMessage,
  HarnessWsClient,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Protocol vocabulary, resolved rather than restated
 * ---------------------------------------------------------------------------------------------- */

/**
 * The binding reasons, in protocol's documented lifecycle order: establish,
 * replace, keep, drop, end. Destructuring the frozen tuple keeps every reason
 * out of this file's source text; the first bind of the suite announcing
 * `REASON_BOUND` is what proves the order is the one the service uses.
 */
const [REASON_BOUND, REASON_REPLACED, REASON_NAVIGATED, REASON_ORIGIN_CHANGED, REASON_UNBOUND] =
  BINDING_REASONS;

/** The two connection kinds this suite opens, from protocol's `CLIENT_KINDS`. */
const [CLIENT_VSCODE, CLIENT_DEVTOOLS] = CLIENT_KINDS;

/** The reopen replay's frames, in the order `src/sessions/reopen.ts` sends them. */
const [
  REPLAY_SESSION_UPDATED,
  REPLAY_SESSION_PROGRESS,
  REPLAY_ANALYSIS_COMPLETED,
  REPLAY_PANEL_GENERATED,
] = REPLAY_MESSAGE_ORDER;

/** Two of protocol's progress statuses, for the stored history of the replayed session. */
const [PROGRESS_RUNNING, PROGRESS_DONE] = PROGRESS_STATUSES;

/** The stage a reload during capture is reported under, from protocol's stage vocabulary. */
const PROGRESS_CAPTURE = progressStageSchema.enum.capture;

/**
 * The developer-facing entry AAP §0.5.5 prescribes for an application that
 * reloads while a capture is open.
 */
const RELOAD_NOTICE = 'Page reloaded during capture';

/** Protocol's closed error-code vocabulary, keyed by code. */
const CODES = errorCodeSchema.enum;

/** Protocol's payload registry, as a type. */
type PayloadRegistry = typeof MESSAGE_PAYLOAD_SCHEMAS;

/**
 * The message type whose registered payload schema is exactly `S` — mutual
 * assignability, so a schema that is merely a structural subset of another
 * never resolves to it. The same derivation `src/server/routes/binding.ts`
 * uses for the announcement it sends.
 */
type MessageTypeOfSchema<S> = {
  [K in MessageType]: [PayloadRegistry[K]] extends [S]
    ? [S] extends [PayloadRegistry[K]]
      ? K
      : never
    : never;
}[MessageType];

/**
 * Looks a message type up in protocol's registry by schema identity.
 *
 * @throws Error At module load when no message, or more than one, carries
 * `schema` — an impossible state for a schema protocol registers once.
 */
function messageTypeOf<S>(schema: S): MessageTypeOfSchema<S> {
  const isCarrier = (candidate: MessageType): candidate is MessageTypeOfSchema<S> =>
    MESSAGE_PAYLOAD_SCHEMAS[candidate] === schema;
  const carriers = MESSAGE_TYPES.filter(isCarrier);
  const [only] = carriers;
  if (only === undefined || carriers.length !== 1) {
    throw new Error(
      `Expected exactly one registered message type per payload schema, found ${String(carriers.length)}.`,
    );
  }
  return only;
}

const SESSION_BIND = messageTypeOf(sessionBindPayloadSchema);
const SESSION_BOUND = messageTypeOf(sessionBoundPayloadSchema);
const TAB_NAVIGATED = messageTypeOf(tabNavigatedPayloadSchema);
const SESSION_UNBIND = messageTypeOf(sessionUnbindPayloadSchema);
const AGENT_CONFIG = messageTypeOf(agentConfigPayloadSchema);
const TARGET_REQUEST = messageTypeOf(targetRequestPayloadSchema);
const TARGET_SELECTED = messageTypeOf(targetSelectedPayloadSchema);

/**
 * The editor's HTTP operation that makes the service push {@link TARGET_REQUEST}
 * to a session's bound tab. Protocol names the HTTP leg after the push it
 * produces, so it is derived from the message rather than spelled, and
 * `satisfies` proves the name is also an operation of the route table.
 */
const TARGET_REQUEST_OPERATION = TARGET_REQUEST satisfies HttpOperationId;

/**
 * The page-agent signals the capturing session's plan asks for: browser-tier
 * runtime actions only, so arming it touches no file and needs no dev-server
 * preload — this suite is about where `agent.config` lands, not what it enables.
 */
const BROWSER_ACTION_TYPES = [
  'interaction-tracking',
  'react-render-tracking',
  'fetch-tracking',
] as const satisfies readonly InstrumentationActionType[];

/**
 * The service's debug record for a closed WebSocket connection
 * (`src/server/ws.ts`). It is the only observable sign that the service has
 * processed a close, which the dropped-socket test waits for before it
 * reconnects so the reconnect cannot race the offline marking.
 */
const CONNECTION_CLOSED_LOG = 'a WebSocket connection closed';

/** The first tab id this suite hands out; every test takes fresh ones above it. */
const FIRST_TAB_ID = 4100;

/** The highest TCP port, bounding the "same host, other port" near miss. */
const MAX_PORT = 65_535;

/* -------------------------------------------------------------------------------------------------
 * Suite state
 * ---------------------------------------------------------------------------------------------- */

/** One fixture project, its live stand-in dev server, its session and its editor connection. */
interface ProjectUnderTest {
  readonly project: FixtureProjectCopy;
  /** The URL the launcher reported and the session recorded. */
  readonly devServerUrl: string;
  /** Its serialized origin — what a bind announces and what matching compares. */
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly sessionId: SessionId;
  /** The editor connection announcing this project, which hears the session's announcements. */
  readonly editor: HarnessWsClient;
}

/** The session that holds an open capture throughout the suite. */
interface CapturingProject extends ProjectUnderTest {
  readonly plan: InstrumentationPlan;
  readonly captureId: CaptureId;
}

/** The completed session whose stored state the reopen replay sends. */
interface GeneratedProject extends ProjectUnderTest {
  readonly analysis: AnalysisResult;
  readonly panel: PanelSpec;
}

interface SuiteProjects {
  readonly capturing: CapturingProject;
  readonly created: ProjectUnderTest;
  readonly generated: GeneratedProject;
}

let harness: Harness | undefined;
let projects: SuiteProjects | undefined;
let lastTabId = FIRST_TAB_ID;

/** The running harness. @throws Error When `beforeAll` did not start it. */
function service(): Harness {
  if (harness === undefined) {
    throw new Error('The binding suite did not start its harness.');
  }
  return harness;
}

/** The three sessions under test. @throws Error When `beforeAll` did not finish. */
function suite(): SuiteProjects {
  if (projects === undefined) {
    throw new Error('The binding suite did not finish creating its sessions.');
  }
  return projects;
}

/** A tab id no earlier test of this file has used. */
function freshTab(): number {
  lastTabId += 1;
  return lastTabId;
}

/* -------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */

/** The value of an `Ok`, or an error naming the step and the refusal's code. */
function unwrap<T>(result: Result<T, DebuggenError>, step: string): T {
  if (isErr(result)) {
    throw new Error(`${step} failed (${result.error.code}): ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.value;
}

/** An absolute page URL on a project's dev server. */
function pageOf(target: ProjectUnderTest, path: string): string {
  return new URL(path, target.origin).toString();
}

/** A selected-element descriptor on `url`, as the DevTools panel reports one. */
function targetOn(url: string): SelectedTarget {
  return {
    selector: 'main > section > button',
    tagName: 'button',
    text: 'Refresh',
    componentChain: [],
    url,
  };
}

/**
 * {@link targetOn} with a selector naming `probe`, so the session record shows
 * which of several selections it holds.
 */
function probeTarget(url: string, probe: string): SelectedTarget {
  return { ...targetOn(url), selector: `main > section > button[data-probe="${probe}"]` };
}

/** A DevTools connection for one inspected tab, with a fresh or a given credential. */
function openPanel(tabId: number, credential?: DevtoolsCredential): Promise<DevtoolsConnection> {
  return service().connectDevtools({ tabId, credential });
}

/** The session record as the manager holds it. */
function recordOf(sessionId: SessionId): SessionRecord {
  const record = unwrap(service().manager.get(sessionId), 'Reading the session record');
  if (record === undefined) {
    throw new Error(`Session ${sessionId} does not exist.`);
  }
  return record;
}

/** The durable binding row of a tab, through the harness's `SessionsRepo`. */
function storedBindingOfTab(tabId: number): TabBinding | undefined {
  return unwrap(service().repos.sessions.getBindingByTab(tabId), 'Reading a binding by tab');
}

/** The durable binding row of a session, through the harness's `SessionsRepo`. */
function storedBindingOfSession(sessionId: SessionId): TabBinding | undefined {
  return unwrap(
    service().repos.sessions.getBindingBySession(sessionId),
    'Reading a binding by session',
  );
}

/** One raw row of the `bindings` table. */
interface BindingRow {
  readonly tabId: number;
  readonly sessionId: string;
  readonly url: string;
}

/**
 * The whole `bindings` table, read raw and ordered by tab. The repository
 * accessors answer one key at a time; this is what shows that no stray row —
 * a displaced tab, a duplicate for a session — survived a change.
 */
function bindingRows(): BindingRow[] {
  const rows = service()
    .store.statement('SELECT tab_id, session_id, url FROM bindings ORDER BY tab_id')
    .all();
  return rows.map((row) => {
    const tabId = row['tab_id'];
    const sessionId = row['session_id'];
    const url = row['url'];
    if (typeof tabId !== 'number' || typeof sessionId !== 'string' || typeof url !== 'string') {
      throw new Error('A bindings row does not have the shape the schema declares.');
    }
    return { tabId, sessionId, url };
  });
}

/** The rows that mention a tab or a session. */
function rowsFor(filter: { readonly tabId?: number; readonly sessionId?: string }): BindingRow[] {
  return bindingRows().filter(
    (row) => row.tabId === filter.tabId || row.sessionId === filter.sessionId,
  );
}

/** The stored `sessions.record` document of one session, as the raw JSON text the row holds. */
function storedRecordJson(sessionId: SessionId): string {
  const row = service().store.statement('SELECT record FROM sessions WHERE id = ?').get(sessionId);
  const record = row?.['record'];
  if (typeof record !== 'string') {
    throw new Error(`Session ${sessionId} has no stored record document.`);
  }
  return record;
}

/**
 * The stored `sessions.record` document and every `bindings` row as raw text —
 * the view in which a value the service was meant to redact would show up
 * whichever column or field it leaked into.
 */
function storedText(sessionId: SessionId): string {
  return `${storedRecordJson(sessionId)}\n${JSON.stringify(bindingRows())}`;
}

/** How many record-write failures this file has injected, for unique trigger names. */
let injectedFailures = 0;

/** The shape of every session id the service mints, checked before one is spelled into DDL. */
const INJECTABLE_ID = /^[A-Za-z0-9_-]+$/u;

/**
 * Runs `body` while every update of one session's row is refused by a
 * temporary trigger on the service's own store connection — a real failure of
 * the session manager's record write (its upsert takes the `UPDATE` path for
 * an existing session), not a stub. The trigger is dropped whatever `body`
 * does, so no later test inherits it.
 */
async function withRecordWritesRefused<T>(
  sessionId: SessionId,
  body: () => Promise<T>,
): Promise<T> {
  if (!INJECTABLE_ID.test(sessionId)) {
    throw new Error('A session id with unexpected characters cannot be named in a trigger.');
  }
  injectedFailures += 1;
  const trigger = `binding_suite_refuse_${String(injectedFailures)}`;
  const { db } = service().store;
  db.exec(
    `CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE ON sessions WHEN OLD.id = '${sessionId}'
     BEGIN SELECT RAISE(ABORT, 'injected record write failure'); END`,
  );
  try {
    return await body();
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS temp.${trigger}`);
  }
}

/**
 * Asserts the binding route's log since record index `from` shows a clean
 * compensation: no `error` record (a compensation step that failed), no
 * displaced binding left without its live half, and no URL of any session's
 * origin — the route logs ids, reasons and codes only.
 */
function expectCleanCompensation(from: number): void {
  const records = service()
    .logger.records.slice(from)
    .filter((record) => record.fields['subsystem'] === 'binding');
  expect(records.length, 'the refused bind was logged').toBeGreaterThan(0);
  expect(records.filter((record) => record.level === 'error')).toEqual([]);
  expect(records.filter((record) => record.message.includes('re-established'))).toEqual([]);
  const { capturing, created, generated } = suite();
  for (const record of records) {
    for (const origin of [capturing.origin, created.origin, generated.origin]) {
      expect(record.line).not.toContain(origin);
    }
  }
}

/** The id of the session's open capture window, if it has one. */
function openCaptureId(sessionId: SessionId): string | undefined {
  const active = unwrap(
    service().repos.sessions.getActiveCapture(sessionId),
    'Reading the open capture',
  );
  return active?.capture.id;
}

/** The session's stored progress history, in stored order. */
function progressOf(sessionId: SessionId): ProgressEntry[] {
  return unwrap(service().repos.sessions.listProgress(sessionId), 'Reading the progress history');
}

/** The frames of one type a client received at or after transcript index `from`. */
function framesSince<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  from: number,
): HarnessMessage<K>[] {
  return client.received
    .slice(from)
    .flatMap((message) => (isMessageOfType(message, type) ? [message] : []));
}

/** Every message type a client received at or after `from`, in arrival order. */
function typesSince(client: HarnessWsClient, from: number): MessageType[] {
  return client.received.slice(from).map((message) => message.type);
}

/**
 * The `session.bound` announcements a client received at or after `from`,
 * each validated by protocol's schema — an announcement that does not parse
 * fails the test here rather than being compared field by field.
 */
function announcementsSince(client: HarnessWsClient, from: number): SessionBoundPayload[] {
  return framesSince(client, SESSION_BOUND, from).map((message) =>
    sessionBoundPayloadSchema.parse(message.payload),
  );
}

/** What one frame sent through {@link sendSettled} produced. */
interface Settled {
  /** The frame's envelope id, which any `error` reply carries as its `ref`. */
  readonly id: string;
  /** The client's transcript length before the frame was sent. */
  readonly mark: number;
  /** Every `error` the service answered the frame with. */
  readonly errors: readonly ErrorPayload[];
}

/**
 * Sends one frame and waits for the harness's ordering barrier behind it, so
 * the service has finished handling the frame — and every frame the handling
 * pushed to this connection has arrived — before anything is read. `options`
 * sets envelope fields, such as the acting `tabId` a multiplexing DevTools
 * connection names on every frame it sends for a tab.
 */
async function sendSettled<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  payload: MessagePayload<K>,
  options?: CreateEnvelopeOptions,
): Promise<Settled> {
  const mark = client.received.length;
  const receipt = client.send(type, payload, options);
  if (isErr(receipt.result)) {
    throw new Error(`${type} could not be sent: ${receipt.result.error.message}`);
  }
  const answered = await client.flush();
  if (!answered) {
    throw new Error(`The connection closed before ${type} was handled: ${client.describe()}`);
  }
  return { id: receipt.id, mark, errors: client.errorsFor(receipt.id) };
}

/** What a `session.bind` announces: a tab, its document URL and, optionally, the session asked for. */
interface BindRequest {
  readonly tabId: number;
  readonly url: string;
  readonly sessionId?: string | undefined;
  /** Overrides the origin derived from `url`, to announce one that disagrees with it. */
  readonly origin?: string | undefined;
}

/** Sends a schema-valid `session.bind` and settles it. */
function bind(client: HarnessWsClient, request: BindRequest): Promise<Settled> {
  const payload = sessionBindPayloadSchema.parse({
    tabId: request.tabId,
    url: request.url,
    origin: request.origin ?? new URL(request.url).origin,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  });
  return sendSettled(client, SESSION_BIND, payload);
}

/** Sends a schema-valid `target.selected` of `target` for `sessionId` and settles it. */
function select(
  client: HarnessWsClient,
  sessionId: SessionId,
  target: SelectedTarget,
): Promise<Settled> {
  return sendSettled(
    client,
    TARGET_SELECTED,
    targetSelectedPayloadSchema.parse({ sessionId, target }),
  );
}

/**
 * Asserts a bind succeeded and returns its establishment announcement: the
 * `session.bound` for exactly this session and tab with reason `bound`, which
 * the service sends after every `replaced` announcement the bind caused.
 */
function expectEstablished(
  client: HarnessWsClient,
  settled: Settled,
  sessionId: SessionId,
  tabId: number,
): SessionBoundPayload {
  expect(settled.errors, `the bind was refused: ${JSON.stringify(settled.errors)}`).toEqual([]);
  const established = announcementsSince(client, settled.mark).filter(
    (payload) =>
      payload.sessionId === sessionId && payload.tabId === tabId && payload.reason === REASON_BOUND,
  );
  expect(
    established,
    `no establishment for tab ${String(tabId)}: ${client.describe()}`,
  ).toHaveLength(1);
  const [only] = established;
  if (only === undefined) {
    throw new Error('Unreachable: the establishment announcement was counted but is missing.');
  }
  return only;
}

/** Asserts a frame was refused with exactly one typed `error` naming it and `code`. */
function expectRefused(settled: Settled, code: ErrorPayload['code']): ErrorPayload {
  expect(settled.errors).toHaveLength(1);
  const [refusal] = settled.errors;
  if (refusal === undefined) {
    throw new Error('Unreachable: the refusal was counted but is missing.');
  }
  expect(refusal).toMatchObject({ code, ref: settled.id });
  expect(refusal.message.trim().length).toBeGreaterThan(0);
  return refusal;
}

/** Asserts a refusal quotes nothing of the page it refused: neither its host nor its path. */
function expectNoUrlIn(refusal: ErrorPayload, url: string): void {
  const { host, pathname } = new URL(url);
  const text = JSON.stringify(refusal);
  expect(text).not.toContain(host);
  expect(text).not.toContain(pathname);
}

/**
 * Asserts an `agent.config` arms the page agent for the capturing session's
 * open capture: a schema-valid payload naming the session and the same
 * `captureId`, carrying the hooks the stored plan derives — never the dormant
 * set.
 */
function expectArmedFor(payload: AgentConfigPayload, target: CapturingProject): void {
  const config = agentConfigPayloadSchema.parse(payload);
  expect(config).toEqual({
    sessionId: target.sessionId,
    captureId: target.captureId,
    hooks: deriveAgentHookConfig(target.plan.instrumentationTargets),
  });
  expect(config.hooks).not.toEqual(DORMANT_AGENT_HOOK_CONFIG);
}

/** Waits until the capturing session's agent has been armed on `client` at or after `from`. */
function waitForArming(
  client: HarnessWsClient,
  target: CapturingProject,
  from: number,
): Promise<HarnessMessage<typeof AGENT_CONFIG>> {
  return waitFor(
    client,
    AGENT_CONFIG,
    (message, index) => index >= from && message.payload.captureId === target.captureId,
  );
}

/** Settles several connections in turn, so every frame already pushed to them has arrived. */
async function settleAll(...clients: readonly HarnessWsClient[]): Promise<void> {
  for (const client of clients) {
    const answered = await client.flush();
    if (!answered) {
      throw new Error(`A connection closed while it was being settled: ${client.describe()}`);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Near-miss origins
 * ---------------------------------------------------------------------------------------------- */

/**
 * Documents whose origin is *almost* a session's: the realistic regressions of
 * an origin check done by prefix, by host only or by port only. Each must be
 * treated as a different origin — for matching a bind and for keeping a
 * binding across a navigation alike.
 */
interface NearMiss {
  readonly label: string;
  /** A page URL near `target`'s origin; `taken` holds every session's port. */
  readonly page: (target: ProjectUnderTest, taken: ReadonlySet<number>) => string;
}

/** A port on the same host that no session of this suite serves. */
function portNear(port: number, taken: ReadonlySet<number>): number {
  for (let offset = 1; offset < MAX_PORT; offset += 1) {
    for (const candidate of [port + offset, port - offset]) {
      if (candidate > 0 && candidate <= MAX_PORT && !taken.has(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error('No free port exists near the dev server.');
}

const NEAR_MISSES: readonly NearMiss[] = [
  {
    label: 'the same host on another port',
    page: (target, taken) =>
      `http://${target.hostname}:${String(portNear(target.port, taken))}/reports`,
  },
  {
    // `http://127.0.0.1:4123` is a string prefix of `http://127.0.0.1:41234`:
    // what `devServerUrl.startsWith(origin)` would wrongly accept.
    label: 'an origin that is a string prefix of the session origin',
    page: (target) => `${target.origin.slice(0, -1)}/reports`,
  },
  {
    // `127.0.0.10` starts with `127.0.0.1`: what a host prefix match would accept.
    label: 'a host that the session host is a string prefix of',
    page: (target) => `http://${target.hostname}0:${String(target.port)}/reports`,
  },
  {
    // `127.0.0` is a textual prefix of `127.0.0.1`; WHATWG parses it as
    // `127.0.0.0`, so the serialized origins differ as they must.
    label: 'a host that is a string prefix of the session host',
    page: (target) =>
      `http://${target.hostname.slice(0, target.hostname.lastIndexOf('.'))}:${String(target.port)}/reports`,
  },
  {
    label: 'the same host and port over https',
    page: (target) => `https://${target.hostname}:${String(target.port)}/reports`,
  },
];

/** Every port a session of this suite is served on. */
function takenPorts(): ReadonlySet<number> {
  const { capturing, created, generated } = suite();
  return new Set([capturing.port, created.port, generated.port]);
}

/* -------------------------------------------------------------------------------------------------
 * Setup
 * ---------------------------------------------------------------------------------------------- */

/** Launches a project's stand-in dev server through the real launcher and creates its session. */
async function startProject(
  running: Harness,
  project: FixtureProjectCopy,
  question: string,
): Promise<ProjectUnderTest> {
  const launched = unwrap(
    await running.launchDevServer(project.root),
    `Launching the dev server of ${project.root}`,
  );
  const session = unwrap(
    await running.manager.create({
      projectRoot: project.root,
      question,
      devServerUrl: launched.devServerUrl,
    }),
    'Creating a session',
  );
  const editor = await running.editor(project.root);
  const parsed = new URL(launched.devServerUrl);
  return {
    project,
    devServerUrl: launched.devServerUrl,
    origin: parsed.origin,
    hostname: parsed.hostname,
    port: Number(parsed.port),
    sessionId: session.id,
    editor,
  };
}

/** Moves a session through `statuses` in order, failing on the first refusal. */
async function advance(
  running: Harness,
  sessionId: SessionId,
  statuses: readonly SessionStatus[],
): Promise<void> {
  for (const status of statuses) {
    unwrap(await running.manager.transitionTo(sessionId, status), `Moving to ${status}`);
  }
}

/**
 * Plans the browser-tier runtime signals, reaches `ready` and opens a capture
 * window — the state in which a newly bound tab or a reloaded document must be
 * re-armed for the same capture (AAP §0.5.5, "Page reloaded during capture").
 */
async function openCapture(running: Harness, target: ProjectUnderTest): Promise<CapturingProject> {
  await advance(running, target.sessionId, ['understanding', 'investigating', 'planning']);
  const plan = unwrap(
    normalizePlan(
      {
        objective: 'Find where the time of one interaction is spent.',
        capture: ['interaction timing', 'React renders', 'fetch calls'],
        instrumentationTargets: BROWSER_ACTION_TYPES.map((type) => ({
          file: TARGETLESS_FILE,
          symbol: TARGETLESS_SYMBOL,
          type,
        })),
      },
      { sessionId: target.sessionId, planVersion: 1, resolver: createAdapterRegistry() },
    ),
    'Normalizing the plan',
  );
  const recorded = unwrap(
    await running.manager.recordPlan(target.sessionId, plan),
    'Recording the plan',
  );
  await advance(running, target.sessionId, ['instrumenting']);
  unwrap(
    await running.manager.transitionTo(target.sessionId, 'ready', { readinessSatisfied: true }),
    'Moving to ready',
  );
  const capture = unwrap(
    await running.manager.startCapture(target.sessionId),
    'Opening the capture window',
  );
  return { ...target, plan: recorded.plan, captureId: capture.captureId };
}

/**
 * Completes a session from stored evidence: a capture holding the committed
 * cross-tier batch, an analysis citing one of its events, the committed valid
 * panel normalized against that analysis, a short progress history, and the
 * guarded move to `generated`. Everything is written through the service's own
 * repositories and manager, exactly as the pipeline would leave it.
 */
async function completeSession(
  running: Harness,
  target: ProjectUnderTest,
): Promise<GeneratedProject> {
  const { sessionId } = target;
  const { captureId } = await openCapture(running, target);

  const stored = unwrap(
    running.repos.telemetry.insertMany(
      readTelemetryBatch('telemetry-trace-cross-tier.json').map((event) => ({
        ...event,
        sessionId,
        captureId,
      })),
    ),
    'Storing the captured events',
  );
  const summary = computeCaptureSummary(stored.events, { captureId, sessionId });
  unwrap(
    await running.manager.stopCapture(sessionId, { summary, next: 'analyzing' }),
    'Closing the capture window',
  );

  const [slowest] = [...stored.events].sort((left, right) => right.duration - left.duration);
  if (slowest === undefined) {
    throw new Error('The committed cross-tier batch is empty.');
  }
  const analysis = unwrap(
    running.repos.panels.insertAnalysis(
      createAnalysisResult(
        {
          observed: [
            {
              statement: 'One span accounts for most of the recorded interaction time.',
              evidence: [{ eventId: slowest.id }],
            },
          ],
          likelyCauses: [],
        },
        {
          sessionId,
          captureId,
          analysisVersion: ANALYSIS_VERSION_START,
          createdAt: running.now(),
          metrics: summary.metrics,
        },
      ),
    ),
    'Storing the analysis',
  );
  const input = unwrap(
    parsePanelSpecInput(readFixtureJson('model-output-valid-panel.json')),
    'Parsing the committed panel input',
  );
  const panel = unwrap(
    running.repos.panels.insertPanel(
      normalizePanel(input, analysis, { id: newPanelId(), sessionId, panelVersion: 1 }),
      { captureId },
    ),
    'Storing the panel',
  );

  for (const [index, stage] of PROGRESS_STAGES.slice(0, 3).entries()) {
    for (const status of [PROGRESS_RUNNING, PROGRESS_DONE]) {
      unwrap(
        running.repos.sessions.appendProgress({
          sessionId,
          stage,
          status,
          message: `Stage ${String(index + 1)} (${stage}) is ${status}.`,
        }),
        'Storing a progress row',
      );
    }
  }

  unwrap(
    await running.manager.transitionTo(sessionId, 'generated', { analysis, panel }),
    'Moving to generated',
  );
  return { ...target, analysis, panel };
}

beforeAll(async () => {
  const running = await startHarness();
  harness = running;
  const second = await running.copyFixtureProject();
  const third = await running.copyFixtureProject();

  const capturing = await openCapture(
    running,
    await startProject(running, running.requireProject(), 'Why does the report take so long?'),
  );
  const created = await startProject(running, second, 'Why does this list render so often?');
  const generated = await completeSession(
    running,
    await startProject(running, third, 'Why did this request run twice?'),
  );

  const origins = new Set([capturing.origin, created.origin, generated.origin]);
  if (origins.size !== 3) {
    throw new Error('The three stand-in dev servers must serve three distinct origins.');
  }
  projects = { capturing, created, generated };
});

afterAll(async () => {
  await harness?.assertNoLeaks();
});

/* -------------------------------------------------------------------------------------------------
 * session.bind
 * ---------------------------------------------------------------------------------------------- */

describe(SESSION_BIND, () => {
  it('binds a tab to the session whose dev-server origin matches and answers session.bound { sessionId, tabId, url }', async () => {
    const { capturing } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    expect(client.identity.client).toBe(CLIENT_DEVTOOLS);
    expect(capturing.editor.identity.client).toBe(CLIENT_VSCODE);

    const url = pageOf(capturing, '/reports');
    const editorMark = capturing.editor.received.length;
    const bound = await service().bindTab(
      client,
      sessionBindPayloadSchema.parse({ tabId, url, origin: capturing.origin }),
    );
    if (isErr(bound)) {
      throw new Error(`The bind was refused (${bound.error.code}): ${bound.error.message}`);
    }

    // The announcement: the base payload of AAP §0.4.2 plus the establishing reason,
    // routed on the envelope to the session it names.
    expect(sessionBoundPayloadSchema.parse(bound.value.payload)).toEqual({
      sessionId: capturing.sessionId,
      tabId,
      url,
      reason: REASON_BOUND,
    });
    expect(bound.value.sessionId).toBe(capturing.sessionId);

    // The durable row, the record mirror and the live routing all agree.
    expect(storedBindingOfTab(tabId)).toMatchObject({
      sessionId: capturing.sessionId,
      tab: { tabId, url },
    });
    expect(storedBindingOfSession(capturing.sessionId)?.tab).toEqual({ tabId, url });
    expect(rowsFor({ tabId, sessionId: capturing.sessionId })).toEqual([
      { tabId, sessionId: capturing.sessionId, url },
    ]);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId, url });

    // The session's editor hears the establishment too.
    await waitFor(
      capturing.editor,
      SESSION_BOUND,
      (message, index) =>
        index >= editorMark &&
        message.payload.tabId === tabId &&
        message.payload.reason === REASON_BOUND,
    );

    // The open capture continues in the newly bound tab.
    const armed = await waitForArming(client, capturing, 0);
    expectArmedFor(armed.payload, capturing);
  });

  it('binds to a named session whose origin matches, and refuses a named session served from another origin', async () => {
    const { capturing, created } = suite();

    const namedTab = freshTab();
    const named = await openPanel(namedTab);
    const url = pageOf(created, '/dashboard');
    const bound = await bind(named.client, {
      tabId: namedTab,
      url,
      sessionId: created.sessionId,
    });
    expect(expectEstablished(named.client, bound, created.sessionId, namedTab)).toEqual({
      sessionId: created.sessionId,
      tabId: namedTab,
      url,
      reason: REASON_BOUND,
    });
    expect(storedBindingOfTab(namedTab)).toMatchObject({
      sessionId: created.sessionId,
      tab: { tabId: namedTab, url },
    });

    // Naming a session does not override the origin check: the page is served
    // by the second project's dev server, the session asked for is the first's.
    const rowsBefore = bindingRows();
    const wrongTab = freshTab();
    const wrong = await openPanel(wrongTab);
    const mismatch = await bind(wrong.client, {
      tabId: wrongTab,
      url: pageOf(created, '/dashboard'),
      sessionId: capturing.sessionId,
    });
    expectRefused(mismatch, CODES.TAB_NOT_BOUND);
    expect(announcementsSince(wrong.client, mismatch.mark)).toEqual([]);
    expect(storedBindingOfTab(wrongTab)).toBeUndefined();
    expect(bindingRows()).toEqual(rowsBefore);

    // A named session that does not exist is a typed refusal, not a fallback to origin matching.
    const missing = await bind(wrong.client, {
      tabId: wrongTab,
      url: pageOf(capturing, '/reports'),
      sessionId: newSessionId(),
    });
    expectRefused(missing, CODES.SESSION_NOT_FOUND);
    expect(bindingRows()).toEqual(rowsBefore);

    // Neither refusal cost the connection anything.
    expect(wrong.client.authenticated).toBe(true);
    expect(wrong.client.closes).toEqual([]);
  });

  it('answers a bind from an origin no session serves with a typed error rather than an arbitrary binding', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const rowsBefore = bindingRows();

    for (const nearMiss of NEAR_MISSES) {
      const page = nearMiss.page(capturing, takenPorts());
      const byOrigin = await bind(client, { tabId, url: page });
      expect(byOrigin.errors, nearMiss.label).toHaveLength(1);
      expectRefused(byOrigin, CODES.SESSION_NOT_FOUND);

      const byName = await bind(client, { tabId, url: page, sessionId: capturing.sessionId });
      expect(byName.errors, nearMiss.label).toHaveLength(1);
      expectRefused(byName, CODES.TAB_NOT_BOUND);
    }

    // An announced origin that is not the URL's own is refused outright, even
    // though both the URL's origin and the announced one are served by a session.
    const disagreeing = await bind(client, {
      tabId,
      url: pageOf(capturing, '/reports'),
      origin: created.origin,
    });
    expectRefused(disagreeing, CODES.PROTOCOL_INVALID_MESSAGE);

    expect(announcementsSince(client, 0)).toEqual([]);
    expect(storedBindingOfTab(tabId)).toBeUndefined();
    expect(bindingRows()).toEqual(rowsBefore);
    expect(client.authenticated).toBe(true);
  });

  it('records the binding against the connection principal, not against anything a frame or a hello claims', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const owner = await openPanel(tabId);
    const url = pageOf(created, '/orders');
    expectEstablished(
      owner.client,
      await bind(owner.client, { tabId, url }),
      created.sessionId,
      tabId,
    );
    const rowsBefore = bindingRows();

    // Another extension's credential, on a connection whose hello claims the very same tab.
    const intruder = await openPanel(tabId);
    expect(intruder.credential.extensionId).not.toBe(owner.credential.extensionId);
    expect(intruder.client.identity.tabId).toBe(tabId);

    expectRefused(
      await sendSettled(
        intruder.client,
        SESSION_UNBIND,
        sessionUnbindPayloadSchema.parse({ tabId }),
      ),
      CODES.TAB_NOT_BOUND,
    );
    expectRefused(
      await sendSettled(
        intruder.client,
        TAB_NAVIGATED,
        tabNavigatedPayloadSchema.parse({ tabId, url: pageOf(capturing, '/reports') }),
      ),
      CODES.TAB_NOT_BOUND,
    );
    expectRefused(
      await sendSettled(
        intruder.client,
        TARGET_SELECTED,
        targetSelectedPayloadSchema.parse({ sessionId: created.sessionId, target: targetOn(url) }),
      ),
      CODES.TAB_NOT_BOUND,
    );
    // Nor can it claim the session by naming it from a page of another origin —
    // for its own hello's tab, so the origin rule is what refuses it.
    expectRefused(
      await bind(intruder.client, {
        tabId,
        url: pageOf(capturing, '/reports'),
        sessionId: created.sessionId,
      }),
      CODES.TAB_NOT_BOUND,
    );
    expect(announcementsSince(intruder.client, 0)).toEqual([]);
    expect(bindingRows()).toEqual(rowsBefore);

    // An editor credential is not a binding principal at all.
    const editorBind = await bind(created.editor, { tabId: freshTab(), url });
    expectRefused(editorBind, CODES.UNAUTHORIZED);
    expect(bindingRows()).toEqual(rowsBefore);

    // The owner's credential alone is not authority: it is shared by every tab
    // the paired extension inspects. A second connection of that credential
    // announcing another tab in its hello acts for that tab only, so it may not
    // act on the session — not by default, and not by naming the bound tab on
    // the frame against its own hello.
    const sibling = await openPanel(freshTab(), owner.credential);
    const target = targetOn(url);
    const selection = targetSelectedPayloadSchema.parse({ sessionId: created.sessionId, target });
    expectRefused(
      await sendSettled(sibling.client, TARGET_SELECTED, selection),
      CODES.TAB_NOT_BOUND,
    );
    expectRefused(
      await sendSettled(sibling.client, TARGET_SELECTED, selection, { tabId }),
      CODES.TAB_NOT_BOUND,
    );
    expect(recordOf(created.sessionId).target).not.toEqual(target);

    // A connection of the owner's credential for the bound tab itself — the
    // service worker reconnecting — acts on the session without a re-bind.
    const reconnected = await openPanel(tabId, owner.credential);
    const ownerMark = owner.client.received.length;
    const selected = await sendSettled(reconnected.client, TARGET_SELECTED, selection);
    expect(selected.errors).toEqual([]);
    expect(recordOf(created.sessionId).target).toEqual(target);

    // The connection that made the binding still carries the session's fan-out.
    await waitFor(
      owner.client,
      REPLAY_SESSION_UPDATED,
      (message, index) =>
        index >= ownerMark && message.payload.session.target?.selector === target.selector,
    );
    expect(storedBindingOfTab(tabId)).toMatchObject({ sessionId: created.sessionId });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Replacement: one tab per session, one session per tab
 * ---------------------------------------------------------------------------------------------- */

describe('replacement', () => {
  it('replaces a session’s bound tab with a second tab, announces it, and moves the tab-bound deliveries', async () => {
    const { capturing } = suite();
    const firstTab = freshTab();
    const secondTab = freshTab();
    const first = await openPanel(firstTab);
    const second = await openPanel(secondTab);
    const firstUrl = pageOf(capturing, '/reports');
    const secondUrl = pageOf(capturing, '/reports/weekly');

    const firstBind = await bind(first.client, { tabId: firstTab, url: firstUrl });
    expectEstablished(first.client, firstBind, capturing.sessionId, firstTab);
    await waitForArming(first.client, capturing, firstBind.mark);

    const firstMark = first.client.received.length;
    const editorMark = capturing.editor.received.length;
    const secondBind = await bind(second.client, { tabId: secondTab, url: secondUrl });
    expectEstablished(second.client, secondBind, capturing.sessionId, secondTab);
    await settleAll(first.client, capturing.editor);

    // The replacement is announced to the displaced panel and to the session's
    // editor — the displaced binding first, then the new one.
    const displaced = {
      sessionId: capturing.sessionId,
      tabId: firstTab,
      url: firstUrl,
      reason: REASON_REPLACED,
    };
    expect(announcementsSince(first.client, firstMark)).toContainEqual(displaced);
    expect(announcementsSince(capturing.editor, editorMark)).toEqual([
      displaced,
      { sessionId: capturing.sessionId, tabId: secondTab, url: secondUrl, reason: REASON_BOUND },
    ]);

    // Exactly one row for the session, and it is the second tab's.
    expect(storedBindingOfTab(firstTab)).toBeUndefined();
    expect(storedBindingOfSession(capturing.sessionId)?.tab).toEqual({
      tabId: secondTab,
      url: secondUrl,
    });
    expect(rowsFor({ tabId: firstTab, sessionId: capturing.sessionId })).toEqual([
      { tabId: secondTab, sessionId: capturing.sessionId, url: secondUrl },
    ]);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId: secondTab, url: secondUrl });

    // The open capture's agent configuration now reaches the second tab, and the
    // displaced panel hears nothing but binding announcements.
    const rearmed = framesSince(second.client, AGENT_CONFIG, secondBind.mark);
    expect(rearmed).toHaveLength(1);
    const [config] = rearmed;
    if (config === undefined) {
      throw new Error('Unreachable: the re-arm was counted but is missing.');
    }
    expectArmedFor(config.payload, capturing);
    expect(new Set(typesSince(first.client, firstMark))).toEqual(new Set([SESSION_BOUND]));

    // A later fan-out of the session reaches the second tab's connection only.
    const firstLater = first.client.received.length;
    const secondLater = second.client.received.length;
    unwrap(
      await service().manager.patch(capturing.sessionId, { target: targetOn(secondUrl) }),
      'Patching the session',
    );
    await waitFor(second.client, REPLAY_SESSION_UPDATED, (_message, index) => index >= secondLater);
    await settleAll(first.client);
    expect(typesSince(first.client, firstLater)).toEqual([]);

    // The editor's element request follows the binding too: the service asks
    // the replacing tab, names it in the reply, and never asks the displaced one.
    const firstAsked = first.client.received.length;
    const secondAsked = second.client.received.length;
    const asked = unwrap(
      await service()
        .http()
        .request(TARGET_REQUEST_OPERATION, { params: { id: capturing.sessionId }, body: {} }),
      'Requesting a target of the bound tab',
    );
    expect(asked).toEqual({ sessionId: capturing.sessionId, tabId: secondTab });
    const request = await waitFor(
      second.client,
      TARGET_REQUEST,
      (_message, index) => index >= secondAsked,
    );
    expect(targetRequestPayloadSchema.parse(request.payload)).toEqual({
      sessionId: capturing.sessionId,
    });
    await settleAll(first.client, second.client);
    expect(framesSince(second.client, TARGET_REQUEST, secondAsked)).toHaveLength(1);
    expect(typesSince(first.client, firstAsked)).toEqual([]);

    // And the displaced panel may no longer act on the session.
    expectRefused(
      await sendSettled(
        first.client,
        TARGET_SELECTED,
        targetSelectedPayloadSchema.parse({
          sessionId: capturing.sessionId,
          target: targetOn(firstUrl),
        }),
      ),
      CODES.TAB_NOT_BOUND,
    );
  });

  it('moves a tab to a second session, announcing that the first session lost it', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const firstUrl = pageOf(capturing, '/reports');
    const secondUrl = pageOf(created, '/dashboard');

    expectEstablished(
      client,
      await bind(client, { tabId, url: firstUrl }),
      capturing.sessionId,
      tabId,
    );

    const firstEditorMark = capturing.editor.received.length;
    const secondEditorMark = created.editor.received.length;
    const moved = await bind(client, { tabId, url: secondUrl });
    expectEstablished(client, moved, created.sessionId, tabId);
    await settleAll(capturing.editor, created.editor);

    // The panel hears that the first session lost its tab before it hears the new binding.
    const lost = {
      sessionId: capturing.sessionId,
      tabId,
      url: firstUrl,
      reason: REASON_REPLACED,
    };
    const joined = { sessionId: created.sessionId, tabId, url: secondUrl, reason: REASON_BOUND };
    const heard = announcementsSince(client, moved.mark);
    const lostAt = heard.findIndex((payload) => isDeepStrictEqual(payload, lost));
    const joinedAt = heard.findIndex((payload) => isDeepStrictEqual(payload, joined));
    expect(lostAt, JSON.stringify(heard)).toBeGreaterThanOrEqual(0);
    expect(joinedAt, JSON.stringify(heard)).toBeGreaterThan(lostAt);

    // Each session's editor hears its own side of the move.
    expect(announcementsSince(capturing.editor, firstEditorMark)).toContainEqual(lost);
    expect(announcementsSince(created.editor, secondEditorMark)).toContainEqual(joined);

    // The tab's one row now names the second session; the first holds none.
    expect(rowsFor({ tabId })).toEqual([{ tabId, sessionId: created.sessionId, url: secondUrl }]);
    expect(storedBindingOfSession(capturing.sessionId)).toBeUndefined();
    expect(storedBindingOfSession(created.sessionId)?.tab).toEqual({ tabId, url: secondUrl });
    expect(recordOf(capturing.sessionId).boundTab).toBeUndefined();
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId, url: secondUrl });

    // Losing its tab neither ended the first session nor closed its capture,
    // and the second session, which captures nothing, armed no agent.
    expect(openCaptureId(capturing.sessionId)).toBe(capturing.captureId);
    expect(framesSince(client, AGENT_CONFIG, moved.mark)).toEqual([]);
  });

  it('treats a redundant re-bind of the same tab and session as idempotent', async () => {
    const { created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(created, '/orders');

    expectEstablished(client, await bind(client, { tabId, url }), created.sessionId, tabId);
    const editorMark = created.editor.received.length;

    const again = await bind(client, { tabId, url });
    expect(expectEstablished(client, again, created.sessionId, tabId)).toEqual({
      sessionId: created.sessionId,
      tabId,
      url,
      reason: REASON_BOUND,
    });
    await settleAll(created.editor);

    // No spurious replacement anywhere, and still exactly one row.
    expect(
      announcementsSince(client, again.mark).filter((payload) => payload.reason !== REASON_BOUND),
    ).toEqual([]);
    expect(
      announcementsSince(created.editor, editorMark).filter(
        (payload) => payload.reason === REASON_REPLACED,
      ),
    ).toEqual([]);
    expect(rowsFor({ tabId, sessionId: created.sessionId })).toEqual([
      { tabId, sessionId: created.sessionId, url },
    ]);
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId, url });
  });

  it('refuses a replacement whose record mirror fails, restores the displaced binding everywhere and announces nothing', async () => {
    const { capturing } = suite();
    const firstTab = freshTab();
    const secondTab = freshTab();
    const first = await openPanel(firstTab);
    const second = await openPanel(secondTab);
    const firstUrl = pageOf(capturing, '/reports');

    const firstBind = await bind(first.client, { tabId: firstTab, url: firstUrl });
    expectEstablished(first.client, firstBind, capturing.sessionId, firstTab);
    await waitForArming(first.client, capturing, firstBind.mark);
    const rowsBefore = bindingRows();
    const storedBefore = storedBindingOfTab(firstTab);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId: firstTab, url: firstUrl });
    const firstMark = first.client.received.length;
    const editorMark = capturing.editor.received.length;
    const logMark = service().logger.records.length;

    // The second tab's bind reaches the record mirror, which the store refuses.
    const refused = await withRecordWritesRefused(capturing.sessionId, () =>
      bind(second.client, { tabId: secondTab, url: pageOf(capturing, '/reports/weekly') }),
    );
    expectRefused(refused, CODES.STORE_ERROR);
    await settleAll(first.client, capturing.editor);
    expectCleanCompensation(logMark);

    // Nothing was announced: no replacement to the displaced panel or the
    // editor, no establishment, no re-arm of the refused tab.
    expect(announcementsSince(first.client, firstMark)).toEqual([]);
    expect(announcementsSince(capturing.editor, editorMark)).toEqual([]);
    expect(announcementsSince(second.client, refused.mark)).toEqual([]);
    expect(framesSince(second.client, AGENT_CONFIG, refused.mark)).toEqual([]);

    // The durable row — its bound-at stamp included — and the record are as they were.
    expect(bindingRows()).toEqual(rowsBefore);
    expect(storedBindingOfTab(firstTab)).toEqual(storedBefore);
    expect(storedBindingOfTab(secondTab)).toBeUndefined();
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId: firstTab, url: firstUrl });

    // The live routing is the first tab's again: the session fan-out reaches
    // its connection and not the refused one's …
    const firstLater = first.client.received.length;
    const secondLater = second.client.received.length;
    unwrap(
      await service().manager.patch(capturing.sessionId, { target: targetOn(firstUrl) }),
      'Patching the session',
    );
    await waitFor(first.client, REPLAY_SESSION_UPDATED, (_message, index) => index >= firstLater);
    await settleAll(second.client);
    expect(framesSince(second.client, REPLAY_SESSION_UPDATED, secondLater)).toEqual([]);

    // … and the first tab's credential still owns the binding: its reload is
    // kept and re-arms the open capture there.
    const reloaded = await sendSettled(
      first.client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId: firstTab, url: firstUrl }),
    );
    expect(reloaded.errors).toEqual([]);
    expect(announcementsSince(first.client, reloaded.mark)).toEqual([
      {
        sessionId: capturing.sessionId,
        tabId: firstTab,
        url: firstUrl,
        reason: REASON_NAVIGATED,
      },
    ]);
    expectArmedFor(
      (await waitForArming(first.client, capturing, reloaded.mark)).payload,
      capturing,
    );
  });

  it('refuses moving a tab whose new session’s record fails, and puts the tab back on its first session in the store, the registry and both records', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const otherTab = freshTab();
    const other = await openPanel(otherTab);
    const firstUrl = pageOf(capturing, '/reports');
    const otherUrl = pageOf(created, '/dashboard');

    expectEstablished(
      client,
      await bind(client, { tabId, url: firstUrl }),
      capturing.sessionId,
      tabId,
    );
    expectEstablished(
      other.client,
      await bind(other.client, { tabId: otherTab, url: otherUrl }),
      created.sessionId,
      otherTab,
    );
    const rowsBefore = bindingRows();
    const storedBefore = [storedBindingOfTab(tabId), storedBindingOfTab(otherTab)];
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId, url: firstUrl });
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId: otherTab, url: otherUrl });
    const otherMark = other.client.received.length;
    const firstEditorMark = capturing.editor.received.length;
    const secondEditorMark = created.editor.received.length;
    const logMark = service().logger.records.length;

    // Moving the tab clears the first session's record, then the second
    // session's record refuses the tab — displacing its own tab along the way.
    const moved = await withRecordWritesRefused(created.sessionId, () =>
      bind(client, { tabId, url: pageOf(created, '/orders') }),
    );
    expectRefused(moved, CODES.STORE_ERROR);
    await settleAll(client, other.client, capturing.editor, created.editor);
    expectCleanCompensation(logMark);

    // Neither side of the move, nor the second session's own tab, heard a thing.
    expect(announcementsSince(client, moved.mark)).toEqual([]);
    expect(announcementsSince(other.client, otherMark)).toEqual([]);
    expect(announcementsSince(capturing.editor, firstEditorMark)).toEqual([]);
    expect(announcementsSince(created.editor, secondEditorMark)).toEqual([]);

    // Both durable rows are back, stamps included, and the first session's
    // cleared record shows its tab again.
    expect(bindingRows()).toEqual(rowsBefore);
    expect([storedBindingOfTab(tabId), storedBindingOfTab(otherTab)]).toEqual(storedBefore);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId, url: firstUrl });
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId: otherTab, url: otherUrl });

    // Live: the tab is bound to its first session again — a reload is kept
    // there and re-arms that session's capture …
    const reloaded = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: firstUrl }),
    );
    expect(reloaded.errors).toEqual([]);
    expect(announcementsSince(client, reloaded.mark)).toEqual([
      { sessionId: capturing.sessionId, tabId, url: firstUrl, reason: REASON_NAVIGATED },
    ]);
    expectArmedFor((await waitForArming(client, capturing, reloaded.mark)).payload, capturing);

    // … and the second session's own tab still carries that session's fan-out.
    const otherLater = other.client.received.length;
    unwrap(
      await service().manager.patch(created.sessionId, { target: targetOn(otherUrl) }),
      'Patching the second session',
    );
    await waitFor(other.client, REPLAY_SESSION_UPDATED, (_message, index) => index >= otherLater);
  });

  it('refuses a re-bind of the same tab and session at a new URL whose record mirror fails, keeping the existing binding, its URL and its stamp everywhere and announcing nothing', async () => {
    const { created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const firstUrl = pageOf(created, '/orders');
    const nextUrl = pageOf(created, '/orders/7');

    expectEstablished(
      client,
      await bind(client, { tabId, url: firstUrl }),
      created.sessionId,
      tabId,
    );
    const rowsBefore = bindingRows();
    const storedBefore = storedBindingOfTab(tabId);
    expect(storedBefore).toMatchObject({
      sessionId: created.sessionId,
      tab: { tabId, url: firstUrl },
    });
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId, url: firstUrl });
    const editorMark = created.editor.received.length;
    const logMark = service().logger.records.length;

    // The same credential re-binds the tab to its own session at another page:
    // neither store reports the existing binding displaced, and the record
    // mirror of the new URL is refused.
    const refused = await withRecordWritesRefused(created.sessionId, () =>
      bind(client, { tabId, url: nextUrl, sessionId: created.sessionId }),
    );
    expectRefused(refused, CODES.STORE_ERROR);
    await settleAll(created.editor);
    expectCleanCompensation(logMark);

    // No `session.bound` — establishment or replacement — reached the panel or the editor.
    expect(announcementsSince(client, refused.mark)).toEqual([]);
    expect(announcementsSince(created.editor, editorMark)).toEqual([]);

    // The durable row keeps its URL and its bound-at stamp, and the record
    // still shows the tab at its first URL.
    expect(bindingRows()).toEqual(rowsBefore);
    expect(storedBindingOfTab(tabId)).toEqual(storedBefore);
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId, url: firstUrl });

    // The live binding still names the session: its fan-out reaches the tab.
    const fanOutMark = client.received.length;
    unwrap(
      await service().manager.patch(created.sessionId, { target: targetOn(firstUrl) }),
      'Patching the session',
    );
    await waitFor(client, REPLAY_SESSION_UPDATED, (_message, index) => index >= fanOutMark);

    // It holds the first URL and the first stamp too: a navigation the record
    // refuses writes the row back from the live binding's own URL and stamp,
    // so the row reads exactly as it did before the refused re-bind.
    const probe = await withRecordWritesRefused(created.sessionId, () =>
      sendSettled(
        client,
        TAB_NAVIGATED,
        tabNavigatedPayloadSchema.parse({ tabId, url: pageOf(created, '/orders/8') }),
      ),
    );
    expectRefused(probe, CODES.STORE_ERROR);
    expect(storedBindingOfTab(tabId)).toEqual(storedBefore);
    expect(announcementsSince(client, probe.mark)).toEqual([]);

    // A later navigation and an unbind both work against that binding.
    const reloaded = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: firstUrl }),
    );
    expect(reloaded.errors).toEqual([]);
    expect(announcementsSince(client, reloaded.mark)).toEqual([
      { sessionId: created.sessionId, tabId, url: firstUrl, reason: REASON_NAVIGATED },
    ]);
    expect(storedBindingOfTab(tabId)).toEqual(storedBefore);
    const unbound = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(unbound.errors).toEqual([]);
    expect(announcementsSince(client, unbound.mark)).toEqual([
      { sessionId: created.sessionId, tabId, url: firstUrl, reason: REASON_UNBOUND },
    ]);
    expect(rowsFor({ tabId })).toEqual([]);
    expect(recordOf(created.sessionId).boundTab).toBeUndefined();
  });

  it('refuses a re-bind of the same tab and session from a new DevTools connection whose record mirror fails, leaving the binding with the credential that made it', async () => {
    const { created } = suite();
    const tabId = freshTab();
    const first = await openPanel(tabId);
    const firstUrl = pageOf(created, '/orders');

    expectEstablished(
      first.client,
      await bind(first.client, { tabId, url: firstUrl }),
      created.sessionId,
      tabId,
    );
    const rowsBefore = bindingRows();
    const storedBefore = storedBindingOfTab(tabId);
    const second = await openPanel(tabId);
    const firstMark = first.client.received.length;
    const editorMark = created.editor.received.length;
    const logMark = service().logger.records.length;

    // Another credential re-binds the same tab to the same session: the store
    // reports no displaced row, and the record refuses the new URL.
    const refused = await withRecordWritesRefused(created.sessionId, () =>
      bind(second.client, { tabId, url: pageOf(created, '/orders/7') }),
    );
    expectRefused(refused, CODES.STORE_ERROR);
    await settleAll(first.client, created.editor);
    expectCleanCompensation(logMark);

    // Nobody heard a thing, and the row, its stamp and the record are as they were.
    expect(announcementsSince(first.client, firstMark)).toEqual([]);
    expect(announcementsSince(second.client, refused.mark)).toEqual([]);
    expect(announcementsSince(created.editor, editorMark)).toEqual([]);
    expect(bindingRows()).toEqual(rowsBefore);
    expect(storedBindingOfTab(tabId)).toEqual(storedBefore);
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId, url: firstUrl });

    // The binding is still the first credential's: the second may not unbind
    // it, and the first unbinds it at the URL it bound.
    expectRefused(
      await sendSettled(second.client, SESSION_UNBIND, sessionUnbindPayloadSchema.parse({ tabId })),
      CODES.TAB_NOT_BOUND,
    );
    const unbound = await sendSettled(
      first.client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(unbound.errors).toEqual([]);
    expect(announcementsSince(first.client, unbound.mark)).toEqual([
      { sessionId: created.sessionId, tabId, url: firstUrl, reason: REASON_UNBOUND },
    ]);
    expect(rowsFor({ tabId })).toEqual([]);
  });

  it('tells the tabs of one multiplexing connection apart: each acts for its own binding, a displaced tab for none', async () => {
    const { created } = suite();
    const credential = service().issueDevtoolsCredential();
    // Exactly like the MV3 service worker: one credential, one connection, and
    // no tab in the hello — every frame names the tab it acts for instead.
    const mux = await service().ws({
      client: 'devtools',
      token: credential.token,
      origin: credential.origin,
    });
    expect(mux.authenticated, mux.describe()).toBe(true);
    expect(mux.identity.tabId).toBeUndefined();
    const firstTab = freshTab();
    const secondTab = freshTab();
    const firstUrl = pageOf(created, '/orders');
    const secondUrl = pageOf(created, '/orders/7');

    /** A `target.selected` for the session, acting for `tab` (none when `undefined`). */
    const select = (tab: number | undefined, url: string): Promise<Settled> =>
      sendSettled(
        mux,
        TARGET_SELECTED,
        targetSelectedPayloadSchema.parse({
          sessionId: created.sessionId,
          target: targetOn(url),
        }),
        tab === undefined ? undefined : { tabId: tab },
      );

    // A binding frame is authorized for the tab its own payload names.
    expectEstablished(
      mux,
      await bind(mux, { tabId: firstTab, url: firstUrl, sessionId: created.sessionId }),
      created.sessionId,
      firstTab,
    );
    expect((await select(firstTab, firstUrl)).errors).toEqual([]);
    // The credential's other tab, and a frame that names no tab, may not act on it.
    expectRefused(await select(secondTab, firstUrl), CODES.TAB_NOT_BOUND);
    expectRefused(await select(undefined, firstUrl), CODES.TAB_NOT_BOUND);

    // The second tab of the same credential takes the session over …
    expectEstablished(
      mux,
      await bind(mux, { tabId: secondTab, url: secondUrl, sessionId: created.sessionId }),
      created.sessionId,
      secondTab,
    );
    expect(storedBindingOfSession(created.sessionId)?.tab).toEqual({
      tabId: secondTab,
      url: secondUrl,
    });

    // … after which the displaced tab may no longer act on it, and the new one may.
    expectRefused(await select(firstTab, firstUrl), CODES.TAB_NOT_BOUND);
    const target = targetOn(secondUrl);
    expect((await select(secondTab, secondUrl)).errors).toEqual([]);
    expect(recordOf(created.sessionId).target).toEqual(target);

    // Binding frames keep naming their own tab: a navigation of the displaced
    // tab touches nothing, and unbinding the bound tab drops the binding.
    const navigated = await sendSettled(
      mux,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId: firstTab, url: firstUrl }),
      { tabId: firstTab },
    );
    expect(navigated.errors).toEqual([]);
    expect(storedBindingOfSession(created.sessionId)?.tab.tabId).toBe(secondTab);
    const unbound = await sendSettled(
      mux,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId: secondTab }),
      { tabId: secondTab },
    );
    expect(unbound.errors).toEqual([]);
    expect(storedBindingOfSession(created.sessionId)).toBeUndefined();
    expectRefused(await select(secondTab, secondUrl), CODES.TAB_NOT_BOUND);
  });
});

/* -------------------------------------------------------------------------------------------------
 * tab.navigated
 * ---------------------------------------------------------------------------------------------- */

describe(TAB_NAVIGATED, () => {
  it('keeps the binding across a same-origin navigation, continues the capture and re-arms the agent in the bound tab only', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const panel = await openPanel(tabId);
    const bystanderTab = freshTab();
    const bystander = await openPanel(bystanderTab);
    const firstUrl = pageOf(capturing, '/reports');
    const nextUrl = pageOf(capturing, '/reports/weekly');

    const bound = await bind(panel.client, { tabId, url: firstUrl });
    expectEstablished(panel.client, bound, capturing.sessionId, tabId);
    await waitForArming(panel.client, capturing, bound.mark);
    expectEstablished(
      bystander.client,
      await bind(bystander.client, { tabId: bystanderTab, url: pageOf(created, '/dashboard') }),
      created.sessionId,
      bystanderTab,
    );
    const statusBefore = recordOf(capturing.sessionId).status;
    const bystanderMark = bystander.client.received.length;
    const editorMark = capturing.editor.received.length;

    const navigated = await sendSettled(
      panel.client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: nextUrl }),
    );
    expect(navigated.errors).toEqual([]);

    // Announced as a kept binding about the new document, to the panel and the editor.
    const kept = {
      sessionId: capturing.sessionId,
      tabId,
      url: nextUrl,
      reason: REASON_NAVIGATED,
    };
    expect(announcementsSince(panel.client, navigated.mark)).toEqual([kept]);
    await settleAll(capturing.editor, bystander.client);
    expect(announcementsSince(capturing.editor, editorMark)).toEqual([kept]);

    // The new document's dormant agent is re-armed through the arming port for
    // the same capture — in the bound tab and nowhere else.
    const rearmed = framesSince(panel.client, AGENT_CONFIG, navigated.mark);
    expect(rearmed).toHaveLength(1);
    const [config] = rearmed;
    if (config === undefined) {
      throw new Error('Unreachable: the re-arm was counted but is missing.');
    }
    expectArmedFor(config.payload, capturing);
    expect(framesSince(bystander.client, AGENT_CONFIG, bystanderMark)).toEqual([]);

    // The binding survived with the new URL, in the store and on the record,
    // and the capture window is the one that was open before.
    expect(rowsFor({ tabId, sessionId: capturing.sessionId })).toEqual([
      { tabId, sessionId: capturing.sessionId, url: nextUrl },
    ]);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId, url: nextUrl });
    expect(recordOf(capturing.sessionId).status).toBe(statusBefore);
    expect(openCaptureId(capturing.sessionId)).toBe(capturing.captureId);
    expect(service().manager.captureOwnerForProject(capturing.project.root)).toEqual({
      sessionId: capturing.sessionId,
      captureId: capturing.captureId,
    });
  });

  it('refuses a target.selected of the document the tab navigated away from, and accepts a query or fragment variant of the current one', async () => {
    const { capturing } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const firstUrl = pageOf(capturing, '/reports');
    const nextUrl = pageOf(capturing, '/reports/weekly');
    expectEstablished(
      client,
      await bind(client, { tabId, url: firstUrl }),
      capturing.sessionId,
      tabId,
    );

    // A selection of the document the tab shows is accepted, so the refusal
    // below is about the document and not about the sender.
    const current = probeTarget(firstUrl, 'current');
    expect((await select(client, capturing.sessionId, current)).errors).toEqual([]);
    expect(recordOf(capturing.sessionId).target).toEqual(current);

    // A same-origin navigation keeps the binding and moves its URL on …
    const navigated = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: nextUrl }),
    );
    expect(navigated.errors).toEqual([]);
    expect(storedBindingOfTab(tabId)?.tab.url).toBe(nextUrl);
    await settleAll(capturing.editor, client);
    const editorMark = capturing.editor.received.length;

    // … so a selection still made in the document the tab left is stale: refused
    // with the frame's id as `ref`, in words that quote no URL, and never recorded.
    const stale = await select(client, capturing.sessionId, probeTarget(firstUrl, 'stale'));
    const refusal = expectRefused(stale, CODES.TAB_NOT_BOUND);
    expectNoUrlIn(refusal, firstUrl);
    expect(recordOf(capturing.sessionId).target).toEqual(current);
    await settleAll(capturing.editor);
    expect(framesSince(capturing.editor, REPLAY_SESSION_UPDATED, editorMark)).toEqual([]);

    // The current document with another query string and a fragment is the same
    // document: accepted, and announced as the session's target — in the form
    // every stored descriptor takes, its query values and fragment masked.
    const variant = probeTarget(`${nextUrl}?range=week&page=2#totals`, 'variant');
    const recorded = redactSelectedTarget(variant);
    expect(recorded.url).toBe(`${nextUrl}?range=?&page=?#?`);
    const accepted = await select(client, capturing.sessionId, variant);
    expect(accepted.errors).toEqual([]);
    await waitFor(
      client,
      REPLAY_SESSION_UPDATED,
      (message, index) =>
        index >= accepted.mark && isDeepStrictEqual(message.payload.session.target, recorded),
    );
    expect(recordOf(capturing.sessionId).target).toEqual(recorded);
  });

  it('refuses a target.selected that names another origin than the bound tab’s, near misses included', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports');
    expectEstablished(client, await bind(client, { tabId, url }), capturing.sessionId, tabId);
    const current = probeTarget(url, 'origin-baseline');
    expect((await select(client, capturing.sessionId, current)).errors).toEqual([]);
    await settleAll(client);
    const mark = client.received.length;

    // Another session's dev server on the same path, then every near-miss origin.
    const foreign = [
      { label: 'another session’s dev server', page: pageOf(created, '/reports') },
      ...NEAR_MISSES.map((nearMiss) => ({
        label: nearMiss.label,
        page: nearMiss.page(capturing, takenPorts()),
      })),
    ];
    for (const { label, page } of foreign) {
      expect(new URL(page).origin, label).not.toBe(capturing.origin);
      const forged = await select(client, capturing.sessionId, probeTarget(page, 'forged'));
      expectNoUrlIn(expectRefused(forged, CODES.TAB_NOT_BOUND), page);
      expect(recordOf(capturing.sessionId).target, label).toEqual(current);
    }

    // Nothing reached the session: no update, and the binding is where it was.
    await settleAll(client);
    expect(framesSince(client, REPLAY_SESSION_UPDATED, mark)).toEqual([]);
    expect(storedBindingOfTab(tabId)).toMatchObject({
      sessionId: capturing.sessionId,
      tab: { tabId, url },
    });
    expect(client.authenticated).toBe(true);
  });

  it('reports each reload during an open capture exactly once, as a stored capture-stage progress row the panel and the editor both receive', async () => {
    const { capturing } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports?range=week');
    const progressBefore = progressOf(capturing.sessionId);

    // Binding a tab, and re-binding it redundantly, is not a reload: neither
    // stores a progress row, though both re-arm the open capture.
    const bound = await bind(client, { tabId, url });
    expectEstablished(client, bound, capturing.sessionId, tabId);
    await waitForArming(client, capturing, bound.mark);
    const again = await bind(client, { tabId, url });
    expectEstablished(client, again, capturing.sessionId, tabId);
    await waitForArming(client, capturing, again.mark);
    expect(progressOf(capturing.sessionId)).toEqual(progressBefore);

    const expectedRow = {
      stage: PROGRESS_CAPTURE,
      status: PROGRESS_DONE,
      message: RELOAD_NOTICE,
    };

    for (const [count, next] of [
      [1, url],
      [2, pageOf(capturing, '/reports/weekly?range=month')],
    ] as const) {
      const panelMark = client.received.length;
      const editorMark = capturing.editor.received.length;
      const navigated = await sendSettled(
        client,
        TAB_NAVIGATED,
        tabNavigatedPayloadSchema.parse({ tabId, url: next }),
      );
      expect(navigated.errors).toEqual([]);
      await waitForArming(client, capturing, panelMark);
      await settleAll(capturing.editor);

      // One stored row per navigation, appended after everything before it.
      const added = progressOf(capturing.sessionId).slice(progressBefore.length);
      expect(added, `after navigation ${String(count)}`).toHaveLength(count);
      const row = added.at(-1);
      expect(row).toMatchObject({ sessionId: capturing.sessionId, ...expectedRow });
      expect(typeof row?.detail).toBe('string');

      // Exactly one frame per navigation, to the bound panel and to the editor.
      for (const [receiver, from] of [
        [client, panelMark],
        [capturing.editor, editorMark],
      ] as const) {
        const frames = framesSince(receiver, REPLAY_SESSION_PROGRESS, from);
        expect(frames, receiver.describe()).toHaveLength(1);
        expect(frames[0]?.payload).toMatchObject({
          sessionId: capturing.sessionId,
          ...expectedRow,
        });
        expect(frames[0]?.payload.detail).toBe(row?.detail);
      }

      // The notice says whether the agent resumed; it carries no URL.
      expect(JSON.stringify(row)).not.toContain(capturing.origin);
      expect(JSON.stringify(row)).not.toContain('range=');
    }
  });

  it('reports no reload for a navigation of a session without an open capture', async () => {
    const { created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    expectEstablished(
      client,
      await bind(client, { tabId, url: pageOf(created, '/orders') }),
      created.sessionId,
      tabId,
    );
    const progressBefore = progressOf(created.sessionId);
    const panelMark = client.received.length;
    const editorMark = created.editor.received.length;

    const navigated = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: pageOf(created, '/orders/7') }),
    );
    expect(navigated.errors).toEqual([]);
    expect(announcementsSince(client, navigated.mark)).toHaveLength(1);
    await settleAll(created.editor);

    expect(progressOf(created.sessionId)).toEqual(progressBefore);
    expect(framesSince(client, REPLAY_SESSION_PROGRESS, panelMark)).toEqual([]);
    expect(framesSince(created.editor, REPLAY_SESSION_PROGRESS, editorMark)).toEqual([]);
  });

  it('refuses a same-origin navigation whose URL the session record will not take, keeping the previous URL everywhere and announcing nothing', async () => {
    const { capturing } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports');

    const bound = await bind(client, { tabId, url });
    expectEstablished(client, bound, capturing.sessionId, tabId);
    await waitForArming(client, capturing, bound.mark);
    const rowsBefore = bindingRows();
    const storedBefore = storedBindingOfTab(tabId);
    const progressBefore = progressOf(capturing.sessionId);
    const editorMark = capturing.editor.received.length;

    const refused = await withRecordWritesRefused(capturing.sessionId, () =>
      sendSettled(
        client,
        TAB_NAVIGATED,
        tabNavigatedPayloadSchema.parse({ tabId, url: pageOf(capturing, '/reports/weekly') }),
      ),
    );
    expectRefused(refused, CODES.STORE_ERROR);
    await settleAll(capturing.editor);

    // No surface heard of the URL, and the agent was not re-armed for it.
    expect(announcementsSince(client, refused.mark)).toEqual([]);
    expect(announcementsSince(capturing.editor, editorMark)).toEqual([]);
    expect(framesSince(client, AGENT_CONFIG, refused.mark)).toEqual([]);
    expect(progressOf(capturing.sessionId)).toEqual(progressBefore);

    // The row, its stamp and the record still show the previous URL …
    expect(bindingRows()).toEqual(rowsBefore);
    expect(storedBindingOfTab(tabId)).toEqual(storedBefore);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId, url });

    // … and so does the live binding, whose URL an unbind announces.
    const unbound = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(unbound.errors).toEqual([]);
    expect(announcementsSince(client, unbound.mark)).toEqual([
      { sessionId: capturing.sessionId, tabId, url, reason: REASON_UNBOUND },
    ]);
  });

  it('unbinds a tab that navigates to another origin and announces it, without ending the session or discarding its capture', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports');
    const away = pageOf(created, '/dashboard');

    const bound = await bind(client, { tabId, url });
    expectEstablished(client, bound, capturing.sessionId, tabId);
    await waitForArming(client, capturing, bound.mark);
    const statusBefore = recordOf(capturing.sessionId).status;
    const editorMark = capturing.editor.received.length;

    const left = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: away }),
    );
    expect(left.errors).toEqual([]);

    // The drop carries the new document, which is what the panel renders as
    // "Tab left ‹origin›", and the editor hears it too.
    const dropped = {
      sessionId: capturing.sessionId,
      tabId,
      url: away,
      reason: REASON_ORIGIN_CHANGED,
    };
    expect(announcementsSince(client, left.mark)).toEqual([dropped]);
    expect(new URL(dropped.url).origin).not.toBe(capturing.origin);
    await settleAll(capturing.editor);
    expect(announcementsSince(capturing.editor, editorMark)).toContainEqual(dropped);
    expect(framesSince(client, AGENT_CONFIG, left.mark)).toEqual([]);

    // Unbound everywhere — and not silently rebound to the session serving the new origin.
    expect(storedBindingOfTab(tabId)).toBeUndefined();
    expect(storedBindingOfSession(capturing.sessionId)).toBeUndefined();
    expect(storedBindingOfSession(created.sessionId)?.tab.tabId).not.toBe(tabId);
    expect(rowsFor({ tabId })).toEqual([]);
    expect(recordOf(capturing.sessionId).boundTab).toBeUndefined();

    // The session and its capture are untouched.
    expect(recordOf(capturing.sessionId).status).toBe(statusBefore);
    expect(openCaptureId(capturing.sessionId)).toBe(capturing.captureId);
    expect(service().manager.captureOwnerForProject(capturing.project.root)?.captureId).toBe(
      capturing.captureId,
    );
  });

  it('refuses an origin change whose record will not clear its bound tab, keeping the binding routed, stored and recorded and announcing nothing, and drops it on the next navigation', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports');
    const away = pageOf(created, '/dashboard');

    const bound = await bind(client, { tabId, url });
    expectEstablished(client, bound, capturing.sessionId, tabId);
    await waitForArming(client, capturing, bound.mark);
    const rowsBefore = bindingRows();
    const storedBefore = storedBindingOfTab(tabId);
    const recordBefore = storedRecordJson(capturing.sessionId);
    const statusBefore = recordOf(capturing.sessionId).status;
    const editorMark = capturing.editor.received.length;
    const logMark = service().logger.records.length;

    // The navigation leaves the session's origin; clearing the record's tab is refused.
    const refused = await withRecordWritesRefused(capturing.sessionId, () =>
      sendSettled(client, TAB_NAVIGATED, tabNavigatedPayloadSchema.parse({ tabId, url: away })),
    );
    expectNoUrlIn(expectRefused(refused, CODES.STORE_ERROR), away);
    await settleAll(capturing.editor);
    expectCleanCompensation(logMark);

    // No surface heard of a drop the record does not show.
    expect(announcementsSince(client, refused.mark)).toEqual([]);
    expect(announcementsSince(capturing.editor, editorMark)).toEqual([]);
    expect(framesSince(client, AGENT_CONFIG, refused.mark)).toEqual([]);

    // The row — its bound-at stamp included — and the record document are
    // exactly as they were, and the tab was not bound to the new origin's session.
    expect(bindingRows()).toEqual(rowsBefore);
    expect(storedBindingOfTab(tabId)).toEqual(storedBefore);
    expect(storedRecordJson(capturing.sessionId)).toBe(recordBefore);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId, url });
    expect(storedBindingOfSession(created.sessionId)?.tab.tabId).not.toBe(tabId);

    // The live binding still routes the session's fan-out to the tab.
    const later = client.received.length;
    unwrap(
      await service().manager.patch(capturing.sessionId, { target: targetOn(url) }),
      'Patching the session',
    );
    await waitFor(client, REPLAY_SESSION_UPDATED, (_message, index) => index >= later);

    // The next navigation finds the binding and completes the drop everywhere.
    const retryMark = capturing.editor.received.length;
    const left = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: away }),
    );
    expect(left.errors).toEqual([]);
    const dropped = {
      sessionId: capturing.sessionId,
      tabId,
      url: away,
      reason: REASON_ORIGIN_CHANGED,
    };
    expect(announcementsSince(client, left.mark)).toEqual([dropped]);
    await settleAll(capturing.editor);
    expect(announcementsSince(capturing.editor, retryMark)).toEqual([dropped]);
    expect(rowsFor({ tabId })).toEqual([]);
    expect(storedBindingOfSession(capturing.sessionId)).toBeUndefined();
    expect(recordOf(capturing.sessionId).boundTab).toBeUndefined();
    expect(recordOf(capturing.sessionId).status).toBe(statusBefore);
    expect(openCaptureId(capturing.sessionId)).toBe(capturing.captureId);
  });

  it.each(NEAR_MISSES)('treats $label as a different origin', async (nearMiss) => {
    const { capturing } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports');
    const page = nearMiss.page(capturing, takenPorts());
    expect(new URL(page).origin).not.toBe(capturing.origin);

    expectEstablished(client, await bind(client, { tabId, url }), capturing.sessionId, tabId);
    const moved = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: page }),
    );
    expect(moved.errors).toEqual([]);
    expect(announcementsSince(client, moved.mark)).toEqual([
      { sessionId: capturing.sessionId, tabId, url: page, reason: REASON_ORIGIN_CHANGED },
    ]);
    expect(framesSince(client, AGENT_CONFIG, moved.mark)).toEqual([]);
    expect(rowsFor({ tabId })).toEqual([]);
    expect(openCaptureId(capturing.sessionId)).toBe(capturing.captureId);
  });

  it('ignores a navigation of a tab that is not bound', async () => {
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const rowsBefore = bindingRows();

    const ignored = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: pageOf(suite().capturing, '/reports') }),
    );
    expect(ignored.errors).toEqual([]);
    expect(announcementsSince(client, ignored.mark)).toEqual([]);
    expect(bindingRows()).toEqual(rowsBefore);
  });
});

/* -------------------------------------------------------------------------------------------------
 * session.unbind, and the dropped socket
 * ---------------------------------------------------------------------------------------------- */

describe(SESSION_UNBIND, () => {
  it('drops the binding without ending the session, cancelling its capture or disarming its agent', async () => {
    const { capturing } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports');

    const bound = await bind(client, { tabId, url });
    expectEstablished(client, bound, capturing.sessionId, tabId);
    await waitForArming(client, capturing, bound.mark);
    const statusBefore = recordOf(capturing.sessionId).status;
    const editorMark = capturing.editor.received.length;

    const unbound = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(unbound.errors).toEqual([]);

    const ended = { sessionId: capturing.sessionId, tabId, url, reason: REASON_UNBOUND };
    expect(announcementsSince(client, unbound.mark)).toEqual([ended]);
    await settleAll(capturing.editor);
    expect(announcementsSince(capturing.editor, editorMark)).toContainEqual(ended);

    // The binding is gone from the store and the record …
    expect(storedBindingOfTab(tabId)).toBeUndefined();
    expect(storedBindingOfSession(capturing.sessionId)).toBeUndefined();
    expect(rowsFor({ tabId })).toEqual([]);
    expect(recordOf(capturing.sessionId).boundTab).toBeUndefined();

    // … while the session, its status and its capture window are exactly as they were,
    // and no disarming configuration was sent.
    expect(recordOf(capturing.sessionId).status).toBe(statusBefore);
    expect(openCaptureId(capturing.sessionId)).toBe(capturing.captureId);
    expect(service().manager.captureOwnerForProject(capturing.project.root)?.captureId).toBe(
      capturing.captureId,
    );
    expect(framesSince(client, AGENT_CONFIG, unbound.mark)).toEqual([]);

    // The instrumentation is still armed for that capture: binding the tab again
    // re-arms the page agent for the very same capture window.
    const rebound = await bind(client, { tabId, url });
    expectEstablished(client, rebound, capturing.sessionId, tabId);
    const rearmed = framesSince(client, AGENT_CONFIG, rebound.mark);
    expect(rearmed).toHaveLength(1);
    const [config] = rearmed;
    if (config === undefined) {
      throw new Error('Unreachable: the re-arm was counted but is missing.');
    }
    expectArmedFor(config.payload, capturing);
  });

  it('treats unbinding a tab that is not bound as a harmless no-op', async () => {
    const { created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const rowsBefore = bindingRows();

    // The connection's own tab, before anything bound it: a single-tab
    // connection may unbind no other tab at all.
    const never = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(never.errors).toEqual([]);
    expect(announcementsSince(client, never.mark)).toEqual([]);
    expect(bindingRows()).toEqual(rowsBefore);

    // A repeated unbind — the panel and the service worker both reporting one
    // closure — announces the drop once and answers the second with nothing.
    const url = pageOf(created, '/orders');
    expectEstablished(client, await bind(client, { tabId, url }), created.sessionId, tabId);
    const once = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    const twice = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(once.errors).toEqual([]);
    expect(twice.errors).toEqual([]);
    expect(announcementsSince(client, once.mark)).toEqual([
      { sessionId: created.sessionId, tabId, url, reason: REASON_UNBOUND },
    ]);
    expect(rowsFor({ tabId })).toEqual([]);

    // The connection is still whole: it binds again at once.
    expect(client.authenticated).toBe(true);
    expect(client.closes).toEqual([]);
    expectEstablished(client, await bind(client, { tabId, url }), created.sessionId, tabId);
  });

  it('fails loudly, by name, when an action needs the session’s bound tab after an unbind', async () => {
    const { capturing } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports');

    expectEstablished(client, await bind(client, { tabId, url }), capturing.sessionId, tabId);
    expect(
      (await sendSettled(client, SESSION_UNBIND, sessionUnbindPayloadSchema.parse({ tabId })))
        .errors,
    ).toEqual([]);
    const targetBefore = recordOf(capturing.sessionId).target;

    const refused = expectRefused(
      await sendSettled(
        client,
        TARGET_SELECTED,
        targetSelectedPayloadSchema.parse({
          sessionId: capturing.sessionId,
          target: targetOn(url),
        }),
      ),
      CODES.TAB_NOT_BOUND,
    );
    expect(refused.code).toBe(CODES.TAB_NOT_BOUND);
    expect(recordOf(capturing.sessionId).target).toEqual(targetBefore);
    expect(client.authenticated).toBe(true);
  });

  it('keeps the session and its binding when a DevTools socket simply closes, and carries the binding on the same credential’s reconnect', async () => {
    const { capturing } = suite();
    const running = service();
    const tabId = freshTab();
    const credential = running.issueDevtoolsCredential();
    const first = await openPanel(tabId, credential);
    const url = pageOf(capturing, '/reports');

    const bound = await bind(first.client, { tabId, url });
    expectEstablished(first.client, bound, capturing.sessionId, tabId);
    await waitForArming(first.client, capturing, bound.mark);
    const statusBefore = recordOf(capturing.sessionId).status;
    const rowsBefore = bindingRows();

    // The socket closes without an unbind — DevTools crashed, or the MV3 service
    // worker was suspended — and the service records the close.
    const closesBefore = running.logger.withMessage(CONNECTION_CLOSED_LOG).length;
    await first.client.close();
    await waitUntil(
      () =>
        running.logger.withMessage(CONNECTION_CLOSED_LOG).length > closesBefore ? true : undefined,
      'the service has processed the DevTools socket close',
    );

    // Offline is not removed: the binding, the session and its capture survive.
    expect(bindingRows()).toEqual(rowsBefore);
    expect(storedBindingOfTab(tabId)).toMatchObject({
      sessionId: capturing.sessionId,
      tab: { tabId, url },
    });
    expect(recordOf(capturing.sessionId).status).toBe(statusBefore);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId, url });
    expect(openCaptureId(capturing.sessionId)).toBe(capturing.captureId);

    // The same credential reconnects and carries the binding without re-binding:
    // it may act on the session, and the session's fan-out reaches it.
    const second = await openPanel(tabId, credential);
    const mark = second.client.received.length;
    const target = targetOn(url);
    const selected = await sendSettled(
      second.client,
      TARGET_SELECTED,
      targetSelectedPayloadSchema.parse({ sessionId: capturing.sessionId, target }),
    );
    expect(selected.errors).toEqual([]);
    await waitFor(
      second.client,
      REPLAY_SESSION_UPDATED,
      (message, index) =>
        index >= mark && message.payload.session.target?.selector === target.selector,
    );
    expect(announcementsSince(second.client, mark)).toEqual([]);
    expect(bindingRows()).toEqual(rowsBefore);
  });

  it('refuses an unbind whose record will not clear its bound tab, keeping the binding routed, stored and recorded and announcing nothing, and drops it on retry', async () => {
    const { capturing } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(capturing, '/reports');

    const bound = await bind(client, { tabId, url });
    expectEstablished(client, bound, capturing.sessionId, tabId);
    await waitForArming(client, capturing, bound.mark);
    const rowsBefore = bindingRows();
    const storedBefore = storedBindingOfTab(tabId);
    const recordBefore = storedRecordJson(capturing.sessionId);
    const statusBefore = recordOf(capturing.sessionId).status;
    const editorMark = capturing.editor.received.length;
    const logMark = service().logger.records.length;

    // The unbind reaches the record mirror, which the store refuses.
    const refused = await withRecordWritesRefused(capturing.sessionId, () =>
      sendSettled(client, SESSION_UNBIND, sessionUnbindPayloadSchema.parse({ tabId })),
    );
    expectNoUrlIn(expectRefused(refused, CODES.STORE_ERROR), url);
    await settleAll(capturing.editor);
    expectCleanCompensation(logMark);

    // Nothing was announced: neither the panel nor the editor heard of a drop.
    expect(announcementsSince(client, refused.mark)).toEqual([]);
    expect(announcementsSince(capturing.editor, editorMark)).toEqual([]);

    // The row — its bound-at stamp included — and the record document are exactly as they were.
    expect(bindingRows()).toEqual(rowsBefore);
    expect(storedBindingOfTab(tabId)).toEqual(storedBefore);
    expect(storedRecordJson(capturing.sessionId)).toBe(recordBefore);
    expect(recordOf(capturing.sessionId).boundTab).toEqual({ tabId, url });

    // The live binding still routes: the session's fan-out reaches the tab …
    const later = client.received.length;
    unwrap(
      await service().manager.patch(capturing.sessionId, { target: targetOn(url) }),
      'Patching the session',
    );
    await waitFor(client, REPLAY_SESSION_UPDATED, (_message, index) => index >= later);

    // … and the tab's credential still owns it: a reload is kept and re-arms
    // the open capture there.
    const reloaded = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url }),
    );
    expect(reloaded.errors).toEqual([]);
    expect(announcementsSince(client, reloaded.mark)).toEqual([
      { sessionId: capturing.sessionId, tabId, url, reason: REASON_NAVIGATED },
    ]);
    expectArmedFor((await waitForArming(client, capturing, reloaded.mark)).payload, capturing);

    // The retried unbind finds the binding and drops it from every store.
    await settleAll(capturing.editor);
    const retryMark = capturing.editor.received.length;
    const retried = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(retried.errors).toEqual([]);
    const ended = { sessionId: capturing.sessionId, tabId, url, reason: REASON_UNBOUND };
    expect(announcementsSince(client, retried.mark)).toEqual([ended]);
    await settleAll(capturing.editor);
    expect(announcementsSince(capturing.editor, retryMark)).toEqual([ended]);
    expect(storedBindingOfTab(tabId)).toBeUndefined();
    expect(storedBindingOfSession(capturing.sessionId)).toBeUndefined();
    expect(rowsFor({ tabId })).toEqual([]);
    expect(recordOf(capturing.sessionId).boundTab).toBeUndefined();
    expect(recordOf(capturing.sessionId).status).toBe(statusBefore);
    expect(openCaptureId(capturing.sessionId)).toBe(capturing.captureId);
  });

  it('drops the binding of a session whose record has vanished, since there is no bound tab left to clear', async () => {
    const { created } = suite();
    const running = service();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(created, '/orders');

    // A disposable session on the same dev server, bound by id so no other
    // test's origin matching is affected, whose record is then purged the way
    // retention deletes a row while a panel still holds its live binding.
    const disposable = unwrap(
      await running.manager.create({
        projectRoot: created.project.root,
        question: 'Why does this list flicker on load?',
        devServerUrl: created.devServerUrl,
      }),
      'Creating a disposable session',
    );
    const bound = await bind(client, { tabId, url, sessionId: disposable.id });
    expectEstablished(client, bound, disposable.id, tabId);
    running.store.statement('DELETE FROM sessions WHERE id = ?').run(disposable.id);
    expect(
      unwrap(running.manager.get(disposable.id), 'Reading the purged session'),
    ).toBeUndefined();
    expect(rowsFor({ tabId })).toEqual([]);

    const unbound = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(unbound.errors).toEqual([]);
    expect(announcementsSince(client, unbound.mark)).toEqual([
      { sessionId: disposable.id, tabId, url, reason: REASON_UNBOUND },
    ]);
    expect(rowsFor({ tabId, sessionId: disposable.id })).toEqual([]);

    // The live binding is gone too: a second unbind has nothing left to drop.
    const twice = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId }),
    );
    expect(twice.errors).toEqual([]);
    expect(announcementsSince(client, twice.mark)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Restoration racing session.end
 * ---------------------------------------------------------------------------------------------- */

/** The prefix of each race case's own `fs.mkdtemp` directory. */
const RACE_RIG_PREFIX = 'debuggen-binding-race-';

/** WHATWG `WebSocket.CLOSED`: the ready state the rig's socket reports once the registry closed it. */
const SOCKET_READY_STATE_CLOSED = 3;

/** The byte length of a SHA-256 digest: what a credential's `tokenHash` is the hex form of. */
const TOKEN_HASH_BYTES = 32;

/** The Chrome extension the rig's DevTools credential was paired with: 32 letters from Chrome's `a`–`p` id alphabet. */
const RACE_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** A promise the test settles by hand. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

/** A {@link Deferred}. A promise executor runs synchronously, so its resolver is captured before this returns. */
function deferred<T>(): Deferred<T> {
  const resolvers: ((value: T) => void)[] = [];
  const promise = new Promise<T>((resolve) => {
    resolvers.push(resolve);
  });
  const [resolve] = resolvers;
  if (resolve === undefined) {
    throw new Error('Unreachable: a promise executor runs synchronously.');
  }
  return { promise, resolve };
}

/** The `setBoundTab` call the rig held: which session record the route asked to show which tab. */
interface MirrorCall {
  readonly sessionId: SessionId;
  readonly boundTab: BoundTab | undefined;
}

/** A record mirror the rig holds open until the test answers it. */
interface HeldMirror {
  /** Settles with the call once the route has made it and is awaiting its answer. */
  readonly reached: Promise<MirrorCall>;
  /** Answers the held call: the route resumes with exactly this result. */
  readonly answer: (result: Result<SessionRecord, DebuggenError>) => void;
}

/** The binding routes over a store of their own (see the module overview, "Restoration racing `session.end`"). */
interface RaceRig {
  /** The `fs.mkdtemp` directory holding the rig's store; removed after the case. */
  readonly directory: string;
  readonly store: Store;
  readonly sessions: SessionsRepo;
  /** The real manager: the route's mirrors reach it unless held, and the test ends sessions through it. */
  readonly manager: SessionManager;
  readonly clients: ClientRegistry;
  readonly routes: BindingRoutes;
  /** The registered panel's credential. */
  readonly principal: DevtoolsPrincipal;
  /** The registered panel's connection, as `src/server/ws.ts` hands it to the routes. */
  readonly connection: BindingConnection;
  /** Every frame the registry wrote to the panel's socket, raw, in send order. */
  readonly sent: readonly string[];
  /** Every session the routes asked to re-arm. The rig opens no capture, so none may be. */
  readonly armRequests: readonly string[];
  /** Holds the route's next `setBoundTab` open until the test answers it. */
  holdNextMirror(): HeldMirror;
}

/**
 * Builds a {@link RaceRig}: a fresh store in its own `fs.mkdtemp` directory;
 * the real sessions and panels repositories, progress emitter, session manager
 * (configured as the service under test is), reopener and client registry over
 * it, all logging to the harness's capturing logger; and one registered
 * DevTools connection. Whatever was acquired is released should a step refuse.
 */
async function openRaceRig(): Promise<RaceRig> {
  const running = service();
  const logger = running.logger.root;
  const directory = await mkdtemp(join(realpathSync(tmpdir()), RACE_RIG_PREFIX));
  let store: Store | undefined;
  try {
    const opened = unwrap(
      openStore({ databasePath: join(directory, 'sessions.sqlite'), logger }),
      'Opening the race rig store',
    );
    store = opened;
    const sessions = createSessionsRepo({ store: opened, logger });
    const clients = createClientRegistry({ logger });
    const progress = createSessionProgress({ sessions, broadcaster: clients, logger });
    const manager = createSessionManager({
      sessions,
      broadcaster: clients,
      progress,
      config: running.config,
      logger,
    });
    const reopener = createSessionReopener({
      sessions,
      panels: createPanelsRepo({ store: opened, logger }),
      broadcaster: clients,
      logger,
    });

    let held:
      | {
          readonly reached: Deferred<MirrorCall>;
          readonly answer: Deferred<Result<SessionRecord, DebuggenError>>;
        }
      | undefined;
    const armRequests: string[] = [];
    const routes = createBindingRoutes({
      clients,
      sessions,
      manager: {
        setBoundTab: (sessionId, boundTab) => {
          const next = held;
          if (next === undefined) {
            return manager.setBoundTab(sessionId, boundTab);
          }
          held = undefined;
          next.reached.resolve({ sessionId, boundTab });
          return next.answer.promise;
        },
      },
      reopener,
      arming: {
        armCapture: (request) => {
          armRequests.push(request.sessionId);
          return err(
            new DebuggenError(
              CODES.INTERNAL,
              'The race rig opens no capture, so nothing may be armed.',
            ),
          );
        },
      },
      progress,
      logger,
    });

    const sent: string[] = [];
    let socketOpen = true;
    const socket: ClientSocket = {
      send: (data) => {
        sent.push(data);
      },
      close: () => {
        socketOpen = false;
      },
      get readyState() {
        return socketOpen ? SOCKET_READY_STATE_OPEN : SOCKET_READY_STATE_CLOSED;
      },
    };
    const principal: DevtoolsPrincipal = {
      role: CLIENT_DEVTOOLS,
      tokenHash: randomBytes(TOKEN_HASH_BYTES).toString('hex'),
      issuedAt: running.now(),
      scope: { kind: 'extension', extensionId: RACE_EXTENSION_ID },
    };
    const panel = unwrap(
      clients.register({ kind: CLIENT_DEVTOOLS, principal, socket }),
      'Registering the race rig panel',
    );

    return {
      directory,
      store: opened,
      sessions,
      manager,
      clients,
      routes,
      principal,
      connection: { principal, clientId: panel.id },
      sent,
      armRequests,
      holdNextMirror: () => {
        if (held !== undefined) {
          throw new Error("The route's next record mirror is already held.");
        }
        const next = {
          reached: deferred<MirrorCall>(),
          answer: deferred<Result<SessionRecord, DebuggenError>>(),
        };
        held = next;
        return { reached: next.reached.promise, answer: next.answer.resolve };
      },
    };
  } catch (cause) {
    if (store !== undefined && !store.isClosed) {
      store.close();
    }
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}

/** Releases a {@link RaceRig}: its connection, its store and its directory. */
async function closeRaceRig(rig: RaceRig): Promise<void> {
  rig.clients.closeAll();
  if (!rig.store.isClosed) {
    rig.store.close();
  }
  await rm(rig.directory, { recursive: true, force: true });
}

/** A session record of the rig, as its manager holds it. */
function rigRecordOf(rig: RaceRig, sessionId: SessionId): SessionRecord {
  const record = unwrap(rig.manager.get(sessionId), 'Reading a race rig session');
  if (record === undefined) {
    throw new Error(`Race rig session ${sessionId} does not exist.`);
  }
  return record;
}

/** One raw row of the rig's `bindings` table, bound-at stamp included. */
interface StampedBindingRow extends BindingRow {
  readonly boundAt: number;
}

/** The rig's whole `bindings` table, read raw and ordered by tab. */
function rigBindingRows(rig: RaceRig): StampedBindingRow[] {
  const rows = rig.store
    .statement('SELECT tab_id, session_id, url, bound_at FROM bindings ORDER BY tab_id')
    .all();
  return rows.map((row) => {
    const tabId = row['tab_id'];
    const sessionId = row['session_id'];
    const url = row['url'];
    const boundAt = row['bound_at'];
    if (
      typeof tabId !== 'number' ||
      typeof sessionId !== 'string' ||
      typeof url !== 'string' ||
      typeof boundAt !== 'number'
    ) {
      throw new Error('A bindings row does not have the shape the schema declares.');
    }
    return { tabId, sessionId, url, boundAt };
  });
}

/** The `session.bound` announcements the rig's panel received at or after `from`, each schema-validated. */
function rigAnnouncementsSince(rig: RaceRig, from: number): SessionBoundPayload[] {
  return rig.sent.slice(from).flatMap((raw) => {
    const message = unwrap(decodeMessage(raw), 'Decoding a frame the race rig panel received');
    return isMessageOfType(message, SESSION_BOUND)
      ? [sessionBoundPayloadSchema.parse(message.payload)]
      : [];
  });
}

/** The binding route's records in the harness's capturing log at or after index `from`. */
function bindingLogSince(from: number): CapturedLogRecord[] {
  return service()
    .logger.records.slice(from)
    .filter((record) => record.fields['subsystem'] === 'binding');
}

/** The refusal of a result expected to be refused. @throws Error When it succeeded. */
function refusalOf<T>(result: Result<T, DebuggenError>, step: string): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`${step} was expected to be refused, and succeeded.`);
  }
  return result.error;
}

/** A tab the rig bound to an open session, as both routing stores held it after the bind. */
interface RigBinding {
  readonly sessionId: SessionId;
  readonly tabId: number;
  readonly url: string;
  readonly row: TabBinding;
  readonly live: TabBindingView;
}

/**
 * Creates an open session on the `created` project's dev server in the rig's
 * store and binds a fresh tab to it by id, through the unheld routes: the row,
 * the live binding and the record's bound tab all stand afterwards.
 */
async function bindRigSession(rig: RaceRig): Promise<RigBinding> {
  const { created } = suite();
  const session = unwrap(
    await rig.manager.create({
      projectRoot: created.project.root,
      question: 'Why does the order list stall after a filter change?',
      devServerUrl: created.devServerUrl,
    }),
    'Creating a race rig session',
  );
  const tabId = freshTab();
  const url = pageOf(created, '/orders');
  const bound = unwrap(
    await rig.routes.handleSessionBind(
      sessionBindPayloadSchema.parse({ tabId, url, origin: created.origin, sessionId: session.id }),
      rig.connection,
    ),
    'Binding the race rig tab',
  );
  expect(bound).toMatchObject({ sessionId: session.id, tabId, url });
  const row = unwrap(rig.sessions.getBindingByTab(tabId), 'Reading the bound row');
  const live = rig.clients.bindingForTab(tabId);
  if (row === undefined || live === undefined) {
    throw new Error('The bind left the tab without its row or its live binding.');
  }
  expect(rigRecordOf(rig, session.id).boundTab).toEqual({ tabId, url });
  return { sessionId: session.id, tabId, url, row, live };
}

/** One way a binding ends, driven through the rig's routes. */
interface DropKind {
  readonly label: string;
  /** The reason a drop that stands is announced with. */
  readonly reason: SessionBoundPayload['reason'];
  /** Sends the frame that ends the tab's binding and answers the handler's outcome. */
  readonly drop: (
    rig: RaceRig,
    tabId: number,
  ) => Promise<Result<{ readonly kind: string }, DebuggenError>>;
}

/** The two frames that end a binding: an unbind, and a navigation to another origin. */
const DROP_KINDS: readonly DropKind[] = [
  {
    label: SESSION_UNBIND,
    reason: REASON_UNBOUND,
    drop: (rig, tabId) =>
      rig.routes.handleSessionUnbind(sessionUnbindPayloadSchema.parse({ tabId }), rig.connection),
  },
  {
    label: `a cross-origin ${TAB_NAVIGATED}`,
    reason: REASON_ORIGIN_CHANGED,
    drop: (rig, tabId) =>
      rig.routes.handleTabNavigated(
        tabNavigatedPayloadSchema.parse({ tabId, url: pageOf(suite().capturing, '/reports') }),
        rig.connection,
      ),
  },
];

/** The record mirror refusal every race case answers the held call with. */
function refusedMirror(): Result<SessionRecord, DebuggenError> {
  return err(new DebuggenError(CODES.STORE_ERROR, 'The race rig refused the record mirror.'));
}

describe('binding restoration racing session.end', () => {
  let rig: RaceRig | undefined;

  beforeEach(async () => {
    rig = await openRaceRig();
  });

  afterEach(async () => {
    const current = rig;
    rig = undefined;
    if (current !== undefined) {
      await closeRaceRig(current);
    }
  });

  /** The current case's rig. @throws Error When `beforeEach` did not build it. */
  function currentRig(): RaceRig {
    if (rig === undefined) {
      throw new Error('The race case did not build its rig.');
    }
    return rig;
  }

  for (const kind of DROP_KINDS) {
    it(`lets a session.end that commits while ${kind.label} awaits its record mirror stand once the mirror is refused: nothing is restored or announced and the drop answers ignored`, async () => {
      const current = currentRig();
      const bound = await bindRigSession(current);
      const sentMark = current.sent.length;
      const logMark = service().logger.records.length;
      const held = current.holdNextMirror();

      // The drop removes the row, releases the live binding and then awaits
      // the record mirror, which the rig holds open.
      const dropping = kind.drop(current, bound.tabId);
      expect(await held.reached).toEqual({ sessionId: bound.sessionId, boundTab: undefined });
      expect(rigBindingRows(current)).toEqual([]);
      expect(current.clients.bindingForTab(bound.tabId)).toBeUndefined();

      // Meanwhile the real session.end commits `ended` without a bound tab,
      // removing the session's binding rows in the same store transaction.
      const ended = unwrap(await current.manager.end(bound.sessionId), 'Ending the session');
      expect(ended.session.status).toBe('ended');
      expect(ended.session.boundTab).toBeUndefined();

      // Only now is the record mirror refused.
      held.answer(refusedMirror());
      expect(unwrap(await dropping, `Answering ${kind.label}`)).toEqual({ kind: 'ignored' });

      // The end's outcome stands in both routing stores and on the record.
      expect(
        unwrap(current.sessions.getBindingByTab(bound.tabId), 'Reading the tab row'),
      ).toBeUndefined();
      expect(
        unwrap(current.sessions.getBindingBySession(bound.sessionId), 'Reading the session row'),
      ).toBeUndefined();
      expect(rigBindingRows(current)).toEqual([]);
      expect(current.clients.bindingForTab(bound.tabId)).toBeUndefined();
      const record = rigRecordOf(current, bound.sessionId);
      expect(record.status).toBe('ended');
      expect(record.boundTab).toBeUndefined();

      // Nobody is told of a drop the end already made; the route logged the
      // outcome at info, by ids alone.
      expect(rigAnnouncementsSince(current, sentMark)).toEqual([]);
      const logged = bindingLogSince(logMark);
      expect(logged.filter((entry) => entry.level === 'error')).toEqual([]);
      expect(
        logged.filter(
          (entry) =>
            entry.level === 'info' &&
            entry.message.includes('ended while its binding was being dropped'),
        ),
      ).toHaveLength(1);
      const { capturing, created } = suite();
      for (const entry of logged) {
        expect(entry.line).not.toContain(created.origin);
        expect(entry.line).not.toContain(capturing.origin);
      }

      // The tab is unbound for good: a second unbind has nothing left to drop.
      expect(
        unwrap(
          await current.routes.handleSessionUnbind(
            sessionUnbindPayloadSchema.parse({ tabId: bound.tabId }),
            current.connection,
          ),
          'Unbinding again',
        ),
      ).toEqual({ kind: 'ignored' });
      expect(rigAnnouncementsSince(current, sentMark)).toEqual([]);
      expect(current.armRequests).toEqual([]);
    });

    it(`restores the row, its bound-at stamp and the live binding when ${kind.label} has its record mirror refused on a session that stays open, returns the refusal and drops the binding on retry`, async () => {
      const current = currentRig();
      const bound = await bindRigSession(current);
      const recordBefore = rigRecordOf(current, bound.sessionId);
      const rowsBefore = rigBindingRows(current);
      const sentMark = current.sent.length;
      const held = current.holdNextMirror();

      const dropping = kind.drop(current, bound.tabId);
      expect(await held.reached).toEqual({ sessionId: bound.sessionId, boundTab: undefined });
      expect(rigBindingRows(current)).toEqual([]);
      expect(current.clients.bindingForTab(bound.tabId)).toBeUndefined();

      // The session is still open when the record mirror is refused.
      held.answer(refusedMirror());
      expect(refusalOf(await dropping, kind.label).code).toBe(CODES.STORE_ERROR);

      // Both routing stores are exactly as before the drop, the record never
      // changed, and nothing was announced.
      expect(unwrap(current.sessions.getBindingByTab(bound.tabId), 'Reading the tab row')).toEqual(
        bound.row,
      );
      expect(rigBindingRows(current)).toEqual(rowsBefore);
      expect(current.clients.bindingForTab(bound.tabId)).toMatchObject({
        tabId: bound.tabId,
        sessionId: bound.sessionId,
        url: bound.url,
        boundBy: current.principal.tokenHash,
        boundAt: bound.live.boundAt,
      });
      expect(rigRecordOf(current, bound.sessionId)).toEqual(recordBefore);
      expect(rigAnnouncementsSince(current, sentMark)).toEqual([]);

      // The retried drop finds the binding, and this time the record takes it.
      const retryMark = current.sent.length;
      expect(unwrap(await kind.drop(current, bound.tabId), `Retrying ${kind.label}`)).toMatchObject(
        { kind: 'dropped' },
      );
      expect(rigBindingRows(current)).toEqual([]);
      expect(current.clients.bindingForTab(bound.tabId)).toBeUndefined();
      const record = rigRecordOf(current, bound.sessionId);
      expect(record.boundTab).toBeUndefined();
      expect(record.status).toBe(recordBefore.status);
      expect(
        rigAnnouncementsSince(current, retryMark).map((payload) => ({
          sessionId: payload.sessionId,
          tabId: payload.tabId,
          reason: payload.reason,
        })),
      ).toEqual([{ sessionId: bound.sessionId, tabId: bound.tabId, reason: kind.reason }]);
      expect(current.armRequests).toEqual([]);
    });
  }
});

/* -------------------------------------------------------------------------------------------------
 * Privacy: no raw inspected URL or selected-element text is stored or announced
 * ---------------------------------------------------------------------------------------------- */

/**
 * The query values planted in URLs a selected element's labels embed. Neither
 * is secret-shaped, so no content rule masks them: only URL redaction keeps
 * them out of the store and off the wire.
 */
const EMBEDDED_QUERY_VALUE = 'samplevalue';
const EMBEDDED_SELECTOR_VALUE = 'QQZZ7';

/** One selected-element descriptor whose labels embed URLs, and what the service must keep of it. */
interface EmbeddedUrlCase {
  readonly label: string;
  /** The descriptor as the panel (or the editor's `session.create`) sends it. */
  readonly target: SelectedTarget;
  /** The descriptor the record and every `session.updated` must carry. */
  readonly expected: SelectedTarget;
  /** The masked `key=?` forms the stored record and every frame must show. */
  readonly masked: readonly string[];
}

/** A page on the dev server at `origin`. */
function pageAt(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

/**
 * Descriptors whose labels embed URLs, each built for the dev server at a
 * given origin: a sentence quoting an origin-relative link, selected through
 * an attribute selector that names another; and a link whose visible text is
 * its own absolute address. Every embedded query value must become `?` per
 * key, with keys, paths and the surrounding text kept — the rule the document
 * URL itself is held to (AAP §0.5.2).
 */
const EMBEDDED_URL_CASES: readonly ((origin: string) => EmbeddedUrlCase)[] = [
  (origin) => ({
    label: 'a relative link quoted in the text and one named by the selector',
    target: {
      selector: `a[href="/p?id=${EMBEDDED_SELECTOR_VALUE}"]`,
      tagName: 'a',
      text: `Visit /reset?coupon=${EMBEDDED_QUERY_VALUE}`,
      componentChain: ['LinkRow'],
      url: pageAt(origin, '/reset'),
    },
    expected: {
      selector: 'a[href="/p?id=?"]',
      tagName: 'a',
      text: 'Visit /reset?coupon=?',
      componentChain: ['LinkRow'],
      url: pageAt(origin, '/reset'),
    },
    masked: ['coupon=?', 'id=?'],
  }),
  (origin) => ({
    label: 'a link whose text is its own absolute address',
    target: {
      selector: 'main > section > a',
      tagName: 'a',
      text: pageAt(origin, `/reset?coupon=${EMBEDDED_QUERY_VALUE}`),
      componentChain: [],
      url: pageAt(origin, '/reset'),
    },
    expected: {
      selector: 'main > section > a',
      tagName: 'a',
      text: pageAt(origin, '/reset?coupon=?'),
      componentChain: [],
      url: pageAt(origin, '/reset'),
    },
    masked: ['coupon=?'],
  }),
];

/**
 * Asserts one stored or broadcast text holds no embedded query value and
 * shows every masked form the case expects.
 */
function expectEmbeddedUrlsMasked(text: string, where: string, masked: readonly string[]): void {
  for (const leaked of [EMBEDDED_QUERY_VALUE, EMBEDDED_SELECTOR_VALUE]) {
    expect(text, `${where} leaks ${leaked}`).not.toContain(leaked);
  }
  for (const form of masked) {
    expect(text, `${where} lacks ${form}`).toContain(form);
  }
}

/**
 * Waits for a `session.updated` of `sessionId` carrying `expected` at or after
 * `from`, then asserts every `session.updated` of that session since `from`
 * carries the redacted descriptor and nothing of the raw one.
 */
async function expectUpdatesMasked(
  receiver: HarnessWsClient,
  sessionId: SessionId,
  from: number,
  embedded: EmbeddedUrlCase,
  where: string,
): Promise<void> {
  await waitFor(
    receiver,
    REPLAY_SESSION_UPDATED,
    (message, index) =>
      index >= from &&
      message.payload.session.id === sessionId &&
      isDeepStrictEqual(message.payload.session.target, embedded.expected),
  );
  const updates = framesSince(receiver, REPLAY_SESSION_UPDATED, from).filter(
    (message) => message.payload.session.id === sessionId,
  );
  expect(updates.length, where).toBeGreaterThan(0);
  for (const update of updates) {
    expect(update.payload.session.target, where).toEqual(embedded.expected);
    expectEmbeddedUrlsMasked(JSON.stringify(update), where, embedded.masked);
  }
}

describe('privacy of the inspected document', () => {
  it('stores, mirrors and announces only the query-redacted URL on bind, same-origin navigation and an origin change', async () => {
    const { capturing, created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const rawUrl = pageOf(created, '/orders?token=abc&sort=price');
    const redactedUrl = pageOf(created, '/orders?token=?&sort=?');
    const editorMark = created.editor.received.length;

    // Bound by origin from the raw URL, recorded and announced redacted.
    const bound = await bind(client, { tabId, url: rawUrl });
    expect(expectEstablished(client, bound, created.sessionId, tabId).url).toBe(redactedUrl);
    expect(rowsFor({ tabId })).toEqual([{ tabId, sessionId: created.sessionId, url: redactedUrl }]);
    expect(storedBindingOfTab(tabId)?.tab).toEqual({ tabId, url: redactedUrl });
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId, url: redactedUrl });
    await settleAll(created.editor);
    expect(
      announcementsSince(created.editor, editorMark).filter((payload) => payload.tabId === tabId),
    ).toEqual([{ sessionId: created.sessionId, tabId, url: redactedUrl, reason: REASON_BOUND }]);

    // A redundant re-bind from the same raw URL is still recognised as one.
    const again = await bind(client, { tabId, url: rawUrl });
    expectEstablished(client, again, created.sessionId, tabId);
    expect(
      announcementsSince(client, again.mark).filter((payload) => payload.reason !== REASON_BOUND),
    ).toEqual([]);

    // A same-origin navigation keeps the binding under the redacted new URL,
    // its fragment masked as well as its query values.
    const nextRaw = pageOf(created, '/orders/7?token=def&page=2#receipt-q7x');
    const nextRedacted = pageOf(created, '/orders/7?token=?&page=?#?');
    const navigated = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: nextRaw }),
    );
    expect(navigated.errors).toEqual([]);
    expect(announcementsSince(client, navigated.mark)).toEqual([
      { sessionId: created.sessionId, tabId, url: nextRedacted, reason: REASON_NAVIGATED },
    ]);
    expect(rowsFor({ tabId })).toEqual([
      { tabId, sessionId: created.sessionId, url: nextRedacted },
    ]);
    expect(recordOf(created.sessionId).boundTab).toEqual({ tabId, url: nextRedacted });

    // Leaving the origin drops the binding and announces the new document redacted too.
    const awayRaw = pageOf(capturing, '/reports?invite=ghi');
    const left = await sendSettled(
      client,
      TAB_NAVIGATED,
      tabNavigatedPayloadSchema.parse({ tabId, url: awayRaw }),
    );
    expect(left.errors).toEqual([]);
    expect(announcementsSince(client, left.mark)).toEqual([
      {
        sessionId: created.sessionId,
        tabId,
        url: pageOf(capturing, '/reports?invite=?'),
        reason: REASON_ORIGIN_CHANGED,
      },
    ]);

    // No query value, fragment or raw URL reached any stored column or frame.
    const stored = storedText(created.sessionId);
    const heard = JSON.stringify([client.received, created.editor.received]);
    for (const leaked of [
      'token=abc',
      'sort=price',
      'token=def',
      'page=2',
      'receipt-q7x',
      'invite=ghi',
    ]) {
      expect(stored, leaked).not.toContain(leaked);
      expect(heard, leaked).not.toContain(leaked);
    }
  });

  it('stores a selected target with its URL query and secret-shaped text redacted', async () => {
    const { created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const pageUrl = pageOf(created, '/orders');
    expectEstablished(
      client,
      await bind(client, { tabId, url: pageUrl }),
      created.sessionId,
      tabId,
    );

    const secret = randomSecretLike('bearer');
    const [, secretBody] = secret.split(' ');
    if (secretBody === undefined) {
      throw new Error('The assembled bearer credential has no body.');
    }
    const target: SelectedTarget = {
      selector: 'main > section > button',
      tagName: 'button',
      text: secret,
      componentChain: ['OrderRow', 'OrderTable'],
      url: pageOf(created, '/orders?token=abc&sort=price#row-7'),
    };
    const mark = client.received.length;
    const editorMark = created.editor.received.length;
    const selected = await sendSettled(
      client,
      TARGET_SELECTED,
      targetSelectedPayloadSchema.parse({ sessionId: created.sessionId, target }),
    );
    expect(selected.errors).toEqual([]);

    // The record holds the redacted descriptor: the query values and the
    // fragment masked, the credential in the text replaced, the rest intact.
    const expected: SelectedTarget = {
      selector: target.selector,
      tagName: target.tagName,
      text: scrub(secret),
      componentChain: [...target.componentChain],
      url: pageOf(created, '/orders?token=?&sort=?#?'),
    };
    expect(expected.text).toContain(REDACTION_MARKER);
    expect(recordOf(created.sessionId).target).toEqual(expected);

    // So does the `session.updated` fan-out, to the panel and to the editor.
    for (const [receiver, from] of [
      [client, mark],
      [created.editor, editorMark],
    ] as const) {
      const updated = await waitFor(
        receiver,
        REPLAY_SESSION_UPDATED,
        (message, index) =>
          index >= from && message.payload.session.target?.selector === target.selector,
      );
      expect(updated.payload.session.target).toEqual(expected);
    }

    // The credential and the query values are nowhere in the store or on the wire.
    const stored = storedText(created.sessionId);
    const heard = JSON.stringify([client.received.slice(mark), created.editor.received]);
    for (const leaked of [secretBody, 'token=abc', 'sort=price', 'row-7']) {
      expect(stored, 'stored').not.toContain(leaked);
      expect(heard, 'broadcast').not.toContain(leaked);
    }
  });

  it('stores the target a session.create carries redacted', async () => {
    const running = service();
    const project = await running.copyFixtureProject();
    // `session.create` resolves the project's dev server, so it needs a live one.
    unwrap(await running.launchDevServer(project.root), 'Launching the dev server');
    const secret = randomSecretLike('jwt');
    const target: SelectedTarget = {
      selector: '#checkout > button',
      tagName: 'button',
      text: `Token ${secret}`,
      componentChain: ['CheckoutButton'],
      url: pageOf(suite().created, '/checkout?coupon=abc&step=2'),
    };

    const session = await running.createSession({
      projectRoot: project.root,
      question: 'Why does checkout hang after the second step?',
      target,
    });

    const expected: SelectedTarget = {
      selector: target.selector,
      tagName: target.tagName,
      text: scrub(target.text),
      componentChain: [...target.componentChain],
      url: pageOf(suite().created, '/checkout?coupon=?&step=?'),
    };
    expect(expected.text).toContain(REDACTION_MARKER);
    expect(session.target).toEqual(expected);
    expect(recordOf(session.id).target).toEqual(expected);
    const stored = storedText(session.id);
    for (const leaked of [secret, 'coupon=abc', 'step=2']) {
      expect(stored).not.toContain(leaked);
    }
  });

  it('masks the query value of every URL a selected target’s text or selector embeds, in the record and in every session.updated', async () => {
    const { created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    // Bound to the document every case's element is of: a selection of another
    // document is refused before anything is recorded.
    expectEstablished(
      client,
      await bind(client, { tabId, url: pageOf(created, '/reset') }),
      created.sessionId,
      tabId,
    );
    const firstMark = client.received.length;
    const firstEditorMark = created.editor.received.length;

    for (const build of EMBEDDED_URL_CASES) {
      const embedded = build(created.origin);
      const mark = client.received.length;
      const editorMark = created.editor.received.length;
      const selected = await sendSettled(
        client,
        TARGET_SELECTED,
        targetSelectedPayloadSchema.parse({
          sessionId: created.sessionId,
          target: embedded.target,
        }),
      );
      expect(selected.errors, embedded.label).toEqual([]);

      // The stored record holds the masked descriptor, and its raw JSON holds
      // no embedded query value …
      expect(recordOf(created.sessionId).target, embedded.label).toEqual(embedded.expected);
      expectEmbeddedUrlsMasked(
        storedRecordJson(created.sessionId),
        `the stored record (${embedded.label})`,
        embedded.masked,
      );

      // … and so does every `session.updated` the panel and the editor received.
      await expectUpdatesMasked(
        client,
        created.sessionId,
        mark,
        embedded,
        `the panel (${embedded.label})`,
      );
      await expectUpdatesMasked(
        created.editor,
        created.sessionId,
        editorMark,
        embedded,
        `the editor (${embedded.label})`,
      );
    }

    // Nothing either connection heard, and no stored column, holds a raw value.
    const heard = JSON.stringify([
      client.received.slice(firstMark),
      created.editor.received.slice(firstEditorMark),
    ]);
    const stored = storedText(created.sessionId);
    for (const leaked of [EMBEDDED_QUERY_VALUE, EMBEDDED_SELECTOR_VALUE]) {
      expect(heard, 'broadcast').not.toContain(leaked);
      expect(stored, 'stored').not.toContain(leaked);
    }
  });

  it('accepts a selection of the document the tab shows though its path carries a secret the binding holds scrubbed', async () => {
    const { created } = suite();
    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const secret = randomSecretLike('jwt');
    const page = pageOf(created, `/invite/${secret}`);
    const bound = expectEstablished(
      client,
      await bind(client, { tabId, url: page }),
      created.sessionId,
      tabId,
    );
    // The binding holds the path scrubbed; the page reports its own URL, raw.
    expect(bound.url).not.toContain(secret);
    expect(storedBindingOfTab(tabId)?.tab.url).toBe(bound.url);

    const selection = probeTarget(page, 'secret-path');
    const recorded = redactSelectedTarget(selection);
    expect(recorded.url).toBe(bound.url);
    const selected = await select(client, created.sessionId, selection);
    expect(selected.errors).toEqual([]);
    await waitFor(
      client,
      REPLAY_SESSION_UPDATED,
      (message, index) =>
        index >= selected.mark && isDeepStrictEqual(message.payload.session.target, recorded),
    );
    expect(recordOf(created.sessionId).target).toEqual(recorded);
    expect(storedText(created.sessionId)).not.toContain(secret);

    // Another document of the same origin is still another document.
    const elsewhere = await select(
      client,
      created.sessionId,
      probeTarget(pageOf(created, '/orders'), 'elsewhere'),
    );
    expectRefused(elsewhere, CODES.TAB_NOT_BOUND);
    expect(recordOf(created.sessionId).target).toEqual(recorded);
  });

  it('masks the query value of every URL the labels of a session.create target embed, in the record and in every session.updated', async () => {
    const running = service();
    for (const build of EMBEDDED_URL_CASES) {
      // One project per case: `session.create` resolves the project's dev
      // server, so each needs a live one, and the descriptor names its page.
      const project = await running.copyFixtureProject();
      const launched = unwrap(
        await running.launchDevServer(project.root),
        'Launching the dev server',
      );
      const embedded = build(new URL(launched.devServerUrl).origin);
      const editor = await running.editor(project.root);
      const editorMark = editor.received.length;

      const session = await running.createSession({
        projectRoot: project.root,
        question: 'Why does following this link take so long?',
        target: embedded.target,
      });

      // The answer, the record and its raw stored JSON hold the masked descriptor …
      expect(session.target, embedded.label).toEqual(embedded.expected);
      expect(recordOf(session.id).target, embedded.label).toEqual(embedded.expected);
      expectEmbeddedUrlsMasked(
        storedRecordJson(session.id),
        `the stored record (${embedded.label})`,
        embedded.masked,
      );

      // … and every `session.updated` the project's editor received carries no raw value.
      await expectUpdatesMasked(
        editor,
        session.id,
        editorMark,
        embedded,
        `the editor (${embedded.label})`,
      );
      const heard = JSON.stringify(editor.received.slice(editorMark));
      for (const leaked of [EMBEDDED_QUERY_VALUE, EMBEDDED_SELECTOR_VALUE]) {
        expect(heard, 'broadcast').not.toContain(leaked);
        expect(storedText(session.id), 'stored').not.toContain(leaked);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Replay on bind
 * ---------------------------------------------------------------------------------------------- */

describe('replay on bind', () => {
  it('replays the stored record, progress, analysis and panel to a freshly bound panel, appending nothing', async () => {
    const { generated } = suite();
    const progressBefore = progressOf(generated.sessionId);
    expect(progressBefore.length).toBeGreaterThan(0);
    expect(recordOf(generated.sessionId).status).toBe('generated');

    const tabId = freshTab();
    const { client } = await openPanel(tabId);
    const url = pageOf(generated, '/');
    const editorMark = generated.editor.received.length;

    const bound = await bind(client, { tabId, url });
    expectEstablished(client, bound, generated.sessionId, tabId);

    // After the establishment, exactly the reopen replay, in its fixed order.
    const received = client.received;
    const establishedAt = received.findIndex(
      (message, index) =>
        index >= bound.mark &&
        isMessageOfType(message, SESSION_BOUND) &&
        message.payload.sessionId === generated.sessionId &&
        message.payload.tabId === tabId,
    );
    expect(establishedAt).toBeGreaterThanOrEqual(bound.mark);
    const replayFrom = establishedAt + 1;
    expect(typesSince(client, replayFrom)).toEqual([
      REPLAY_SESSION_UPDATED,
      ...progressBefore.map(() => REPLAY_SESSION_PROGRESS),
      REPLAY_ANALYSIS_COMPLETED,
      REPLAY_PANEL_GENERATED,
    ]);

    // The record the panel re-renders from already shows its own tab.
    const [updated] = framesSince(client, REPLAY_SESSION_UPDATED, replayFrom);
    expect(updated?.payload.session.id).toBe(generated.sessionId);
    expect(updated?.payload.session.boundTab).toEqual({ tabId, url });

    // The stored rows, verbatim and in stored order.
    expect(
      framesSince(client, REPLAY_SESSION_PROGRESS, replayFrom).map((message) => ({
        stage: message.payload.stage,
        status: message.payload.status,
        message: message.payload.message,
      })),
    ).toEqual(
      progressBefore.map((row) => ({ stage: row.stage, status: row.status, message: row.message })),
    );

    // The stored analysis and panel, as stored.
    const [analysis] = framesSince(client, REPLAY_ANALYSIS_COMPLETED, replayFrom);
    expect(analysis?.payload).toEqual({
      sessionId: generated.sessionId,
      analysis: generated.analysis,
    });
    const [panel] = framesSince(client, REPLAY_PANEL_GENERATED, replayFrom);
    expect(panel?.payload).toEqual({
      sessionId: generated.sessionId,
      panelId: generated.panel.id,
      panel: generated.panel,
    });

    // Replaying wrote nothing, and the editor — which already holds this state — was not replayed to.
    expect(progressOf(generated.sessionId)).toEqual(progressBefore);
    expect(recordOf(generated.sessionId).status).toBe('generated');
    await settleAll(generated.editor);
    const editorTypes = typesSince(generated.editor, editorMark);
    expect(editorTypes).toContain(SESSION_BOUND);
    expect(editorTypes).not.toContain(REPLAY_SESSION_PROGRESS);
    expect(editorTypes).not.toContain(REPLAY_ANALYSIS_COMPLETED);
    expect(editorTypes).not.toContain(REPLAY_PANEL_GENERATED);
  });
});
