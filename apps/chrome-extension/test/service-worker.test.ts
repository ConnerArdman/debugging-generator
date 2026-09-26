/**
 * Unit spec for `../src/background/service-worker.ts` — the composition root of
 * the extension's Manifest V3 worker — held to the element-selection contract
 * of `@debuggen/protocol`'s `messages/target.ts`:
 *
 * - **A selection is pending until the service settles it.** A sent
 *   `target.selected` frame is not an acceptance. The worker answers the
 *   panel's `target.selected` request only on the verdict: the
 *   `session.updated` whose target is the descriptor sent (accepted), the
 *   `error` whose `ref` is the frame's envelope id (refused, with the service's
 *   code), or — when neither arrives — one read-back of the session that
 *   decides it, so a frame lost with the socket is reported instead of shown
 *   as the session's target.
 * - **An unchanged target is not a send.** The session is read before the
 *   send; a descriptor that already is its recorded target is answered
 *   accepted without a frame, because no confirmation could tell a recorded
 *   frame of it from a lost one.
 * - **A selection is never queued on the socket.** While the socket
 *   reconnects the selection is held in the worker, sent only once the socket
 *   opens, and answered unconfirmed at the delivery deadline without ever
 *   reaching the transport — so a later reconnect flushes nothing.
 * - **Selections from the page are settled the same way.** A descriptor from
 *   the page agent's picker or the Elements panel is forwarded under the same
 *   verdict; a refusal reaches the panel as the service's relayed `error`, and a
 *   lost selection as the worker's own `error` push.
 * - **Picker mode is the panel's to arm.** The service's `target.request`
 *   reaches the bound tab's panel, which enters picker mode and arms it through
 *   `target.pick`; the worker sends nothing to the DevTools page for it, so the
 *   Elements panel's `$0` never becomes the target on its own. "Pick element"
 *   arms the page agent's picker only, and with no agent answers
 *   `AGENT_NOT_READY` — the `$0` route is "Use selected element".
 * - **A page-agent pick must be of the tab's current document.** A
 *   `target.described` from a bridge whose agent document is not the tab's
 *   current one is dropped, and the panel told.
 *
 * **Harness.** Collected into the `chrome-extension` Vitest project
 * (happy-dom). `createWorker` is fully injectable, so the whole composition —
 * the real port hub, tab registry, credential store, agent controller, socket
 * bridge and protocol clients — runs against recording fakes local to this
 * file: `chrome.runtime` / `chrome.tabs` / `chrome.alarms` / `chrome.storage`
 * surfaces, a socket constructor the spec accepts and feeds frames through,
 * and runtime ports it drives from both ends. HTTP goes through the worker's
 * own `HttpClient`, which resolves the global `fetch` per call; the spec
 * replaces it with an in-memory route table, so nothing reaches the network.
 * Vitest's fake timers drive every wait. Ids, origins and descriptors are
 * neutral synthetic values (AAP §0.5.4); the credential is an obviously fake
 * literal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  createEnvelope,
  decodeMessage,
  DEFAULT_WS_BACKOFF,
  encodeMessage,
  healthPath,
  isMessageOfType,
  parseSessionRecord,
  PROTOCOL_VERSION,
  sessionPath,
} from '@debuggen/protocol';
import type {
  FetchLike,
  HttpResponseLike,
  MessageByType,
  ProtocolMessage,
  SelectedTarget,
  SessionRecord,
  WebSocketConstructorLike,
  WebSocketLike,
  WsEventMapLike,
} from '@debuggen/protocol';
import { isErr } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import { DEVTOOLS_TOKEN_STORAGE_KEY, STORED_CREDENTIAL_VERSION } from '../src/background/auth';
import type { WorkerTimerApi } from '../src/background/messages';
import { PORT_REQUEST_TIMEOUT_MS } from '../src/background/ports';
import { createWorker, SELECTION_VERDICT_TIMEOUTS } from '../src/background/service-worker';
import type {
  DebugGeneratorWorker,
  WorkerEnvironment,
  WorkerEvent,
  WorkerTab,
  WorkerTabChange,
} from '../src/background/service-worker';
import {
  EXTENSION_CHANNEL,
  newPortRequestId,
  PORT_CONTENT_BRIDGE,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
} from '../src/shared/messages';
import type {
  PortRequestFrame,
  PortRequestKind,
  PortRequestPayloads,
} from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/** This extension's id, as `chrome.runtime.id` reports it. */
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** The URL of this extension's own DevTools pages (panel and devtools page). */
const EXTENSION_PAGE_URL = `chrome-extension://${EXTENSION_ID}/src/panel/index.html`;

/** The devtools credential stored before the worker starts. Obviously fake. */
const TOKEN = 'test-devtools-token';

/** The inspected, bound tab. */
const TAB = 41;

/** The session bound to {@link TAB}. */
const SESSION = 'ses_4k2p9dq7m1zx0c3v';

/** The local application's origin: loopback HTTP, as the host permissions grant. */
const APP_ORIGIN = 'http://localhost:4100';

/** The inspected document. */
const APP_URL = `${APP_ORIGIN}/workspace/overview`;

/** A fixed creation instant for the session record. */
const CREATED_AT = 1_758_000_000_000;

/** A running service's `GET /health` answer. */
const HEALTH_BODY = Object.freeze({
  version: '0.1.0-test',
  protocolVersion: PROTOCOL_VERSION,
  pairingAvailable: true,
});

/** The WebSocket `readyState` values the fake socket moves through. */
const READY_STATE = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 });

/** A close code the socket client retries after. */
const ABNORMAL_CLOSURE = 1006;

/** The element the developer selects. */
const PICKED: SelectedTarget = Object.freeze({
  selector: 'main > section.toolbar > button.save',
  tagName: 'BUTTON',
  text: 'Save changes',
  componentChain: ['SaveButton', 'Toolbar'],
  url: APP_URL,
});

