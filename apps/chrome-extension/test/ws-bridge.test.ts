/**
 * Unit spec for `../src/background/ws-bridge.ts` — the service worker's one
 * connection to the local service, and the only module in the extension that
 * opens a socket or performs HTTP.
 *
 * Four product guarantees run through that module, and this spec holds them:
 *
 * - **The credential is presented once, first, and nowhere else.** Every
 *   connection starts with a `client.hello` frame announcing the `devtools`
 *   client, the protocol version and the stored credential — frame zero, written
 *   in the same turn the socket opens, well inside the service's
 *   `CLIENT_HELLO_TIMEOUT_MS` window — and the credential appears in no other
 *   frame, no log record and no status snapshot (AAP §0.5.6).
 * - **Chrome disconnects recover on the documented curve.** A dropped socket is
 *   retried on `DEFAULT_WS_BACKOFF` (0.5 s → 10 s, jittered downward, clamped at
 *   `maxMs`); the `chrome.alarms` keepalive — owned by the bridge, never by the
 *   platform-neutral transport — revives an evicted worker's connection; and
 *   every persisted tab binding is re-announced on each new socket
 *   (AAP §0.5.5, "Chrome disconnects").
 * - **The page agent's raw batches become protocol envelopes.** The MAIN-world
 *   agent never imports the protocol, so the bridge wraps its `{ events }` into
 *   `telemetry.event` frames — unchanged, in order, chunked to the receiver's
 *   own per-frame bound — and inbound frames are validated by
 *   `@debuggen/protocol` before one is relayed to a panel or handed to a typed
 *   subscriber (AAP §0.4.2).
 * - **A refused credential is terminal, a stopped service is a state.** A 4401
 *   close (`WS_CLOSE_UNAUTHORIZED`) reports the refusal to the credential store,
 *   renders "Not paired" and schedules no retry, while any other close is
 *   retried; a service that does not answer is the "Service not running" pill,
 *   never a throw or a rejected promise.
 *
 * The real exports are the authority. Where they refine the brief, the spec
 * follows them: the store's refusal hook is `WsBridgeDeps.onUnauthorized`, the
 * bridge's randomness is injectable (`random`), so the backoff curve is asserted
 * exactly at both edges of the jitter band and banded under `Math.random`; the
 * panel's view of the connection is the `WorkerStatusSnapshot` stream published
 * through `pushStatus` together with `getStatus().transport`; and the per-frame
 * event bound is read off `telemetryEventPayloadSchema` — the schema the service
 * validates each frame with — because the protocol keeps its
 * `MAX_EVENTS_PER_BATCH` constant module-private.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). Every collaborator of `createWsBridge`
 * is a recording fake built fresh per case and local to this file — no helper
 * module, no `vi.mock`: the module has no import-time side effect and is fully
 * injectable. The socket is a recording `WebSocketConstructorLike`; the HTTP
 * client is the protocol's real `HttpClient` over an injected `fetch` that
 * answers from an in-memory route table; the global `fetch` is replaced by a spy
 * that must record zero calls, and the global `WebSocket` is never touched, so
 * nothing reaches the network. Vitest's fake timers drive every delay. Tab ids,
 * origins, session and capture ids are neutral synthetic values (AAP §0.5.4),
 * and the credential is an obviously fake literal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  CLIENT_HELLO_TIMEOUT_MS,
  CLIENT_KINDS,
  createEnvelope,
  decodeMessage,
  DEFAULT_WS_BACKOFF,
  encodeMessage,
  healthPath,
  HTTP_ROUTES,
  HttpClient,
  isMessageOfType,
  panelDataPath,
  PROTOCOL_VERSION,
  resolveWsUrl,
  telemetryEventPayloadSchema,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
} from '@debuggen/protocol';
import type {
  AgentHookConfig,
  ClientKind,
  ConnectionState,
  DataQuery,
  FetchLike,
  HttpFetchInit,
  HttpResponseLike,
  MessageByType,
  MessageHandler,
  ProtocolMessage,
  SessionBoundPayload,
  TelemetryEventIngress,
  TokenProvider,
  WebSocketConstructorLike,
  WebSocketLike,
  WsEventMapLike,
} from '@debuggen/protocol';
import { isErr } from '@debuggen/shared';
import type { DebuggenError, LogFields, Logger, LogLevel, Result } from '@debuggen/shared';

import type { UnauthorizedEvidence, UnauthorizedHandling } from '../src/background/auth';
import {
  isRelayedMessage,
  KEEPALIVE_ALARM_NAME,
  KEEPALIVE_PERIOD_MINUTES,
} from '../src/background/messages';
import type {
  ProtocolSend,
  ProtocolSubscribe,
  RelayPush,
  TabBindingRecord,
  WorkerAlarmsApi,
  WorkerStatusSink,
  WorkerStatusSnapshot,
  WorkerTimerApi,
} from '../src/background/messages';
import { createWsBridge } from '../src/background/ws-bridge';
import type { WsBridge, WsBridgeDeps } from '../src/background/ws-bridge';
import {
  DEFAULT_SERVICE_BASE_URL,
  isRelayedMessageType,
  PANEL_CONNECTION_LABELS,
  PANEL_CONNECTION_STATUSES,
  panelConnectionStatus,
  RELAYED_MESSAGE_TYPES,
} from '../src/shared/messages';
import type { PanelConnectionStatus } from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/** A Chrome tab id, as the protocol's binding payloads type it. */
type TabId = SessionBoundPayload['tabId'];

/** A session id, as the protocol's binding payloads type it. */
type SessionId = SessionBoundPayload['sessionId'];

/**
 * The devtools credential every harness stores. Obviously fake: it matches no
 * provider's key format, and the spec asserts it never reaches a log.
 */
const TOKEN = 'test-devtools-token';

/** The tab whose panels a session is bound to. */
const TAB_A: TabId = 11;

/** A second tab, bound to another session or to none. */
const TAB_B: TabId = 22;

const SESSION_A: SessionId = 'session-test-a';
const SESSION_B: SessionId = 'session-test-b';
const CAPTURE_1 = 'capture-test-1';

/** The origin of the application under debug — a neutral local port. */
const APP_ORIGIN = 'http://127.0.0.1:4100';

/** The bound document's (already query-redacted) URL. */
const APP_URL = `${APP_ORIGIN}/workspace/overview`;

/** A base epoch-millisecond instant for bindings and events. */
const BASE_EPOCH_MS = 1_700_000_000_000;

/** WebSocket close code 1000, "normal closure": a deliberate teardown. */
const NORMAL_CLOSURE = 1000;

/** WebSocket close code 1006, "abnormal closure": the ordinary dropped socket. */
const ABNORMAL_CLOSURE = 1006;

/** The reason a refusing service gives with its 4401. Names no value. */
const REFUSED_REASON = 'the devtools credential was refused';

/** A service URL the loopback-only policy must refuse. */
const NON_LOOPBACK_SERVICE_URL = 'http://debuggen-service.test:43117';

/**
 * The client kind this connection must announce, typed by the protocol's own
 * `ClientKind` vocabulary so a rename there fails to compile here.
 */
const DEVTOOLS: ClientKind = 'devtools';

/**
 * The WHATWG `WebSocket.readyState` values the fake socket moves through. The
 * transport compares against `OPEN` before every write, so the fake must report
 * it exactly as a platform socket does.
 */
const READY_STATE = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 });

/** The persisted binding of {@link TAB_A} to {@link SESSION_A}. */
const BINDING_A: TabBindingRecord = {
  tabId: TAB_A,
  sessionId: SESSION_A,
  url: APP_URL,
  origin: APP_ORIGIN,
  boundAt: BASE_EPOCH_MS,
};

