/**
 * Producer replay across the real service boundary: what the service tells the
 * two telemetry producers — the Node preload over its `server-agent`
 * connection, the page agent through the DevTools connection that relays it —
 * when a configuration could not be delivered, and what it tells them after a
 * restart it did not see coming.
 *
 * AAP §0.4.2 has no producer acknowledgement message, so the service judges a
 * configuration by its connection's delivery receipt and replays what no
 * connection took (AAP §0.5.1: runtime hooks are disabled, not merely idled;
 * §0.5.5: a disconnected producer reconnects). This suite owns what only the
 * composed service can show, end to end through `src/server/ws.ts`,
 * `src/instrumentation/service.ts`, `src/cleanup/cleanup.ts` and `src/main.ts`:
 *
 * - **A preload that was away when a capture stopped** is sent the capture-less
 *   `server-agent.config` the moment it reconnects, and the ended session's
 *   `partial` cleanup verdict is upgraded to `clean` once it has taken it.
 * - **A DevTools connection that was away when a capture stopped** is sent the
 *   dormant `agent.config` it was owed the moment the same credential
 *   reconnects.
 * - **Nothing is pushed unasked**: a preload whose credential this service
 *   issued, and which it neither armed nor owes a disarm, receives nothing.
 * - **A restart settles every interrupted capture before serving**: no
 *   capture is continued — each is failed and released, with or without its
 *   plan — so a preload that survived the restart is disabled as it reconnects,
 *   a tab bound to the session again is sent the dormant configuration, and the
 *   session's cleanup is `clean` only once both producers have taken theirs;
 *   one whose producers never return ends `partial`.
 *
 * ## Rules ruling
 *
 * - **User rules (AAP §0.10).** `review_rules` answers "No user rules
 *   provided.", so no user rule governs this file; the §0.10 baseline does.
 * - **Gate membership.** Collected by the `local-service-integration` project
 *   (`pnpm test:integration`, inside `pnpm verify`) and part of the `tsc -b`,
 *   `eslint --max-warnings 0` and `prettier --check .` programs.
 * - **No committed secret.** Every credential is minted at run time through the
 *   service's own auth service; no token-shaped literal appears below.
 * - **No demo knowledge.** The harness's sample project and invented temporary
 *   projects only; nothing here names the demo application.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  DORMANT_AGENT_HOOK_CONFIG,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  createAdapterRegistry,
  normalizePlan,
} from '@debuggen/instrumentation';
import type { InstrumentationPlan, InstrumentationPlanInput } from '@debuggen/instrumentation';
import {
  CLEANUP_STATUSES,
  PROTOCOL_VERSION,
  SESSION_STATUSES,
  WS_PATH,
  createEnvelope,
  decodeMessage,
  encodeMessage,
  isMessageOfType,
  parseAgentConfigPayload,
  parseServerAgentConfigPayload,
} from '@debuggen/protocol';
import type {
  AgentConfigPayload,
  ProtocolMessage,
  ServerAgentConfigPayload,
  SessionRecord,
} from '@debuggen/protocol';
import { isErr, isOk, newId, newProducerId, noopLogger, unwrap } from '@debuggen/shared';

import { LOG_BINDING_KEYS } from '../../src/logging.js';
import { startService } from '../../src/main.js';
import type { ServiceHandle } from '../../src/main.js';
import { createSessionsRepo } from '../../src/store/sessions-repo.js';
import {
  HARNESS_TIMEOUTS,
  chromeExtensionOrigin,
  newExtensionId,
  startHarness,
  waitFor,
  waitUntil,
} from './harness.js';
import type { DevtoolsCredential, Harness, HarnessWsClient } from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary and constants
 * ---------------------------------------------------------------------------------------------- */

/** Reads a closed vocabulary into a name → value map, so no status literal is restated. */
function vocabulary<T extends string>(values: readonly T[]): { readonly [K in T]: K } {
  return Object.fromEntries(values.map((value) => [value, value])) as { readonly [K in T]: K };
}

/** Session statuses, from `@debuggen/protocol`. */
const SESSION = vocabulary(SESSION_STATUSES);

/** Cleanup statuses, from `@debuggen/protocol`. */
const CLEANUP = vocabulary(CLEANUP_STATUSES);

/** The question every session asks; nothing in the service may branch on it (AAP §0.5.4). */
const QUESTION = 'Why does the report take so long to appear after I press refresh?';

/** The message the WebSocket server logs once it has processed a socket close. */
const CONNECTION_CLOSED_LOG = 'a WebSocket connection closed';

