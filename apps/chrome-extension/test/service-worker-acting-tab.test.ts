/**
 * Unit spec for `../src/background/service-worker.ts` — the extension's
 * composition root — driven through the real {@link createWorker} with every
 * collaborator it composes left real (the credential store, the port hub, the
 * tab registry, the agent controller and the socket bridge) and only the
 * platform faked: `chrome.runtime`, `chrome.tabs`, `chrome.alarms`, both
 * `chrome.storage` areas, the timers, the platform `fetch`, and a WebSocket
 * constructor whose sockets are served by an in-memory {@link FakeService}.
 *
 * The fake service behaves as the local service does where this spec depends
 * on it: it takes `client.hello` and stays open, answers every `session.bind`
 * with `session.bound` (reason `bound`) after recording the binding in its
 * live table, and refuses — with an `error` frame, `TAB_NOT_BOUND` — any
 * `telemetry.event` whose acting tab has no live binding for the envelope's
 * session. A restart closes every socket and forgets every binding, exactly as
 * a restarted service's empty binding table does.
 *
 * The product guarantees held here:
 *
 * - **A cold worker delivers what the page sent while it was starting** — in
 *   `seq` order, only after the service confirmed the tab's binding, every
 *   frame naming its tab and session.
 * - **A service restart loses nothing and is refused nothing**: batches sent
 *   while the socket is down wait for the re-announced binding to be
 *   confirmed, and none is parked in the socket client's reconnect queue,
 *   which is flushed before that confirmation.
 * - **One tab's backlog is bounded** (64 batches), overflow is reported, and
 *   the rest stays in order.
 * - **A batch is never relabelled**: one produced under one session (or
 *   capture) is dropped when the tab's binding has moved on by its turn.
 * - **A panel keeps the tab it inspects**: a panel associated with tab B that
 *   names tab A's session is not moved to tab A, and never acts for it.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project. Every fake is built per case by
 * {@link startWorker}; the only suite-level state is the list of composed
 * workers, each disposed after its case. No `vi.mock` is used (the worker
 * module has no import-time side effect outside a real extension service
 * worker), Vitest's fake timers drive every delay — the fake network's latency
 * included — and the platform `fetch` is replaced by a recording stub, so
 * nothing reaches the network. Ids and origins are neutral synthetic values
 * (AAP §0.5.4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  ACTING_TAB_HEADER,
  createEnvelope,
  decodeMessage,
  DEFAULT_WS_BACKOFF,
  encodeMessage,
  isMessageOfType,
  parseSessionRecord,
  PROTOCOL_VERSION,
} from '@debuggen/protocol';
import type {
  DataQuery,
  FetchLike,
  HttpResponseLike,
  MessageByType,
  ProtocolMessage,
  TelemetryEventIngress,
  WebSocketLike,
  WsEventMapLike,
} from '@debuggen/protocol';
import { isErr } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import { DEVTOOLS_TOKEN_STORAGE_KEY, STORED_CREDENTIAL_VERSION } from '../src/background/auth';
import type { TabBindingRecord, WorkerTimerApi } from '../src/background/messages';
import { createWorker } from '../src/background/service-worker';
import type {
  DebugGeneratorWorker,
  WorkerEnvironment,
  WorkerTab,
  WorkerTabChange,
} from '../src/background/service-worker';
import { BINDING_STORAGE_KEY } from '../src/background/tab-registry';
import { TELEMETRY_ROUTE_WAIT_MS } from '../src/background/ws-bridge';
import {
  DEFAULT_SERVICE_BASE_URL,
  EXTENSION_CHANNEL,
  isPortResponse,
  newPortRequestId,
  PORT_CONTENT_BRIDGE,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
} from '../src/shared/messages';
import type {
  BridgeUpstreamMessage,
  DevtoolsUpstreamMessage,
  ExtensionPortName,
  PageTelemetryBatchPayload,
  PortRequestFrame,
  PortRequestId,
  PortRequestKind,
  PortRequestPayloads,
  PortResponse,
} from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/** A Chrome tab id, as the registry's records type it. */
type TabId = TabBindingRecord['tabId'];

/** A session id, as the registry's records type it. */
type SessionId = TabBindingRecord['sessionId'];

/** The extension id: 32 letters a–p, the shape Chrome gives one. */
const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** The devtools credential the local storage area holds. Obviously fake. */
const TOKEN = 'test-devtools-token';

/** The inspected application's origin — a neutral local port. */
const APP_ORIGIN = 'http://127.0.0.1:4100';

/** The bound document's (already query-redacted) URL. */
const APP_URL = `${APP_ORIGIN}/workspace/overview`;

/** Two inspected tabs. */
const TAB_A: TabId = 7;
const TAB_B: TabId = 9;

/*
 * Every id a page agent frame carries has the canonical opaque shape — the
 * kind prefix and sixteen `[0-9a-z]` — because the port hub refuses a bridge
 * frame whose ids the product could not have minted.
 */

/** Two sessions of the application, and two captures. */
const SESSION_1: SessionId = 'ses_testsession00001';
const SESSION_2: SessionId = 'ses_testsession00002';
const CAPTURE_1 = 'cap_testcapture00001';
const CAPTURE_2 = 'cap_testcapture00002';

/** A base epoch-millisecond instant for bindings and events. */
const BASE_EPOCH_MS = 1_700_000_000_000;

/** The one producer of the page agent in every case. */
const PRODUCER_ID = 'prd_testproducer0001';

/** The one page agent document in every case. */
const DOCUMENT_ID = 'doc_testdocument0001';

/** WebSocket close code 1012, "service restart": what a restarting service sends. */
const SERVICE_RESTART_CLOSE = 1012;