/** A complete agent hook set with every flag at one value. */
function hookSet(enabled: boolean): AgentHookConfig {
  return {
    interactions: enabled,
    react: enabled,
    state: enabled,
    fetch: enabled,
    perf: enabled,
    errors: enabled,
    componentTree: enabled,
  };
}

/** A lowercase hexadecimal identifier of `width` digits, never all zeros. */
function hexId(value: number, width: number): string {
  return (value + 1).toString(16).padStart(width, '0');
}

/**
 * One raw, ingress-shaped event exactly as the page agent emits it: no session,
 * capture or ingest fields — those are the service's to assign.
 */
function makeEvent(index: number): TelemetryEventIngress {
  return {
    id: `event-test-${String(index)}`,
    traceId: hexId(index, 32),
    spanId: hexId(index, 16),
    kind: 'interaction',
    name: 'click',
    startTime: BASE_EPOCH_MS + index,
    duration: 1.5,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: 'producer-test-1',
    seq: index,
  };
}

/** `count` consecutive raw events. */
function makeEvents(count: number): TelemetryEventIngress[] {
  return Array.from({ length: count }, (_, index) => makeEvent(index));
}

/**
 * The largest batch {@link telemetryFrameEventLimit} probes before concluding
 * the schema declares no bound at all.
 */
const FRAME_LIMIT_PROBE_CEILING = 2 ** 16;

/**
 * The most events one `telemetry.event` frame may carry, as the schema the
 * service validates every frame with reports it.
 *
 * The protocol keeps its `MAX_EVENTS_PER_BATCH` constant module-private and
 * exports only the schema that enforces it, so the bound is derived from that
 * schema's public behaviour — never read out of the bridge's own mechanism:
 * valid batches of doubling size are validated until one is refused, and the
 * refusal's `too_big` issue on `events` names the maximum. The chunking case
 * then re-proves the value at the boundary (exactly `limit` events validate,
 * one more does not).
 */
function telemetryFrameEventLimit(): number {
  for (let size = 1; size <= FRAME_LIMIT_PROBE_CEILING; size *= 2) {
    const parsed = telemetryEventPayloadSchema.safeParse({ events: makeEvents(size) });
    if (parsed.success) {
      continue;
    }
    for (const issue of parsed.error.issues) {
      if (
        issue.code === 'too_big' &&
        issue.path.length === 1 &&
        issue.path[0] === 'events' &&
        typeof issue.maximum === 'number'
      ) {
        return issue.maximum;
      }
    }
    throw new Error(
      `a batch of ${String(size)} valid events was refused for a reason other than its length`,
    );
  }
  throw new Error('telemetryEventPayloadSchema accepted every probed batch: it declares no bound');
}

/**
 * The nominal `DEFAULT_WS_BACKOFF` delay before reconnect attempt `attempt`
 * (1-based): `initialMs · factor^(attempt − 1)`, clamped at `maxMs`. Every
 * number comes from the exported curve.
 */
function nominalDelay(attempt: number): number {
  const { initialMs, factor, maxMs } = DEFAULT_WS_BACKOFF;
  return Math.min(initialMs * factor ** (attempt - 1), maxMs);
}

/** The first attempt whose nominal delay has reached the `maxMs` clamp. */
function clampAttempt(): number {
  let attempt = 1;
  while (nominalDelay(attempt) < DEFAULT_WS_BACKOFF.maxMs) {
    attempt += 1;
  }
  return attempt;
}

/** A JSON response as the injected `fetch` answers it. */
function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** A running service's `GET /health` answer. */
const HEALTH_BODY = Object.freeze({
  version: '0.1.0-test',
  protocolVersion: PROTOCOL_VERSION,
  pairingAvailable: true,
});

/** A panel-data query for one trace — the timeline's query shape. */
const TRACE_QUERY: DataQuery = { source: 'trace', filter: { traceId: hexId(0, 32) } };

/*
 * ===========================================================================
 * The fake socket — a recording `WebSocketConstructorLike`
 * ===========================================================================
 */