/** Another element of the same document. */
const OTHER: SelectedTarget = Object.freeze({
  selector: 'main > aside.filters > input.search',
  tagName: 'INPUT',
  componentChain: ['SearchBox'],
  url: APP_URL,
});

/** A session record, validated by the protocol's own schema. */
function sessionRecord(target?: SelectedTarget): SessionRecord {
  const parsed = parseSessionRecord({
    id: SESSION,
    projectRoot: '/home/example/workspace/site',
    projectName: 'site',
    devServerUrl: APP_ORIGIN,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT + 1_000,
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
    ...(target === undefined ? {} : { target }),
  });
  if (isErr(parsed)) {
    throw new Error(`the session record fixture is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

/*
 * ===========================================================================
 * Fakes — Chrome events and ports
 * ===========================================================================
 */

/** A `WorkerEvent` the spec can fire. */
interface FakeEvent<Listener extends (...args: never[]) => void> extends WorkerEvent<Listener> {
  readonly listeners: ReadonlySet<Listener>;
  fire(...args: Parameters<Listener>): void;
}

function createEvent<Listener extends (...args: never[]) => void>(): FakeEvent<Listener> {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    fire: (...args) => {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
  };
}

/**
 * A `chrome.events.Event` of a runtime port. Ports carry no declarative rules,
 * so the three rule methods answer with nothing, as Chrome's port events do.
 */
class FakeChromeEvent<Args extends unknown[]> implements chrome.events.Event<
  (...args: Args) => void
> {
  readonly listeners = new Set<(...args: Args) => void>();

  addListener(callback: (...args: Args) => void): void {
    this.listeners.add(callback);
  }

  removeListener(callback: (...args: Args) => void): void {
    this.listeners.delete(callback);
  }

  hasListener(callback: (...args: Args) => void): boolean {
    return this.listeners.has(callback);
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  getRules(): void {
    return undefined;
  }

  addRules(): void {
    return undefined;
  }

  removeRules(): void {
    return undefined;
  }

  fire(...args: Args): void {
    for (const callback of [...this.listeners]) {
      callback(...args);
    }
  }
}

/** A runtime port the spec drives from the far end. */
class FakePort implements chrome.runtime.Port {
  readonly onMessage = new FakeChromeEvent<[message: unknown, port: chrome.runtime.Port]>();
  readonly onDisconnect = new FakeChromeEvent<[port: chrome.runtime.Port]>();
  /** Every frame the worker posted on this port, in order. */
  readonly posted: unknown[] = [];
  disconnected = false;

  constructor(
    readonly name: string,
    readonly sender: chrome.runtime.MessageSender,
  ) {}

  postMessage = (message: unknown): void => {
    if (this.disconnected) {
      throw new Error('Attempting to use a disconnected port object');
    }
    this.posted.push(message);
  };

  disconnect = (): void => {
    this.disconnected = true;
  };

  /** Deliver one frame to the worker. */
  send(message: unknown): void {
    this.onMessage.fire(message, this);
  }
}

/** A record the posted frames are read through. */
type Frame = Readonly<Record<string, unknown>>;

function isFrame(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/*
 * ===========================================================================
 * Fakes — the socket
 * ===========================================================================
 */

/** The listener sets of one socket, one per event of `WsEventMapLike`. */
type SocketListeners = {
  [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void>;
};

/** A socket the spec accepts, feeds and drops by hand. */
interface FakeSocket extends WebSocketLike {
  readonly sent: readonly string[];
  accept(): void;
  receive(message: ProtocolMessage): void;
  drop(code: number): void;
}

function createSocketFactory(): {
  readonly ctor: WebSocketConstructorLike;
  readonly sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];

  class RecordingSocket implements FakeSocket {
    readyState: number = READY_STATE.connecting;
    readonly sent: string[] = [];
    private readonly listeners: SocketListeners = {
      open: new Set(),
      message: new Set(),
      close: new Set(),
      error: new Set(),
    };

    constructor(readonly url: string) {
      sockets.push(this);
    }

    addEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      this.listeners[type].add(listener);
    }

    removeEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      this.listeners[type].delete(listener);
    }

    send(data: string): void {
      if (this.readyState !== READY_STATE.open) {
        throw new Error('the fake socket is not open');
      }
      this.sent.push(data);
    }

    close(): void {
      this.readyState = READY_STATE.closing;
    }

    accept(): void {
      this.readyState = READY_STATE.open;
      this.emit('open', { type: 'open' });
    }

    receive(message: ProtocolMessage): void {
      this.emit('message', { data: encodeMessage(message) });
    }

    drop(code: number): void {
      this.readyState = READY_STATE.closed;
      this.emit('close', { code, reason: '' });
    }

    private emit<K extends keyof WsEventMapLike>(type: K, event: WsEventMapLike[K]): void {
      for (const listener of [...this.listeners[type]]) {
        listener(event);
      }
    }
  }

  return { ctor: RecordingSocket, sockets };
}

/*
 * ===========================================================================
 * Fakes — storage, logger, HTTP
 * ===========================================================================
 */

/** A `chrome.storage` area over a map. */
function createStorageArea(initial: Record<string, unknown> = {}): {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: string): Promise<void>;
} {
  const items = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(items.has(key) ? { [key]: items.get(key) } : {}),
    set: (values) => {
      for (const [key, value] of Object.entries(values)) {
        items.set(key, value);
      }
      return Promise.resolve();
    },
    remove: (key) => {
      items.delete(key);
      return Promise.resolve();
    },
  };
}

/** One record the injected logger received, bindings merged in. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

function createRecordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (more) => createRecordingLogger(entries, { ...bindings, ...more }),
  };
}

/** A JSON response as the injected `fetch` answers it. */
function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/*
 * ===========================================================================
 * Harness
 * ===========================================================================
 */

/** What a case can change about the world while it runs. */
interface WorldState {
  /** Whether the service answers HTTP at all. */
  serviceUp: boolean;
  /** The record `GET /sessions/:id` answers with. */
  storedSession: SessionRecord;
}

interface Harness {
  readonly worker: DebugGeneratorWorker;
  readonly sockets: readonly FakeSocket[];
  readonly world: WorldState;
  readonly fetch: Mock<FetchLike>;
  readonly logs: readonly LogEntry[];
  readonly onConnect: FakeEvent<(port: chrome.runtime.Port) => void>;
}

/** Let every pending continuation run without firing anything due later. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Advance the fake clock, then drain what the fired timers queued. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

/** Build the worker over fresh fakes. Fake timers must already be installed. */
function createHarness(): Harness {
  const logs: LogEntry[] = [];
  const { ctor, sockets } = createSocketFactory();
  const world: WorldState = { serviceUp: true, storedSession: sessionRecord() };

  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let lastHandle = 0;
  const timers: WorkerTimerApi = {
    setTimeout: (handler, ms) => {
      lastHandle += 1;
      const handle = lastHandle;
      live.set(
        handle,
        setTimeout(() => {
          live.delete(handle);
          handler();
        }, ms),
      );
      return handle;
    },
    clearTimeout: (handle) => {
      const timer = live.get(handle);
      if (timer !== undefined) {
        clearTimeout(timer);
        live.delete(handle);
      }
    },
  };

  const fetch = vi.fn<FetchLike>((url) => {
    if (!world.serviceUp) {
      return Promise.reject(new TypeError('connection refused by the test fetch'));
    }
    const path = new URL(url).pathname;
    if (path === healthPath()) {
      return Promise.resolve(jsonResponse(200, HEALTH_BODY));
    }
    if (path === sessionPath(SESSION)) {
      return Promise.resolve(jsonResponse(200, world.storedSession));
    }
    return Promise.resolve(
      jsonResponse(404, { code: 'SESSION_NOT_FOUND', message: 'No such route in the test.' }),
    );
  });
  vi.stubGlobal('fetch', fetch);

  const onConnect = createEvent<(port: chrome.runtime.Port) => void>();
  const env: WorkerEnvironment = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      onConnect,
      onInstalled: createEvent<(details: { readonly reason: string }) => void>(),
      onStartup: createEvent<() => void>(),
    },
    tabs: {
      get: () => Promise.resolve<WorkerTab>({ url: APP_URL }),
      reload: () => Promise.resolve(),
      onUpdated:
        createEvent<(tabId: number, changeInfo: WorkerTabChange, tab: WorkerTab) => void>(),
      onRemoved: createEvent<(tabId: number) => void>(),
    },
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(true),
      onAlarm: createEvent<(alarm: { readonly name: string }) => void>(),
    },
    storage: {
      local: createStorageArea({
        [DEVTOOLS_TOKEN_STORAGE_KEY]: { version: STORED_CREDENTIAL_VERSION, token: TOKEN },
      }),
      session: createStorageArea(),
    },
    webSocketConstructor: ctor,
    timers,
    logger: createRecordingLogger(logs),
    random: () => 1,
  };

  return { worker: createWorker(env), sockets, world, fetch, logs, onConnect };
}

/** The most recently constructed socket. */
function latestSocket(h: Harness): FakeSocket {
  const socket = h.sockets.at(-1);
  if (socket === undefined) {
    throw new Error('the worker has not opened a socket');
  }
  return socket;
}

/**
 * Advance the clock one backoff step at a time until the socket client has
 * constructed a new socket that is still connecting — its next attempt — and
 * answer that socket. An attempt the service never accepted was retired by
 * the client's bounded opening wait, so accepting it would open nothing.
 */
async function nextConnectingSocket(h: Harness): Promise<FakeSocket> {
  const before = h.sockets.length;
  for (let waited = 0; waited <= DEFAULT_WS_BACKOFF.maxMs; waited += DEFAULT_WS_BACKOFF.initialMs) {
    await advance(DEFAULT_WS_BACKOFF.initialMs);
    const latest = h.sockets.at(-1);
    if (h.sockets.length > before && latest?.readyState === READY_STATE.connecting) {
      return latest;
    }
  }
  throw new Error('the socket client made no new connection attempt');
}

/** Every frame the service received on a socket, decoded by the protocol. */
function framesOf(socket: FakeSocket): ProtocolMessage[] {
  return socket.sent.map((text) => {
    const decoded = decodeMessage(text);
    if (isErr(decoded)) {
      throw new Error(`a recorded frame failed to decode (${decoded.error.code})`);
    }
    return decoded.value;
  });
}

/** The `target.selected` frames the service received, in order. */
function selectedFrames(h: Harness): MessageByType<'target.selected'>[] {
  return h.sockets
    .flatMap((socket) => framesOf(socket))
    .filter((message): message is MessageByType<'target.selected'> =>
      isMessageOfType(message, 'target.selected'),
    );
}

/** The one `target.selected` frame the service received. */
function onlySelectedFrame(h: Harness): MessageByType<'target.selected'> {
  const frames = selectedFrames(h);
  expect(frames).toHaveLength(1);
  const frame = frames[0];
  if (frame === undefined) {
    throw new Error('no target.selected frame was sent');
  }
  return frame;
}

/** How many times the worker read the session record over HTTP. */
function sessionReads(h: Harness): number {
  return h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === sessionPath(SESSION))
    .length;
}

/** Whether the worker logged `message` with at least these fields. */
function loggedVerdict(h: Harness, message: string, fields: LogFields): boolean {
  return h.logs.some(
    (entry) =>
      entry.message === message &&
      Object.entries(fields).every(([key, value]) => entry.fields[key] === value),
  );
}

/** Open a runtime port to the worker. */
function connectPort(h: Harness, name: string, sender: chrome.runtime.MessageSender): FakePort {
  const port = new FakePort(name, sender);
  h.onConnect.fire(port);
  return port;
}

/** A panel → worker request frame. */
function portRequest<Kind extends PortRequestKind>(
  kind: Kind,
  payload: PortRequestPayloads[Kind],
): PortRequestFrame<Kind> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'request',
    requestId: newPortRequestId(),
    kind,
    payload,
  };
}

/** The worker's answer to one request on a port, or `undefined` while it is pending. */
function responseTo(port: FakePort, requestId: string): Frame | undefined {
  return port.posted
    .filter(isFrame)
    .find((frame) => frame.direction === 'response' && frame.requestId === requestId);
}

/** The protocol envelopes relayed or pushed to a panel port, in order. */
function protocolPushes(port: FakePort): Frame[] {
  return port.posted
    .filter(isFrame)
    .filter((frame) => frame.direction === 'push' && frame.kind === 'protocol')
    .map((frame) => frame.message)
    .filter(isFrame);
}

/** The downstream frames posted to a devtools page or bridge port, in order. */
function downstream(port: FakePort): Frame[] {
  return port.posted.filter(isFrame).filter((frame) => frame.direction === 'downstream');
}

/** The `requestId` of a downstream picker frame, read without asserting its type. */
function requestIdOf(frame: Frame | undefined): unknown {
  const payload = frame?.payload;
  return isFrame(payload) ? payload.requestId : undefined;
}

/** Deliver one service frame on the live socket and let it settle. */
async function serviceSends(h: Harness, message: ProtocolMessage): Promise<void> {
  latestSocket(h).receive(message);
  await flush();
}

/** The bound world every case starts from. */
interface BoundWorld {
  readonly panel: FakePort;
  readonly devtools: FakePort;
}

/**
 * Start the worker, accept its socket, and bind {@link TAB} to {@link SESSION}
 * the way Chrome and the service do: the panel opens and asks for its
 * snapshot naming its inspected tab (which associates it with that tab), its
 * DevTools page announces the tab (which asks for a binding), and the service
 * answers `session.bound`.
 */
async function startBound(h: Harness): Promise<BoundWorld> {
  await flush();
  latestSocket(h).accept();
  await flush();
  const panel = connectPort(h, PORT_PANEL, { id: EXTENSION_ID, url: EXTENSION_PAGE_URL });
  const snapshot = portRequest('session.snapshot', { inspectedTabId: TAB });
  panel.send(snapshot);
  await flush();
  expect(responseTo(panel, snapshot.requestId)).toMatchObject({ ok: true });
  const devtools = connectPort(h, PORT_DEVTOOLS, { id: EXTENSION_ID, url: EXTENSION_PAGE_URL });
  devtools.send({
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'devtools.hello',
    payload: { tabId: TAB, url: APP_URL, origin: APP_ORIGIN },
  });
  await flush();
  expect(framesOf(latestSocket(h)).map((message) => message.type)).toContain('session.bind');
  await serviceSends(
    h,
    createEnvelope('session.bound', { sessionId: SESSION, tabId: TAB, url: APP_URL }),
  );
  await expect(h.worker.registry.getTabForSession(SESSION)).resolves.toBe(TAB);
  return { panel, devtools };
}

/** The `chrome.tabs.Tab` Chrome puts on a content script's port sender for {@link TAB}. */
const INSPECTED_TAB: chrome.tabs.Tab = Object.freeze({
  id: TAB,
  index: 0,
  windowId: 1,
  url: APP_URL,
  pinned: false,
  highlighted: true,
  active: true,
  frozen: false,
  incognito: false,
  selected: true,
  discarded: false,
  autoDiscardable: true,
  groupId: -1,
  lastAccessed: CREATED_AT,
});

/** Connect the page's content-script bridge for {@link TAB}. */
function connectBridge(h: Harness): FakePort {
  return connectPort(h, PORT_CONTENT_BRIDGE, {
    id: EXTENSION_ID,
    tab: INSPECTED_TAB,
    frameId: 0,
    origin: APP_ORIGIN,
    url: APP_URL,
  });
}

/*
 * The page agent's ids have the canonical opaque shape (`doc_` / `prd_` and
 * sixteen `[0-9a-z]`): the port hub refuses a bridge frame whose ids the agent
 * could not have minted.
 */

/** The page agent document of {@link TAB}'s current load. */
const DOCUMENT_ID = 'doc_currentload00001';

/** The page agent document of an earlier load of {@link TAB}. */
const PREVIOUS_DOCUMENT_ID = 'doc_earlierload00001';

/** The producer id the page agent of `documentId` announces with it. */
function producerIdOf(documentId: string): string {
  return documentId.replace(/^doc_/u, 'prd_');
}

/** The panel's notice for a page-agent pick of a document the tab no longer shows. */
const STALE_SELECTION_MESSAGE =
  'The page changed before the element was reported, so it was not selected. Pick it again.';

/** A bridge → worker frame, as the content-script bridge posts it. */
function bridgeFrame(type: string, payload: Readonly<Record<string, unknown>>): Frame {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type,
    payload,
  };
}

/** The page agent's `agent.ready` for one document of {@link TAB}. */
function agentReady(documentId: string): Frame {
  return bridgeFrame('agent.ready', {
    documentId,
    producerId: producerIdOf(documentId),
    url: APP_URL,
    installedBeforeReact: true,
    reactDetected: true,
  });
}

/**
 * Connect the page's bridge and let its agent announce `documentId`, as a page
 * load does: the bridge's frames are then of that document, and so is the
 * tab's readiness.
 */
async function connectReadyBridge(h: Harness, documentId: string = DOCUMENT_ID): Promise<FakePort> {
  const bridge = connectBridge(h);
  bridge.send(agentReady(documentId));
  await flush();
  expect(h.worker.agent.getReadiness(TAB)?.documentId).toBe(documentId);
  return bridge;
}

/** Every log record, serialized, for privacy assertions. */
function serializedLogs(h: Harness): string {
  return JSON.stringify(h.logs);
}

/** Assert that no log record carries the descriptor or the document URL. */
function expectNoDescriptorInLogs(h: Harness, target: SelectedTarget): void {
  const text = serializedLogs(h);
  expect(text).not.toContain(target.selector);
  expect(text).not.toContain('/workspace/overview');
  expect(text).not.toContain(TOKEN);
}

/*
 * ===========================================================================
 * Suite-wide environment
 * ===========================================================================
 */

let harness: Harness | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  harness?.worker.dispose();
  harness = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fresh harness, disposed after the case. */
function setup(): Harness {
  harness = createHarness();
  return harness;
}

/*
 * ===========================================================================
 * The verdict budgets
 * ===========================================================================
 */

describe('the selection verdict budgets', () => {
  it('fit the longest path inside the port request timeout, and give a held selection longer', () => {
    const { sentMs, queuedMs, verifyMs } = SELECTION_VERDICT_TIMEOUTS;
    expect(sentMs).toBeLessThan(queuedMs);
    // The read before the send, the whole hold for an open socket, the sent
    // wait and the read-back, one after another.
    expect(verifyMs + queuedMs + sentMs + verifyMs).toBeLessThan(PORT_REQUEST_TIMEOUT_MS);
  });
});

/*
 * ===========================================================================
 * target.selected from the panel
 * ===========================================================================
 */

describe("the panel's target.selected request is answered on the service's verdict", () => {
  it('stays pending after the send and is accepted only by the matching session.updated', async () => {
    const h = setup();
    const { panel } = await startBound(h);

    const request = portRequest('target.selected', { sessionId: SESSION, target: PICKED });
    panel.send(request);
    await flush();

    // Sent, under an envelope id the worker minted — and not answered.
    const frame = onlySelectedFrame(h);
    expect(frame.payload).toEqual({ sessionId: SESSION, target: PICKED });
    expect(frame.id.length).toBeGreaterThan(0);
    expect(responseTo(panel, request.requestId)).toBeUndefined();

    // An update of this session that carries another target settles nothing.
    await serviceSends(h, createEnvelope('session.updated', { session: sessionRecord(OTHER) }));
    await advance(1_000);
    expect(responseTo(panel, request.requestId)).toBeUndefined();

    // The update that carries the descriptor sent is the acceptance.
    await serviceSends(h, createEnvelope('session.updated', { session: sessionRecord(PICKED) }));
    expect(responseTo(panel, request.requestId)).toMatchObject({
      ok: true,
      kind: 'target.selected',
      payload: { accepted: true },
    });
    // The confirming record reached the panel too, ahead of the answer.
    const updates = protocolPushes(panel).filter((message) => message.type === 'session.updated');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    // One read, before the send; no read-back was needed.
    expect(sessionReads(h)).toBe(1);
    expect(
      loggedVerdict(h, 'The service accepted a selected element.', { via: 'session.updated' }),
    ).toBe(true);
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('accepts a descriptor that already is the recorded target without sending a frame', async () => {
    const h = setup();
    const { panel } = await startBound(h);
    // The session's target already equals the pick: no confirmation could tell
    // a recorded frame of it from a lost one, so none is sent.
    h.world.storedSession = sessionRecord(PICKED);

    const request = portRequest('target.selected', { sessionId: SESSION, target: PICKED });
    panel.send(request);
    await flush();

    expect(responseTo(panel, request.requestId)).toMatchObject({
      ok: true,
      kind: 'target.selected',
      payload: { accepted: true },
    });
    expect(selectedFrames(h)).toHaveLength(0);
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);
    expect(sessionReads(h)).toBe(1);
    expect(
      loggedVerdict(h, 'The service accepted a selected element.', {
        via: 'already-recorded',
        source: 'panel',
      }),
    ).toBe(true);
    expectNoDescriptorInLogs(h, PICKED);
  });

  it("answers the refusal an error{ref} carries with the service's code, ignoring other errors", async () => {
    const h = setup();
    const { panel } = await startBound(h);

    const request = portRequest('target.selected', { sessionId: SESSION, target: PICKED });
    panel.send(request);
    await flush();
    const frame = onlySelectedFrame(h);

    // An error about some other frame is not this selection's verdict.
    await serviceSends(
      h,
      createEnvelope('error', {
        code: 'PROTOCOL_INVALID_MESSAGE',
        message: 'Another frame was malformed.',
        ref: 'msg_unrelated_frame_id',
      }),
    );
    expect(responseTo(panel, request.requestId)).toBeUndefined();

    await serviceSends(
      h,
      createEnvelope('error', {
        code: 'TAB_NOT_BOUND',
        message: 'The selection is not of the bound tab’s current document.',
        ref: frame.id,
      }),
    );
    const response = responseTo(panel, request.requestId);
    expect(response).toMatchObject({
      ok: false,
      kind: 'target.selected',
      error: {
        code: 'TAB_NOT_BOUND',
        message: 'The selection is not of the bound tab’s current document.',
      },
    });

    // A late acceptance-looking update changes nothing: the request is settled.
    await serviceSends(h, createEnvelope('session.updated', { session: sessionRecord(PICKED) }));
    expect(
      panel.posted
        .filter(isFrame)
        .filter(
          (posted) => posted.direction === 'response' && posted.requestId === request.requestId,
        ),
    ).toHaveLength(1);
    expect(h.logs.some((entry) => entry.fields.errorCode === 'TAB_NOT_BOUND')).toBe(true);
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('reads the session back when nothing answers, and reports a mismatch as TRANSPORT_DISCONNECTED', async () => {
    const h = setup();
    const { panel } = await startBound(h);
    h.world.storedSession = sessionRecord(OTHER);

    const request = portRequest('target.selected', { sessionId: SESSION, target: PICKED });
    panel.send(request);
    await flush();
    onlySelectedFrame(h);

    await advance(SELECTION_VERDICT_TIMEOUTS.sentMs - 1);
    expect(responseTo(panel, request.requestId)).toBeUndefined();

    await advance(1);
    expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === sessionPath(SESSION))).toBe(
      true,
    );
    const response = responseTo(panel, request.requestId);
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'TRANSPORT_DISCONNECTED',
        message:
          "The service did not confirm the selected element, so it is not the session's target.",
      },
    });
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('accepts a selection nothing answered when the read-back session carries it', async () => {
    const h = setup();
    const { panel } = await startBound(h);

    const request = portRequest('target.selected', { sessionId: SESSION, target: PICKED });
    panel.send(request);
    await flush();
    onlySelectedFrame(h);
    // The service recorded the frame, but its broadcast never arrived.
    h.world.storedSession = sessionRecord(PICKED);
    await advance(SELECTION_VERDICT_TIMEOUTS.sentMs);

    expect(responseTo(panel, request.requestId)).toMatchObject({
      ok: true,
      payload: { accepted: true },
    });
    // The read before the send, then the read-back that decided it.
    expect(sessionReads(h)).toBe(2);
    expect(loggedVerdict(h, 'The service accepted a selected element.', { via: 'verified' })).toBe(
      true,
    );
  });

  it('holds a selection while the socket reconnects, never queues it, and flushes nothing after the deadline', async () => {
    const h = setup();
    const { panel } = await startBound(h);
    // The socket drops and the service stops answering.
    h.world.serviceUp = false;
    latestSocket(h).drop(ABNORMAL_CLOSURE);
    await flush();
    const socketsBefore = h.sockets.length;

    const request = portRequest('target.selected', { sessionId: SESSION, target: PICKED });
    panel.send(request);
    await flush();
    // Held in the worker, still pending: nothing reached the transport.
    expect(h.worker.wsBridge.getStatus().transport).not.toBe('open');
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);
    expect(selectedFrames(h)).toHaveLength(0);
    expect(responseTo(panel, request.requestId)).toBeUndefined();

    // Past the sent-frame budget the held selection is still pending.
    await advance(SELECTION_VERDICT_TIMEOUTS.sentMs);
    expect(responseTo(panel, request.requestId)).toBeUndefined();

    // At the delivery deadline it is reported unconfirmed, never having been sent.
    await advance(SELECTION_VERDICT_TIMEOUTS.queuedMs - SELECTION_VERDICT_TIMEOUTS.sentMs);
    expect(responseTo(panel, request.requestId)).toMatchObject({
      ok: false,
      kind: 'target.selected',
      error: {
        code: 'TRANSPORT_DISCONNECTED',
        message:
          "The service did not confirm the selected element, so it is not the session's target.",
      },
    });
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);

    // The service returns and the socket reconnects: nothing is flushed. The
    // attempts made while it was down were retired unopened, so the next one
    // is the socket the service accepts.
    h.world.serviceUp = true;
    expect(h.sockets.length).toBeGreaterThan(socketsBefore);
    (await nextConnectingSocket(h)).accept();
    await flush();
    expect(h.worker.wsBridge.getStatus().transport).toBe('open');
    expect(selectedFrames(h)).toHaveLength(0);
    await advance(SELECTION_VERDICT_TIMEOUTS.queuedMs);
    expect(selectedFrames(h)).toHaveLength(0);
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('sends a held selection once the socket reopens within the budget, and accepts the matching session.updated', async () => {
    const h = setup();
    const { panel } = await startBound(h);
    latestSocket(h).drop(ABNORMAL_CLOSURE);
    await flush();
    const socketsBefore = h.sockets.length;

    const request = portRequest('target.selected', { sessionId: SESSION, target: PICKED });
    panel.send(request);
    await flush();
    expect(selectedFrames(h)).toHaveLength(0);
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);

    // The socket client's first reconnect attempt, well inside the deadline.
    await advance(DEFAULT_WS_BACKOFF.initialMs);
    expect(h.sockets.length).toBeGreaterThan(socketsBefore);
    const reopened = latestSocket(h);
    reopened.accept();
    await flush();

    // Written directly to the open socket, never queued.
    const frame = onlySelectedFrame(h);
    expect(framesOf(reopened).some((message) => message.id === frame.id)).toBe(true);
    expect(frame.payload).toEqual({ sessionId: SESSION, target: PICKED });
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);
    expect(responseTo(panel, request.requestId)).toBeUndefined();

    await serviceSends(h, createEnvelope('session.updated', { session: sessionRecord(PICKED) }));
    expect(responseTo(panel, request.requestId)).toMatchObject({
      ok: true,
      kind: 'target.selected',
      payload: { accepted: true },
    });
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('answers at once, without sending, when the socket is closed rather than reconnecting', async () => {
    const h = setup();
    const { panel } = await startBound(h);
    await h.worker.wsBridge.close();
    await flush();
    expect(h.worker.wsBridge.getStatus().transport).toBe('closed');

    const request = portRequest('target.selected', { sessionId: SESSION, target: PICKED });
    panel.send(request);
    await flush();

    expect(responseTo(panel, request.requestId)).toMatchObject({
      ok: false,
      kind: 'target.selected',
      error: { code: 'TRANSPORT_DISCONNECTED' },
    });
    expect(selectedFrames(h)).toHaveLength(0);
    expect(
      loggedVerdict(h, 'A selected element could not be sent to the service.', {
        errorCode: 'TRANSPORT_DISCONNECTED',
      }),
    ).toBe(true);
  });

  it("refuses a selection for a session other than the inspected tab's, without sending it", async () => {
    const h = setup();
    const { panel } = await startBound(h);

    const request = portRequest('target.selected', {
      sessionId: 'ses_9z9z9z9z9z9z9z9z',
      target: PICKED,
    });
    panel.send(request);
    await flush();

    expect(selectedFrames(h)).toHaveLength(0);
    expect(responseTo(panel, request.requestId)).toMatchObject({
      ok: false,
      error: { code: 'TAB_NOT_BOUND' },
    });
  });
});

/*
 * ===========================================================================
 * Selections from the page: the agent's picker and the Elements panel
 * ===========================================================================
 */

describe('a selection from the page is forwarded under the same verdict', () => {
  it('lets the refusal reach the panel as the relayed service error, and logs its code only', async () => {
    const h = setup();
    const { panel } = await startBound(h);
    const bridge = await connectReadyBridge(h);

    bridge.send(bridgeFrame('target.described', { target: PICKED }));
    await flush();
    const frame = onlySelectedFrame(h);
    expect(frame.payload).toEqual({ sessionId: SESSION, target: PICKED });

    await serviceSends(
      h,
      createEnvelope('error', {
        code: 'TAB_NOT_BOUND',
        message: 'The selection is not of the bound tab’s current document.',
        ref: frame.id,
      }),
    );

    const errors = protocolPushes(panel).filter((message) => message.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ payload: { code: 'TAB_NOT_BOUND', ref: frame.id } });
    expect(
      h.logs.some(
        (entry) =>
          entry.message === 'The service refused a selected element.' &&
          entry.fields.errorCode === 'TAB_NOT_BOUND' &&
          entry.fields.source === 'agent',
      ),
    ).toBe(true);
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('drops a page-agent pick of a document the tab no longer shows, and tells the panel', async () => {
    const h = setup();
    const { panel } = await startBound(h);
    // The developer picks in an earlier load just as the tab moves on: the
    // pick arrives on the tab's current bridge, and the next document's
    // bridge — which retires the earlier one — announces itself before the
    // worker acts on the pick.
    const earlier = await connectReadyBridge(h, PREVIOUS_DOCUMENT_ID);
    earlier.send(bridgeFrame('target.described', { target: PICKED }));
    const current = connectBridge(h);
    current.send(agentReady(DOCUMENT_ID));
    await flush();
    expect(h.worker.agent.getReadiness(TAB)?.documentId).toBe(DOCUMENT_ID);

    expect(selectedFrames(h)).toHaveLength(0);
    expect(sessionReads(h)).toBe(0);
    const errors = protocolPushes(panel).filter((message) => message.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      sessionId: SESSION,
      payload: { code: 'TAB_NOT_BOUND', message: STALE_SELECTION_MESSAGE },
    });
    expect(
      loggedVerdict(h, 'A selected element of a document the tab no longer shows was dropped.', {
        tabId: TAB,
        errorCode: 'TAB_NOT_BOUND',
        reason: 'superseded',
      }),
    ).toBe(true);

    // The same element picked in the current document is forwarded.
    current.send(bridgeFrame('target.described', { target: PICKED }));
    await flush();
    expect(onlySelectedFrame(h).payload).toEqual({ sessionId: SESSION, target: PICKED });
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('drops a pick from a bridge whose page agent never announced its document', async () => {
    const h = setup();
    const { panel } = await startBound(h);
    const bridge = connectBridge(h);

    bridge.send(bridgeFrame('target.described', { target: PICKED }));
    await flush();

    // No document of this bridge has announced itself, so the pick cannot be
    // attributed to one: the port hub withholds it before any worker handler,
    // and nothing reaches the service or — being unattributable page input —
    // the panel.
    expect(selectedFrames(h)).toHaveLength(0);
    expect(sessionReads(h)).toBe(0);
    expect(
      loggedVerdict(h, 'withheld a bridge frame', {
        tabId: TAB,
        type: 'target.described',
        reason: 'described-before-ready',
      }),
    ).toBe(true);
    expect(protocolPushes(panel).filter((message) => message.type === 'error')).toEqual([]);

    // Once its document is announced, the same bridge's pick is forwarded.
    bridge.send(agentReady(DOCUMENT_ID));
    await flush();
    bridge.send(bridgeFrame('target.described', { target: PICKED }));
    await flush();
    expect(onlySelectedFrame(h).payload).toEqual({ sessionId: SESSION, target: PICKED });
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('tells the panel when a selection from the Elements panel was lost', async () => {
    const h = setup();
    const { panel, devtools } = await startBound(h);
    h.world.storedSession = sessionRecord();

    devtools.send({
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'upstream',
      type: 'devtools.element',
      payload: { tabId: TAB, target: PICKED },
    });
    await flush();
    onlySelectedFrame(h);
    expect(protocolPushes(panel).filter((message) => message.type === 'error')).toHaveLength(0);

    await advance(SELECTION_VERDICT_TIMEOUTS.sentMs);

    const errors = protocolPushes(panel).filter((message) => message.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      sessionId: SESSION,
      payload: { code: 'TRANSPORT_DISCONNECTED' },
    });
    expectNoDescriptorInLogs(h, PICKED);
  });

  it('pushes nothing extra when the service accepts the selection', async () => {
    const h = setup();
    const { panel, devtools } = await startBound(h);

    devtools.send({
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'upstream',
      type: 'devtools.element',
      payload: { tabId: TAB, target: PICKED },
    });
    await flush();
    await serviceSends(h, createEnvelope('session.updated', { session: sessionRecord(PICKED) }));
    await advance(SELECTION_VERDICT_TIMEOUTS.queuedMs + SELECTION_VERDICT_TIMEOUTS.verifyMs);

    expect(protocolPushes(panel).filter((message) => message.type === 'error')).toHaveLength(0);
    expect(
      h.logs.some(
        (entry) =>
          entry.message === 'The service accepted a selected element.' &&
          entry.fields.via === 'session.updated' &&
          entry.fields.source === 'devtools',
      ),
    ).toBe(true);
  });
});

/*
 * ===========================================================================
 * Picker mode: the service's target.request and the panel's target.pick
 * ===========================================================================
 */

describe("the service's target.request is the panel's to arm, and never selects $0", () => {
  it('relays the request to the bound panel and sends nothing to the DevTools page or the page agent', async () => {
    const h = setup();
    const { panel, devtools } = await startBound(h);
    const bridge = await connectReadyBridge(h);
    const bridgeBefore = downstream(bridge).length;

    await serviceSends(h, createEnvelope('target.request', { sessionId: SESSION }));

    // The panel receives the relayed frame, which puts it into picker mode;
    // arming it is the panel's own `target.pick`.
    const requests = protocolPushes(panel).filter((message) => message.type === 'target.request');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ payload: { sessionId: SESSION } });

    // Nothing reaches the DevTools page — so the Elements panel's `$0` is not
    // described — and the worker arms nothing on the page by itself.
    expect(downstream(devtools)).toHaveLength(0);
    expect(downstream(bridge)).toHaveLength(bridgeBefore);

    // Nothing becomes the session's target until the developer acts.
    await advance(
      SELECTION_VERDICT_TIMEOUTS.verifyMs * 2 +
        SELECTION_VERDICT_TIMEOUTS.queuedMs +
        SELECTION_VERDICT_TIMEOUTS.sentMs,
    );
    expect(selectedFrames(h)).toHaveLength(0);
    expect(sessionReads(h)).toBe(0);
    expect(
      loggedVerdict(h, 'target.request relayed to the panels, which arm picker mode.', {
        sessionId: SESSION,
      }),
    ).toBe(true);
  });

  it('forwards nothing for a session no inspected tab is bound to', async () => {
    const h = setup();
    const { panel, devtools } = await startBound(h);
    const bridge = await connectReadyBridge(h);
    const bridgeBefore = downstream(bridge).length;

    await serviceSends(h, createEnvelope('target.request', { sessionId: 'ses_9z9z9z9z9z9z9z9z' }));

    expect(downstream(bridge)).toHaveLength(bridgeBefore);
    expect(downstream(devtools)).toHaveLength(0);
    expect(selectedFrames(h)).toHaveLength(0);
    // A session no tab is bound to has no panel to reach.
    expect(
      protocolPushes(panel).filter((message) => message.type === 'target.request'),
    ).toHaveLength(0);
  });
});

describe("target.pick arms the page agent's picker only", () => {
  it('arms the page agent through the bridge and forwards the element it answers with', async () => {
    const h = setup();
    const { panel, devtools } = await startBound(h);
    const bridge = await connectReadyBridge(h);
    const bridgeBefore = downstream(bridge).length;

    const pick = portRequest('target.pick', { sessionId: SESSION, enabled: true });
    panel.send(pick);
    await flush();

    expect(responseTo(panel, pick.requestId)).toMatchObject({
      ok: true,
      kind: 'target.pick',
      payload: { active: true },
    });
    const armed = downstream(bridge).slice(bridgeBefore);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ channel: EXTENSION_CHANNEL, type: 'target.request' });
    const requestId = requestIdOf(armed[0]);
    expect(typeof requestId).toBe('string');
    expect(downstream(devtools)).toHaveLength(0);

    // The agent answers with the element the developer clicked.
    bridge.send(bridgeFrame('target.described', { target: PICKED, requestId }));
    await flush();
    expect(onlySelectedFrame(h).payload).toEqual({ sessionId: SESSION, target: PICKED });
  });

  it('answers AGENT_NOT_READY with the recovery when no page agent is connected, asking DevTools for nothing', async () => {
    const h = setup();
    const { panel, devtools } = await startBound(h);

    const pick = portRequest('target.pick', { sessionId: SESSION, enabled: true });
    panel.send(pick);
    await flush();

    expect(responseTo(panel, pick.requestId)).toMatchObject({
      ok: false,
      kind: 'target.pick',
      error: {
        code: 'AGENT_NOT_READY',
        message:
          'The Debug Generator page agent is not running on the inspected page, so picker mode is unavailable. Reload the application page, or select the element in the Elements panel and press "Use selected element".',
      },
    });
    // No `devtools.describeRequest`, nor anything else: `$0` is "Use selected
    // element", the panel's explicit control.
    expect(downstream(devtools)).toHaveLength(0);
    expect(selectedFrames(h)).toHaveLength(0);
    expect(
      loggedVerdict(h, 'Picker mode could not be armed.', {
        tabId: TAB,
        sessionId: SESSION,
        errorCode: 'AGENT_NOT_READY',
      }),
    ).toBe(true);
  });

  it('leaves picker mode without a request to anything', async () => {
    const h = setup();
    const { panel, devtools } = await startBound(h);
    const bridge = await connectReadyBridge(h);
    const bridgeBefore = downstream(bridge).length;

    const off = portRequest('target.pick', { sessionId: SESSION, enabled: false });
    panel.send(off);
    await flush();

    expect(responseTo(panel, off.requestId)).toMatchObject({
      ok: true,
      payload: { active: false },
    });
    expect(downstream(bridge)).toHaveLength(bridgeBefore);
    expect(downstream(devtools)).toHaveLength(0);
  });

  it('refuses a pick for a session no inspected tab of this panel is bound to', async () => {
    const h = setup();
    const { panel, devtools } = await startBound(h);
    const bridge = await connectReadyBridge(h);
    const bridgeBefore = downstream(bridge).length;

    const pick = portRequest('target.pick', { sessionId: 'ses_9z9z9z9z9z9z9z9z', enabled: true });
    panel.send(pick);
    await flush();

    expect(responseTo(panel, pick.requestId)).toMatchObject({
      ok: false,
      error: { code: 'TAB_NOT_BOUND' },
    });
    expect(downstream(bridge)).toHaveLength(bridgeBefore);
    expect(downstream(devtools)).toHaveLength(0);
  });
});