/** WebSocket close code 1006, "abnormal closure": a connection that was refused. */
const ABNORMAL_CLOSURE = 1006;

/** The WHATWG `WebSocket.readyState` values the fake sockets move through. */
const READY_STATE = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 });

/**
 * Simulated network latency on Vitest's fake clock: how long the fake
 * service's handshake takes, and how long each frame it sends takes to arrive.
 * Real, macrotask-scale delays are what make a cold wake racy — the worker's
 * `ready` settles while its socket is still connecting — so the fake never
 * answers on a microtask.
 */
const HANDSHAKE_LATENCY_MS = 10;
const REPLY_LATENCY_MS = 2;

/** Enough fake time for a handshake, the hello and a bind round trip to finish. */
const NETWORK_SETTLE_MS = 50;

/** The most batches one tab may have waiting — the worker's documented bound. */
const LANE_BOUND = 64;

/** A panel-data query for one trace — the timeline's query shape. */
const TRACE_QUERY: DataQuery = { source: 'trace', filter: { traceId: hexId(0, 32) } };

/** A running service's `GET /health` answer. */
const HEALTH_BODY = Object.freeze({
  version: '0.1.0-test',
  protocolVersion: PROTOCOL_VERSION,
  pairingAvailable: true,
});

/** A lowercase hexadecimal identifier of `width` digits, never all zeros. */
function hexId(value: number, width: number): string {
  return (value + 1).toString(16).padStart(width, '0');
}

/** A persisted binding of `tabId` to `sessionId`, optionally mid-capture. */
function binding(tabId: TabId, sessionId: SessionId, captureId?: string): TabBindingRecord {
  return {
    tabId,
    sessionId,
    url: APP_URL,
    origin: APP_ORIGIN,
    boundAt: BASE_EPOCH_MS,
    ...(captureId === undefined ? {} : { captureId }),
  };
}

/** One raw, ingress-shaped event exactly as the page agent emits it. */
function makeEvent(seq: number): TelemetryEventIngress {
  return {
    id: `event-test-${String(seq)}`,
    traceId: hexId(seq, 32),
    spanId: hexId(seq, 16),
    kind: 'interaction',
    name: 'click',
    startTime: BASE_EPOCH_MS + seq,
    duration: 1,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: PRODUCER_ID,
    seq,
  };
}

/** The session and capture the page agent stamped on a batch, when armed. */
interface BatchStamp {
  readonly sessionId?: SessionId;
  readonly captureId?: string;
}

/** A `telemetry.batch` bridge frame holding one event of sequence `seq`. */
function batchFrame(seq: number, stamp: BatchStamp = {}): BridgeUpstreamMessage<'telemetry.batch'> {
  const payload: PageTelemetryBatchPayload = {
    events: [makeEvent(seq)],
    producerId: PRODUCER_ID,
    documentId: DOCUMENT_ID,
    batchSeq: seq,
    droppedCount: 0,
    ...(stamp.sessionId === undefined ? {} : { sessionId: stamp.sessionId }),
    ...(stamp.captureId === undefined ? {} : { captureId: stamp.captureId }),
  };
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'telemetry.batch',
    payload,
  };
}

/**
 * The `agent.ready` the page agent announces its document with. The port hub
 * forwards a bridge's batches only once this frame has pinned the document
 * and producer they belong to, so every case's bridge sends it first.
 */
function readyFrame(): BridgeUpstreamMessage<'agent.ready'> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'agent.ready',
    payload: {
      documentId: DOCUMENT_ID,
      producerId: PRODUCER_ID,
      url: APP_URL,
      installedBeforeReact: true,
      reactDetected: true,
    },
  };
}

/** The `devtools.hello` a DevTools page sends for its inspected tab. */
function devtoolsHello(tabId: TabId): DevtoolsUpstreamMessage<'devtools.hello'> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'devtools.hello',
    payload: { tabId, url: APP_URL, origin: APP_ORIGIN },
  };
}

/** One panel request frame of `kind`. */
function panelRequest<Kind extends PortRequestKind>(
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

/*
 * ===========================================================================
 * Chrome fakes
 * ===========================================================================
 */

/** A Chrome event: the two members the worker uses, plus a way to fire it. */
interface FakeEvent<Args extends unknown[]> {
  addListener(listener: (...args: Args) => void): void;
  removeListener(listener: (...args: Args) => void): void;
  /** Deliver the event to every listener, as the platform does. */
  emit(...args: Args): void;
}

function createEvent<Args extends unknown[]>(): FakeEvent<Args> {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    emit: (...args) => {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
  };
}

/** The `sender` of a runtime port, as far as the port hub reads it. */
interface FakeSender {
  readonly id: string;
  readonly url?: string;
  readonly origin?: string;
  readonly frameId?: number;
  readonly tab?: { readonly id: TabId };
}

/** A `chrome.runtime.Port` opened towards the worker, recording what it is sent. */
interface FakeRuntimePort {
  readonly name: ExtensionPortName;
  readonly sender: FakeSender;
  readonly onMessage: FakeEvent<[unknown]>;
  readonly onDisconnect: FakeEvent<[unknown]>;
  /** Every frame the worker posted on this port, in order. */
  readonly posted: unknown[];
  postMessage(message: unknown): void;
  disconnect(): void;
}

function createRuntimePort(name: ExtensionPortName, sender: FakeSender): FakeRuntimePort {
  const posted: unknown[] = [];
  return {
    name,
    sender,
    onMessage: createEvent<[unknown]>(),
    onDisconnect: createEvent<[unknown]>(),
    posted,
    postMessage: (message) => {
      posted.push(message);
    },
    disconnect: () => undefined,
  };
}

/**
 * The fake port as the `chrome.runtime.Port` the worker's `onConnect` listener
 * is typed with. The port hub reads exactly `name`, `sender`, `onMessage`,
 * `onDisconnect`, `postMessage` and `disconnect`, which the fake implements;
 * the remaining members of Chrome's event objects are never touched.
 */
function asChromePort(port: FakeRuntimePort): chrome.runtime.Port {
  return port as unknown as chrome.runtime.Port;
}

/** An in-memory `chrome.storage` area. */
interface FakeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  remove(key: string): Promise<void>;
}