/** One `close(code, reason)` call a socket received. */
interface CloseCall {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

/** The listener sets of one socket, one per event of `WsEventMapLike`. */
type SocketListeners = {
  [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void>;
};

/**
 * A socket the spec drives by hand: it records every frame written to it and
 * every close it was asked for, and it fires the four events on demand, exactly
 * as a platform socket would.
 */
interface FakeSocket extends WebSocketLike {
  /** The URL the transport constructed it with. */
  readonly url: string;
  /** Every text frame written to it, in order. */
  readonly sent: readonly string[];
  /** Every `close()` call it received, in order. */
  readonly closeCalls: readonly CloseCall[];
  /** How many listeners are attached, across the four events. */
  listenerCount(): number;
  /** The server accepted the connection: `readyState` OPEN, then `open`. */
  accept(): void;
  /** The server sent one frame. */
  receive(data: unknown): void;
  /** The connection closed from the far side: `readyState` CLOSED, then `close`. */
  drop(code: number, reason?: string): void;
}

/**
 * Build a recording socket constructor and the list every socket it constructs
 * is appended to. The class is declared inside the factory so each harness owns
 * its own list — there is no module-level state.
 */
function createSocketFactory(): {
  readonly ctor: WebSocketConstructorLike;
  readonly sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];

  class RecordingSocket implements FakeSocket {
    readyState: number = READY_STATE.connecting;
    readonly url: string;
    readonly sent: string[] = [];
    readonly closeCalls: CloseCall[] = [];
    private readonly listeners: SocketListeners = {
      open: new Set(),
      message: new Set(),
      close: new Set(),
      error: new Set(),
    };

    constructor(url: string) {
      this.url = url;
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

    close(code?: number, reason?: string): void {
      this.closeCalls.push({ code, reason });
      this.readyState = READY_STATE.closing;
    }

    listenerCount(): number {
      return (
        this.listeners.open.size +
        this.listeners.message.size +
        this.listeners.close.size +
        this.listeners.error.size
      );
    }

    accept(): void {
      this.readyState = READY_STATE.open;
      this.emit('open', { type: 'open' });
    }

    receive(data: unknown): void {
      this.emit('message', { data });
    }

    drop(code: number, reason = ''): void {
      this.readyState = READY_STATE.closed;
      this.emit('close', { code, reason });
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
 * Harness — one recording fake per `WsBridgeDeps` member
 * ===========================================================================
 */

/** One record the injected logger received, bindings merged in. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A `Logger` that records every call, children included, into one list. */
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

/** How the injected `fetch` answers one path. */
type RouteHandler = (init: HttpFetchInit | undefined) => Promise<HttpResponseLike>;

/** What a case can change about the world while it runs. */
interface HarnessState {
  /** Whether the credential store holds a credential. */
  credentialStored: boolean;
  /** Whether the service answers HTTP at all. */
  serviceUp: boolean;
  /** The bindings `chrome.storage.session` holds, as `listBindings` reads them. */
  bindings: TabBindingRecord[];
  /** What the credential store answers when told of a refusal. */
  unauthorizedAnswer: UnauthorizedHandling;
}

/** How a case configures its harness. */
interface HarnessOptions {
  /**
   * The jitter source: a fixed function, or `'platform'` to leave the bridge on
   * its `Math.random` default. Defaults to `() => 1`, which makes every delay
   * exactly the nominal curve.
   */
  readonly random?: (() => number) | 'platform';
  /** Whether a credential is stored when the case starts. Defaults to `true`. */
  readonly credentialStored?: boolean;
  /** Whether the service answers HTTP when the case starts. Defaults to `true`. */
  readonly serviceUp?: boolean;
  /** The persisted bindings. Defaults to none. */
  readonly bindings?: readonly TabBindingRecord[];
  /** The configured service base URL. Defaults to `DEFAULT_SERVICE_BASE_URL`. */
  readonly serviceBaseUrl?: string;
  /** The primary inspected tab the hello announces. Defaults to none. */
  readonly primaryTabId?: TabId;
  /** What the credential store answers to a refusal. Defaults to `'cleared'`. */
  readonly unauthorizedAnswer?: UnauthorizedHandling;
  /**
   * The credential getter. Defaults to the store's: the token while one is
   * stored, `undefined` after the store cleared it.
   */
  readonly token?: TokenProvider;
}

/** Everything a case drives or inspects. */
interface Harness {
  readonly bridge: WsBridge;
  /** Every socket the transport constructed, in order. */
  readonly sockets: readonly FakeSocket[];
  /** Every delay handed to the injected `setTimeout`, in order. */
  readonly delays: readonly number[];
  readonly state: HarnessState;
  /** The injected `fetch`'s route table, keyed by path. */
  readonly routes: Map<string, RouteHandler>;
  readonly fetch: Mock<FetchLike>;
  readonly tokenProvider: Mock<TokenProvider>;
  readonly hasCredential: Mock<() => Promise<boolean>>;
  readonly onUnauthorized: Mock<(evidence: UnauthorizedEvidence) => Promise<UnauthorizedHandling>>;
  readonly createAlarm: Mock<WorkerAlarmsApi['create']>;
  readonly clearAlarm: Mock<WorkerAlarmsApi['clear']>;
  readonly setTimer: Mock<WorkerTimerApi['setTimeout']>;
  readonly clearTimer: Mock<WorkerTimerApi['clearTimeout']>;
  readonly relayPush: Mock<RelayPush>;
  readonly pushStatus: Mock<WorkerStatusSink>;
  readonly listBindings: Mock<WsBridgeDeps['listBindings']>;
  readonly logs: readonly LogEntry[];
}

/** Build a bridge over fresh fakes. Fake timers must already be installed. */
function createHarness(options: HarnessOptions = {}): Harness {
  const state: HarnessState = {
    credentialStored: options.credentialStored ?? true,
    serviceUp: options.serviceUp ?? true,
    bindings: [...(options.bindings ?? [])],
    unauthorizedAnswer: options.unauthorizedAnswer ?? 'cleared',
  };
  const logs: LogEntry[] = [];
  const logger = createRecordingLogger(logs);
  const { ctor, sockets } = createSocketFactory();

  // Opaque numeric handles over Vitest's faked `setTimeout`, as `TimerApi` requires.
  const delays: number[] = [];
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let lastHandle = 0;
  const setTimer = vi.fn<WorkerTimerApi['setTimeout']>((handler, ms) => {
    delays.push(ms);
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
  });
  const clearTimer = vi.fn<WorkerTimerApi['clearTimeout']>((handle) => {
    const timer = live.get(handle);
    if (timer !== undefined) {
      clearTimeout(timer);
      live.delete(handle);
    }
  });

  const routes = new Map<string, RouteHandler>([
    [healthPath(), () => Promise.resolve(jsonResponse(200, HEALTH_BODY))],
  ]);
  // A stopped service refuses the connection itself, whatever the path — the
  // rejection a platform `fetch` answers with for a closed port.
  const fetch = vi.fn<FetchLike>((url, init) => {
    if (!state.serviceUp) {
      return Promise.reject(new TypeError('connection refused by the test fetch'));
    }
    const route = routes.get(new URL(url).pathname);
    return route === undefined
      ? Promise.reject(new TypeError('the test fetch has no route for this request'))
      : route(init);
  });

  const tokenProvider = vi.fn<TokenProvider>(
    options.token ?? (() => (state.credentialStored ? TOKEN : undefined)),
  );
  const hasCredential = vi.fn<() => Promise<boolean>>(() =>
    Promise.resolve(state.credentialStored),
  );
  const onUnauthorized = vi.fn<(evidence: UnauthorizedEvidence) => Promise<UnauthorizedHandling>>(
    () => {
      const answer = state.unauthorizedAnswer;
      if (answer === 'cleared') {
        state.credentialStored = false;
      }
      return Promise.resolve(answer);
    },
  );
  const createAlarm = vi.fn<WorkerAlarmsApi['create']>(() => Promise.resolve());
  const clearAlarm = vi.fn<WorkerAlarmsApi['clear']>(() => Promise.resolve(true));
  const relayPush = vi.fn<RelayPush>();
  const pushStatus = vi.fn<WorkerStatusSink>();
  const listBindings = vi.fn<WsBridgeDeps['listBindings']>(() =>
    Promise.resolve([...state.bindings]),
  );

  const serviceBaseUrl = options.serviceBaseUrl ?? DEFAULT_SERVICE_BASE_URL;
  const httpClient = new HttpClient({
    baseUrl: serviceBaseUrl,
    token: tokenProvider,
    fetch,
    logger,
  });
  const random = options.random ?? (() => 1);
  const primaryTabId = options.primaryTabId;

  const bridge = createWsBridge({
    webSocketConstructor: ctor,
    httpClient,
    tokenProvider,
    onUnauthorized,
    hasCredential,
    alarms: { create: createAlarm, clear: clearAlarm },
    timers: { setTimeout: setTimer, clearTimeout: clearTimer },
    random: random === 'platform' ? undefined : random,
    relayPush,
    pushStatus,
    listBindings,
    serviceBaseUrl,
    primaryTabId: () => primaryTabId,
    logger,
  });

  return {
    bridge,
    sockets,
    delays,
    state,
    routes,
    fetch,
    tokenProvider,
    hasCredential,
    onUnauthorized,
    createAlarm,
    clearAlarm,
    setTimer,
    clearTimer,
    relayPush,
    pushStatus,
    listBindings,
    logs,
  };
}

/*
 * ===========================================================================
 * Query and driving helpers over the recorded fakes
 * ===========================================================================
 */

/**
 * Let every pending promise continuation run. `advanceTimersByTimeAsync(0)`
 * yields to the real event loop before it fires anything, so the whole
 * microtask queue drains; nothing that is due later is fired.
 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Advance the fake clock, then drain what the fired timers queued. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

/** The socket at `index`, narrowed rather than asserted. */
function socketAt(h: Harness, index: number): FakeSocket {
  const socket = h.sockets[index];
  if (socket === undefined) {
    throw new Error(`no socket was constructed at index ${String(index)}`);
  }
  return socket;
}

/** The most recently constructed socket. */
function latestSocket(h: Harness): FakeSocket {
  return socketAt(h, h.sockets.length - 1);
}

/** Decode one recorded frame with the protocol's own validator. */
function decodeFrame(frame: string): ProtocolMessage {
  const decoded = decodeMessage(frame);
  if (isErr(decoded)) {
    throw new Error(`a recorded frame failed to decode (${decoded.error.code})`);
  }
  return decoded.value;
}

/** Every frame a socket carried, decoded. */
function framesOf(socket: FakeSocket): ProtocolMessage[] {
  return socket.sent.map(decodeFrame);
}

/** The message types a socket carried, in order. */
function typesOf(socket: FakeSocket): ProtocolMessage['type'][] {
  return framesOf(socket).map((message) => message.type);
}

/** Deliver one inbound frame, encoded exactly as the service encodes it. */
function deliver(socket: FakeSocket, message: ProtocolMessage): void {
  socket.receive(encodeMessage(message));
}

/** Connect, let the server accept, and let the open handling settle. */
async function connectAndOpen(h: Harness): Promise<FakeSocket> {
  await h.bridge.connect();
  const socket = latestSocket(h);
  socket.accept();
  await flush();
  return socket;
}

/** Every status pushed to the panels, in order. */
function pushedStatuses(h: Harness): PanelConnectionStatus[] {
  return h.pushStatus.mock.calls.map(([snapshot]) => snapshot.status);
}

/** A list with consecutive repeats collapsed: the transitions a panel saw. */
function transitions<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

/** The last snapshot pushed to the panels. */
function lastPushed(h: Harness): WorkerStatusSnapshot {
  const call = h.pushStatus.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('no status snapshot was pushed');
  }
  return call[0];
}

/** Drop the latest socket from the far side with a reconnectable code. */
async function dropLatest(h: Harness, code: number = ABNORMAL_CLOSURE): Promise<void> {
  latestSocket(h).drop(code);
  await flush();
}

/** How many `GET /health` probes the injected `fetch` has received. */
function healthProbeCount(h: Harness): number {
  return h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === healthPath()).length;
}

/*
 * ===========================================================================
 * Suite-wide environment: fake timers, and a global `fetch` that must never run
 * ===========================================================================
 */

/** Stands in for the platform `fetch`; any call would be a real network request. */
const globalFetch = vi.fn<FetchLike>(() =>
  Promise.reject(new Error('the platform fetch must never be reached from this spec')),
);

beforeEach(() => {
  vi.useFakeTimers();
  globalFetch.mockClear();
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The value of a successful `Result`, or a failure naming the error code. */
function okValue<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    throw new Error(`expected an ok Result, got ${result.error.code}`);
  }
  return result.value;
}

/** The first frame a socket carried, decoded. */
function firstFrame(socket: FakeSocket): ProtocolMessage {
  const frame = socket.sent[0];
  if (frame === undefined) {
    throw new Error('the socket carried no frame');
  }
  return decodeFrame(frame);
}

/** A decoded frame narrowed to `client.hello`, or a failure naming its type. */
function asHello(message: ProtocolMessage): MessageByType<'client.hello'> {
  if (!isMessageOfType(message, 'client.hello')) {
    throw new Error(`expected client.hello, got ${message.type}`);
  }
  return message;
}

/** The canonical socket URL of the default service, as the protocol resolves it. */
function defaultSocketUrl(): string {
  const resolved = resolveWsUrl(DEFAULT_SERVICE_BASE_URL);
  if (isErr(resolved)) {
    throw new Error(`the default service URL was refused (${resolved.error.code})`);
  }
  return resolved.value;
}

/*
 * ===========================================================================
 * Cases
 * ===========================================================================
 */

describe('createWsBridge', () => {
  it('is pure construction: no socket, no alarm, no probe, no published status', () => {
    const h = createHarness({ bindings: [BINDING_A] });

    expect(h.sockets).toHaveLength(0);
    expect(h.createAlarm).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.hasCredential).not.toHaveBeenCalled();
    expect(h.tokenProvider).not.toHaveBeenCalled();
    expect(h.listBindings).not.toHaveBeenCalled();
    expect(h.pushStatus).not.toHaveBeenCalled();
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'closed',
      keepaliveArmed: false,
      disposed: false,
      queuedFrameCount: 0,
    });
  });
});

