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
 * `target.request` has no service producer (the harness uses a client-sent one
 * only as its ordering barrier), so the bound-tab routing is asserted through
 * `agent.config` and the session fan-out, which resolve their recipient through
 * the same binding.
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
 * ## Vocabulary
 *
 * No binding reason, client kind or message type is spelled here: reasons and
 * kinds are destructured from protocol's ordered tuples, the replay's message
 * types from `REPLAY_MESSAGE_ORDER`, error codes from `errorCodeSchema`, and
 * every other message type is resolved from protocol's registry by the payload
 * schema it carries. Credentials come from the harness; nothing secret-shaped
 * appears in this file and `process.env` is never touched.
 */

import { isDeepStrictEqual } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  errorCodeSchema,
  isMessageOfType,
  sessionBindPayloadSchema,
  sessionBoundPayloadSchema,
  sessionUnbindPayloadSchema,
  tabNavigatedPayloadSchema,
  targetSelectedPayloadSchema,
} from '@debuggen/protocol';
import type {
  AgentConfigPayload,
  AnalysisResult,
  ErrorPayload,
  MessagePayload,
  MessageType,
  PanelSpec,
  SelectedTarget,
  SessionBoundPayload,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import { isErr, newPanelId, newSessionId } from '@debuggen/shared';
import type { CaptureId, DebuggenError, Result, SessionId } from '@debuggen/shared';
import { computeCaptureSummary } from '@debuggen/telemetry';

import { REPLAY_MESSAGE_ORDER } from '../../src/sessions/reopen.js';
import type { ProgressEntry, TabBinding } from '../../src/store/sessions-repo.js';
import {
  readFixtureJson,
  readTelemetryBatch,
  startHarness,
  waitFor,
  waitUntil,
} from './harness.js';
import type {
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
const TARGET_SELECTED = messageTypeOf(targetSelectedPayloadSchema);

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
 * pushed to this connection has arrived — before anything is read.
 */
async function sendSettled<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  payload: MessagePayload<K>,
): Promise<Settled> {
  const mark = client.received.length;
  const receipt = client.send(type, payload);
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
    // Nor can it claim the session by naming it from a page of another origin.
    expectRefused(
      await bind(intruder.client, {
        tabId: freshTab(),
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

    // Authority is the credential: a second connection of the owner's credential,
    // announcing a different tab in its hello, acts on the session without binding.
    const sibling = await openPanel(freshTab(), owner.credential);
    const ownerMark = owner.client.received.length;
    const target = targetOn(url);
    const selected = await sendSettled(
      sibling.client,
      TARGET_SELECTED,
      targetSelectedPayloadSchema.parse({ sessionId: created.sessionId, target }),
    );
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

    const never = await sendSettled(
      client,
      SESSION_UNBIND,
      sessionUnbindPayloadSchema.parse({ tabId: freshTab() }),
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