function createStorageArea(initial: Readonly<Record<string, unknown>> = {}): FakeStorageArea {
  const values = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  return {
    get: (key) =>
      Promise.resolve(values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}),
    set: (items) => {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, structuredClone(value));
      }
      return Promise.resolve();
    },
    remove: (key) => {
      values.delete(key);
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

/**
 * Opaque numeric handles over Vitest's faked `setTimeout`, as the worker's
 * `TimerApi` requires.
 */
function createTimers(): WorkerTimerApi {
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let lastHandle = 0;
  return {
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
}

/*
 * ===========================================================================
 * The fake local service and its sockets
 * ===========================================================================
 */

/** One entry of the service's wire timeline: a frame in or out, on a socket. */
interface WireEntry {
  /** The 1-based index of the socket in construction order. */
  readonly socket: number;
  readonly direction: 'in' | 'out';
  readonly type: ProtocolMessage['type'];
  readonly tabId: number | undefined;
  readonly sessionId: string | undefined;
}

/** A `telemetry.event` the service received, with the socket it came on. */
interface ReceivedTelemetry {
  readonly socket: number;
  readonly message: MessageByType<'telemetry.event'>;
}

/**
 * The local service as the worker sees it through its socket.
 *
 * `bindAnswer` decides which session a `session.bind` is bound to — by
 * default the one it names — so a case can have the service re-bind a tab.
 */
interface FakeService {
  /** Every socket constructed, in order. */
  readonly sockets: FakeServiceSocket[];
  /** The live binding table: tab → session. Emptied by {@link stop}. */
  readonly bindings: Map<number, string>;
  /** Every frame in and out, in order. */
  readonly timeline: WireEntry[];
  /** Every `telemetry.event` stored. */
  readonly accepted: ReceivedTelemetry[];
  /** Every `telemetry.event` refused with `TAB_NOT_BOUND`. */
  readonly refused: ReceivedTelemetry[];
  /** Which session a `session.bind` binds its tab to. */
  bindAnswer: (payload: MessageByType<'session.bind'>['payload']) => string | undefined;
  /** Park every `session.bind` unprocessed, as a busy service would, until {@link releaseBinds}. */
  holdBinds(): void;
  /** Process the parked binds, in arrival order, and stop parking. */
  releaseBinds(): void;
  /** Close every open socket (a restart) and refuse connections until {@link start}. */
  stop(): void;
  /** Accept connections again, with an empty binding table. */
  start(): void;
  /** The socket constructor handed to the worker. */
  readonly ctor: WorkerEnvironment['webSocketConstructor'];
}

/** One socket as the service side sees and drives it. */
interface FakeServiceSocket extends WebSocketLike {
  /** The 1-based index in construction order. */
  readonly index: number;
  /** Every frame written to it, decoded. */
  readonly frames: ProtocolMessage[];
}

function createFakeService(): FakeService {
  const sockets: FakeServiceSocket[] = [];
  const bindings = new Map<number, string>();
  const timeline: WireEntry[] = [];
  const accepted: ReceivedTelemetry[] = [];
  const refused: ReceivedTelemetry[] = [];
  let up = true;
  // By default a bind binds the session it names; a case may replace this.
  let bindAnswer: FakeService['bindAnswer'] = (payload) => payload.sessionId;
  let holding = false;
  const heldBinds: { socket: FakeServiceSocket; message: MessageByType<'session.bind'> }[] = [];

  /** The listener sets of one socket, per event. */
  type Listeners = { [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void> };
  const listenersOf = new WeakMap<FakeServiceSocket, Listeners>();

  function emit<K extends keyof WsEventMapLike>(
    socket: FakeServiceSocket,
    type: K,
    event: WsEventMapLike[K],
  ): void {
    const listeners = listenersOf.get(socket);
    if (listeners === undefined) {
      return;
    }
    for (const listener of [...listeners[type]]) {
      listener(event);
    }
  }

  const readyStates = new WeakMap<FakeServiceSocket, number>();

  function serverClose(socket: FakeServiceSocket, code: number): void {
    readyStates.set(socket, READY_STATE.closed);
    emit(socket, 'close', { code, reason: '' });
  }

  /** Send a frame to the worker, as the network would: {@link REPLY_LATENCY_MS} later. */
  function reply(socket: FakeServiceSocket, message: ProtocolMessage): void {
    timeline.push({
      socket: socket.index,
      direction: 'out',
      type: message.type,
      tabId: tabOf(message),
      sessionId: message.sessionId ?? sessionOf(message),
    });
    const data = encodeMessage(message);
    setTimeout(() => {
      if (readyStates.get(socket) === READY_STATE.open) {
        emit(socket, 'message', { data });
      }
    }, REPLY_LATENCY_MS);
  }

  /**
   * Bind a tab live — one tab per session, as the service's binding table
   * keeps it — and answer with `session.bound`, reason `bound`.
   */
  function bind(socket: FakeServiceSocket, message: MessageByType<'session.bind'>): void {
    const sessionId = bindAnswer(message.payload);
    if (sessionId === undefined) {
      reply(
        socket,
        createEnvelope('error', { code: 'SESSION_NOT_FOUND', message: 'No session to bind.' }),
      );
      return;
    }
    for (const [tabId, bound] of bindings) {
      if (bound === sessionId && tabId !== message.payload.tabId) {
        bindings.delete(tabId);
      }
    }
    bindings.set(message.payload.tabId, sessionId);
    reply(
      socket,
      createEnvelope('session.bound', {
        sessionId,
        tabId: message.payload.tabId,
        url: message.payload.url,
        reason: 'bound',
      }),
    );
  }

  /** Serve one frame the worker wrote. */
  function serve(socket: FakeServiceSocket, message: ProtocolMessage): void {
    if (isMessageOfType(message, 'session.bind')) {
      if (holding) {
        heldBinds.push({ socket, message });
      } else {
        bind(socket, message);
      }
      return;
    }
    if (isMessageOfType(message, 'telemetry.event')) {
      const tabId = message.tabId;
      const live = tabId === undefined ? undefined : bindings.get(tabId);
      const record: ReceivedTelemetry = { socket: socket.index, message };
      if (live === undefined || (message.sessionId !== undefined && message.sessionId !== live)) {
        refused.push(record);
        reply(
          socket,
          createEnvelope('error', {
            code: 'TAB_NOT_BOUND',
            message: 'The acting tab has no live binding for this session.',
          }),
        );
        return;
      }
      accepted.push(record);
    }
  }

  class ServiceSocket implements FakeServiceSocket {
    readonly index: number;
    readonly frames: ProtocolMessage[] = [];

    constructor() {
      sockets.push(this);
      this.index = sockets.length;
      readyStates.set(this, READY_STATE.connecting);
      listenersOf.set(this, {
        open: new Set(),
        message: new Set(),
        close: new Set(),
        error: new Set(),
      });
      // The handshake completes HANDSHAKE_LATENCY_MS later, after the client
      // has attached its listeners — or the connection is refused while the
      // service is down.
      setTimeout(() => {
        if (readyStates.get(this) !== READY_STATE.connecting) {
          return;
        }
        if (up) {
          readyStates.set(this, READY_STATE.open);
          emit(this, 'open', { type: 'open' });
        } else {
          serverClose(this, ABNORMAL_CLOSURE);
        }
      }, HANDSHAKE_LATENCY_MS);
    }

    get readyState(): number {
      return readyStates.get(this) ?? READY_STATE.closed;
    }

    addEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      listenersOf.get(this)?.[type].add(listener);
    }

    removeEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      listenersOf.get(this)?.[type].delete(listener);
    }

    send(data: string): void {
      if (this.readyState !== READY_STATE.open) {
        throw new Error('the fake service socket is not open');
      }
      const decoded = decodeMessage(data);
      if (isErr(decoded)) {
        throw new Error(`the worker wrote an undecodable frame (${decoded.error.code})`);
      }
      const message = decoded.value;
      this.frames.push(message);
      timeline.push({
        socket: this.index,
        direction: 'in',
        type: message.type,
        tabId: tabOf(message),
        sessionId: message.sessionId ?? sessionOf(message),
      });
      serve(this, message);
    }

    close(): void {
      readyStates.set(this, READY_STATE.closed);
    }
  }

  return {
    sockets,
    bindings,
    timeline,
    accepted,
    refused,
    get bindAnswer() {
      return bindAnswer;
    },
    set bindAnswer(answer) {
      bindAnswer = answer;
    },
    holdBinds: () => {
      holding = true;
    },
    releaseBinds: () => {
      holding = false;
      for (const held of heldBinds.splice(0)) {
        if (held.socket.readyState === READY_STATE.open) {
          bind(held.socket, held.message);
        }
      }
    },
    stop: () => {
      up = false;
      bindings.clear();
      for (const socket of sockets) {
        if (socket.readyState === READY_STATE.open) {
          serverClose(socket, SERVICE_RESTART_CLOSE);
        }
      }
    },
    start: () => {
      up = true;
      bindings.clear();
    },
    ctor: ServiceSocket,
  };
}

/** The tab a frame names: its acting tab, else its payload's. */
function tabOf(message: ProtocolMessage): number | undefined {
  if (message.tabId !== undefined) {
    return message.tabId;
  }
  const payload: unknown = message.payload;
  if (typeof payload === 'object' && payload !== null && 'tabId' in payload) {
    const tabId = payload.tabId;
    return typeof tabId === 'number' ? tabId : undefined;
  }
  return undefined;
}

/** The session a frame's payload names, if any. */
function sessionOf(message: ProtocolMessage): string | undefined {
  const payload: unknown = message.payload;
  if (typeof payload === 'object' && payload !== null && 'sessionId' in payload) {
    const sessionId = payload.sessionId;
    return typeof sessionId === 'string' ? sessionId : undefined;
  }
  return undefined;
}

/*
 * ===========================================================================
 * The harness — one real worker over fresh fakes
 * ===========================================================================
 */

/** What a case can configure. */
interface WorkerOptions {
  /** The bindings `chrome.storage.session` holds when the worker starts. */
  readonly bindings?: readonly TabBindingRecord[];
}

/** Everything a case drives or inspects. */
interface WorkerHarness {
  readonly worker: DebugGeneratorWorker;
  readonly service: FakeService;
  readonly logs: readonly LogEntry[];
  readonly fetch: Mock<FetchLike>;
  /** Whether `worker.ready` has settled. */
  readonly isReady: () => boolean;
  /** Open a runtime port towards the worker, as Chrome would. */
  readonly connect: (name: ExtensionPortName, sender: FakeSender) => FakeRuntimePort;
}

/** A session record of `sessionId`, as the service's `GET /sessions/:id` answers it. */
function sessionRecordOf(sessionId: SessionId): unknown {
  const parsed = parseSessionRecord({
    id: sessionId,
    projectRoot: '/home/example/workspace/site',
    projectName: 'site',
    devServerUrl: APP_ORIGIN,
    createdAt: BASE_EPOCH_MS,
    updatedAt: BASE_EPOCH_MS + 1_000,
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
  });
  if (isErr(parsed)) {
    throw new Error(`the session record fixture is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** The fake service's HTTP answer to one request URL. */
function serviceRoute(url: string): HttpResponseLike {
  const path = new URL(url).pathname;
  if (path === '/health') {
    return jsonResponse(200, HEALTH_BODY);
  }
  const session = /^\/sessions\/([^/]+)(\/panel)?$/u.exec(path);
  const sessionId = session?.[1];
  if (sessionId !== undefined) {
    return session?.[2] === undefined
      ? jsonResponse(200, sessionRecordOf(decodeURIComponent(sessionId)))
      : jsonResponse(200, { panel: null });
  }
  return jsonResponse(404, { code: 'SESSION_NOT_FOUND', message: 'Not found in this test.' });
}

/** A JSON response as the stubbed `fetch` answers it. */
function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** Compose a real worker over fresh fakes. Fake timers must already be installed. */
function startWorker(options: WorkerOptions = {}): WorkerHarness {
  const logs: LogEntry[] = [];
  const service = createFakeService();
  const snapshot: Record<string, TabBindingRecord> = {};
  for (const record of options.bindings ?? []) {
    snapshot[String(record.tabId)] = record;
  }
  const local = createStorageArea({
    [DEVTOOLS_TOKEN_STORAGE_KEY]: { version: STORED_CREDENTIAL_VERSION, token: TOKEN },
  });
  const session = createStorageArea(
    Object.keys(snapshot).length === 0 ? {} : { [BINDING_STORAGE_KEY]: snapshot },
  );
  const onConnect = createEvent<[chrome.runtime.Port]>();

  // The service's health route answers, and so does each session's record
  // and current panel (none yet) — what a bound panel's snapshot reads, and
  // must read in full to be answered. Every other route answers "not found";
  // none is needed for delivery. The mock records each call's request init
  // (and its acting-tab header).
  const fetch = vi.fn<FetchLike>((url: string) => Promise.resolve(serviceRoute(url)));
  vi.stubGlobal('fetch', fetch);

  const env: WorkerEnvironment = {
    runtime: {
      id: RUNTIME_ID,
      lastError: undefined,
      onConnect,
      onInstalled: createEvent<[{ readonly reason: string }]>(),
      onStartup: createEvent<[]>(),
    },
    tabs: {
      get: (): Promise<WorkerTab> => Promise.resolve({ url: APP_URL }),
      reload: () => Promise.resolve(),
      onUpdated: createEvent<[TabId, WorkerTabChange, WorkerTab]>(),
      onRemoved: createEvent<[TabId]>(),
    },
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(true),
      onAlarm: createEvent<[{ readonly name: string }]>(),
    },
    storage: { local, session },
    webSocketConstructor: service.ctor,
    timers: createTimers(),
    serviceBaseUrl: DEFAULT_SERVICE_BASE_URL,
    logger: createRecordingLogger(logs),
    random: () => 1,
  };

  const worker = createWorker(env);
  let ready = false;
  void worker.ready.then(() => {
    ready = true;
  });

  return {
    worker,
    service,
    logs,
    fetch,
    isReady: () => ready,
    connect: (name, sender) => {
      const port = createRuntimePort(name, sender);
      onConnect.emit(asChromePort(port));
      return port;
    },
  };
}

/** The sender of the content-script bridge in the top frame of `tabId`. */
function bridgeSender(tabId: TabId): FakeSender {
  return { id: RUNTIME_ID, tab: { id: tabId }, frameId: 0, origin: APP_ORIGIN, url: APP_URL };
}

/** The sender of one of this extension's own pages (a panel or a DevTools page). */
function extensionPageSender(page: string): FakeSender {
  return { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/${page}` };
}

/** Let every pending promise continuation run; nothing due later is fired. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Advance the fake clock, then drain what the fired timers queued. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

/** Let the simulated network finish what is in flight: a handshake, a hello, a bind round trip. */
async function settleNetwork(): Promise<void> {
  await advance(NETWORK_SETTLE_MS);
}

/** The nominal backoff delay before reconnect attempt `attempt` (1-based). */
function nominalDelay(attempt: number): number {
  const { initialMs, factor, maxMs } = DEFAULT_WS_BACKOFF;
  return Math.min(initialMs * factor ** (attempt - 1), maxMs);
}

/** Every `seq` the service stored, in the order it stored them. */
function acceptedSeqs(service: FakeService): number[] {
  return service.accepted.flatMap((record) => record.message.payload.events.map((e) => e.seq));
}

/** Every event id the service received on any `telemetry.event`, stored or refused. */
function receivedEventIds(service: FakeService): string[] {
  return [...service.accepted, ...service.refused].flatMap((record) =>
    record.message.payload.events.map((event) => event.id),
  );
}

/** The message types one socket carried, in order. */
function typesOn(service: FakeService, socket: number): ProtocolMessage['type'][] {
  return service.sockets[socket - 1]?.frames.map((message) => message.type) ?? [];
}

/**
 * Whether, on `socket`, the first `session.bound` the service sent for
 * `tabId` precedes the first `telemetry.event` it received — false when
 * either is missing.
 */
function boundBeforeTelemetry(service: FakeService, socket: number, tabId: TabId): boolean {
  const bound = service.timeline.findIndex(
    (entry) =>
      entry.socket === socket &&
      entry.direction === 'out' &&
      entry.type === 'session.bound' &&
      entry.tabId === tabId,
  );
  const telemetry = service.timeline.findIndex(
    (entry) =>
      entry.socket === socket && entry.direction === 'in' && entry.type === 'telemetry.event',
  );
  return bound !== -1 && telemetry !== -1 && bound < telemetry;
}

/** The response the worker posted on `port` for `requestId`. */
function responseFor(port: FakeRuntimePort, requestId: PortRequestId): PortResponse {
  const response = port.posted.find(
    (frame): frame is PortResponse => isPortResponse(frame) && frame.requestId === requestId,
  );
  if (response === undefined) {
    throw new Error('the worker posted no response for the request');
  }
  return response;
}

/*
 * The worker's own log messages this spec observes — constant strings, never
 * carrying telemetry content, so a case can match them exactly.
 */

/** A batch whose route or write failed (warn, with a cumulative loss count). */
const LOSS_LOG = 'A telemetry batch was dropped: it could not be delivered to the local service.';

/** A batch that arrived at a full lane (warn, with a cumulative overflow count). */
const OVERFLOW_LOG = 'A telemetry batch was dropped: too many batches are waiting for its tab.';

/** A batch produced for another session or capture than the tab's binding (info). */
const STALE_LOG = 'A telemetry batch produced for another session or capture was dropped.';

/**
 * A panel's session claim its association contradicts — here a session bound
 * to another tab (info, with the panel's tab and the session's).
 */
const STALE_PANEL_CLAIM_LOG = 'A stale session claim from a panel was ignored.';

/** The log records carrying `message`. */
function logsWith(logs: readonly LogEntry[], message: string): LogEntry[] {
  return logs.filter((entry) => entry.message === message);
}

/*
 * ===========================================================================
 * Suite-wide environment
 * ===========================================================================
 */

/** Every worker a case composed, disposed after it. */
const composed: DebugGeneratorWorker[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const worker of composed.splice(0)) {
    worker.dispose();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Connect the content-script bridge of `tabId` and let its page agent
 * announce its document, as a page load does: the batches it sends next are
 * of that document.
 */
function connectAnnouncedBridge(h: WorkerHarness, tabId: TabId): FakeRuntimePort {
  const bridge = h.connect(PORT_CONTENT_BRIDGE, bridgeSender(tabId));
  bridge.onMessage.emit(readyFrame());
  return bridge;
}

/** {@link startWorker}, registered for disposal. */
function compose(options?: WorkerOptions): WorkerHarness {
  const harness = startWorker(options);
  composed.push(harness.worker);
  return harness;
}

/*
 * ===========================================================================
 * Cases
 * ===========================================================================
 */

describe('telemetry on a cold worker', () => {
  it('(i) delivers every batch posted before `ready`, in seq order, after the tab’s session.bound, each frame naming its tab and session', async () => {
    const h = compose({ bindings: [binding(TAB_A, SESSION_1)] });
    const bridge = connectAnnouncedBridge(h, TAB_A);
    for (let seq = 0; seq < 5; seq += 1) {
      bridge.onMessage.emit(batchFrame(seq, { sessionId: SESSION_1 }));
    }
    expect(h.isReady()).toBe(false);

    // `ready` settles once the socket is constructed, not once it is open,
    // authenticated or bound: the batches must wait past it.
    await flush();
    expect(h.isReady()).toBe(true);
    expect(h.worker.wsBridge.getStatus().transport).toBe('connecting');
    expect(h.service.sockets).toHaveLength(1);
    expect(typesOn(h.service, 1)).toEqual([]);
    // The one frame waiting in the socket client is the page agent's
    // `agent.ready` relay, which the client flushes after its hello; no
    // telemetry is ever handed to that queue.
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(1);

    await settleNetwork();

    expect(typesOn(h.service, 1)).toEqual([
      'client.hello',
      'agent.ready',
      'session.bind',
      'telemetry.event',
      'telemetry.event',
      'telemetry.event',
      'telemetry.event',
      'telemetry.event',
    ]);
    expect(boundBeforeTelemetry(h.service, 1, TAB_A)).toBe(true);
    expect(acceptedSeqs(h.service)).toEqual([0, 1, 2, 3, 4]);
    expect(
      h.service.accepted.map((record) => [record.message.tabId, record.message.sessionId]),
    ).toEqual(Array.from({ length: 5 }, () => [TAB_A, SESSION_1]));
    expect(h.service.refused).toEqual([]);
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);
  });
});

describe('telemetry across a service restart', () => {
  it('(ii) holds batches sent while the socket is down until the re-announced bind is confirmed — none refused, none queued in the socket client', async () => {
    const h = compose({ bindings: [binding(TAB_A, SESSION_1)] });
    const bridge = connectAnnouncedBridge(h, TAB_A);
    await settleNetwork();
    bridge.onMessage.emit(batchFrame(0, { sessionId: SESSION_1 }));
    await flush();
    expect(acceptedSeqs(h.service)).toEqual([0]);

    // The service restarts: every socket closes and the binding table empties.
    h.service.stop();
    await flush();
    expect(h.service.bindings.size).toBe(0);
    bridge.onMessage.emit(batchFrame(1, { sessionId: SESSION_1 }));
    bridge.onMessage.emit(batchFrame(2, { sessionId: SESSION_1 }));
    await flush();
    expect(h.worker.wsBridge.getStatus().transport).toBe('reconnecting');
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);

    // The first retry finds the service still down.
    await advance(nominalDelay(1));
    await settleNetwork();
    expect(h.service.sockets).toHaveLength(2);
    expect(h.service.sockets[1]?.readyState).toBe(READY_STATE.closed);
    bridge.onMessage.emit(batchFrame(3, { sessionId: SESSION_1 }));
    await flush();
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);
    expect(acceptedSeqs(h.service)).toEqual([0]);

    // Back up, but slow to process binds: the next retry connects and
    // re-announces the binding, and until the service confirms it nothing is
    // written on the new socket.
    h.service.start();
    h.service.holdBinds();
    await advance(nominalDelay(2));
    await settleNetwork();
    expect(h.service.sockets).toHaveLength(3);
    expect(h.worker.wsBridge.getStatus().transport).toBe('open');
    expect(typesOn(h.service, 3)).toEqual(['client.hello', 'session.bind']);
    expect(h.worker.wsBridge.getStatus().queuedFrameCount).toBe(0);
    bridge.onMessage.emit(batchFrame(4, { sessionId: SESSION_1 }));
    await flush();
    expect(typesOn(h.service, 3)).toEqual(['client.hello', 'session.bind']);

    // The confirmation arrives: the held batches go, in order, then new ones.
    h.service.releaseBinds();
    expect([...h.service.bindings]).toEqual([[TAB_A, SESSION_1]]);
    await settleNetwork();
    bridge.onMessage.emit(batchFrame(5, { sessionId: SESSION_1 }));
    await flush();

    expect(typesOn(h.service, 3).slice(0, 2)).toEqual(['client.hello', 'session.bind']);
    expect(
      typesOn(h.service, 3)
        .slice(2)
        .every((type) => type === 'telemetry.event'),
    ).toBe(true);
    expect(boundBeforeTelemetry(h.service, 3, TAB_A)).toBe(true);
    expect(acceptedSeqs(h.service)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(h.service.refused).toEqual([]);
    expect(
      h.service.accepted.every(
        (record) => record.message.tabId === TAB_A && record.message.sessionId === SESSION_1,
      ),
    ).toBe(true);
    expect(logsWith(h.logs, LOSS_LOG)).toEqual([]);
  });

  it('reports a batch whose route is not confirmed within TELEMETRY_ROUTE_WAIT_MS of its arrival, and delivers the ones that arrive later', async () => {
    const h = compose({ bindings: [binding(TAB_A, SESSION_1)] });
    const bridge = connectAnnouncedBridge(h, TAB_A);
    await settleNetwork();
    h.service.stop();
    await flush();
    bridge.onMessage.emit(batchFrame(0, { sessionId: SESSION_1 }));
    await flush();

    // The service stays down: nothing is reported before the batch's deadline…
    await advance(TELEMETRY_ROUTE_WAIT_MS - 1);
    expect(logsWith(h.logs, LOSS_LOG)).toEqual([]);
    // …and the loss is reported when it passes.
    await advance(1);

    const losses = logsWith(h.logs, LOSS_LOG);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.level).toBe('warn');
    expect(losses[0]?.fields).toMatchObject({
      tabId: TAB_A,
      events: 1,
      stage: 'route',
      errorCode: 'TRANSPORT_DISCONNECTED',
      lossCount: 1,
    });
    expect(JSON.stringify(losses)).not.toContain('event-test-0');

    h.service.start();
    bridge.onMessage.emit(batchFrame(1, { sessionId: SESSION_1 }));
    await advance(DEFAULT_WS_BACKOFF.maxMs);
    await settleNetwork();
    expect(acceptedSeqs(h.service)).toEqual([1]);
    expect(h.service.refused).toEqual([]);
  });
});