describe('the client.hello handshake', () => {
  it('opens exactly one socket, at the canonical ws://…/ws endpoint of the configured service', async () => {
    const h = createHarness();

    await h.bridge.connect();

    expect(h.sockets).toHaveLength(1);
    const socket = socketAt(h, 0);
    const endpoint = new URL(socket.url);
    expect(socket.url).toBe(defaultSocketUrl());
    expect(endpoint.protocol).toBe('ws:');
    expect(endpoint.pathname).toBe(WS_PATH);
    expect(endpoint.host).toBe(new URL(DEFAULT_SERVICE_BASE_URL).host);
    expect(h.bridge.getStatus().transport).toBe<ConnectionState>('connecting');

    // Connecting again while an attempt is under way never opens a second socket.
    await h.bridge.connect();
    expect(h.sockets).toHaveLength(1);
  });

  it('writes client.hello as frame 0 — devtools kind, stored credential, protocol version — in the turn the socket opens', async () => {
    const h = createHarness({ primaryTabId: TAB_A });
    await h.bridge.connect();
    const socket = socketAt(h, 0);
    expect(socket.sent).toHaveLength(0);

    socket.accept();

    // Nothing has drained and no timer has run: the hello is already on the
    // wire, far inside the service's CLIENT_HELLO_TIMEOUT_MS window, and no
    // deadline timer was needed for a credential that answers synchronously.
    const hello = asHello(firstFrame(socket));
    expect(CLIENT_KINDS).toContain(hello.payload.client);
    expect(hello.payload.client).toBe(DEVTOOLS);
    expect(hello.payload.token).toBe(TOKEN);
    expect(hello.payload.version).toBe(PROTOCOL_VERSION);
    expect(hello.payload.tabId).toBe(TAB_A);
    expect(h.delays).toEqual([]);
    expect(h.tokenProvider).toHaveBeenCalledTimes(1);
    expect(h.bridge.getStatus().transport).toBe<ConnectionState>('open');

    await flush();
    expect(typesOf(socket).filter((type) => type === 'client.hello')).toHaveLength(1);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
    expect(PANEL_CONNECTION_LABELS[lastPushed(h).status]).toBe('Connected');
  });

  it('omits tabId from the hello while no inspected tab is known', async () => {
    const h = createHarness();

    const socket = await connectAndOpen(h);

    const hello = asHello(firstFrame(socket));
    expect(Object.keys(hello.payload)).not.toContain('tabId');
    expect(hello.payload.token).toBe(TOKEN);
  });

  it('queues a frame sent while connecting and writes it only after the hello', async () => {
    const h = createHarness();
    await h.bridge.connect();
    const socket = socketAt(h, 0);

    const queued = h.bridge.send('tab.navigated', { tabId: TAB_A, url: APP_URL });

    expect(okValue(queued)).toBe('queued');
    expect(socket.sent).toHaveLength(0);
    expect(h.bridge.getStatus().queuedFrameCount).toBe(1);

    socket.accept();
    await flush();

    expect(typesOf(socket)).toEqual(['client.hello', 'tab.navigated']);
    const navigated = framesOf(socket)[1];
    expect(navigated?.payload).toEqual({ tabId: TAB_A, url: APP_URL });
    expect(h.bridge.getStatus().queuedFrameCount).toBe(0);

    // Once open, a frame goes straight to the socket.
    expect(okValue(h.bridge.send('tab.navigated', { tabId: TAB_B, url: APP_URL }))).toBe('sent');
    expect(typesOf(socket)).toEqual(['client.hello', 'tab.navigated', 'tab.navigated']);
  });

  it('refuses a frame sent before any connection as a typed Err, without throwing', () => {
    const h = createHarness();
    const send: ProtocolSend = h.bridge.send;

    const outcome = send('tab.navigated', { tabId: TAB_A, url: APP_URL });

    expect(isErr(outcome)).toBe(true);
    expect(h.sockets).toHaveLength(0);
  });

  it('opens nothing without a stored credential, and the pill says Not paired', async () => {
    const h = createHarness({ credentialStored: false });

    await h.bridge.connect();

    expect(h.sockets).toHaveLength(0);
    expect(h.tokenProvider).not.toHaveBeenCalled();
    expect(h.createAlarm).not.toHaveBeenCalled();
    const snapshot = lastPushed(h);
    expect(snapshot.status).toBe<PanelConnectionStatus>('not-paired');
    expect(PANEL_CONNECTION_LABELS[snapshot.status]).toBe('Not paired');
    expect(snapshot.hasCredential).toBe(false);
  });

  it('puts nothing on the wire when the credential store stalls past CLIENT_HELLO_TIMEOUT_MS, and does not retry', async () => {
    const h = createHarness({ token: () => new Promise<string | undefined>(() => {}) });
    await h.bridge.connect();
    const socket = socketAt(h, 0);

    socket.accept();
    await flush();

    // The local deadline is exactly the service's own hello window.
    expect(h.delays).toEqual([CLIENT_HELLO_TIMEOUT_MS]);
    await advance(CLIENT_HELLO_TIMEOUT_MS - 1);
    expect(socket.closeCalls).toHaveLength(0);

    await advance(1);

    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(1);
    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.onUnauthorized.mock.calls[0]?.[0]).toMatchObject({ code: WS_CLOSE_UNAUTHORIZED });
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('not-paired');

    await advance(DEFAULT_WS_BACKOFF.maxMs * 3);
    expect(h.sockets).toHaveLength(1);
  });

  it('refuses a non-loopback service URL: no socket, no credential read, and the pill says Service not running', async () => {
    const h = createHarness({ serviceBaseUrl: NON_LOOPBACK_SERVICE_URL });

    await h.bridge.connect();
    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });

    expect(h.sockets).toHaveLength(0);
    expect(h.tokenProvider).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.createAlarm).not.toHaveBeenCalled();
    const snapshot = lastPushed(h);
    expect(snapshot.status).toBe<PanelConnectionStatus>('service-not-running');
    expect(PANEL_CONNECTION_LABELS[snapshot.status]).toBe('Service not running');
    expect(snapshot.hint?.length ?? 0).toBeGreaterThan(0);
    // The refused value is never displayed: it may carry a pasted credential.
    expect(snapshot.serviceUrl).toBeUndefined();
    expect(JSON.stringify(h.pushStatus.mock.calls)).not.toContain(
      new URL(NON_LOOPBACK_SERVICE_URL).hostname,
    );
    expect(h.bridge.getStatus().configurationErrorCode).toBeDefined();
  });

  it('carries the credential only inside client.hello — never in another frame, a log record or a status snapshot', async () => {
    const h = createHarness({ bindings: [BINDING_A], primaryTabId: TAB_A });
    await connectAndOpen(h);
    h.bridge.sendTelemetryBatch(TAB_A, makeEvents(3));
    h.bridge.send('tab.navigated', { tabId: TAB_A, url: APP_URL });
    await dropLatest(h);
    await advance(nominalDelay(1));
    latestSocket(h).accept();
    await flush();
    await h.bridge.probeService();
    latestSocket(h).drop(WS_CLOSE_UNAUTHORIZED, REFUSED_REASON);
    await flush();

    expect(h.sockets).toHaveLength(2);
    let hellos = 0;
    for (const socket of h.sockets) {
      for (const frame of socket.sent) {
        const message = decodeFrame(frame);
        if (isMessageOfType(message, 'client.hello')) {
          hellos += 1;
          expect(message.payload.token).toBe(TOKEN);
        } else {
          expect(frame).not.toContain(TOKEN);
        }
      }
    }
    expect(hellos).toBe(2);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
    expect(JSON.stringify(h.pushStatus.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(h.relayPush.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(h.bridge.getStatus())).not.toContain(TOKEN);
  });
});