/** The prefix of the per-document ids the simulated page agents report in `agent.ready`. */
const DOCUMENT_ID_PREFIX = 'doc';

/** The first inspected tab id; every session gets the next one. */
const FIRST_TAB_ID = 8_300;

/** How long the restart cases wait for a frame on a raw socket. */
const RAW_FRAME_TIMEOUT_MS = 5_000;

/** The dev-server URL the restart cases' sessions record; nothing listens on it. */
const DEV_SERVER_URL = 'http://127.0.0.1:3000';

/** The inspected tab the restart case binds. */
const RESTART_TAB_ID = 8_900;

/**
 * A runtime-only plan in the authoring shape: an interaction signal the page
 * agent collects and a database signal only the preload collects, every action
 * targetless, so the plan edits no file and arming it configures both producers.
 */
const RUNTIME_PLAN_INPUT: InstrumentationPlanInput = {
  objective: 'Observe the interaction and its database queries without editing code',
  capture: ['click event timing', 'database query spans'],
  instrumentationTargets: [
    { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
    { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'db-query-tracking' },
  ],
};

/* -------------------------------------------------------------------------------------------------
 * Shared probes
 * ---------------------------------------------------------------------------------------------- */

/** Whether every hook of a page-agent configuration is off: the dormant configuration. */
function isDormant(payload: AgentConfigPayload): boolean {
  return Object.values(payload.hooks).every((enabled) => enabled === false);
}

/* -------------------------------------------------------------------------------------------------
 * Part 1 — reconnect replay, through the harness
 * ---------------------------------------------------------------------------------------------- */

let harness: Harness;
let nextTabId = FIRST_TAB_ID;

/** The harness's sample project, its launched dev server and its preload credential. */
interface ProjectUnderTest {
  readonly root: string;
  readonly devServerUrl: string;
  readonly origin: string;
  readonly serverAgentToken: string;
}

/** A session in `ready`, with a bound DevTools tab whose page agent reported. */
interface SessionUnderTest {
  readonly id: string;
  readonly tabId: number;
  readonly devtools: HarnessWsClient;
  /** The DevTools credential that bound the tab, so the same service worker can reconnect. */
  readonly credential: DevtoolsCredential;
}

let project: ProjectUnderTest;
let preload: HarnessWsClient;

/** Opens a `server-agent` connection for the project with its scoped credential. */
async function connectPreload(): Promise<HarnessWsClient> {
  const client = await harness.ws({
    client: 'server-agent',
    projectRoot: project.root,
    token: project.serverAgentToken,
  });
  if (!client.authenticated) {
    throw new Error(`The server-agent connection was not accepted: ${client.describe()}`);
  }
  return client;
}

/** The message the WebSocket server logs once it has authenticated a connection. */
const CONNECTION_AUTHENTICATED_LOG = 'authenticated a WebSocket connection';

/**
 * How many `server-agent` connections the service has authenticated and not
 * yet seen close, read from its own log: the suite's preload client, and the
 * real Node preload the launcher attaches to the stand-in dev server.
 */
function openServerAgentConnections(): number {
  const ofServerAgent = (message: string): number =>
    harness.logger
      .withMessage(message)
      .filter((record) => record.fields[LOG_BINDING_KEYS.client] === 'server-agent').length;
  return ofServerAgent(CONNECTION_AUTHENTICATED_LOG) - ofServerAgent(CONNECTION_CLOSED_LOG);
}

/** Launches the project's stand-in dev server, preload attached, and records its URL. */
async function launchDevServer(): Promise<void> {
  const launched = await harness.launchDevServer(project.root);
  if (isErr(launched)) {
    throw new Error(
      `devServer.launch was refused (${launched.error.code}): ${launched.error.message}`,
    );
  }
  const { devServerUrl } = launched.value;
  project = { ...project, devServerUrl, origin: new URL(devServerUrl).origin };
}

/** Closes a client and waits until the service has processed the close. */
async function disconnect(client: HarnessWsClient): Promise<void> {
  const closesBefore = harness.logger.withMessage(CONNECTION_CLOSED_LOG).length;
  await client.close();
  await waitUntil(
    () =>
      harness.logger.withMessage(CONNECTION_CLOSED_LOG).length > closesBefore ? true : undefined,
    'the service has processed the socket close',
  );
}

/**
 * Creates a session on the project and brings it to `ready` the way the
 * product does: the pipeline plans and installs, a DevTools connection binds a
 * tab, and the tab's page agent reports a document whose hook was installed
 * before React.
 */
async function openSession(): Promise<SessionUnderTest> {
  const created = await harness.createSession({ projectRoot: project.root, question: QUESTION });
  const tabId = nextTabId;
  nextTabId += 1;
  const { client, credential } = await harness.connectDevtools({ tabId });
  const bound = await harness.bindTab(client, {
    tabId,
    url: project.devServerUrl,
    origin: project.origin,
    sessionId: created.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
  }
  const receipt = client.send('agent.ready', {
    tabId,
    documentId: newId(DOCUMENT_ID_PREFIX),
    producerId: newProducerId(),
    url: project.devServerUrl,
    installedBeforeReact: true,
    reactDetected: true,
  });
  if (isErr(receipt.result)) {
    throw new Error(`agent.ready could not be sent: ${receipt.result.error.message}`);
  }
  if (!(await client.flush()) || client.errorsFor(receipt.id).length > 0) {
    throw new Error(`agent.ready was not accepted: ${client.describe()}`);
  }
  const reached = await harness.waitForSession(
    created.id,
    (record) => record.status === SESSION.ready || record.status === SESSION.failed,
  );
  if (reached.status !== SESSION.ready) {
    throw new Error(`Session ${created.id} was filed "${reached.status}" instead of "ready".`);
  }
  return { id: created.id, tabId, devtools: client, credential };
}

/** Starts a capture and returns its id. */
async function startCapture(sessionId: string): Promise<string> {
  const started = await harness.startCapture(sessionId);
  if (isErr(started)) {
    throw new Error(`capture.start was refused (${started.error.code}): ${started.error.message}`);
  }
  return started.value.captureId;
}

/** Stops the capture and waits for the session to leave the capture and analysis stages. */
async function stopCapture(sessionId: string): Promise<SessionRecord> {
  const stopped = await harness.stopCapture(sessionId);
  if (isErr(stopped)) {
    throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
  }
  return harness.waitForSession(
    sessionId,
    (record) => record.status !== SESSION.capturing && record.status !== SESSION.analyzing,
  );
}

/** Ends a session and returns the cleanup verdict `session.end` answered with. */
async function endSession(sessionId: string): Promise<string> {
  const ended = await harness.endSession(sessionId);
  if (isErr(ended)) {
    throw new Error(`session.end was refused (${ended.error.code}): ${ended.error.message}`);
  }
  return ended.value.cleanup;
}

/** The session as the store holds it. */
function storedSession(sessionId: string): SessionRecord {
  const read = harness.repos.sessions.get(sessionId);
  if (isErr(read) || read.value === undefined) {
    throw new Error(`Session ${sessionId} could not be read from the store.`);
  }
  return read.value;
}

/** The `server-agent.config` payloads a client received from transcript index `from` on. */
function serverConfigsSince(client: HarnessWsClient, from: number): ServerAgentConfigPayload[] {
  return client.received
    .slice(from)
    .flatMap((message) =>
      isMessageOfType(message, 'server-agent.config') ? [message.payload] : [],
    );
}

/** Waits for a `server-agent.config` at index `from` or later satisfying `predicate`. */
async function waitForServerConfig(
  client: HarnessWsClient,
  from: number,
  predicate: (payload: ServerAgentConfigPayload) => boolean,
): Promise<ServerAgentConfigPayload> {
  const message = await waitFor(
    client,
    'server-agent.config',
    (candidate, index) => index >= from && predicate(candidate.payload),
    HARNESS_TIMEOUTS.capture,
  );
  return unwrap(parseServerAgentConfigPayload(message.payload));
}

/** Waits for an `agent.config` at index `from` or later satisfying `predicate`. */
async function waitForAgentConfig(
  client: HarnessWsClient,
  from: number,
  predicate: (payload: AgentConfigPayload) => boolean,
): Promise<AgentConfigPayload> {
  const message = await waitFor(
    client,
    'agent.config',
    (candidate, index) => index >= from && predicate(candidate.payload),
    HARNESS_TIMEOUTS.capture,
  );
  return unwrap(parseAgentConfigPayload(message.payload));
}

describe('producer replay on reconnect', () => {
  beforeAll(async () => {
    harness = await startHarness();
    const root = harness.requireProject().root;
    project = {
      root,
      devServerUrl: '',
      origin: '',
      serverAgentToken: harness.issueServerAgentCredential(root).token,
    };
    await launchDevServer();
  }, HARNESS_TIMEOUTS.pipeline);

  afterAll(async () => {
    await harness.assertNoLeaks();
  });

  it('pushes nothing to a preload of its own credential that it neither armed nor owes', async () => {
    preload = await connectPreload();

    expect(await preload.flush()).toBe(true);
    expect(serverConfigsSince(preload, 0)).toEqual([]);
  });

  it('disables a preload that was away when the capture stopped, upgrading the ended session’s cleanup to clean', async () => {
    const session = await openSession();
    const armedFrom = preload.received.length;
    const captureId = await startCapture(session.id);
    await waitForServerConfig(preload, armedFrom, (payload) => payload.captureId === captureId);

    // Every preload of the project goes away while the capture is open — the
    // suite's client, and the launched dev server with the real preload it
    // carries — and the capture stops without them: the capture-less
    // configuration has no connection to take it.
    await disconnect(preload);
    const stopped = await harness.rawFetch('devServer.stop', {
      body: { projectRoot: project.root },
    });
    expect(stopped.status).toBe(200);
    await waitUntil(
      () => (openServerAgentConnections() === 0 ? true : undefined),
      'every server-agent connection of the project has closed',
      HARNESS_TIMEOUTS.capture,
    );
    await stopCapture(session.id);

    // The runtime-only plan patched no file, but the preload may still hold the
    // capture, so the session's cleanup is not clean yet.
    expect(await endSession(session.id)).toBe(CLEANUP.partial);
    expect(storedSession(session.id).cleanup.status).toBe(CLEANUP.partial);

    // A preload of the project reconnects — under a fresh credential, since
    // stopping the dev server revoked the project's preload credentials: it is
    // sent the capture-less configuration the project still owes at once, and
    // the verdict is upgraded and recorded through the session manager.
    project = {
      ...project,
      serverAgentToken: harness.issueServerAgentCredential(project.root).token,
    };
    preload = await connectPreload();
    const disabled = await waitForServerConfig(
      preload,
      0,
      (payload) => payload.captureId === undefined,
    );
    expect(disabled.sessionId).toBeUndefined();
    const upgraded = await waitUntil(
      () =>
        storedSession(session.id).cleanup.status === CLEANUP.clean
          ? storedSession(session.id)
          : undefined,
      'the ended session’s cleanup verdict has been upgraded to clean',
    );
    expect(upgraded.status).toBe(SESSION.ended);
    expect(upgraded.cleanup.conflicts).toEqual([]);

    // The next session needs a dev server again.
    await launchDevServer();
  });

  it('sends a DevTools connection that was away when the capture stopped the dormant configuration it was owed', async () => {
    const session = await openSession();
    const armedFrom = session.devtools.received.length;
    const captureId = await startCapture(session.id);
    const armed = await waitForAgentConfig(
      session.devtools,
      armedFrom,
      (payload) => payload.captureId === captureId,
    );
    expect(isDormant(armed)).toBe(false);

    // The service worker is suspended while the capture is open, and the
    // capture stops without it: the dormant configuration has no connection to
    // take it.
    await disconnect(session.devtools);
    await stopCapture(session.id);

    // The same credential reconnects: the binding is its credential's, so the
    // connection carries the session again, and is sent the dormant
    // configuration for the capture it was left armed for, without a re-bind.
    const { client: reconnected } = await harness.connectDevtools({
      tabId: session.tabId,
      credential: session.credential,
    });
    const dormant = await waitForAgentConfig(
      reconnected,
      0,
      (payload) => payload.captureId === captureId,
    );
    expect(dormant.sessionId).toBe(session.id);
    expect(isDormant(dormant)).toBe(true);
    expect(dormant.hooks).toEqual(DORMANT_AGENT_HOOK_CONFIG);

    // Nothing is owed any more, so ending the session reports a clean cleanup.
    expect(await endSession(session.id)).toBe(CLEANUP.clean);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Part 2 — a restart, through `startService` itself
 * ---------------------------------------------------------------------------------------------- */

/** Temporary roots and open handles the restart cases clean up after themselves. */
const roots: string[] = [];
const handles: ServiceHandle[] = [];
const sockets: WebSocket[] = [];

/** A fresh, symlink-free temporary directory. */
function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  roots.push(root);
  return root;
}

/** Starts the service against `stateRoot` on an ephemeral port, with the real clock. */
async function start(stateRoot: string): Promise<ServiceHandle> {
  const started = await startService({
    env: { DEBUGGEN_PROVIDER: 'deterministic' },
    overrides: { debuggenHome: stateRoot, port: 0, logLevel: 'silent' },
  });
  if (isErr(started)) {
    throw new Error(`startService failed: ${started.error.code}: ${started.error.message}`);
  }
  handles.push(started.value);
  return started.value;
}

/** A raw protocol socket and every frame it received. */
interface RawClient {
  readonly socket: WebSocket;
  readonly received: ProtocolMessage[];
}

/** Opens a raw socket to the service, recording every frame it receives. */
async function openRawSocket(handle: ServiceHandle, origin?: string): Promise<RawClient> {
  const received: ProtocolMessage[] = [];
  const socket = new WebSocket(
    `${handle.url.replace(/^http/u, 'ws')}${WS_PATH}`,
    origin === undefined ? {} : { origin },
  );
  sockets.push(socket);
  socket.on('message', (data: Buffer) => {
    const decoded = decodeMessage(data.toString('utf8'));
    if (isOk(decoded)) {
      received.push(decoded.value);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', reject);
  });
  return { socket, received };
}

/** Opens a raw `server-agent` connection and sends its hello. */
async function connectRawPreload(
  handle: ServiceHandle,
  projectRoot: string,
  token: string,
): Promise<RawClient> {
  const client = await openRawSocket(handle);
  client.socket.send(
    encodeMessage(
      createEnvelope('client.hello', {
        client: 'server-agent',
        projectRoot,
        version: PROTOCOL_VERSION,
        token,
      }),
    ),
  );
  return client;
}

/**
 * Opens a raw `devtools` connection from a freshly issued extension credential
 * and binds `tabId` to `sessionId` at `url`, as the service worker does when
 * its panel opens.
 */
async function bindRawDevtools(
  handle: ServiceHandle,
  sessionId: string,
  tabId: number,
  url: string,
): Promise<RawClient> {
  const extensionId = newExtensionId();
  const token = unwrap(handle.auth.issueDevtoolsCredential(extensionId)).token;
  const client = await openRawSocket(handle, chromeExtensionOrigin(extensionId));
  client.socket.send(
    encodeMessage(
      createEnvelope('client.hello', {
        client: 'devtools',
        tabId,
        version: PROTOCOL_VERSION,
        token,
      }),
    ),
  );
  client.socket.send(
    encodeMessage(
      createEnvelope('session.bind', { tabId, url, origin: new URL(url).origin, sessionId }),
    ),
  );
  await waitUntil(
    () => client.received.find((frame) => isMessageOfType(frame, 'session.bound')),
    'the raw DevTools connection has bound its tab',
    RAW_FRAME_TIMEOUT_MS,
  );
  return client;
}

/** Waits until a raw preload has received a `server-agent.config`, and returns its payload. */
async function firstServerConfig(preloadSocket: RawClient): Promise<ServerAgentConfigPayload> {
  const message = await waitUntil(
    () => preloadSocket.received.find((frame) => isMessageOfType(frame, 'server-agent.config')),
    'the reconnected preload has received a server-agent.config',
    RAW_FRAME_TIMEOUT_MS,
  );
  if (!isMessageOfType(message, 'server-agent.config')) {
    throw new Error('The frame found is not a server-agent.config.');
  }
  return unwrap(parseServerAgentConfigPayload(message.payload));
}

/**
 * Leaves a session exactly as a killed process would: `capturing`, with an
 * open capture window of plan version 1, and `plans` holding the runtime-only
 * plan only when `keepPlan` is set — a record whose capture names a plan it
 * does not hold.
 */
async function leaveCapturing(
  handle: ServiceHandle,
  projectRoot: string,
  keepPlan: boolean,
): Promise<{ readonly sessionId: string; readonly captureId: string }> {
  const session = unwrap(
    await handle.manager.create({
      projectRoot,
      question: QUESTION,
      devServerUrl: DEV_SERVER_URL,
    }),
  );
  const repo = createSessionsRepo({ store: handle.store });
  const plan: InstrumentationPlan = unwrap(
    normalizePlan(RUNTIME_PLAN_INPUT, {
      sessionId: session.id,
      planVersion: 1,
      resolver: createAdapterRegistry({ logger: noopLogger }),
    }),
  );
  unwrap(repo.insertPlan(plan));
  const opened = unwrap(repo.startCapture({ sessionId: session.id, planVersion: 1 }));
  const stored = unwrap(repo.get(session.id));
  if (stored === undefined) {
    throw new Error(`Session ${session.id} disappeared from the store.`);
  }
  unwrap(
    repo.update({
      ...stored,
      status: SESSION.capturing,
      plans: keepPlan ? [plan] : [],
      captures: [opened.capture],
    }),
  );
  return { sessionId: session.id, captureId: opened.capture.id };
}

describe('producer replay across a restart', () => {
  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails every interrupted capture, disables its surviving preload and holds its cleanup until both producers are dormant', async () => {
    const container = makeRoot('debuggen-producer-replay-');
    const stateRoot = join(container, 'home');
    const interruptedRoot = join(container, 'interrupted');
    const abandonedRoot = join(container, 'abandoned');
    for (const root of [interruptedRoot, abandonedRoot]) {
      mkdirSync(root, { recursive: true });
    }

    // A first process arms two captures and is killed while both are open: one
    // whose runtime-only plan the record still holds, one whose plan is gone.
    const first = await start(stateRoot);
    const interrupted = await leaveCapturing(first, interruptedRoot, true);
    const abandoned = await leaveCapturing(first, abandonedRoot, false);
    const interruptedToken = unwrap(
      first.auth.issueServerAgentCredential({ projectRoot: interruptedRoot }),
    ).token;
    // Closed as a killed process leaves it: a graceful close would end both
    // live sessions, so `retain` keeps them `capturing` for the next start.
    for (const handle of handles.splice(0)) {
      await handle.close({ liveSessions: 'retain' });
    }

    // The next start settles both before it serves: neither is continued, the
    // one with its plan included, because no producer has taken its
    // configuration from the new process.
    const second = await start(stateRoot);
    expect(second.startup.interruptedSessions).toMatchObject({
      examined: 2,
      errors: [],
      aborted: false,
    });
    expect(second.startup.interruptedSessions.failed).toEqual(
      [interrupted.sessionId, abandoned.sessionId].sort().map((sessionId) => ({
        sessionId,
        status: SESSION.capturing,
        reason: 'capture-interrupted',
      })),
    );
    const repo = createSessionsRepo({ store: second.store });
    for (const { sessionId } of [interrupted, abandoned]) {
      expect(unwrap(repo.get(sessionId))?.status).toBe(SESSION.failed);
      expect(unwrap(repo.getActiveCapture(sessionId))).toBeUndefined();
    }

    // The preload that survived the restart may still hold the capture: it is
    // disabled, never re-armed, as it reconnects.
    const interruptedPreload = await connectRawPreload(second, interruptedRoot, interruptedToken);
    const disabled = await firstServerConfig(interruptedPreload);
    expect(disabled.captureId).toBeUndefined();
    expect(disabled.sessionId).toBeUndefined();

    // Its page agent may still hold it too: a tab bound to the session again is
    // sent the dormant configuration for that capture, after which nothing is
    // owed and ending the session reports a clean cleanup.
    const devtools = await bindRawDevtools(
      second,
      interrupted.sessionId,
      RESTART_TAB_ID,
      `${DEV_SERVER_URL}/`,
    );
    const dormantFrame = await waitUntil(
      () =>
        devtools.received.find(
          (frame) =>
            isMessageOfType(frame, 'agent.config') &&
            frame.payload.captureId === interrupted.captureId,
        ),
      'the rebound tab has been sent the dormant configuration',
      RAW_FRAME_TIMEOUT_MS,
    );
    if (!isMessageOfType(dormantFrame, 'agent.config')) {
      throw new Error('The frame found is not an agent.config.');
    }
    expect(isDormant(unwrap(parseAgentConfigPayload(dormantFrame.payload)))).toBe(true);
    expect(
      devtools.received.some(
        (frame) =>
          isMessageOfType(frame, 'agent.config') &&
          frame.payload.captureId === interrupted.captureId &&
          !isDormant(unwrap(parseAgentConfigPayload(frame.payload))),
      ),
    ).toBe(false);
    unwrap(await second.manager.end(interrupted.sessionId));
    expect(unwrap(repo.get(interrupted.sessionId))?.cleanup.status).toBe(CLEANUP.clean);

    // The capture whose producers never come back: ending its session cannot
    // call the runtime hooks dormant, so the files are clean and the cleanup
    // is partial.
    unwrap(await second.manager.end(abandoned.sessionId));
    const afterEnd = unwrap(repo.get(abandoned.sessionId));
    expect(afterEnd?.status).toBe(SESSION.ended);
    expect(afterEnd?.cleanup.status).toBe(CLEANUP.partial);
  });
});