describe('the per-tab telemetry lane', () => {
  it('(iii) reports every batch beyond 64 pending on one tab, and delivers the rest in order', async () => {
    const h = compose({ bindings: [binding(TAB_A, SESSION_1)] });
    const bridge = connectAnnouncedBridge(h, TAB_A);
    const total = LANE_BOUND + 6;
    for (let seq = 0; seq < total; seq += 1) {
      bridge.onMessage.emit(batchFrame(seq, { sessionId: SESSION_1 }));
    }

    await settleNetwork();

    const overflow = logsWith(h.logs, OVERFLOW_LOG);
    expect(overflow).toHaveLength(total - LANE_BOUND);
    expect(overflow.map((entry) => entry.level)).toEqual(overflow.map(() => 'warn'));
    expect(overflow.map((entry) => entry.fields.overflowCount)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(overflow.every((entry) => entry.fields.pending === LANE_BOUND)).toBe(true);
    expect(acceptedSeqs(h.service)).toEqual(Array.from({ length: LANE_BOUND }, (_, seq) => seq));
    expect(h.service.refused).toEqual([]);

    // The lane is released once drained: the next batch is delivered at once.
    bridge.onMessage.emit(batchFrame(total, { sessionId: SESSION_1 }));
    await flush();
    expect(acceptedSeqs(h.service).at(-1)).toBe(total);
  });

  it('(iv) drops a batch pinned to session 1 when the tab is re-bound to session 2 before it drains — no session-1 batch is sent as session 2', async () => {
    const h = compose({ bindings: [binding(TAB_A, SESSION_1)] });
    const bridge = connectAnnouncedBridge(h, TAB_A);
    await settleNetwork();
    bridge.onMessage.emit(batchFrame(0, { sessionId: SESSION_1 }));
    await flush();
    expect(acceptedSeqs(h.service)).toEqual([0]);

    // While the socket is down, two session-1 batches wait on the lane.
    h.service.stop();
    await flush();
    bridge.onMessage.emit(batchFrame(1, { sessionId: SESSION_1 }));
    bridge.onMessage.emit(batchFrame(2, { sessionId: SESSION_1 }));
    await flush();

    // The developer replaced the session while the worker was away: the
    // service answers the re-announced binding by binding the tab to session 2.
    h.service.bindAnswer = (payload) => (payload.tabId === TAB_A ? SESSION_2 : payload.sessionId);
    h.service.start();
    await advance(nominalDelay(1));
    await settleNetwork();
    expect(await h.worker.registry.getBinding(TAB_A)).toMatchObject({ sessionId: SESSION_2 });

    bridge.onMessage.emit(batchFrame(3, { sessionId: SESSION_2 }));
    await flush();

    // Only session 2's own batch reaches the service after the re-bind.
    expect(acceptedSeqs(h.service)).toEqual([0, 3]);
    expect(
      h.service.accepted.map((record) => [record.message.tabId, record.message.sessionId]),
    ).toEqual([
      [TAB_A, SESSION_1],
      [TAB_A, SESSION_2],
    ]);
    expect(receivedEventIds(h.service)).not.toContain('event-test-1');
    expect(receivedEventIds(h.service)).not.toContain('event-test-2');
    expect(h.service.refused).toEqual([]);
    // Each session-1 batch is accounted for: the one waiting for the route
    // when the tab moved, and the one whose turn came after it.
    const routeLoss = logsWith(h.logs, LOSS_LOG);
    const stale = logsWith(h.logs, STALE_LOG);
    expect(routeLoss.map((entry) => [entry.fields.sessionId, entry.fields.errorCode])).toEqual([
      [SESSION_1, 'TAB_NOT_BOUND'],
    ]);
    expect(stale.map((entry) => [entry.fields.tabId, entry.fields.reason])).toEqual([
      [TAB_A, 'session-mismatch'],
    ]);
  });

  it('drops a batch produced for another capture than the tab’s, and never lets the page’s stamp route one', async () => {
    const h = compose({ bindings: [binding(TAB_A, SESSION_1, CAPTURE_2)] });
    const bridge = connectAnnouncedBridge(h, TAB_A);
    bridge.onMessage.emit(batchFrame(0, { sessionId: SESSION_1, captureId: CAPTURE_1 }));
    bridge.onMessage.emit(batchFrame(1, { sessionId: SESSION_1, captureId: CAPTURE_2 }));
    bridge.onMessage.emit(batchFrame(2, {}));
    bridge.onMessage.emit(batchFrame(3, { sessionId: SESSION_2 }));

    await settleNetwork();

    // The stamp only rejects: the unstamped batch goes to the tab's own session.
    expect(acceptedSeqs(h.service)).toEqual([1, 2]);
    expect(h.service.accepted.every((record) => record.message.sessionId === SESSION_1)).toBe(true);
    const stale = logsWith(h.logs, STALE_LOG);
    expect(stale.map((entry) => entry.fields.reason)).toEqual([
      'capture-mismatch',
      'session-mismatch',
    ]);
  });
});

describe('which tab a panel acts for', () => {
  it('(v) keeps a panel associated with tab B when it names tab A’s session, and never acts for tab A', async () => {
    const h = compose({ bindings: [binding(TAB_A, SESSION_1), binding(TAB_B, SESSION_2)] });
    await settleNetwork();
    const devtools = h.connect(PORT_DEVTOOLS, extensionPageSender('src/devtools/devtools.html'));
    devtools.onMessage.emit(devtoolsHello(TAB_B));
    await flush();
    const panel = h.connect(PORT_PANEL, extensionPageSender('src/panel/index.html'));

    // The panel's first snapshot associates it with its DevTools page's tab.
    const first = panelRequest('session.snapshot', {});
    panel.onMessage.emit(first);
    await flush();
    expect(responseFor(panel, first.requestId)).toMatchObject({
      ok: true,
      payload: { binding: { kind: 'bound', tabId: TAB_B, sessionId: SESSION_2 } },
    });

    // It then names tab A's session: it stays on tab B and is answered for B.
    const claim = panelRequest('session.snapshot', { sessionId: SESSION_1 });
    panel.onMessage.emit(claim);
    await flush();
    expect(responseFor(panel, claim.requestId)).toMatchObject({
      ok: true,
      payload: { binding: { kind: 'bound', tabId: TAB_B, sessionId: SESSION_2 } },
    });
    const panels = h.worker.hub
      .listConnections()
      .filter((connection) => connection.role === PORT_PANEL);
    expect(panels.map((connection) => connection.tabId)).toEqual([TAB_B]);
    expect(
      logsWith(h.logs, STALE_PANEL_CLAIM_LOG).map((entry) => [
        entry.fields.tabId,
        entry.fields.sessionTabId,
      ]),
    ).toEqual([[TAB_B, TAB_A]]);

    // Its requests for session 1 are refused here, never sent acting for tab A.
    const query = panelRequest('panelData.query', { sessionId: SESSION_1, query: TRACE_QUERY });
    const capture = panelRequest('capture.start', { sessionId: SESSION_1 });
    panel.onMessage.emit(query);
    panel.onMessage.emit(capture);
    await flush();
    for (const request of [query, capture]) {
      expect(responseFor(panel, request.requestId)).toMatchObject({
        ok: false,
        error: { code: 'TAB_NOT_BOUND' },
      });
    }
    // Every request the worker made acted for the panel's own tab — its
    // snapshots' session reads included — and none named session 1.
    const actingTabs = h.fetch.mock.calls.map(([, init]) => init?.headers?.[ACTING_TAB_HEADER]);
    expect(actingTabs).toContain(String(TAB_B));
    expect(actingTabs).not.toContain(String(TAB_A));
    expect(h.fetch.mock.calls.some(([url]) => url.includes(SESSION_1))).toBe(false);
    expect(
      h.service.timeline.some(
        (entry) =>
          entry.direction === 'in' && entry.tabId === TAB_A && entry.type !== 'session.bind',
      ),
    ).toBe(false);
  });
});