describe('reconnect backoff (0.5 s → 10 s) and the chrome.alarms keepalive', () => {
  it("retries a dropped connection on DEFAULT_WS_BACKOFF's nominal curve, clamping at maxMs", async () => {
    const h = createHarness({ random: () => 1 });
    await h.bridge.connect();
    const lastAttempt = clampAttempt() + 2;
    const observed: number[] = [];

    for (let attempt = 1; attempt <= lastAttempt; attempt += 1) {
      const socketsBefore = h.sockets.length;
      await dropLatest(h);

      const delay = h.delays.at(-1) ?? Number.NaN;
      observed.push(delay);
      expect(delay).toBe(nominalDelay(attempt));
      expect(h.bridge.getStatus().transport).toBe<ConnectionState>('reconnecting');
      const snapshot = lastPushed(h);
      expect(snapshot.status).toBe<PanelConnectionStatus>('reconnecting');
      expect(PANEL_CONNECTION_LABELS[snapshot.status]).toBe('Reconnecting\u2026');
      expect(snapshot.retryInMs).toBe(delay);

      // The attempt happens after the delay — not a millisecond before it.
      await advance(delay - 1);
      expect(h.sockets).toHaveLength(socketsBefore);
      await advance(1);
      expect(h.sockets).toHaveLength(socketsBefore + 1);
      expect(latestSocket(h).url).toBe(defaultSocketUrl());
    }

    const { initialMs, factor, maxMs } = DEFAULT_WS_BACKOFF;
    expect(observed[0]).toBe(initialMs);
    observed.forEach((delay, index) => {
      expect(delay).toBeLessThanOrEqual(maxMs);
      const previous = observed[index - 1];
      if (previous !== undefined) {
        expect(delay).toBe(Math.min(previous * factor, maxMs));
      }
    });
    expect(observed.slice(clampAttempt() - 1)).toEqual(
      Array.from({ length: lastAttempt - clampAttempt() + 1 }, () => maxMs),
    );
    expect(h.onUnauthorized).not.toHaveBeenCalled();
  });

  it('with the lowest jitter sample, every delay sits exactly at the bottom of the band', async () => {
    const h = createHarness({ random: () => 0 });
    await h.bridge.connect();
    const { jitter } = DEFAULT_WS_BACKOFF;

    for (let attempt = 1; attempt <= clampAttempt() + 1; attempt += 1) {
      await dropLatest(h);
      const delay = h.delays.at(-1) ?? Number.NaN;
      expect(delay).toBe(Math.round(nominalDelay(attempt) * (1 - jitter)));
      await advance(delay);
    }
  });

  it('under the platform Math.random, every delay stays inside the jitter band and never exceeds maxMs', async () => {
    const random = vi.spyOn(Math, 'random');
    const h = createHarness({ random: 'platform' });
    await h.bridge.connect();
    const { jitter, maxMs } = DEFAULT_WS_BACKOFF;
    const attempts = clampAttempt() + 2;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await dropLatest(h);
      const delay = h.delays.at(-1) ?? Number.NaN;
      const nominal = nominalDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(nominal * (1 - jitter)));
      expect(delay).toBeLessThanOrEqual(nominal);
      expect(delay).toBeLessThanOrEqual(maxMs);
      await advance(delay);
    }

    expect(random.mock.calls.length).toBeGreaterThanOrEqual(attempts);
  });

  it('starts the curve over once a connection has opened', async () => {
    const h = createHarness();
    await h.bridge.connect();
    await dropLatest(h);
    await advance(nominalDelay(1));
    await dropLatest(h);
    expect(h.delays).toEqual([nominalDelay(1), nominalDelay(2)]);

    await advance(nominalDelay(2));
    latestSocket(h).accept();
    await flush();
    await dropLatest(h);

    expect(h.delays.at(-1)).toBe(DEFAULT_WS_BACKOFF.initialMs);
  });

  it('walks the panel through Reconnecting… → Connected → Reconnecting… → Connected, re-announcing every binding on each open', async () => {
    const h = createHarness({ bindings: [BINDING_A] });
    const transports: ConnectionState[] = [];

    await h.bridge.connect();
    transports.push(h.bridge.getStatus().transport);
    socketAt(h, 0).accept();
    await flush();
    transports.push(h.bridge.getStatus().transport);
    await dropLatest(h);
    transports.push(h.bridge.getStatus().transport);
    await advance(nominalDelay(1));
    latestSocket(h).accept();
    await flush();
    transports.push(h.bridge.getStatus().transport);

    expect(transports).toEqual<ConnectionState[]>(['connecting', 'open', 'reconnecting', 'open']);

    const expectedBind = {
      tabId: BINDING_A.tabId,
      url: BINDING_A.url,
      origin: BINDING_A.origin,
      sessionId: BINDING_A.sessionId,
    };
    for (const socket of h.sockets) {
      expect(typesOf(socket)).toEqual(['client.hello', 'session.bind']);
      const bind = framesOf(socket)[1];
      expect(bind?.payload).toEqual(expectedBind);
      expect(bind?.sessionId).toBe(SESSION_A);
    }
    expect(h.listBindings).toHaveBeenCalledTimes(2);

    const seen = transitions(pushedStatuses(h));
    expect(seen).toEqual<PanelConnectionStatus[]>([
      'reconnecting',
      'connected',
      'reconnecting',
      'connected',
    ]);
    expect(seen.map((status) => PANEL_CONNECTION_LABELS[status])).toEqual([
      'Reconnecting\u2026',
      'Connected',
      'Reconnecting\u2026',
      'Connected',
    ]);
    // A connect in progress renders exactly as the shared derivation says it must.
    expect(seen[0]).toBe(
      panelConnectionStatus({ transport: 'connecting', paired: true, serviceReachable: true }),
    );
    for (const [snapshot] of h.pushStatus.mock.calls) {
      expect(PANEL_CONNECTION_STATUSES).toContain(snapshot.status);
    }
  });

  it('logs a failed binding read and keeps the connection', async () => {
    const h = createHarness();
    h.listBindings.mockRejectedValueOnce(new Error('session storage unavailable'));

    const socket = await connectAndOpen(h);

    expect(typesOf(socket)).toEqual(['client.hello']);
    expect(h.bridge.getStatus().transport).toBe<ConnectionState>('open');
    expect(socket.closeCalls).toHaveLength(0);
    expect(h.logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('creates the keepalive alarm once, on the bridge, with KEEPALIVE_ALARM_NAME and KEEPALIVE_PERIOD_MINUTES — never through the transport or the chrome global', async () => {
    const globalCreate = vi.fn();
    const globalClear = vi.fn();
    vi.stubGlobal('chrome', { alarms: { create: globalCreate, clear: globalClear } });
    const h = createHarness();

    await connectAndOpen(h);
    for (let reconnect = 0; reconnect < 2; reconnect += 1) {
      await dropLatest(h);
      await advance(nominalDelay(1));
      latestSocket(h).accept();
      await flush();
    }

    expect(h.sockets).toHaveLength(3);
    expect(h.createAlarm).toHaveBeenCalledTimes(1);
    expect(h.createAlarm).toHaveBeenCalledWith(KEEPALIVE_ALARM_NAME, {
      periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
    });
    expect(h.bridge.getStatus().keepaliveArmed).toBe(true);
    expect(h.clearAlarm).not.toHaveBeenCalled();
    expect(globalCreate).not.toHaveBeenCalled();
    expect(globalClear).not.toHaveBeenCalled();
  });

  it("lets a revived worker's first keepalive tick re-establish the connection and re-announce the persisted bindings", async () => {
    // The worker was evicted: nothing in memory survives, the binding does
    // (chrome.storage.session), and the alarm is the only thing that runs.
    const h = createHarness({ bindings: [BINDING_A] });

    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });

    expect(h.sockets).toHaveLength(1);
    expect(h.createAlarm).toHaveBeenCalledWith(KEEPALIVE_ALARM_NAME, {
      periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
    });
    latestSocket(h).accept();
    await flush();
    expect(typesOf(latestSocket(h))).toEqual(['client.hello', 'session.bind']);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
  });

  it('a tick while reconnecting only refreshes reachability — it never overtakes the backoff timer', async () => {
    const h = createHarness();
    await h.bridge.connect();
    await dropLatest(h);
    const probes = healthProbeCount(h);

    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });
    await flush();

    expect(healthProbeCount(h)).toBe(probes + 1);
    expect(h.sockets).toHaveLength(1);
    expect(h.delays).toEqual([nominalDelay(1)]);
    await advance(nominalDelay(1) - 1);
    expect(h.sockets).toHaveLength(1);
    await advance(1);
    expect(h.sockets).toHaveLength(2);
  });

  it('a tick on an open connection writes nothing and opens nothing', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const framesBefore = socket.sent.length;

    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });
    await h.bridge.handleKeepaliveAlarm();
    await flush();

    expect(h.sockets).toHaveLength(1);
    expect(socket.sent).toHaveLength(framesBefore);
    expect(h.bridge.getStatus().transport).toBe<ConnectionState>('open');
  });

  it('ignores an alarm of any other name', async () => {
    const h = createHarness();

    await h.bridge.handleKeepaliveAlarm({ name: 'another-extension-alarm' });

    expect(h.sockets).toHaveLength(0);
    expect(h.hasCredential).not.toHaveBeenCalled();
    expect(h.pushStatus).not.toHaveBeenCalled();
  });

  it('closes the socket and disarms the keepalive when the credential is removed, and reconnects once paired again', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);

    h.state.credentialStored = false;
    h.bridge.handlePairingState('not-paired');
    await flush();

    expect(socket.closeCalls).toHaveLength(1);
    expect(h.clearAlarm).toHaveBeenCalledWith(KEEPALIVE_ALARM_NAME);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('not-paired');
    await advance(DEFAULT_WS_BACKOFF.maxMs * 2);
    expect(h.sockets).toHaveLength(1);

    h.state.credentialStored = true;
    h.bridge.handlePairingState('paired');
    await flush();

    expect(h.sockets).toHaveLength(2);
    latestSocket(h).accept();
    await flush();
    expect(asHello(firstFrame(latestSocket(h))).payload.token).toBe(TOKEN);
    expect(h.createAlarm).toHaveBeenCalledTimes(2);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
  });

  it('close() disposes: a normal closure, the alarm cleared, and later connects and ticks do nothing', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);

    await h.bridge.close();

    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(NORMAL_CLOSURE);
    expect(socket.listenerCount()).toBe(0);
    expect(h.clearAlarm).toHaveBeenCalledWith(KEEPALIVE_ALARM_NAME);
    expect(h.bridge.getStatus()).toMatchObject({
      disposed: true,
      keepaliveArmed: false,
      transport: 'closed',
    });

    await h.bridge.connect();
    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });
    await advance(DEFAULT_WS_BACKOFF.maxMs * 2);
    await h.bridge.close();

    expect(h.sockets).toHaveLength(1);
    expect(isErr(h.bridge.send('tab.navigated', { tabId: TAB_A, url: APP_URL }))).toBe(true);
    expect(h.clearAlarm).toHaveBeenCalledTimes(1);
  });
});

/** Every `telemetry.event` frame a socket carried, decoded and narrowed. */
function telemetryFramesOf(socket: FakeSocket): MessageByType<'telemetry.event'>[] {
  return framesOf(socket).flatMap((message) =>
    isMessageOfType(message, 'telemetry.event') ? [message] : [],
  );
}

describe('raw agent batches become telemetry.event envelopes', () => {
  it('wraps a small batch into one telemetry.event frame carrying the events unchanged', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const events = makeEvents(3);
    const original = structuredClone(events);

    const outcome = h.bridge.sendTelemetryBatch(TAB_A, events);

    expect(okValue(outcome)).toEqual({ events: 3, frames: 1, sent: 1, queued: 0 });
    const frames = telemetryFramesOf(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual({ events: original });
    // No binding is known for the tab yet, so the frame carries no routing key.
    expect(frames[0]?.sessionId).toBeUndefined();
    // Forwarded, never rewritten: the caller's array is untouched.
    expect(events).toEqual(original);
  });

  it("chunks a batch larger than the receiver's per-frame bound, in order, with nothing dropped or duplicated", async () => {
    const limit = telemetryFrameEventLimit();
    // The bound read off the schema is the schema's behaviour: exactly `limit`
    // events validate, and one more does not.
    expect(telemetryEventPayloadSchema.safeParse({ events: makeEvents(limit) }).success).toBe(true);
    expect(telemetryEventPayloadSchema.safeParse({ events: makeEvents(limit + 1) }).success).toBe(
      false,
    );
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const events = makeEvents(limit * 2 + 3);

    const outcome = okValue(h.bridge.sendTelemetryBatch(TAB_A, events));

    // Every frame decoded through the protocol's own validator, so each is
    // within the bound the service enforces on receipt.
    const frames = telemetryFramesOf(socket);
    expect(frames.map((frame) => frame.payload.events.length)).toEqual([limit, limit, 3]);
    expect(outcome).toEqual({ events: events.length, frames: 3, sent: 3, queued: 0 });
    const forwarded = frames.flatMap((frame) => frame.payload.events);
    expect(forwarded).toHaveLength(events.length);
    expect(new Set(forwarded.map((event) => event.id)).size).toBe(events.length);
    expect(forwarded).toEqual(events);
  });

  it('sends a batch of exactly the bound as one frame, and one event more as two', async () => {
    const limit = telemetryFrameEventLimit();
    const h = createHarness();
    const socket = await connectAndOpen(h);

    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(limit))).frames).toBe(1);
    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(limit + 1))).frames).toBe(2);

    expect(telemetryFramesOf(socket).map((frame) => frame.payload.events.length)).toEqual([
      limit,
      limit,
      1,
    ]);
  });

  it("stamps the tab's bound session on its frames as the routing key, and on no other tab's", async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    deliver(
      socket,
      createEnvelope('session.bound', { sessionId: SESSION_A, tabId: TAB_A, url: APP_URL }),
    );

    h.bridge.sendTelemetryBatch(TAB_A, makeEvents(2));
    h.bridge.sendTelemetryBatch(TAB_B, makeEvents(2));

    expect(telemetryFramesOf(socket).map((frame) => frame.sessionId)).toEqual([
      SESSION_A,
      undefined,
    ]);
  });

  it('queues a batch handed over while reconnecting and flushes it right after the next hello', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    await dropLatest(h);
    const events = makeEvents(4);

    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, events))).toEqual({
      events: 4,
      frames: 1,
      sent: 0,
      queued: 1,
    });
    await advance(nominalDelay(1));
    const socket = latestSocket(h);
    socket.accept();
    await flush();

    expect(typesOf(socket)).toEqual(['client.hello', 'telemetry.event']);
    expect(telemetryFramesOf(socket)[0]?.payload.events).toEqual(events);
  });

  it('refuses a batch that is not an array, or from a value that is not a tab id, as a typed Err — and sends nothing', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const framesBefore = socket.sent.length;

    const refusals = [
      h.bridge.sendTelemetryBatch(TAB_A, { events: makeEvents(1) }),
      h.bridge.sendTelemetryBatch(-1, makeEvents(1)),
    ];

    for (const refusal of refusals) {
      expect(isErr(refusal)).toBe(true);
      if (isErr(refusal)) {
        expect(refusal.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      }
    }
    // An empty batch is a no-op the protocol would refuse anyway.
    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, []))).toEqual({
      events: 0,
      frames: 0,
      sent: 0,
      queued: 0,
    });
    expect(socket.sent).toHaveLength(framesBefore);
  });

  it('answers a batch forwarded before any connection with a typed Err, not a throw', () => {
    const h = createHarness();

    const outcome = h.bridge.sendTelemetryBatch(TAB_A, makeEvents(2));

    expect(isErr(outcome)).toBe(true);
    expect(h.sockets).toHaveLength(0);
  });
});

describe('inbound frames are validated by @debuggen/protocol and routed', () => {
  it('relays a session.bound announcement to the panels of the tab it names', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const bound = createEnvelope('session.bound', {
      sessionId: SESSION_A,
      tabId: TAB_A,
      url: APP_URL,
    });
    expect(RELAYED_MESSAGE_TYPES).toContain(bound.type);

    deliver(socket, bound);

    expect(h.relayPush).toHaveBeenCalledTimes(1);
    expect(h.relayPush).toHaveBeenCalledWith(bound, TAB_A);
    const pushed: unknown = h.relayPush.mock.calls[0]?.[0];
    expect(isRelayedMessage(pushed)).toBe(true);
  });

  it("relays a session's frames to the tab bound to it, and a frame for an unbound session without a tab", async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    deliver(
      socket,
      createEnvelope('session.bound', { sessionId: SESSION_A, tabId: TAB_A, url: APP_URL }),
    );
    const started = createEnvelope('capture.started', {
      sessionId: SESSION_A,
      captureId: CAPTURE_1,
    });
    const elsewhere = createEnvelope('capture.started', {
      sessionId: SESSION_B,
      captureId: CAPTURE_1,
    });
    expect(RELAYED_MESSAGE_TYPES).toContain(started.type);

    deliver(socket, started);
    deliver(socket, elsewhere);

    expect(h.relayPush.mock.calls.slice(1)).toEqual([
      [started, TAB_A],
      [elsewhere, undefined],
    ]);
  });

  it('routes a frame arriving right after a reconnect to the tab of a persisted binding', async () => {
    const h = createHarness({ bindings: [BINDING_A] });
    const socket = await connectAndOpen(h);
    const started = createEnvelope('capture.started', {
      sessionId: SESSION_A,
      captureId: CAPTURE_1,
    });

    deliver(socket, started);

    expect(h.relayPush).toHaveBeenCalledWith(started, TAB_A);
  });

  it('never pushes a non-relayed frame to a panel, but hands it to its typed subscriber', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const onConfig = vi.fn<MessageHandler<'agent.config'>>();
    h.bridge.subscribe('agent.config', onConfig);
    const config = createEnvelope('agent.config', {
      sessionId: SESSION_A,
      captureId: CAPTURE_1,
      hooks: hookSet(true),
    });
    expect(isRelayedMessageType(config.type)).toBe(false);

    deliver(socket, config);

    expect(h.relayPush).not.toHaveBeenCalled();
    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onConfig).toHaveBeenCalledWith(config);
  });

  it('delivers each matching frame to a subscriber until its unsubscribe runs', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const subscribe: ProtocolSubscribe = h.bridge.subscribe;
    const onStarted = vi.fn<MessageHandler<'capture.started'>>();
    const onStopped = vi.fn<MessageHandler<'capture.stopped'>>();
    const unsubscribe = subscribe('capture.started', onStarted);
    subscribe('capture.stopped', onStopped);

    deliver(
      socket,
      createEnvelope('capture.started', { sessionId: SESSION_A, captureId: CAPTURE_1 }),
    );

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted.mock.calls[0]?.[0].payload.captureId).toBe(CAPTURE_1);
    expect(onStopped).not.toHaveBeenCalled();

    unsubscribe();
    unsubscribe();
    deliver(
      socket,
      createEnvelope('capture.started', { sessionId: SESSION_A, captureId: 'capture-test-2' }),
    );

    expect(onStarted).toHaveBeenCalledTimes(1);
    // Subscription and relay are independent: the panels still received both.
    expect(h.relayPush).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['text that is not JSON', 'not json {'],
    [
      'an envelope of an unknown type',
      JSON.stringify({
        id: 'frame-test-1',
        type: 'unknown.message',
        ts: BASE_EPOCH_MS,
        payload: {},
      }),
    ],
    [
      'a relayed type whose payload breaks its schema',
      JSON.stringify({
        id: 'frame-test-2',
        type: 'capture.started',
        sessionId: SESSION_A,
        ts: BASE_EPOCH_MS,
        payload: { sessionId: SESSION_A },
      }),
    ],
  ])(
    'reports %s as a protocol error, dispatches it nowhere and keeps the connection',
    async (_label, frame) => {
      const h = createHarness();
      const socket = await connectAndOpen(h);
      const onStarted = vi.fn<MessageHandler<'capture.started'>>();
      h.bridge.subscribe('capture.started', onStarted);
      const refusal = decodeMessage(frame);
      if (!isErr(refusal)) {
        throw new Error('the fixture frame was expected to be invalid');
      }
      const warningsBefore = h.logs.filter((entry) => entry.level === 'warn').length;

      socket.receive(frame);
      await flush();

      expect(onStarted).not.toHaveBeenCalled();
      expect(h.relayPush).not.toHaveBeenCalled();
      const warnings = h.logs.filter((entry) => entry.level === 'warn').slice(warningsBefore);
      expect(warnings.map((entry) => entry.fields.code)).toContain(refusal.error.code);
      expect(socket.closeCalls).toHaveLength(0);
      expect(h.bridge.getStatus().transport).toBe<ConnectionState>('open');
      expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');

      // The connection is intact: the next valid frame is dispatched as usual.
      const started = createEnvelope('capture.started', {
        sessionId: SESSION_A,
        captureId: CAPTURE_1,
      });
      deliver(socket, started);
      expect(onStarted).toHaveBeenCalledWith(started);
    },
  );
});

describe('a refused credential (4401) is terminal, not a retry loop', () => {
  it('reports a 4401 to the credential store, shows Not paired and never schedules a reconnect', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const statusesBefore = h.pushStatus.mock.calls.length;

    socket.drop(WS_CLOSE_UNAUTHORIZED, REFUSED_REASON);
    await flush();

    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.onUnauthorized).toHaveBeenCalledWith({
      code: WS_CLOSE_UNAUTHORIZED,
      reason: REFUSED_REASON,
    });
    const snapshot = lastPushed(h);
    expect(snapshot.status).toBe<PanelConnectionStatus>('not-paired');
    expect(PANEL_CONNECTION_LABELS[snapshot.status]).toBe('Not paired');
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'closed',
      credentialRefused: true,
      hasCredential: false,
    });
    // Straight to "Not paired": the panel never saw "Reconnecting…" for a refusal.
    expect(pushedStatuses(h).slice(statusesBefore)).not.toContain('reconnecting');
    expect(h.delays).toEqual([]);

    // Well past the clamp, and through a keepalive tick: nothing retries it.
    await advance(DEFAULT_WS_BACKOFF.maxMs * 5);
    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });
    await advance(DEFAULT_WS_BACKOFF.maxMs * 5);

    expect(h.sockets).toHaveLength(1);
    expect(h.delays).toEqual([]);
    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('not-paired');
  });

  it.each([ABNORMAL_CLOSURE, 1011, 4000, WS_CLOSE_UNAUTHORIZED - 1, WS_CLOSE_UNAUTHORIZED + 1])(
    'retries a close with code %i on the curve — only 4401 is terminal',
    async (code) => {
      const h = createHarness();
      const socket = await connectAndOpen(h);

      socket.drop(code, 'the connection was lost');
      await flush();

      expect(h.onUnauthorized).not.toHaveBeenCalled();
      expect(h.delays).toEqual([DEFAULT_WS_BACKOFF.initialMs]);
      expect(lastPushed(h).status).toBe<PanelConnectionStatus>('reconnecting');
      await advance(DEFAULT_WS_BACKOFF.initialMs);
      expect(h.sockets).toHaveLength(2);
    },
  );

  it('reconnects at once — no backoff — when the store already holds a newer credential', async () => {
    const h = createHarness({ unauthorizedAnswer: 'superseded' });
    const socket = await connectAndOpen(h);

    socket.drop(WS_CLOSE_UNAUTHORIZED, REFUSED_REASON);
    await flush();

    expect(h.sockets).toHaveLength(2);
    expect(h.delays).toEqual([]);
    latestSocket(h).accept();
    await flush();
    expect(asHello(firstFrame(latestSocket(h))).payload.token).toBe(TOKEN);
    expect(h.bridge.getStatus().credentialRefused).toBe(false);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
  });

  it('treats an HTTP UNAUTHORIZED like a 4401: the store is told, the pill says Not paired, and the call still resolves', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    h.routes.set(panelDataPath(SESSION_A), () =>
      Promise.resolve(
        jsonResponse(401, {
          code: 'UNAUTHORIZED',
          message: 'The devtools credential was refused.',
        }),
      ),
    );

    const result = await h.bridge.queryPanelData(SESSION_A, TRACE_QUERY);
    await flush();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('UNAUTHORIZED');
    }
    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.onUnauthorized.mock.calls[0]?.[0]).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('not-paired');
  });
});

describe('service reachability and the HTTP operations the panel reaches through the worker', () => {
  it('renders a service that does not answer as Service not running — a state with a hint, never a throw', async () => {
    const h = createHarness({ serviceUp: false });
    await h.bridge.connect();

    // The connection is refused; the auth-exempt health route tells a stopped
    // service apart from a dropped socket.
    await dropLatest(h);

    const snapshot = lastPushed(h);
    expect(snapshot.status).toBe<PanelConnectionStatus>('service-not-running');
    expect(PANEL_CONNECTION_LABELS[snapshot.status]).toBe('Service not running');
    expect(snapshot.hint?.length ?? 0).toBeGreaterThan(0);
    expect(snapshot.serviceUrl).toBe(new URL(DEFAULT_SERVICE_BASE_URL).origin);

    await expect(h.bridge.probeService()).resolves.toMatchObject({ ok: false });
    await expect(h.bridge.queryPanelData(SESSION_A, TRACE_QUERY)).resolves.toMatchObject({
      ok: false,
    });
    const status = h.bridge.getStatus();
    expect(status).toMatchObject({
      transport: 'reconnecting',
      serviceReachable: false,
      panelStatus: 'service-not-running',
    });
    expect(status.panelStatus).toBe(
      panelConnectionStatus({ transport: status.transport, paired: true, serviceReachable: false }),
    );

    // Retrying continues on the curve while the service is down; the service
    // coming back is what ends the state.
    h.state.serviceUp = true;
    await advance(nominalDelay(1));
    latestSocket(h).accept();
    await flush();
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
  });

  it("answers a running service's health as an ok Result and clears the state", async () => {
    const h = createHarness({ serviceUp: false });
    await h.bridge.connect();
    await dropLatest(h);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('service-not-running');

    h.state.serviceUp = true;
    const result = await h.bridge.probeService();

    expect(okValue(result)).toEqual(HEALTH_BODY);
    expect(h.bridge.getStatus().serviceReachable).toBe(true);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('reconnecting');
  });

  it('forwards a DataQuery to POST /sessions/:id/panel-data and returns the DataResult verbatim', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    const answer = { source: 'trace', trace: null } as const;
    h.routes.set(panelDataPath(SESSION_A), () => Promise.resolve(jsonResponse(200, answer)));

    const result = await h.bridge.queryPanelData(SESSION_A, TRACE_QUERY);

    expect(okValue(result)).toEqual(answer);
    const call = h.fetch.mock.calls.find(
      ([url]) => new URL(url).pathname === panelDataPath(SESSION_A),
    );
    expect(call).toBeDefined();
    const [url, init] = call ?? ['', undefined];
    expect(new URL(url).origin).toBe(new URL(DEFAULT_SERVICE_BASE_URL).origin);
    expect(init?.method).toBe(HTTP_ROUTES['panel.data'].method);
    const body: unknown = JSON.parse(init?.body ?? 'null');
    expect(body).toEqual(TRACE_QUERY);
  });

  it('resolves every HTTP operation to a typed Err while the service is down — none rejects', async () => {
    const h = createHarness({ serviceUp: false });

    const results = await Promise.all([
      h.bridge.queryPanelData(SESSION_A, TRACE_QUERY),
      h.bridge.startCapture(SESSION_A),
      h.bridge.stopCapture(SESSION_A),
      h.bridge.getSession(SESSION_A),
      h.bridge.getCurrentPanel(SESSION_A),
      h.bridge.getPanel(SESSION_A, 'panel-test-1'),
      h.bridge.getModifications(SESSION_A),
      h.bridge.probeService(),
    ]);

    expect(results.map((result) => result.ok)).toEqual(results.map(() => false));
    expect(h.sockets).toHaveLength(0);
    expect(h.onUnauthorized).not.toHaveBeenCalled();
  });
});
