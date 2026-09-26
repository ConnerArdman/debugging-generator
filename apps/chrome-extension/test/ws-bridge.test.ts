/**
 * Unit spec for `../src/background/ws-bridge.ts` — the service worker's one
 * connection to the local service, and the only module in the extension that
 * opens a socket or performs HTTP.
 *
 * Five product guarantees run through that module, and this spec holds them:
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
 *   platform-neutral transport — revives an evicted worker's connection; while
 *   the socket is open, a heartbeat below the worker's idle window re-creates
 *   that alarm and probes the service, retiring a socket whose service stopped
 *   answering onto the curve; and every persisted tab binding is re-announced
 *   on each new socket (AAP §0.5.5, "Chrome disconnects").
 * - **The page agent's raw batches become protocol envelopes.** The MAIN-world
 *   agent never imports the protocol, so the bridge wraps its `{ events }` into
 *   `telemetry.event` frames — unchanged, in order, chunked to the receiver's
 *   own per-frame bound; an empty batch that reports loss is one loss-only
 *   frame, and one that reports none sends nothing — and inbound frames are
 *   validated by `@debuggen/protocol` before one is relayed to a panel or
 *   handed to a typed subscriber (AAP §0.4.2).
 * - **Every tab-scoped action names the tab it acts for.** One socket and one
 *   credential serve every inspected tab, so the hello announces no tab; each
 *   frame sent for a tab carries it as the envelope's acting `tabId`, each
 *   session-scoped HTTP request carries it as `x-debuggen-tab`, and a telemetry
 *   batch whose tab has no known session is refused rather than sent unscoped
 *   — the Chrome half of AAP §0.5.6's "only for the session bound to that tab".
 *   Telemetry is written only along a route the service confirmed with
 *   `session.bound` on the current connection, and never enters the socket
 *   client's reconnect queue (`awaitTabRoute` is what the lane waits on).
 * - **Page-supplied ids are relayed, never logged.** `agent.ready` reaches the
 *   service with the page's `documentId` and `producerId` intact, while every
 *   log record names the document by its `fingerprintPageId` digest and shape
 *   verdict alone — a forged id is private text (CWE-532, AAP §0.5.2).
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
  ACTING_TAB_HEADER,
  captureStartPath,
  captureStopPath,
  CLIENT_HELLO_TIMEOUT_MS,
  CLIENT_KINDS,
  createEnvelope,
  decodeMessage,
  DEFAULT_MAX_QUEUED_MESSAGES,
  DEFAULT_WS_BACKOFF,
  DEFAULT_WS_OPEN_TIMEOUT_MS,
  encodeMessage,
  healthPath,
  HTTP_ROUTES,
  HttpClient,
  isMessageOfType,
  pairCompletePath,
  modificationsPath,
  panelByIdPath,
  panelDataPath,
  panelPath,
  PROTOCOL_VERSION,
  READ_PROOF_LENGTH,
  resolveWsUrl,
  sessionPath,
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
import { DebuggenError, isErr } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel, Result } from '@debuggen/shared';

import type {
  CredentialStorageChangeListener,
  UnauthorizedEvidence,
  UnauthorizedHandling,
} from '../src/background/auth';
import {
  createServiceEndpointAccessor,
  DEVTOOLS_TOKEN_STORAGE_KEY,
  parseServiceEndpoint,
  readServiceEndpoint,
  SERVICE_ENDPOINT_HOSTNAMES,
  SERVICE_ENDPOINT_STORAGE_KEY,
  STORED_CREDENTIAL_VERSION,
  writeServiceEndpoint,
} from '../src/background/auth';
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
import { PORT_REQUEST_TIMEOUT_MS } from '../src/background/ports';
import { createWorker, HYDRATION_RETRY_DELAYS_MS } from '../src/background/service-worker';
import { BINDING_STORAGE_KEY } from '../src/background/tab-registry';
import type { DebugGeneratorWorker } from '../src/background/service-worker';
import {
  createWsBridge,
  SOCKET_HEARTBEAT_FAILURE_LIMIT,
  SOCKET_HEARTBEAT_INTERVAL_MS,
  TELEMETRY_ROUTE_WAIT_MS,
} from '../src/background/ws-bridge';
import type { DiscardedTelemetryFrame, WsBridge, WsBridgeDeps } from '../src/background/ws-bridge';
import {
  DEFAULT_SERVICE_BASE_URL,
  EXTENSION_CHANNEL,
  fingerprintPageId,
  isRelayedMessageType,
  newPortRequestId,
  PANEL_CONNECTION_LABELS,
  PANEL_CONNECTION_STATUSES,
  panelConnectionStatus,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
  RELAYED_MESSAGE_TYPES,
} from '../src/shared/messages';
import type { PageAgentReadyPayload, PanelConnectionStatus } from '../src/shared/messages';

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
  /**
   * The far side starts closing after `writes` more frames: `readyState`
   * becomes CLOSING and no event fires yet — the window in which a flush
   * stops part-way and the client still reports `open`.
   */
  startClosingAfter(writes: number): void;
  /**
   * The connection died without the platform noticing yet: every later write
   * throws while `readyState` still reads OPEN and no event fires — the
   * window in which the socket client queues each frame it is handed, for
   * the connection its close event will start.
   */
  stall(): void;
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
    /** Writes left before `readyState` becomes CLOSING; `undefined` for never. */
    private writesBeforeClosing: number | undefined;
    /** Whether every write throws while `readyState` still reads OPEN. */
    private stalled = false;
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
      if (this.stalled) {
        throw new Error('the fake socket died unnoticed');
      }
      this.sent.push(data);
      if (this.writesBeforeClosing !== undefined) {
        this.writesBeforeClosing -= 1;
        if (this.writesBeforeClosing <= 0) {
          this.writesBeforeClosing = undefined;
          this.readyState = READY_STATE.closing;
        }
      }
    }

    close(code?: number, reason?: string): void {
      this.closeCalls.push({ code, reason });
      this.readyState = READY_STATE.closing;
    }

    startClosingAfter(writes: number): void {
      this.writesBeforeClosing = writes;
    }

    stall(): void {
      this.stalled = true;
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
  /** What the credential store answers to a refusal. Defaults to `'cleared'`. */
  readonly unauthorizedAnswer?: UnauthorizedHandling;
  /**
   * The credential getter. Defaults to the store's: the token while one is
   * stored, `undefined` after the store cleared it.
   */
  readonly token?: TokenProvider;
  /**
   * Build the bridge without injected timers, so the socket client and the
   * heartbeat fall back to the platform's (Vitest's faked ones). Defaults to
   * `false`: the recording timers behind {@link Harness.delays}.
   */
  readonly platformTimers?: boolean;
  /**
   * Hand the bridge its `HttpClient` as a thunk over a client the case can
   * replace with {@link Harness.rebuildHttpClient} — the way
   * `service-worker.ts` wires it, so a changed service address reaches the
   * HTTP path. Defaults to `false`: one fixed instance.
   */
  readonly httpClientThunk?: boolean;
  /** The sink for telemetry the socket client discarded. Defaults to none. */
  readonly onTelemetryDropped?: WsBridgeDeps['onTelemetryDropped'];
  /** The sink for every discarded telemetry frame's labels and loss. Defaults to none. */
  readonly onTelemetryFrameDiscarded?: WsBridgeDeps['onTelemetryFrameDiscarded'];
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
  /**
   * Replace the client the `httpClientThunk` hands out with one for `baseUrl`,
   * as the worker does when the service address changes.
   */
  readonly rebuildHttpClient: (baseUrl: string) => void;
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
  const buildHttpClient = (baseUrl: string): HttpClient =>
    new HttpClient({ baseUrl, token: tokenProvider, fetch, logger });
  let httpClient = buildHttpClient(serviceBaseUrl);
  const rebuildHttpClient = (baseUrl: string): void => {
    httpClient = buildHttpClient(baseUrl);
  };
  const random = options.random ?? (() => 1);

  const bridge = createWsBridge({
    webSocketConstructor: ctor,
    httpClient: options.httpClientThunk === true ? () => httpClient : httpClient,
    tokenProvider,
    onUnauthorized,
    hasCredential,
    alarms: { create: createAlarm, clear: clearAlarm },
    timers:
      options.platformTimers === true
        ? undefined
        : { setTimeout: setTimer, clearTimeout: clearTimer },
    random: random === 'platform' ? undefined : random,
    relayPush,
    pushStatus,
    listBindings,
    serviceBaseUrl,
    onTelemetryDropped: options.onTelemetryDropped,
    onTelemetryFrameDiscarded: options.onTelemetryFrameDiscarded,
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
    rebuildHttpClient,
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
      heartbeatActive: false,
      disposed: false,
      queuedFrameCount: 0,
    });
    expect(h.setTimer).not.toHaveBeenCalled();
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
    const h = createHarness({ bindings: [BINDING_A] });
    await h.bridge.connect();
    const socket = socketAt(h, 0);
    expect(socket.sent).toHaveLength(0);

    socket.accept();

    // Nothing has drained and no timer has run: the hello is already on the
    // wire, far inside the service's CLIENT_HELLO_TIMEOUT_MS window, and no
    // credential deadline was needed for a credential that answers
    // synchronously. The only timers are the socket's opening deadline (armed
    // when it was constructed, cleared by the open) and the heartbeat the open
    // started.
    const hello = asHello(firstFrame(socket));
    expect(CLIENT_KINDS).toContain(hello.payload.client);
    expect(hello.payload.client).toBe(DEVTOOLS);
    expect(hello.payload.token).toBe(TOKEN);
    expect(hello.payload.version).toBe(PROTOCOL_VERSION);
    // One connection serves every inspected tab, so the hello names none —
    // even with a binding persisted — and no envelope-level tab either.
    expect(Object.keys(hello.payload)).not.toContain('tabId');
    expect(Object.keys(hello)).not.toContain('tabId');
    expect(h.delays).toEqual([DEFAULT_WS_OPEN_TIMEOUT_MS, SOCKET_HEARTBEAT_INTERVAL_MS]);
    expect(h.delays).not.toContain(CLIENT_HELLO_TIMEOUT_MS);
    expect(h.tokenProvider).toHaveBeenCalledTimes(1);
    expect(h.bridge.getStatus().transport).toBe<ConnectionState>('open');

    await flush();
    expect(typesOf(socket).filter((type) => type === 'client.hello')).toHaveLength(1);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
    expect(PANEL_CONNECTION_LABELS[lastPushed(h).status]).toBe('Connected');
  });

  it('never announces a tab in the hello — with no binding, two bindings, or after a reconnect', async () => {
    const bindingB: TabBindingRecord = { ...BINDING_A, tabId: TAB_B, sessionId: SESSION_B };

    const unbound = createHarness();
    const unboundHello = asHello(firstFrame(await connectAndOpen(unbound)));
    expect(Object.keys(unboundHello.payload)).not.toContain('tabId');
    expect(unboundHello.payload.token).toBe(TOKEN);

    // A hello tab would make the service refuse every frame acting for the
    // other tab: the multiplexed connection must stay tab-less on every open.
    const h = createHarness({ bindings: [BINDING_A, bindingB] });
    await connectAndOpen(h);
    await dropLatest(h);
    await advance(nominalDelay(1));
    latestSocket(h).accept();
    await flush();

    expect(h.sockets).toHaveLength(2);
    for (const socket of h.sockets) {
      const hello = asHello(firstFrame(socket));
      expect(Object.keys(hello.payload)).not.toContain('tabId');
      expect(Object.keys(hello)).not.toContain('tabId');
    }
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

    // The local deadline is exactly the service's own hello window; the other
    // timer is the socket's opening deadline, which the open cleared. No
    // heartbeat: the connection never reached `open`.
    expect(h.delays).toEqual([DEFAULT_WS_OPEN_TIMEOUT_MS, CLIENT_HELLO_TIMEOUT_MS]);
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
    const h = createHarness({ bindings: [BINDING_A] });
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
    // Each socket arms its opening deadline when constructed; the drop clears
    // it and schedules the next step of the curve.
    expect(h.delays).toEqual([
      DEFAULT_WS_OPEN_TIMEOUT_MS,
      nominalDelay(1),
      DEFAULT_WS_OPEN_TIMEOUT_MS,
      nominalDelay(2),
    ]);

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
      // Re-announced acting for the tab it binds.
      expect(bind?.tabId).toBe(BINDING_A.tabId);
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
    // The dropped socket's cleared opening deadline, then the one backoff delay.
    expect(h.delays).toEqual([DEFAULT_WS_OPEN_TIMEOUT_MS, nominalDelay(1)]);
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
      heartbeatActive: false,
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

/** The handles the injected `setTimeout` returned for heartbeat ticks, in order. */
function heartbeatHandles(h: Harness): number[] {
  return h.setTimer.mock.calls.flatMap(([, ms], index) => {
    const result = h.setTimer.mock.results[index];
    return ms === SOCKET_HEARTBEAT_INTERVAL_MS && result?.type === 'return' ? [result.value] : [];
  });
}

describe('the open-socket heartbeat: inside the MV3 idle window, and it notices a dead peer', () => {
  it('ticks below the worker idle window and the keepalive period, on a delay no other timer uses', () => {
    const { initialMs, maxMs } = DEFAULT_WS_BACKOFF;

    expect(SOCKET_HEARTBEAT_INTERVAL_MS).toBeLessThan(30_000);
    expect(SOCKET_HEARTBEAT_INTERVAL_MS).toBeLessThan(KEEPALIVE_PERIOD_MINUTES * 60_000);
    expect(SOCKET_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(CLIENT_HELLO_TIMEOUT_MS);
    expect(SOCKET_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(maxMs);
    expect([DEFAULT_WS_OPEN_TIMEOUT_MS, CLIENT_HELLO_TIMEOUT_MS, initialMs]).not.toContain(
      SOCKET_HEARTBEAT_INTERVAL_MS,
    );
    expect(SOCKET_HEARTBEAT_FAILURE_LIMIT).toBe(2);
  });

  it('re-creates the keepalive alarm and probes the service every SOCKET_HEARTBEAT_INTERVAL_MS while open, writing nothing on the socket', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const framesBefore = socket.sent.length;
    const probesBefore = healthProbeCount(h);
    expect(h.createAlarm).toHaveBeenCalledTimes(1);
    expect(h.bridge.getStatus().heartbeatActive).toBe(true);

    for (let tick = 1; tick <= 3; tick += 1) {
      // Not a millisecond early…
      await advance(SOCKET_HEARTBEAT_INTERVAL_MS - 1);
      expect(h.createAlarm).toHaveBeenCalledTimes(tick);
      expect(healthProbeCount(h)).toBe(probesBefore + tick - 1);
      // …and exactly on the interval: an extension API call that resets the
      // worker's idle timer, and one bounded health probe.
      await advance(1);
      expect(h.createAlarm).toHaveBeenCalledTimes(tick + 1);
      expect(h.createAlarm).toHaveBeenLastCalledWith(KEEPALIVE_ALARM_NAME, {
        periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
      });
      expect(healthProbeCount(h)).toBe(probesBefore + tick);
    }

    // Armed on open, re-armed by each of the three ticks: one tick at a time.
    expect(heartbeatHandles(h)).toHaveLength(4);
    expect(socket.sent).toHaveLength(framesBefore);
    expect(socket.closeCalls).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'open',
      heartbeatActive: true,
      keepaliveArmed: true,
    });
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
  });

  it('never runs while the socket is not open: a connection whose upgrade stalls is retried by its opening deadline instead', async () => {
    const h = createHarness();
    await h.bridge.connect();

    await advance(SOCKET_HEARTBEAT_INTERVAL_MS * 3);

    expect(h.sockets.length).toBeGreaterThan(1);
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'reconnecting',
      heartbeatActive: false,
    });
    expect(heartbeatHandles(h)).toEqual([]);
    expect(h.createAlarm).toHaveBeenCalledTimes(1);
  });

  it('retires an open socket whose service left SOCKET_HEARTBEAT_FAILURE_LIMIT probes in a row unanswered, onto the backoff curve, and starts again on the next open', async () => {
    const h = createHarness({ bindings: [BINDING_A] });
    const socket = await connectAndOpen(h);

    // The service is gone, but no close frame arrived: the socket still reads open.
    h.state.serviceUp = false;
    for (let failure = 1; failure < SOCKET_HEARTBEAT_FAILURE_LIMIT; failure += 1) {
      await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
      // One unanswered probe is not proof: the socket stays, and so does the pill.
      expect(socket.closeCalls).toHaveLength(0);
      expect(h.bridge.getStatus()).toMatchObject({ transport: 'open', heartbeatActive: true });
      expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
    }
    await advance(SOCKET_HEARTBEAT_INTERVAL_MS);

    expect(socket.closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: 'the local service stopped answering' },
    ]);
    expect(socket.listenerCount()).toBe(0);
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'reconnecting',
      heartbeatActive: false,
    });
    // On the jittered curve — never a tight loop against a service that is down.
    expect(h.delays.at(-1)).toBe(nominalDelay(1));
    expect(lastPushed(h).status).not.toBe<PanelConnectionStatus>('connected');
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);

    // The service comes back: the curve reconnects, the bindings are
    // re-announced, and the new connection has its own heartbeat.
    h.state.serviceUp = true;
    await advance(nominalDelay(1) - 1);
    expect(h.sockets).toHaveLength(1);
    await advance(1);
    expect(h.sockets).toHaveLength(2);
    latestSocket(h).accept();
    await flush();

    expect(typesOf(latestSocket(h))).toEqual(['client.hello', 'session.bind']);
    expect(h.bridge.getStatus()).toMatchObject({ transport: 'open', heartbeatActive: true });
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');
    expect(heartbeatHandles(h)).toHaveLength(SOCKET_HEARTBEAT_FAILURE_LIMIT + 1);
  });

  it('counts only consecutive failures: one answered probe resets the count', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);

    for (let round = 0; round < 3; round += 1) {
      h.state.serviceUp = false;
      await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
      h.state.serviceUp = true;
      await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
    }

    expect(socket.closeCalls).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.bridge.getStatus()).toMatchObject({ transport: 'open', heartbeatActive: true });

    h.state.serviceUp = false;
    for (let failure = 1; failure <= SOCKET_HEARTBEAT_FAILURE_LIMIT; failure += 1) {
      await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
    }
    expect(socket.closeCalls).toHaveLength(1);
    expect(h.bridge.getStatus().transport).toBe<ConnectionState>('reconnecting');
  });

  it.each<[string, (h: Harness) => Promise<void>]>([
    ['the socket dropping', (h) => dropLatest(h)],
    [
      'a 4401 refusal',
      async (h) => {
        latestSocket(h).drop(WS_CLOSE_UNAUTHORIZED, REFUSED_REASON);
        await flush();
      },
    ],
    [
      'the credential being removed',
      async (h) => {
        h.state.credentialStored = false;
        h.bridge.handlePairingState('not-paired');
        await flush();
      },
    ],
    ['close()', (h) => h.bridge.close()],
  ])('stops on %s: the pending tick is cleared and never runs', async (_cause, stop) => {
    const h = createHarness();
    await connectAndOpen(h);
    const handles = heartbeatHandles(h);
    expect(handles).toHaveLength(1);
    const alarmsBefore = h.createAlarm.mock.calls.length;

    await stop(h);

    expect(h.clearTimer).toHaveBeenCalledWith(handles[0]);
    expect(h.bridge.getStatus().heartbeatActive).toBe(false);
    await advance(SOCKET_HEARTBEAT_INTERVAL_MS * 2);
    expect(h.createAlarm).toHaveBeenCalledTimes(alarmsBefore);
    expect(heartbeatHandles(h)).toEqual(handles);
  });

  it('abandons a tick whose connection ended while its probe was in flight: it neither re-arms nor counts against the next connection', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    const probesBefore = healthProbeCount(h);
    // The service takes the probe and never answers it.
    h.routes.set(healthPath(), () => new Promise<HttpResponseLike>(() => {}));

    await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
    expect(healthProbeCount(h)).toBe(probesBefore + 1);
    // A tick awaiting its probe is a running heartbeat.
    expect(h.bridge.getStatus().heartbeatActive).toBe(true);

    await dropLatest(h);
    expect(h.bridge.getStatus().heartbeatActive).toBe(false);
    h.routes.set(healthPath(), () => Promise.resolve(jsonResponse(200, HEALTH_BODY)));
    await advance(nominalDelay(1));
    latestSocket(h).accept();
    await flush();
    expect(heartbeatHandles(h)).toHaveLength(2);

    // The orphaned probe runs out of time: its tick does nothing further.
    await advance(CLIENT_HELLO_TIMEOUT_MS);
    expect(heartbeatHandles(h)).toHaveLength(2);
    expect(latestSocket(h).closeCalls).toHaveLength(0);
    expect(h.bridge.getStatus()).toMatchObject({ transport: 'open', heartbeatActive: true });

    // Its failure was not carried over: one unanswered probe on the new
    // connection is still only one.
    h.state.serviceUp = false;
    await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
    expect(latestSocket(h).closeCalls).toHaveLength(0);
    expect(h.bridge.getStatus().transport).toBe<ConnectionState>('open');
  });

  it('runs on the platform timers when none are injected, reading them only once a timer is set', async () => {
    const h = createHarness({ platformTimers: true });
    expect(vi.getTimerCount()).toBe(0);

    const socket = await connectAndOpen(h);
    const probesBefore = healthProbeCount(h);
    await advance(SOCKET_HEARTBEAT_INTERVAL_MS);

    expect(h.setTimer).not.toHaveBeenCalled();
    expect(h.createAlarm).toHaveBeenCalledTimes(2);
    expect(healthProbeCount(h)).toBe(probesBefore + 1);
    expect(socket.closeCalls).toHaveLength(0);

    await h.bridge.close();
    expect(vi.getTimerCount()).toBe(0);
    await advance(SOCKET_HEARTBEAT_INTERVAL_MS * 2);
    expect(h.createAlarm).toHaveBeenCalledTimes(2);
  });
});

/** Every `telemetry.event` frame a socket carried, decoded and narrowed. */
function telemetryFramesOf(socket: FakeSocket): MessageByType<'telemetry.event'>[] {
  return framesOf(socket).flatMap((message) =>
    isMessageOfType(message, 'telemetry.event') ? [message] : [],
  );
}

/**
 * The service answers a binding on this socket: `session.bound` for the pair,
 * with an establishing reason unless `reason` says otherwise — the one thing
 * that confirms a tab's telemetry route.
 */
function answerBound(
  socket: FakeSocket,
  tabId: TabId,
  sessionId: SessionId,
  reason: SessionBoundPayload['reason'] = 'bound',
): void {
  deliver(
    socket,
    createEnvelope('session.bound', {
      sessionId,
      tabId,
      url: APP_URL,
      ...(reason === undefined ? {} : { reason }),
    }),
  );
}

/** The code of a failed `Result`, or a failure naming the success. */
function errCode<T>(result: Result<T, DebuggenError>): string {
  if (!isErr(result)) {
    throw new Error('expected an Err Result, got ok');
  }
  return result.error.code;
}

describe('raw agent batches become telemetry.event envelopes', () => {
  it('wraps a small batch into one telemetry.event frame carrying the events unchanged, scoped to its tab and session', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);
    const events = makeEvents(3);
    const original = structuredClone(events);

    const outcome = h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A);

    expect(okValue(outcome)).toEqual({ events: 3, frames: 1, sent: 1 });
    const frames = telemetryFramesOf(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual({ events: original });
    expect(frames[0]?.sessionId).toBe(SESSION_A);
    expect(frames[0]?.tabId).toBe(TAB_A);
    // Forwarded, never rewritten: the caller's array is untouched.
    expect(events).toEqual(original);
  });

  it("chunks a batch larger than the receiver's per-frame bound, in order, with nothing dropped or duplicated and every chunk scoped", async () => {
    const limit = telemetryFrameEventLimit();
    // The bound read off the schema is the schema's behaviour: exactly `limit`
    // events validate, and one more does not.
    expect(telemetryEventPayloadSchema.safeParse({ events: makeEvents(limit) }).success).toBe(true);
    expect(telemetryEventPayloadSchema.safeParse({ events: makeEvents(limit + 1) }).success).toBe(
      false,
    );
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_B, SESSION_B);
    const events = makeEvents(limit * 2 + 3);

    const outcome = okValue(h.bridge.sendTelemetryBatch(TAB_B, events, SESSION_B));

    // Every frame decoded through the protocol's own validator, so each is
    // within the bound the service enforces on receipt.
    const frames = telemetryFramesOf(socket);
    expect(frames.map((frame) => frame.payload.events.length)).toEqual([limit, limit, 3]);
    expect(outcome).toEqual({ events: events.length, frames: 3, sent: 3 });
    // No chunk loses its scope: the acting tab and the session ride on each.
    expect(frames.map((frame) => [frame.tabId, frame.sessionId])).toEqual([
      [TAB_B, SESSION_B],
      [TAB_B, SESSION_B],
      [TAB_B, SESSION_B],
    ]);
    const forwarded = frames.flatMap((frame) => frame.payload.events);
    expect(forwarded).toHaveLength(events.length);
    expect(new Set(forwarded.map((event) => event.id)).size).toBe(events.length);
    expect(forwarded).toEqual(events);
    expect(forwarded.map((event) => event.seq)).toEqual(events.map((event) => event.seq));
  });

  it('sends a batch of exactly the bound as one frame, and one event more as two', async () => {
    const limit = telemetryFrameEventLimit();
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);

    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(limit), SESSION_A)).frames).toBe(
      1,
    );
    expect(
      okValue(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(limit + 1), SESSION_A)).frames,
    ).toBe(2);

    expect(telemetryFramesOf(socket).map((frame) => frame.payload.events.length)).toEqual([
      limit,
      limit,
      1,
    ]);
  });

  it("scopes a tab's frames to the session the service confirmed for it, and refuses — sending nothing — a tab it confirmed none for", async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);

    const bound = h.bridge.sendTelemetryBatch(TAB_A, makeEvents(2));
    const unbound = h.bridge.sendTelemetryBatch(TAB_B, makeEvents(2));

    expect(okValue(bound).frames).toBe(1);
    expect(isErr(unbound)).toBe(true);
    if (isErr(unbound)) {
      expect(unbound.error.code).toBe('TAB_NOT_BOUND');
    }
    // Tab B's events never reach the wire, least of all under tab A's session.
    expect(telemetryFramesOf(socket).map((frame) => [frame.tabId, frame.sessionId])).toEqual([
      [TAB_A, SESSION_A],
    ]);
  });

  it('on a cold wake, refuses every batch while the socket is connecting — nothing written or queued, none attributed to a persisted tab', async () => {
    // A revived worker: tab A's binding is persisted and the socket is still
    // connecting. Queued telemetry would be flushed right after the hello,
    // before the re-announced binding a restarted service needs.
    const h = createHarness({ bindings: [BINDING_A] });
    await h.bridge.connect();
    const socket = latestSocket(h);

    const refusedB = h.bridge.sendTelemetryBatch(TAB_B, makeEvents(3));
    const refusedA = h.bridge.sendTelemetryBatch(TAB_A, makeEvents(3), SESSION_A);

    for (const refusal of [refusedB, refusedA]) {
      expect(errCode(refusal)).toBe('TRANSPORT_DISCONNECTED');
      if (isErr(refusal)) {
        expect(refusal.error.message).not.toContain(String(TAB_A));
        expect(refusal.error.message).not.toContain(SESSION_A);
      }
    }
    expect(h.bridge.getStatus().queuedFrameCount).toBe(0);

    socket.accept();
    await flush();

    // The hello and the re-announced binding, and no telemetry at all.
    expect(typesOf(socket)).toEqual(['client.hello', 'session.bind']);
    expect(telemetryFramesOf(socket)).toEqual([]);
  });

  it('refuses a batch on an open socket until the service confirms the re-announced binding, then writes it', async () => {
    const h = createHarness({ bindings: [BINDING_A] });
    const socket = await connectAndOpen(h);
    expect(typesOf(socket)).toEqual(['client.hello', 'session.bind']);
    const events = makeEvents(4);

    // Re-announced, not yet answered: the worker's own claim confirms nothing.
    const early = h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A);
    expect(errCode(early)).toBe('TAB_NOT_BOUND');
    if (isErr(early)) {
      expect(early.error.message).not.toContain(SESSION_A);
    }
    expect(h.bridge.getStatus().queuedFrameCount).toBe(0);

    answerBound(socket, TAB_A, SESSION_A);

    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A))).toEqual({
      events: 4,
      frames: 1,
      sent: 1,
    });
    const frames = telemetryFramesOf(socket);
    expect(frames.map((frame) => [frame.tabId, frame.sessionId])).toEqual([[TAB_A, SESSION_A]]);
    expect(frames[0]?.payload.events).toEqual(events);
  });

  it('refuses a batch whose named session is not the one the service confirmed for its tab', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    // The service confirmed tab A for session A; a batch naming session B for
    // tab A is stale (or early) and must not ride on tab A's route.
    answerBound(socket, TAB_A, SESSION_A);

    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(2), SESSION_B))).toBe(
      'TAB_NOT_BOUND',
    );
    expect(telemetryFramesOf(socket)).toEqual([]);

    // An ending announcement withdraws the route it names.
    answerBound(socket, TAB_A, SESSION_A, 'unbound');
    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(2), SESSION_A))).toBe(
      'TAB_NOT_BOUND',
    );
    expect(telemetryFramesOf(socket)).toEqual([]);
  });

  it('refuses a batch while reconnecting — none enters the reconnect queue — and needs a fresh confirmation on the next connection', async () => {
    const h = createHarness({ bindings: [BINDING_A] });
    const first = await connectAndOpen(h);
    answerBound(first, TAB_A, SESSION_A);
    await dropLatest(h);
    const events = makeEvents(4);

    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A))).toBe(
      'TRANSPORT_DISCONNECTED',
    );
    expect(h.bridge.getStatus().queuedFrameCount).toBe(0);

    await advance(nominalDelay(1));
    const socket = latestSocket(h);
    socket.accept();
    await flush();

    // A new connection generation: the old confirmation proves nothing here.
    expect(typesOf(socket)).toEqual(['client.hello', 'session.bind']);
    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A))).toBe('TAB_NOT_BOUND');

    answerBound(socket, TAB_A, SESSION_A);
    okValue(h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A));
    expect(typesOf(socket)).toEqual(['client.hello', 'session.bind', 'telemetry.event']);
    expect(telemetryFramesOf(socket)[0]?.payload.events).toEqual(events);
  });

  it('refuses a batch while the socket is closing — the server closed, the close event is still to come — while other frames still queue', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);
    // The far side started the closing handshake: readyState CLOSING, and the
    // client still reports `open` until the close event arrives.
    socket.close(NORMAL_CLOSURE);
    expect(h.bridge.getStatus().transport).toBe<ConnectionState>('open');
    const framesBefore = socket.sent.length;

    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(2), SESSION_A))).toBe(
      'TRANSPORT_DISCONNECTED',
    );
    expect(h.bridge.getStatus().queuedFrameCount).toBe(0);
    expect(socket.sent).toHaveLength(framesBefore);

    // Control frames keep the client's reconnect queue; only telemetry is kept out.
    expect(okValue(h.bridge.send('tab.navigated', { tabId: TAB_A, url: APP_URL }))).toBe('queued');
    expect(h.bridge.getStatus().queuedFrameCount).toBe(1);
  });

  it('refuses a batch that is not an array, from a value that is not a tab id, or with an empty session id, as a typed Err — and sends nothing', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const framesBefore = socket.sent.length;

    const refusals = [
      h.bridge.sendTelemetryBatch(TAB_A, { events: makeEvents(1) }, SESSION_A),
      h.bridge.sendTelemetryBatch(-1, makeEvents(1), SESSION_A),
      h.bridge.sendTelemetryBatch(TAB_A, makeEvents(1), ''),
    ];

    for (const refusal of refusals) {
      expect(isErr(refusal)).toBe(true);
      if (isErr(refusal)) {
        expect(refusal.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      }
    }
    // An empty batch that reports no loss has nothing the protocol would
    // accept, so it is answered with zeros — even with no route confirmed.
    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, []))).toEqual({
      events: 0,
      frames: 0,
      sent: 0,
    });
    expect(socket.sent).toHaveLength(framesBefore);
  });

  it('answers a batch forwarded before any connection with a typed Err, not a throw', () => {
    const h = createHarness();

    const outcome = h.bridge.sendTelemetryBatch(TAB_A, makeEvents(2), SESSION_A);

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.code).toBe('TRANSPORT_DISCONNECTED');
    }
    expect(h.sockets).toHaveLength(0);
  });
});

/** What `WsBridgeDeps.onTelemetryDropped` is told about one discarded frame. */
type DroppedTelemetry = readonly [tabId: TabId, events: number];

/** A recording `WsBridgeDeps.onTelemetryDropped`. */
function createDropSink(): Mock<(tabId: TabId, events: number) => void> {
  return vi.fn<(tabId: TabId, events: number) => void>();
}

/**
 * `count` single-frame batch origins, alternating between the two tabs, with
 * event counts cycling from `firstEvents` — so the sequence of reports says
 * exactly which frames were named.
 */
function batchOrigins(count: number, firstEvents = 1): DroppedTelemetry[] {
  return Array.from({ length: count }, (_, index): DroppedTelemetry => [
    index % 2 === 0 ? TAB_A : TAB_B,
    firstEvents + (index % 7),
  ]);
}

/** `count` single-frame batch origins of one tab with one event count. */
function sameOrigins(count: number, tabId: TabId, events: number): DroppedTelemetry[] {
  return Array.from({ length: count }, (): DroppedTelemetry => [tabId, events]);
}

/**
 * Let the service confirm TAB_A → SESSION_A and TAB_B → SESSION_B on an open
 * socket, then stall it ({@link FakeSocket.stall}). This is the only way a
 * telemetry frame reaches the socket client's queue: the bridge hands a batch
 * over only on an open socket with a confirmed route, never to a socket that
 * is still connecting or reconnecting, and a write that throws there is queued
 * by the client for the next connection.
 */
async function confirmAndStall(socket: FakeSocket): Promise<void> {
  answerBound(socket, TAB_A, SESSION_A);
  answerBound(socket, TAB_B, SESSION_B);
  await flush();
  socket.stall();
}

/** Connect, open, confirm both tabs' routes and stall the socket: batches now queue. */
async function openStalled(h: Harness): Promise<FakeSocket> {
  const socket = await connectAndOpen(h);
  await confirmAndStall(socket);
  return socket;
}

/**
 * Let the latest (dead) socket's close arrive, and open the connection the
 * client reconnects with, which flushes the queue on open.
 */
async function reopen(h: Harness): Promise<FakeSocket> {
  await dropLatest(h);
  await advance(nominalDelay(1));
  const socket = latestSocket(h);
  socket.accept();
  await flush();
  return socket;
}

/**
 * Hand one single-frame batch per origin to the bridge over a stalled socket
 * ({@link openStalled}); each must end with its one frame queued by the
 * client — an interrupted write, answered `TRANSPORT_DISCONNECTED` with
 * `framesQueued: 1`, which is how the worker knows the frame was handed over.
 */
function queueBatches(h: Harness, origins: readonly DroppedTelemetry[]): void {
  for (const [tabId, events] of origins) {
    const outcome = h.bridge.sendTelemetryBatch(tabId, makeEvents(events));
    expect(errCode(outcome)).toBe('TRANSPORT_DISCONNECTED');
    expect(isErr(outcome) ? outcome.error.details : undefined).toMatchObject({
      tabId,
      framesWritten: 0,
      framesQueued: 1,
    });
  }
}

/** The log line of one dropped telemetry frame. */
const TELEMETRY_DROP_LOG = 'a queued telemetry frame was dropped before it reached the service';

describe('telemetry the socket client discards is reported by tab and event count', () => {
  it('reports each frame the full queue drops, oldest first, with its tab and event count — across two tabs', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    // The connection died unnoticed: every frame handed over waits in the
    // client's queue.
    await openStalled(h);
    const overflow = 9;
    const origins = batchOrigins(DEFAULT_MAX_QUEUED_MESSAGES + overflow);

    queueBatches(h, origins);

    expect(onTelemetryDropped.mock.calls).toEqual(origins.slice(0, overflow));
    expect(h.bridge.getStatus()).toMatchObject({
      droppedFrameCount: overflow,
      queuedFrameCount: DEFAULT_MAX_QUEUED_MESSAGES,
    });
    // One warn line per dropped frame, carrying the tab and the count alone.
    const lines = h.logs.filter((entry) => entry.message === TELEMETRY_DROP_LOG);
    expect(lines.map((entry) => [entry.level, entry.fields.tabId, entry.fields.events])).toEqual(
      origins.slice(0, overflow).map(([tabId, events]) => ['warn', tabId, events]),
    );
    for (const entry of lines) {
      expect(Object.keys(entry.fields).sort()).toEqual(['component', 'events', 'tabId']);
    }
  });

  it('never reports a frame flushed on open — neither when the queue later overflows nor when it flushes again', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    const flushed = sameOrigins(DEFAULT_MAX_QUEUED_MESSAGES - 10, TAB_B, 9);
    queueBatches(h, flushed);
    const first = await reopen(h);
    expect(telemetryFramesOf(first)).toHaveLength(flushed.length);

    // That connection dies unnoticed too; batches queue for the next one
    // until the queue overflows.
    await confirmAndStall(first);
    const overflow = 3;
    const later = batchOrigins(DEFAULT_MAX_QUEUED_MESSAGES + overflow);
    queueBatches(h, later);

    expect(onTelemetryDropped.mock.calls).toEqual(later.slice(0, overflow));

    // The next open flushes the rest, and nothing more is reported.
    const second = await reopen(h);
    expect(telemetryFramesOf(second)).toHaveLength(DEFAULT_MAX_QUEUED_MESSAGES);
    expect(onTelemetryDropped).toHaveBeenCalledTimes(overflow);
    expect(h.bridge.getStatus().queuedFrameCount).toBe(0);
  });

  it('settles before every send: frames a part-way flush delivered while the client still reads open are never reported', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    const delivered = sameOrigins(50, TAB_B, 2);
    const waiting = batchOrigins(DEFAULT_MAX_QUEUED_MESSAGES - delivered.length);
    queueBatches(h, [...delivered, ...waiting]);
    await dropLatest(h);
    await advance(nominalDelay(1));
    const socket = latestSocket(h);
    // The hello and the first 50 frames are written; then the far side starts
    // closing. No close event has arrived, so the client is still `open`.
    socket.startClosingAfter(1 + delivered.length);
    socket.accept();
    await flush();
    expect(telemetryFramesOf(socket)).toHaveLength(delivered.length);
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'open',
      queuedFrameCount: waiting.length,
    });

    // A closing socket is handed no telemetry — the batch is refused, not
    // queued — but any other frame still joins the queue, and every send
    // settles the queue's accounting first.
    expect(errCode(h.bridge.sendTelemetryBatch(TAB_B, makeEvents(4)))).toBe(
      'TRANSPORT_DISCONNECTED',
    );
    expect(h.bridge.getStatus().queuedFrameCount).toBe(waiting.length);
    const overflow = 3;
    for (let index = 0; index < delivered.length + overflow; index += 1) {
      expect(okValue(h.bridge.send('tab.navigated', { tabId: TAB_B, url: APP_URL }))).toBe(
        'queued',
      );
    }

    // The frames dropped are the oldest still waiting — never a delivered one.
    expect(onTelemetryDropped.mock.calls).toEqual(waiting.slice(0, overflow));
  });

  it('reports only the telemetry among interleaved drops, while counting every dropped frame', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    const overflow = 9;
    const origins = batchOrigins(DEFAULT_MAX_QUEUED_MESSAGES + overflow);
    const expected: DroppedTelemetry[] = [];

    origins.forEach((origin, index) => {
      const [tabId] = origin;
      // Every third frame is not telemetry: a navigation report or a readiness relay.
      if (index % 3 === 1) {
        const outcome =
          index % 2 === 0
            ? h.bridge.send('tab.navigated', { tabId, url: APP_URL })
            : h.bridge.relayAgentReady(tabId, {
                documentId: 'doc_0123456789abcdef',
                producerId: 'prd_0123456789abcdef',
                url: APP_URL,
                installedBeforeReact: true,
                reactDetected: true,
              });
        expect(okValue(outcome)).toBe('queued');
        return;
      }
      queueBatches(h, [origin]);
      if (index < overflow) {
        expected.push(origin);
      }
    });

    expect(onTelemetryDropped.mock.calls).toEqual(expected);
    expect(expected).toHaveLength(6);
    expect(h.bridge.getStatus().droppedFrameCount).toBe(overflow);
    expect(h.logs.filter((entry) => entry.message.includes('lost sync'))).toEqual([]);
  });

  it('reports every telemetry frame still queued when the credential is removed, and only those', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    queueBatches(h, sameOrigins(5, TAB_B, 9));
    // Flushed by the next connection, so never reported; then it dies too.
    const next = await reopen(h);
    expect(telemetryFramesOf(next)).toHaveLength(5);
    await confirmAndStall(next);
    const discarded = batchOrigins(4);
    queueBatches(h, discarded.slice(0, 2));
    expect(okValue(h.bridge.send('tab.navigated', { tabId: TAB_A, url: APP_URL }))).toBe('queued');
    queueBatches(h, discarded.slice(2));

    h.state.credentialStored = false;
    h.bridge.handlePairingState('not-paired');
    await flush();

    expect(onTelemetryDropped.mock.calls).toEqual(discarded);
    expect(h.bridge.getStatus()).toMatchObject({ transport: 'closed', queuedFrameCount: 0 });
    const summary = h.logs.find(
      (entry) =>
        entry.message === 'queued telemetry was discarded: the devtools credential was removed',
    );
    expect(summary?.level).toBe('warn');
    expect(summary?.fields).toMatchObject({
      frames: discarded.length,
      events: discarded.reduce((sum, [, events]) => sum + events, 0),
    });

    // Paired again, the next queue starts clean: nothing is reported twice.
    h.state.credentialStored = true;
    h.bridge.handlePairingState('paired');
    await flush();
    latestSocket(h).accept();
    await flush();
    h.bridge.handlePairingState('not-paired');
    await flush();
    expect(onTelemetryDropped).toHaveBeenCalledTimes(discarded.length);
  });

  it('reports nothing when the credential is removed after a 4401 — that queue is kept for the next pairing', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    const kept = batchOrigins(6);
    queueBatches(h, kept);
    latestSocket(h).drop(WS_CLOSE_UNAUTHORIZED, REFUSED_REASON);
    await flush();
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'closed',
      queuedFrameCount: kept.length,
    });

    h.bridge.handlePairingState('not-paired');
    await flush();

    expect(onTelemetryDropped).not.toHaveBeenCalled();
    expect(h.bridge.getStatus().queuedFrameCount).toBe(kept.length);

    // The next pairing delivers what was kept, and still reports nothing.
    h.state.credentialStored = true;
    h.bridge.handlePairingState('paired');
    await flush();
    latestSocket(h).accept();
    await flush();
    expect(telemetryFramesOf(latestSocket(h))).toHaveLength(kept.length);
    expect(onTelemetryDropped).not.toHaveBeenCalled();
  });

  it('reports nothing when the bridge is disposed with telemetry queued', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    queueBatches(h, batchOrigins(12));

    await h.bridge.close();

    expect(onTelemetryDropped).not.toHaveBeenCalled();
    expect(h.bridge.getStatus()).toMatchObject({ disposed: true, queuedFrameCount: 0 });
    expect(h.logs.filter((entry) => entry.message === TELEMETRY_DROP_LOG)).toEqual([]);
  });

  it('contains a drop sink that throws: every send still answers, and every later drop is still reported', async () => {
    const onTelemetryDropped = createDropSink();
    onTelemetryDropped.mockImplementation(() => {
      throw new Error('the drop sink failed');
    });
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    const overflow = 4;
    const origins = batchOrigins(DEFAULT_MAX_QUEUED_MESSAGES + overflow);

    // `queueBatches` asserts every send still answers, its frame queued.
    queueBatches(h, origins);

    expect(onTelemetryDropped.mock.calls).toEqual(origins.slice(0, overflow));
    expect(h.bridge.getStatus().droppedFrameCount).toBe(overflow);
    const contained = h.logs.filter((entry) => entry.message === 'the telemetry drop sink threw');
    expect(contained.map((entry) => [entry.level, entry.fields.tabId])).toEqual(
      origins.slice(0, overflow).map(([tabId]) => ['warn', tabId]),
    );
    expect(JSON.stringify(h.logs)).not.toContain('the drop sink failed');

    // The credential-removed path survives it too, and still closes.
    h.bridge.handlePairingState('not-paired');
    await flush();
    expect(onTelemetryDropped).toHaveBeenCalledTimes(overflow + DEFAULT_MAX_QUEUED_MESSAGES);
    expect(latestSocket(h).closeCalls).toHaveLength(1);
    expect(h.bridge.getStatus()).toMatchObject({ transport: 'closed', queuedFrameCount: 0 });
  });
});

describe('agent.ready is relayed with its page-supplied ids intact, and logged by fingerprint only', () => {
  /**
   * Private text a page script could put in `agent.ready`'s ids: bounded
   * within the protocol's 64-character id, so the relay carries it, yet
   * nothing a log record may hold.
   */
  const FORGED_DOCUMENT_ID = 'PRIVATE-SENTINEL token=abc https://x/?q=secret';
  const FORGED_PRODUCER_ID = 'PRIVATE-SENTINEL producer ?q=hidden';

  /** A document id of the agent's canonical `doc_…` shape. */
  const CANONICAL_DOCUMENT_ID = 'doc_0123456789abcdef';

  /** An `agent.ready` report as the bridge hands it over. */
  function readyReport(overrides: Partial<PageAgentReadyPayload> = {}): PageAgentReadyPayload {
    return {
      documentId: CANONICAL_DOCUMENT_ID,
      producerId: 'prd_0123456789abcdef',
      url: APP_URL,
      installedBeforeReact: true,
      reactDetected: true,
      ...overrides,
    };
  }

  /** The `agent.ready` frames a socket carried, decoded. */
  function readyFramesOf(socket: FakeSocket): MessageByType<'agent.ready'>[] {
    return framesOf(socket).filter((message): message is MessageByType<'agent.ready'> =>
      isMessageOfType(message, 'agent.ready'),
    );
  }

  it('relays a forged documentId verbatim while no log record carries it', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);

    const outcome = h.bridge.relayAgentReady(
      TAB_A,
      readyReport({ documentId: FORGED_DOCUMENT_ID, producerId: FORGED_PRODUCER_ID }),
    );

    expect(okValue(outcome)).toBe('sent');
    expect(readyFramesOf(socket).map((frame) => frame.payload)).toEqual([
      {
        tabId: TAB_A,
        documentId: FORGED_DOCUMENT_ID,
        producerId: FORGED_PRODUCER_ID,
        url: APP_URL,
        installedBeforeReact: true,
        reactDetected: true,
      },
    ]);
    const relayed = h.logs.find((entry) => entry.message === 'relayed agent.ready');
    expect(relayed?.fields).toMatchObject({
      tabId: TAB_A,
      document: fingerprintPageId(FORGED_DOCUMENT_ID),
      documentIdCanonical: false,
      outcome: 'sent',
    });
    expect(relayed?.fields).not.toHaveProperty('documentId');
    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toContain('PRIVATE-SENTINEL');
    expect(serialized).not.toContain('token=abc');
    expect(serialized).not.toContain('q=secret');
    expect(serialized).not.toContain('q=hidden');
  });

  it('logs a refused relay with the fingerprint and shape verdict of a canonical id, never the id', () => {
    const h = createHarness();

    // Before any connection the socket client refuses the frame outright.
    const outcome = h.bridge.relayAgentReady(TAB_A, readyReport());

    expect(isErr(outcome)).toBe(true);
    const refused = h.logs.find((entry) => entry.message === 'agent.ready was not relayed');
    expect(refused?.level).toBe('warn');
    expect(refused?.fields).toMatchObject({
      tabId: TAB_A,
      document: fingerprintPageId(CANONICAL_DOCUMENT_ID),
      documentIdCanonical: true,
    });
    expect(refused?.fields).not.toHaveProperty('documentId');
    expect(JSON.stringify(h.logs)).not.toContain(CANONICAL_DOCUMENT_ID);
  });

  it('tells two documents apart in its logs by fingerprint alone', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    const second = 'doc_fedcba9876543210';

    h.bridge.relayAgentReady(TAB_A, readyReport());
    h.bridge.relayAgentReady(TAB_A, readyReport({ documentId: second }));

    const documents = h.logs
      .filter((entry) => entry.message === 'relayed agent.ready')
      .map((entry) => entry.fields.document);
    expect(documents).toEqual([
      fingerprintPageId(CANONICAL_DOCUMENT_ID),
      fingerprintPageId(second),
    ]);
    expect(new Set(documents).size).toBe(2);
  });
});

/**
 * The delivery context `service-worker.ts` copies from the page agent's bridge
 * frame, exactly as {@link WsBridge.sendTelemetryBatch} types its fourth
 * parameter.
 */
type BatchContext = NonNullable<Parameters<WsBridge['sendTelemetryBatch']>[3]>;

/** How many events the synthetic agent reports having discarded before a batch. */
const DROPPED_EVENTS = 42;

/** Whether a value is a non-null object, as `JSON.parse` returns one. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The payload keys of every `telemetry.event` frame a socket carried, sorted,
 * read off the wire JSON itself rather than off a decoded value — so an absent
 * field is proved absent from what the service receives, not merely undefined
 * after a parse.
 */
function telemetryWireKeys(socket: FakeSocket): string[][] {
  return socket.sent.flatMap((raw) => {
    const frame: unknown = JSON.parse(raw);
    if (!isJsonObject(frame) || frame.type !== 'telemetry.event' || !isJsonObject(frame.payload)) {
      return [];
    }
    return [Object.keys(frame.payload).sort()];
  });
}

/** The warnings recorded after the first `from` of them. */
function warningsSince(h: Harness, from: number): LogEntry[] {
  return h.logs.filter((entry) => entry.level === 'warn').slice(from);
}

/** How many warnings have been recorded so far. */
function warningCount(h: Harness): number {
  return h.logs.filter((entry) => entry.level === 'warn').length;
}

describe('a batch carries its delivery context: the armed capture and the reported loss', () => {
  it('names the armed capture on every frame of a batch split across several frames', async () => {
    const limit = telemetryFrameEventLimit();
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);
    const events = makeEvents(limit * 2 + 1);

    const outcome = okValue(
      h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A, { armedCaptureId: CAPTURE_1 }),
    );

    expect(outcome).toEqual({ events: events.length, frames: 3, sent: 3 });
    // Each frame is attributed on its own at the service, so each must carry
    // the capture the agent recorded it for — decoded by the protocol's own
    // validator, so every frame is one the strict schema accepts.
    const frames = telemetryFramesOf(socket);
    expect(frames.map((frame) => frame.payload.armedCaptureId)).toEqual([
      CAPTURE_1,
      CAPTURE_1,
      CAPTURE_1,
    ]);
    // No loss was reported, so no frame claims one.
    expect(telemetryWireKeys(socket)).toEqual([
      ['armedCaptureId', 'events'],
      ['armedCaptureId', 'events'],
      ['armedCaptureId', 'events'],
    ]);
    expect(frames.flatMap((frame) => frame.payload.events)).toEqual(events);
  });

  it("reports the agent's loss once, on the first frame of the batch, never again per chunk", async () => {
    const limit = telemetryFrameEventLimit();
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);

    okValue(
      h.bridge.sendTelemetryBatch(TAB_A, makeEvents(limit * 2 + 1), SESSION_A, {
        armedCaptureId: CAPTURE_1,
        droppedCount: DROPPED_EVENTS,
      }),
    );

    const frames = telemetryFramesOf(socket);
    expect(frames.map((frame) => frame.payload.droppedCount)).toEqual([
      DROPPED_EVENTS,
      undefined,
      undefined,
    ]);
    expect(telemetryWireKeys(socket)).toEqual([
      ['armedCaptureId', 'droppedCount', 'events'],
      ['armedCaptureId', 'events'],
      ['armedCaptureId', 'events'],
    ]);
    // Summed the way the service accumulates reports, the loss counts exactly once.
    const reported = frames.reduce((sum, frame) => sum + (frame.payload.droppedCount ?? 0), 0);
    expect(reported).toBe(DROPPED_EVENTS);
  });

  it('omits a zero loss rather than sending droppedCount: 0 — absent means none was reported', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);
    const events = makeEvents(2);

    okValue(
      h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A, {
        armedCaptureId: CAPTURE_1,
        droppedCount: 0,
      }),
    );
    okValue(h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A, { droppedCount: 0 }));

    expect(telemetryWireKeys(socket)).toEqual([['armedCaptureId', 'events'], ['events']]);
    expect(telemetryFramesOf(socket)[0]?.payload).toEqual({ events, armedCaptureId: CAPTURE_1 });
  });

  it('without a context, or with one that names nothing, every frame is exactly { events } as before', async () => {
    const limit = telemetryFrameEventLimit();
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);
    const contexts: readonly (BatchContext | undefined)[] = [
      undefined,
      {},
      { armedCaptureId: undefined, droppedCount: undefined },
    ];

    for (const context of contexts) {
      expect(
        okValue(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(limit + 1), SESSION_A, context)),
      ).toEqual({
        events: limit + 1,
        frames: 2,
        sent: 2,
      });
    }

    expect(telemetryWireKeys(socket)).toEqual(
      Array.from({ length: contexts.length * 2 }, () => ['events']),
    );
  });

  it('never queues a batch while reconnecting, and carries its context once the route is confirmed again', async () => {
    const h = createHarness();
    const first = await connectAndOpen(h);
    answerBound(first, TAB_A, SESSION_A);
    await dropLatest(h);
    const events = makeEvents(3);
    const context: BatchContext = { armedCaptureId: CAPTURE_1, droppedCount: DROPPED_EVENTS };

    // Refused rather than parked in the socket client's reconnect queue, which
    // is flushed before the re-announced binding is confirmed.
    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A, context))).toBe(
      'TRANSPORT_DISCONNECTED',
    );
    await advance(nominalDelay(1));
    const socket = latestSocket(h);
    socket.accept();
    await flush();
    expect(typesOf(socket)).not.toContain('telemetry.event');

    answerBound(socket, TAB_A, SESSION_A);
    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A, context))).toEqual({
      events: 3,
      frames: 1,
      sent: 1,
    });
    expect(telemetryFramesOf(socket)[0]?.payload).toEqual({
      events,
      armedCaptureId: CAPTURE_1,
      droppedCount: DROPPED_EVENTS,
    });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['beyond the safe-integer range', Number.MAX_SAFE_INTEGER + 2],
  ])(
    'leaves out a loss count that is %s, which the strict schema would refuse, and still delivers the events',
    async (_label, droppedCount) => {
      const events = makeEvents(2);
      // The receiver's schema is the authority: this value would refuse the frame.
      expect(telemetryEventPayloadSchema.safeParse({ events, droppedCount }).success).toBe(false);
      const h = createHarness();
      const socket = await connectAndOpen(h);
      answerBound(socket, TAB_A, SESSION_A);
      answerBound(socket, TAB_A, SESSION_A);
      const warningsBefore = warningCount(h);

      const outcome = okValue(
        h.bridge.sendTelemetryBatch(TAB_A, events, SESSION_A, {
          armedCaptureId: CAPTURE_1,
          droppedCount,
        }),
      );

      expect(outcome).toEqual({ events: 2, frames: 1, sent: 1 });
      expect(telemetryWireKeys(socket)).toEqual([['armedCaptureId', 'events']]);
      expect(telemetryFramesOf(socket)[0]?.payload.events).toEqual(events);
      const warnings = warningsSince(h, warningsBefore);
      expect(warnings).toHaveLength(1);
      // The tab and counts only: the refused value itself is never logged.
      expect(warnings[0]?.fields).toMatchObject({ tabId: TAB_A, events: 2 });
      expect(
        Object.values(warnings[0]?.fields ?? {}).some((value) => Object.is(value, droppedCount)),
      ).toBe(false);
    },
  );

  it.each([
    ['empty', ''],
    ['padded with whitespace', ` ${CAPTURE_1}`],
    ['longer than a protocol identifier', 'c'.repeat(1024)],
  ])(
    'refuses a batch whose armed capture id is %s: nothing is sent, so it cannot be filed under the open capture',
    async (_label, armedCaptureId) => {
      // The receiver's schema is the authority on what an identifier is.
      expect(
        telemetryEventPayloadSchema.safeParse({ events: makeEvents(1), armedCaptureId }).success,
      ).toBe(false);
      const h = createHarness();
      const socket = await connectAndOpen(h);
      answerBound(socket, TAB_A, SESSION_A);
      answerBound(socket, TAB_A, SESSION_A);
      const framesBefore = socket.sent.length;
      const warningsBefore = warningCount(h);

      const refusal = h.bridge.sendTelemetryBatch(TAB_A, makeEvents(2), SESSION_A, {
        armedCaptureId,
        droppedCount: DROPPED_EVENTS,
      });

      expect(isErr(refusal)).toBe(true);
      if (isErr(refusal)) {
        expect(refusal.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      }
      expect(socket.sent).toHaveLength(framesBefore);
      const warnings = warningsSince(h, warningsBefore);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.fields).toMatchObject({ tabId: TAB_A, events: 2 });
      expect(Object.values(warnings[0]?.fields ?? {})).not.toContain(armedCaptureId);
    },
  );
});

/** The log line of one dropped loss-only telemetry frame. */
const LOSS_REPORT_DROP_LOG =
  'a queued telemetry loss report was dropped before it reached the service';

describe('a loss-only report: an empty batch that carries a loss', () => {
  it('sends one frame of no events with the loss and the armed capture, scoped to its tab and session', async () => {
    // The receiver's schema is the authority: an event-less frame is accepted
    // only as a loss report.
    expect(telemetryEventPayloadSchema.safeParse({ events: [] }).success).toBe(false);
    expect(telemetryEventPayloadSchema.safeParse({ events: [], droppedCount: 0 }).success).toBe(
      false,
    );
    expect(
      telemetryEventPayloadSchema.safeParse({
        events: [],
        armedCaptureId: CAPTURE_1,
        droppedCount: DROPPED_EVENTS,
      }).success,
    ).toBe(true);
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);

    const outcome = h.bridge.sendTelemetryBatch(TAB_A, [], SESSION_A, {
      armedCaptureId: CAPTURE_1,
      droppedCount: DROPPED_EVENTS,
    });

    expect(okValue(outcome)).toEqual({ events: 0, frames: 1, sent: 1 });
    // Decoded through the protocol's own validator, as the service decodes it.
    const frames = telemetryFramesOf(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual({
      events: [],
      armedCaptureId: CAPTURE_1,
      droppedCount: DROPPED_EVENTS,
    });
    expect([frames[0]?.tabId, frames[0]?.sessionId]).toEqual([TAB_A, SESSION_A]);
    expect(telemetryWireKeys(socket)).toEqual([['armedCaptureId', 'droppedCount', 'events']]);
  });

  it('sends exactly { events: [], droppedCount } when no capture is named, along the route the service confirmed', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_B, SESSION_B);

    expect(okValue(h.bridge.sendTelemetryBatch(TAB_B, [], undefined, { droppedCount: 1 }))).toEqual(
      { events: 0, frames: 1, sent: 1 },
    );

    expect(telemetryWireKeys(socket)).toEqual([['droppedCount', 'events']]);
    expect(telemetryFramesOf(socket)[0]).toMatchObject({
      tabId: TAB_B,
      sessionId: SESSION_B,
      payload: { events: [], droppedCount: 1 },
    });
  });

  it('is refused like any batch — not connected, route unconfirmed, a capture id the protocol refuses — and sends nothing', async () => {
    const loss: BatchContext = { armedCaptureId: CAPTURE_1, droppedCount: DROPPED_EVENTS };
    const h = createHarness({ bindings: [BINDING_A] });

    // Before any connection.
    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, [], SESSION_A, loss))).toBe(
      'TRANSPORT_DISCONNECTED',
    );
    const socket = await connectAndOpen(h);
    // Open, with the re-announced binding not yet answered.
    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, [], SESSION_A, loss))).toBe('TAB_NOT_BOUND');
    answerBound(socket, TAB_A, SESSION_A);
    // Another session than the one the service confirmed for the tab.
    expect(errCode(h.bridge.sendTelemetryBatch(TAB_A, [], SESSION_B, loss))).toBe('TAB_NOT_BOUND');
    // A capture the protocol would not accept: never filed under the open one.
    expect(
      errCode(
        h.bridge.sendTelemetryBatch(TAB_A, [], SESSION_A, {
          armedCaptureId: '',
          droppedCount: DROPPED_EVENTS,
        }),
      ),
    ).toBe('PROTOCOL_INVALID_MESSAGE');

    expect(telemetryFramesOf(socket)).toEqual([]);
    expect(h.bridge.getStatus().queuedFrameCount).toBe(0);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])(
    'sends nothing for an empty batch whose loss count is %s: the protocol has no frame for it',
    async (_label, droppedCount) => {
      const h = createHarness();
      const socket = await connectAndOpen(h);
      answerBound(socket, TAB_A, SESSION_A);
      const framesBefore = socket.sent.length;
      const warningsBefore = warningCount(h);

      const outcome = h.bridge.sendTelemetryBatch(TAB_A, [], SESSION_A, {
        armedCaptureId: CAPTURE_1,
        droppedCount,
      });

      expect(okValue(outcome)).toEqual({ events: 0, frames: 0, sent: 0 });
      expect(socket.sent).toHaveLength(framesBefore);
      // A zero is no loss at all; a malformed count is a diagnostic, and the
      // refused value itself is never logged.
      const warnings = warningsSince(h, warningsBefore);
      expect(warnings).toHaveLength(droppedCount === 0 ? 0 : 1);
      for (const warning of warnings) {
        expect(warning.fields).toMatchObject({ tabId: TAB_A });
        expect(Object.values(warning.fields).some((value) => Object.is(value, droppedCount))).toBe(
          false,
        );
      }
    },
  );

  it('logs a queued loss-only frame the full queue drops, and never reports it as undelivered events', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    // The write throws on the stalled socket, so the client queues the frame.
    const report = h.bridge.sendTelemetryBatch(TAB_A, [], undefined, {
      droppedCount: DROPPED_EVENTS,
    });
    expect(errCode(report)).toBe('TRANSPORT_DISCONNECTED');
    expect(isErr(report) ? report.error.details : undefined).toMatchObject({
      tabId: TAB_A,
      framesWritten: 0,
      framesQueued: 1,
    });

    // Filling the queue drops its oldest frame first: the loss report.
    const origins = batchOrigins(DEFAULT_MAX_QUEUED_MESSAGES);
    queueBatches(h, origins);

    expect(onTelemetryDropped).not.toHaveBeenCalled();
    expect(h.bridge.getStatus().droppedFrameCount).toBe(1);
    expect(
      h.logs
        .filter((entry) => entry.message === LOSS_REPORT_DROP_LOG)
        .map((entry) => [entry.level, entry.fields.tabId, entry.fields.droppedCount]),
    ).toEqual([['warn', TAB_A, DROPPED_EVENTS]]);
    expect(h.logs.filter((entry) => entry.message === TELEMETRY_DROP_LOG)).toEqual([]);

    // The next overflow drops the oldest event frame, reported as before.
    queueBatches(h, [[TAB_B, 3]]);
    expect(onTelemetryDropped.mock.calls).toEqual([origins[0]]);
  });

  it('reports only the event frames among queued telemetry discarded with the credential', async () => {
    const onTelemetryDropped = createDropSink();
    const h = createHarness({ onTelemetryDropped });
    await openStalled(h);
    const events = batchOrigins(2);
    queueBatches(h, events.slice(0, 1));
    expect(
      errCode(h.bridge.sendTelemetryBatch(TAB_B, [], undefined, { droppedCount: DROPPED_EVENTS })),
    ).toBe('TRANSPORT_DISCONNECTED');
    queueBatches(h, events.slice(1));

    h.state.credentialStored = false;
    h.bridge.handlePairingState('not-paired');
    await flush();

    expect(onTelemetryDropped.mock.calls).toEqual(events);
    expect(h.bridge.getStatus()).toMatchObject({ transport: 'closed', queuedFrameCount: 0 });
  });
});

/** A recording `WsBridgeDeps.onTelemetryFrameDiscarded`. */
function createDiscardSink(): Mock<(frame: DiscardedTelemetryFrame) => void> {
  return vi.fn<(frame: DiscardedTelemetryFrame) => void>();
}

/** Every frame a discard sink was told of, in order. */
function discardedFrames(
  sink: Mock<(frame: DiscardedTelemetryFrame) => void>,
): DiscardedTelemetryFrame[] {
  return sink.mock.calls.map(([frame]) => frame);
}

/**
 * Queue one batch over a stalled socket ({@link openStalled}) and return the
 * interrupted write's details — how far the batch got before the client took
 * its first frame into the queue instead of writing it.
 */
function queueWithContext(
  h: Harness,
  tabId: TabId,
  events: number,
  sessionId: SessionId,
  context: BatchContext,
): Record<string, unknown> | undefined {
  const outcome = h.bridge.sendTelemetryBatch(tabId, makeEvents(events), sessionId, context);
  expect(errCode(outcome)).toBe('TRANSPORT_DISCONNECTED');
  return isErr(outcome) ? outcome.error.details : undefined;
}

describe('every discarded telemetry frame is reported with its labels and loss, for the service ledger', () => {
  it('reports a queued loss-only frame and an event frame’s carried loss when the full queue drops them, oldest first — the panel sink hears only of events', async () => {
    const onTelemetryDropped = createDropSink();
    const onTelemetryFrameDiscarded = createDiscardSink();
    const h = createHarness({ onTelemetryDropped, onTelemetryFrameDiscarded });
    await openStalled(h);

    // Queued, oldest first: TAB_A's loss-only report for its armed capture,
    // then a TAB_B batch whose first frame carries the page's own loss. The
    // interrupted writes say what the client's queue took.
    expect(
      queueWithContext(h, TAB_A, 0, SESSION_A, {
        armedCaptureId: CAPTURE_1,
        droppedCount: DROPPED_EVENTS,
      }),
    ).toMatchObject({ framesWritten: 0, framesQueued: 1, eventsQueued: 0 });
    expect(queueWithContext(h, TAB_B, 3, SESSION_B, { droppedCount: 5 })).toMatchObject({
      framesWritten: 0,
      eventsWritten: 0,
      framesQueued: 1,
      eventsQueued: 3,
    });
    // Filling the queue drops exactly those two.
    const origins = batchOrigins(DEFAULT_MAX_QUEUED_MESSAGES);
    queueBatches(h, origins);

    expect(discardedFrames(onTelemetryFrameDiscarded)).toStrictEqual([
      {
        tabId: TAB_A,
        sessionId: SESSION_A,
        armedCaptureId: CAPTURE_1,
        events: 0,
        droppedCount: DROPPED_EVENTS,
      },
      { tabId: TAB_B, sessionId: SESSION_B, events: 3, droppedCount: 5 },
    ]);
    // The panel sink keeps its semantics: events only, never a loss-only frame.
    expect(onTelemetryDropped.mock.calls).toEqual([[TAB_B, 3]]);

    // The next overflow drops the oldest plain event frame: its labels are the
    // tab's confirmed route, and it carried no loss.
    queueBatches(h, [[TAB_B, 1]]);
    const [first] = origins;
    expect(discardedFrames(onTelemetryFrameDiscarded).at(-1)).toStrictEqual({
      tabId: first?.[0],
      sessionId: first?.[0] === TAB_A ? SESSION_A : SESSION_B,
      events: first?.[1],
      droppedCount: 0,
    });
    expect(onTelemetryDropped.mock.calls.at(-1)).toEqual(first);
    // The armed capture id is page-supplied: reported to the sink, never logged.
    expect(JSON.stringify(h.logs)).not.toContain(CAPTURE_1);
  });

  it('reports every telemetry frame the credential removal discards, loss-only ones included, with the context each was sent under', async () => {
    const onTelemetryDropped = createDropSink();
    const onTelemetryFrameDiscarded = createDiscardSink();
    const h = createHarness({ onTelemetryDropped, onTelemetryFrameDiscarded });
    await openStalled(h);
    queueBatches(h, [[TAB_A, 2]]);
    queueWithContext(h, TAB_B, 0, SESSION_B, { armedCaptureId: CAPTURE_1, droppedCount: 7 });
    expect(okValue(h.bridge.send('tab.navigated', { tabId: TAB_A, url: APP_URL }))).toBe('queued');
    queueWithContext(h, TAB_A, 4, SESSION_A, {
      armedCaptureId: CAPTURE_1,
      droppedCount: DROPPED_EVENTS,
    });

    h.state.credentialStored = false;
    h.bridge.handlePairingState('not-paired');
    await flush();

    expect(discardedFrames(onTelemetryFrameDiscarded)).toStrictEqual([
      { tabId: TAB_A, sessionId: SESSION_A, events: 2, droppedCount: 0 },
      { tabId: TAB_B, sessionId: SESSION_B, armedCaptureId: CAPTURE_1, events: 0, droppedCount: 7 },
      {
        tabId: TAB_A,
        sessionId: SESSION_A,
        armedCaptureId: CAPTURE_1,
        events: 4,
        droppedCount: DROPPED_EVENTS,
      },
    ]);
    expect(onTelemetryDropped.mock.calls).toEqual([
      [TAB_A, 2],
      [TAB_A, 4],
    ]);
    const summary = h.logs.find(
      (entry) =>
        entry.message === 'queued telemetry was discarded: the devtools credential was removed',
    );
    expect(summary?.fields).toMatchObject({
      frames: 3,
      events: 6,
      droppedCount: 7 + DROPPED_EVENTS,
    });
    expect(h.bridge.getStatus()).toMatchObject({ transport: 'closed', queuedFrameCount: 0 });
    expect(JSON.stringify(h.logs)).not.toContain(CAPTURE_1);
  });

  it('reports nothing for frames a reconnect flushes, nor for frames still queued when the bridge is disposed', async () => {
    const onTelemetryFrameDiscarded = createDiscardSink();
    const h = createHarness({ onTelemetryFrameDiscarded });
    await openStalled(h);
    queueWithContext(h, TAB_A, 0, SESSION_A, { droppedCount: DROPPED_EVENTS });
    queueBatches(h, batchOrigins(3));

    // Flushed after the next hello: delivered, so never reported.
    const next = await reopen(h);
    expect(telemetryFramesOf(next)).toHaveLength(4);
    await confirmAndStall(next);
    queueWithContext(h, TAB_B, 2, SESSION_B, { droppedCount: 1 });

    // Disposal is the worker going away, not a loss to report.
    await h.bridge.close();

    expect(onTelemetryFrameDiscarded).not.toHaveBeenCalled();
    expect(h.bridge.getStatus()).toMatchObject({ disposed: true, queuedFrameCount: 0 });
  });

  it('contains a discard sink that throws: every send still answers, and the panel sink is still told', async () => {
    const onTelemetryDropped = createDropSink();
    const onTelemetryFrameDiscarded = createDiscardSink();
    onTelemetryFrameDiscarded.mockImplementation(() => {
      throw new Error('the discard sink failed');
    });
    const h = createHarness({ onTelemetryDropped, onTelemetryFrameDiscarded });
    await openStalled(h);
    const overflow = 2;
    const origins = batchOrigins(DEFAULT_MAX_QUEUED_MESSAGES + overflow);

    // `queueBatches` asserts every send still answers, its frame queued.
    queueBatches(h, origins);

    expect(onTelemetryFrameDiscarded).toHaveBeenCalledTimes(overflow);
    expect(onTelemetryDropped.mock.calls).toEqual(origins.slice(0, overflow));
    const contained = h.logs.filter(
      (entry) => entry.message === 'the telemetry discard sink threw',
    );
    expect(contained.map((entry) => [entry.level, entry.fields.tabId])).toEqual(
      origins.slice(0, overflow).map(([tabId]) => ['warn', tabId]),
    );
    expect(JSON.stringify(h.logs)).not.toContain('the discard sink failed');
  });
});

/** A route wait whose settlement a case can observe without awaiting it. */
interface ObservedRouteWait {
  /** The settled result, once there is one. */
  readonly result: () => Result<void, DebuggenError> | undefined;
  /** The wait's promise, for the case that does await it. */
  readonly promise: Promise<Result<void, DebuggenError>>;
}

/** Start a route wait and record its settlement as it happens. */
function observeRoute(
  h: Harness,
  tabId: TabId,
  sessionId: SessionId,
  options?: Parameters<WsBridge['awaitTabRoute']>[2],
): ObservedRouteWait {
  let settled: Result<void, DebuggenError> | undefined;
  const promise = h.bridge.awaitTabRoute(tabId, sessionId, options).then((result) => {
    settled = result;
    return result;
  });
  return { result: () => settled, promise };
}

/** The `details.cancelled` a failed route wait reports, if any. */
function cancelledBy(result: Result<void, DebuggenError> | undefined): unknown {
  return result !== undefined && isErr(result) ? result.error.details?.cancelled : undefined;
}

describe('awaitTabRoute — the service-confirmed route telemetry waits for', () => {
  it('answers at once, with no timer, when the route is already confirmed on the open socket', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    answerBound(socket, TAB_A, SESSION_A);
    const timersBefore = h.setTimer.mock.calls.length;

    expect(okValue(await h.bridge.awaitTabRoute(TAB_A, SESSION_A))).toBeUndefined();

    expect(h.setTimer.mock.calls.length).toBe(timersBefore);
    // A confirmation for the tab under another session answers at once too.
    expect(errCode(await h.bridge.awaitTabRoute(TAB_A, SESSION_B))).toBe('TAB_NOT_BOUND');
  });

  it('waits across the open for the answer to the re-announced bind, then resolves ok and releases its timer', async () => {
    const h = createHarness({ bindings: [BINDING_A] });
    await h.bridge.connect();
    const timersBefore = vi.getTimerCount();
    const wait = observeRoute(h, TAB_A, SESSION_A);
    await flush();
    expect(wait.result()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(timersBefore + 1);

    const socket = latestSocket(h);
    socket.accept();
    await flush();
    // Open and re-announced, but not answered: still waiting.
    expect(typesOf(socket)).toEqual(['client.hello', 'session.bind']);
    expect(wait.result()).toBeUndefined();

    answerBound(socket, TAB_A, SESSION_A);
    await flush();

    expect(wait.result()?.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(okValue(h.bridge.sendTelemetryBatch(TAB_A, makeEvents(1), SESSION_A)).sent).toBe(1);
  });

  it('fails with TAB_NOT_BOUND when the tab is confirmed for another session', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const wait = observeRoute(h, TAB_A, SESSION_A);
    await flush();

    answerBound(socket, TAB_A, SESSION_B);
    await flush();

    expect(errCode(await wait.promise)).toBe('TAB_NOT_BOUND');
  });

  it('fails with TAB_NOT_BOUND when the session is confirmed for another tab', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const wait = observeRoute(h, TAB_A, SESSION_A);
    await flush();

    answerBound(socket, TAB_B, SESSION_A);
    await flush();

    expect(errCode(await wait.promise)).toBe('TAB_NOT_BOUND');
  });

  it('fails with TAB_NOT_BOUND on an ending reason for the pair, and ignores one for another pair', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const replaced = observeRoute(h, TAB_A, SESSION_A);
    const unrelated = observeRoute(h, TAB_B, SESSION_B);
    await flush();

    answerBound(socket, TAB_A, SESSION_A, 'replaced');
    answerBound(socket, TAB_B, SESSION_A, 'unbound');
    await flush();

    expect(errCode(await replaced.promise)).toBe('TAB_NOT_BOUND');
    expect(unrelated.result()).toBeUndefined();

    answerBound(socket, TAB_B, SESSION_B, 'navigated');
    expect((await unrelated.promise).ok).toBe(true);
  });

  it('times out on the injected timers after TELEMETRY_ROUTE_WAIT_MS, or after the bound its caller gives', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    const timersBefore = vi.getTimerCount();
    const bounded = observeRoute(h, TAB_A, SESSION_A);
    const shorter = observeRoute(h, TAB_B, SESSION_B, { timeoutMs: 1_000 });
    await flush();
    expect(h.delays).toContain(TELEMETRY_ROUTE_WAIT_MS);
    expect(h.delays).toContain(1_000);

    await advance(1_000);
    expect(errCode(await shorter.promise)).toBe('TRANSPORT_DISCONNECTED');
    expect(cancelledBy(shorter.result())).toBe('timeout');
    expect(bounded.result()).toBeUndefined();

    await advance(TELEMETRY_ROUTE_WAIT_MS - 1_001);
    expect(bounded.result()).toBeUndefined();
    await advance(1);
    expect(errCode(await bounded.promise)).toBe('TRANSPORT_DISCONNECTED');
    expect(cancelledBy(bounded.result())).toBe('timeout');
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('treats every reconnect as a new generation: an earlier confirmation no longer counts', async () => {
    const h = createHarness({ bindings: [BINDING_A] });
    const first = await connectAndOpen(h);
    answerBound(first, TAB_A, SESSION_A);
    expect((await h.bridge.awaitTabRoute(TAB_A, SESSION_A)).ok).toBe(true);

    await dropLatest(h);
    const wait = observeRoute(h, TAB_A, SESSION_A);
    await advance(nominalDelay(1));
    const second = latestSocket(h);
    second.accept();
    await flush();
    expect(wait.result()).toBeUndefined();

    answerBound(second, TAB_A, SESSION_A);
    await flush();
    expect(wait.result()?.ok).toBe(true);
  });

  it('ends a wait with TRANSPORT_DISCONNECTED when its signal fires, or at once for a fired signal', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    const timersBefore = vi.getTimerCount();
    const controller = new AbortController();
    const wait = observeRoute(h, TAB_A, SESSION_A, { signal: controller.signal });
    await flush();

    controller.abort();
    await flush();

    expect(errCode(await wait.promise)).toBe('TRANSPORT_DISCONNECTED');
    expect(cancelledBy(wait.result())).toBe('aborted');
    expect(vi.getTimerCount()).toBe(timersBefore);
    const late = await h.bridge.awaitTabRoute(TAB_A, SESSION_A, { signal: controller.signal });
    expect(cancelledBy(late)).toBe('aborted');
  });

  it('fails pending waits with UNAUTHORIZED when the service refuses the credential, and with TRANSPORT_DISCONNECTED on dispose', async () => {
    const refused = createHarness();
    await connectAndOpen(refused);
    const unauthorized = observeRoute(refused, TAB_A, SESSION_A);
    await flush();
    latestSocket(refused).drop(WS_CLOSE_UNAUTHORIZED, REFUSED_REASON);
    await flush();
    expect(errCode(await unauthorized.promise)).toBe('UNAUTHORIZED');
    expect(errCode(await refused.bridge.awaitTabRoute(TAB_A, SESSION_A))).toBe('UNAUTHORIZED');

    const disposed = createHarness();
    await connectAndOpen(disposed);
    // The open connection's heartbeat is the only timer before the wait …
    expect(disposed.bridge.getStatus().heartbeatActive).toBe(true);
    const timersBefore = vi.getTimerCount();
    const pending = observeRoute(disposed, TAB_A, SESSION_A);
    await flush();
    // … and the wait arms exactly one more: its bound.
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    await disposed.bridge.close();
    expect(errCode(await pending.promise)).toBe('TRANSPORT_DISCONNECTED');
    expect(errCode(await disposed.bridge.awaitTabRoute(TAB_A, SESSION_A))).toBe(
      'TRANSPORT_DISCONNECTED',
    );
    // Dispose released the wait's bound and stopped the heartbeat: nothing of
    // the bridge is left armed.
    expect(disposed.bridge.getStatus().heartbeatActive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a value that is not a tab id or an empty session id, arming nothing', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    const timersBefore = vi.getTimerCount();

    expect(errCode(await h.bridge.awaitTabRoute(-1, SESSION_A))).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(errCode(await h.bridge.awaitTabRoute(TAB_A, ''))).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});

describe('agent.ready is relayed acting for the tab it came from', () => {
  /** The page agent's report: everything but the tab, which it cannot know. */
  const REPORT: PageAgentReadyPayload = {
    documentId: 'document-test-1',
    producerId: 'producer-test-1',
    url: APP_URL,
    installedBeforeReact: true,
    reactDetected: true,
  };

  it('fills the tab into the payload and names it as the envelope acting tab, forwarding every other field intact', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);

    expect(okValue(h.bridge.relayAgentReady(TAB_B, REPORT))).toBe('sent');

    const frames = framesOf(socket).flatMap((message) =>
      isMessageOfType(message, 'agent.ready') ? [message] : [],
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual({ ...REPORT, tabId: TAB_B });
    expect(frames[0]?.tabId).toBe(TAB_B);
  });

  it('refuses a value that is not a tab id, sending nothing', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const framesBefore = socket.sent.length;

    const refusal = h.bridge.relayAgentReady(-1, REPORT);

    expect(isErr(refusal)).toBe(true);
    if (isErr(refusal)) {
      expect(refusal.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    }
    expect(socket.sent).toHaveLength(framesBefore);
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
    // The only timers ever set are the socket's opening deadline and the
    // heartbeat of the connection that opened — no backoff delay follows the
    // refusal, and the refusal stopped the heartbeat.
    expect(pushedStatuses(h).slice(statusesBefore)).not.toContain('reconnecting');
    const timersOfTheOpenConnection = [DEFAULT_WS_OPEN_TIMEOUT_MS, SOCKET_HEARTBEAT_INTERVAL_MS];
    expect(h.delays).toEqual(timersOfTheOpenConnection);
    expect(h.bridge.getStatus().heartbeatActive).toBe(false);

    // Well past the clamp, and through a keepalive tick: nothing retries it.
    await advance(DEFAULT_WS_BACKOFF.maxMs * 5);
    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });
    await advance(DEFAULT_WS_BACKOFF.maxMs * 5);

    expect(h.sockets).toHaveLength(1);
    expect(h.delays).toEqual(timersOfTheOpenConnection);
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
      // The open connection's opening deadline and heartbeat, then the first
      // step of the curve.
      expect(h.delays).toEqual([
        DEFAULT_WS_OPEN_TIMEOUT_MS,
        SOCKET_HEARTBEAT_INTERVAL_MS,
        DEFAULT_WS_BACKOFF.initialMs,
      ]);
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
    // No backoff delay: the first connection's opening deadline and heartbeat,
    // then the replacement socket's own opening deadline.
    expect(h.delays).toEqual([
      DEFAULT_WS_OPEN_TIMEOUT_MS,
      SOCKET_HEARTBEAT_INTERVAL_MS,
      DEFAULT_WS_OPEN_TIMEOUT_MS,
    ]);
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

    const result = await h.bridge.queryPanelData(SESSION_A, TRACE_QUERY, { tabId: TAB_A });
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
    await expect(
      h.bridge.queryPanelData(SESSION_A, TRACE_QUERY, { tabId: TAB_A }),
    ).resolves.toMatchObject({
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

    const result = await h.bridge.queryPanelData(SESSION_A, TRACE_QUERY, { tabId: TAB_A });

    expect(okValue(result)).toEqual(answer);
    const call = h.fetch.mock.calls.find(
      ([url]) => new URL(url).pathname === panelDataPath(SESSION_A),
    );
    expect(call).toBeDefined();
    const [url, init] = call ?? ['', undefined];
    expect(new URL(url).origin).toBe(new URL(DEFAULT_SERVICE_BASE_URL).origin);
    expect(init?.method).toBe(HTTP_ROUTES['panel.data'].method);
    expect(init?.headers?.[ACTING_TAB_HEADER]).toBe(String(TAB_A));
    const body: unknown = JSON.parse(init?.body ?? 'null');
    expect(body).toEqual(TRACE_QUERY);
  });

  it('sends the acting tab as x-debuggen-tab on every session-scoped request, and none on the health probe', async () => {
    const h = createHarness();
    const panelId = 'panel-test-1';
    const expected: readonly (readonly [string, TabId])[] = [
      [panelDataPath(SESSION_A), TAB_A],
      [captureStartPath(SESSION_A), TAB_A],
      [captureStopPath(SESSION_A), TAB_A],
      [sessionPath(SESSION_B), TAB_B],
      [panelPath(SESSION_B), TAB_B],
      [panelByIdPath(SESSION_B, panelId), TAB_B],
      [modificationsPath(SESSION_B), TAB_B],
    ];

    // No route answers these paths, so each call fails at the transport — after
    // the request, headers included, was handed to `fetch`.
    const results = await Promise.all([
      h.bridge.queryPanelData(SESSION_A, TRACE_QUERY, { tabId: TAB_A }),
      h.bridge.startCapture(SESSION_A, { tabId: TAB_A }),
      h.bridge.stopCapture(SESSION_A, { tabId: TAB_A }),
      h.bridge.getSession(SESSION_B, { tabId: TAB_B }),
      h.bridge.getCurrentPanel(SESSION_B, { tabId: TAB_B }),
      h.bridge.getPanel(SESSION_B, panelId, { tabId: TAB_B }),
      h.bridge.getModifications(SESSION_B, { tabId: TAB_B }),
    ]);
    await h.bridge.probeService();

    expect(results.map((result) => result.ok)).toEqual(results.map(() => false));
    for (const [path, tabId] of expected) {
      const calls = h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === path);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]?.headers?.[ACTING_TAB_HEADER]).toBe(String(tabId));
    }
    const health = h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === healthPath());
    expect(health.length).toBeGreaterThan(0);
    for (const [, init] of health) {
      expect(Object.keys(init?.headers ?? {})).not.toContain(ACTING_TAB_HEADER);
    }
  });

  it('refuses a session-scoped request whose acting tab is not a Chrome tab id locally, with nothing sent', async () => {
    const h = createHarness();

    const result = await h.bridge.getSession(SESSION_A, { tabId: -1 });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    }
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.tokenProvider).not.toHaveBeenCalled();
  });

  it('resolves every HTTP operation to a typed Err while the service is down — none rejects', async () => {
    const h = createHarness({ serviceUp: false });

    const results = await Promise.all([
      h.bridge.queryPanelData(SESSION_A, TRACE_QUERY, { tabId: TAB_A }),
      h.bridge.startCapture(SESSION_A, { tabId: TAB_A }),
      h.bridge.stopCapture(SESSION_A, { tabId: TAB_A }),
      h.bridge.getSession(SESSION_A, { tabId: TAB_A }),
      h.bridge.getCurrentPanel(SESSION_A, { tabId: TAB_A }),
      h.bridge.getPanel(SESSION_A, 'panel-test-1', { tabId: TAB_A }),
      h.bridge.getModifications(SESSION_A, { tabId: TAB_A }),
      h.bridge.probeService(),
    ]);

    expect(results.map((result) => result.ok)).toEqual(results.map(() => false));
    expect(h.sockets).toHaveLength(0);
    expect(h.onUnauthorized).not.toHaveBeenCalled();
  });
});

/*
 * ===========================================================================
 * The configured service address — a loopback port the developer chose, on
 * the socket and on every HTTP call
 * ===========================================================================
 */

/** A service on a loopback port other than the default one. */
const OTHER_SERVICE_URL = 'http://127.0.0.1:20150';

/** A third loopback port: the worker environment's own address. */
const ENV_SERVICE_URL = 'http://127.0.0.1:20160';

/** The canonical socket URL of a service base URL, as the protocol resolves it. */
function socketUrlOf(baseUrl: string): string {
  const resolved = resolveWsUrl(baseUrl);
  if (isErr(resolved)) {
    throw new Error(`a test service URL was refused (${resolved.error.code})`);
  }
  return resolved.value;
}

/** The origin of every request an injected `fetch` received, in order. */
function requestOrigins(fetch: Mock<FetchLike>): string[] {
  return fetch.mock.calls.map(([url]) => new URL(url).origin);
}

/** The error of a failed `Result`, or a failure saying it succeeded. */
function errOf<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (!isErr(result)) {
    throw new Error('expected an Err Result, got ok');
  }
  return result.error;
}

/** The refusal `parseServiceEndpoint` answers `raw` with. */
function endpointRefusal(raw: unknown): DebuggenError {
  return errOf(parseServiceEndpoint(raw));
}

describe('WsBridge.setServiceBaseUrl: the configured address reaches the socket and every HTTP call', () => {
  it('uses a non-default loopback port for the socket URL, every HTTP request and the pill', async () => {
    const h = createHarness({ serviceBaseUrl: OTHER_SERVICE_URL });

    const socket = await connectAndOpen(h);
    await h.bridge.probeService();
    await h.bridge.queryPanelData(SESSION_A, TRACE_QUERY, { tabId: TAB_A });

    expect(socket.url).toBe(socketUrlOf(OTHER_SERVICE_URL));
    expect(new URL(socket.url).port).toBe('20150');
    expect(requestOrigins(h.fetch)).toHaveLength(2);
    expect(new Set(requestOrigins(h.fetch))).toEqual(new Set([OTHER_SERVICE_URL]));
    expect(lastPushed(h)).toMatchObject({ status: 'connected', serviceUrl: OTHER_SERVICE_URL });
  });

  it('moves an open connection at once: the old socket is retired, a new one opens at the new port with no backoff, and HTTP follows', async () => {
    const h = createHarness({ httpClientThunk: true, bindings: [BINDING_A] });
    const first = await connectAndOpen(h);
    const timersBefore = h.delays.length;

    h.rebuildHttpClient(OTHER_SERVICE_URL);
    h.bridge.setServiceBaseUrl(OTHER_SERVICE_URL);
    await flush();

    expect(first.closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: 'the configured service URL changed' },
    ]);
    expect(first.listenerCount()).toBe(0);
    expect(h.sockets).toHaveLength(2);
    expect(latestSocket(h).url).toBe(socketUrlOf(OTHER_SERVICE_URL));
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'connecting',
      heartbeatActive: false,
      configurationErrorCode: undefined,
    });
    // Only the new socket's opening deadline: an owner's move is not a retry.
    expect(h.delays.slice(timersBefore)).toEqual([DEFAULT_WS_OPEN_TIMEOUT_MS]);
    expect(lastPushed(h).serviceUrl).toBe(OTHER_SERVICE_URL);

    latestSocket(h).accept();
    await flush();
    expect(typesOf(latestSocket(h))).toEqual(['client.hello', 'session.bind']);
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('connected');

    const requestsBefore = h.fetch.mock.calls.length;
    await h.bridge.probeService();
    expect(requestOrigins(h.fetch).slice(requestsBefore)).toEqual([OTHER_SERVICE_URL]);
  });

  it('changes nothing when the address in force is set again, in any spelling of it', async () => {
    const h = createHarness();
    const socket = await connectAndOpen(h);
    const pushes = h.pushStatus.mock.calls.length;

    h.bridge.setServiceBaseUrl(DEFAULT_SERVICE_BASE_URL);
    h.bridge.setServiceBaseUrl(`  ${DEFAULT_SERVICE_BASE_URL}/  `);
    await flush();

    expect(socket.closeCalls).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.pushStatus.mock.calls).toHaveLength(pushes);
  });

  it('connects a closed bridge at the new address when a credential is stored, and stays Not paired without one', async () => {
    const paired = createHarness();
    paired.bridge.setServiceBaseUrl(OTHER_SERVICE_URL);
    await flush();
    expect(paired.sockets.map((socket) => socket.url)).toEqual([socketUrlOf(OTHER_SERVICE_URL)]);

    const unpaired = createHarness({ credentialStored: false });
    unpaired.bridge.setServiceBaseUrl(OTHER_SERVICE_URL);
    await flush();
    expect(unpaired.sockets).toHaveLength(0);
    expect(lastPushed(unpaired)).toMatchObject({
      status: 'not-paired',
      serviceUrl: OTHER_SERVICE_URL,
    });
  });

  it('turns an address the loopback policy refuses into Service not running — socket closed, HTTP refused, the value never shown — and recovers without a reload', async () => {
    const h = createHarness({ httpClientThunk: true });
    const socket = await connectAndOpen(h);
    const requestsBefore = h.fetch.mock.calls.length;
    const refusedHost = new URL(NON_LOOPBACK_SERVICE_URL).hostname;

    h.bridge.setServiceBaseUrl(NON_LOOPBACK_SERVICE_URL);
    await flush();

    expect(socket.closeCalls).toHaveLength(1);
    expect(h.bridge.getStatus()).toMatchObject({
      transport: 'closed',
      configurationErrorCode: 'CONFIG_INVALID',
      heartbeatActive: false,
    });
    const snapshot = lastPushed(h);
    expect(snapshot.status).toBe<PanelConnectionStatus>('service-not-running');
    expect(snapshot.hint?.length ?? 0).toBeGreaterThan(0);
    expect(snapshot.serviceUrl).toBeUndefined();
    expect(JSON.stringify(h.pushStatus.mock.calls)).not.toContain(refusedHost);
    expect(JSON.stringify(h.logs)).not.toContain(refusedHost);

    expect(isErr(await h.bridge.queryPanelData(SESSION_A, TRACE_QUERY, { tabId: TAB_A }))).toBe(
      true,
    );
    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });
    await advance(DEFAULT_WS_BACKOFF.maxMs * 3);
    expect(h.sockets).toHaveLength(1);
    expect(h.fetch.mock.calls).toHaveLength(requestsBefore);

    h.bridge.setServiceBaseUrl(OTHER_SERVICE_URL);
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(latestSocket(h).url).toBe(socketUrlOf(OTHER_SERVICE_URL));
    expect(h.bridge.getStatus().configurationErrorCode).toBeUndefined();
  });

  it("shows a refusal from the worker's own rule with its hint, closes the socket, and never falls back to the default", async () => {
    const h = createHarness({ httpClientThunk: true });
    const socket = await connectAndOpen(h);
    const refusal = endpointRefusal('https://127.0.0.1:20150');
    const requestsBefore = h.fetch.mock.calls.length;

    h.bridge.setServiceBaseUrl(refusal);
    await flush();

    expect(socket.closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: 'the configured service address was refused' },
    ]);
    expect(lastPushed(h)).toMatchObject({ status: 'service-not-running', hint: refusal.hint });
    expect(lastPushed(h).serviceUrl).toBeUndefined();
    expect(h.bridge.getStatus().configurationErrorCode).toBe('CONFIG_INVALID');

    // Nothing reconnects to the address that was in force before.
    await h.bridge.connect();
    await h.bridge.handleKeepaliveAlarm({ name: KEEPALIVE_ALARM_NAME });
    await advance(DEFAULT_WS_BACKOFF.maxMs * 3);
    expect(h.sockets).toHaveLength(1);
    expect(isErr(await h.bridge.probeService())).toBe(true);
    expect(h.fetch.mock.calls).toHaveLength(requestsBefore);

    // The same refusal again changes nothing; a usable address recovers.
    const pushes = h.pushStatus.mock.calls.length;
    h.bridge.setServiceBaseUrl(refusal);
    expect(h.pushStatus.mock.calls).toHaveLength(pushes);
    h.bridge.setServiceBaseUrl(DEFAULT_SERVICE_BASE_URL);
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(latestSocket(h).url).toBe(defaultSocketUrl());
  });

  it('names the pairing dialog, never a reload, when a refusal carries no hint of its own', async () => {
    const h = createHarness();
    await connectAndOpen(h);

    h.bridge.setServiceBaseUrl(
      new DebuggenError('CONFIG_INVALID', 'The configured service address was refused.'),
    );

    const hint = lastPushed(h).hint ?? '';
    expect(lastPushed(h).status).toBe<PanelConnectionStatus>('service-not-running');
    expect(hint).toContain('pairing dialog');
    expect(hint).toContain(DEFAULT_SERVICE_BASE_URL);
    expect(hint).not.toContain('reload');
  });

  it('does nothing once the bridge is disposed', async () => {
    const h = createHarness();
    await connectAndOpen(h);
    await h.bridge.close();
    const pushes = h.pushStatus.mock.calls.length;

    h.bridge.setServiceBaseUrl(OTHER_SERVICE_URL);
    await flush();

    expect(h.sockets).toHaveLength(1);
    expect(h.pushStatus.mock.calls).toHaveLength(pushes);
  });
});

/*
 * ===========================================================================
 * The service address setting (`../src/background/auth`)
 * ===========================================================================
 */

/** An in-memory `chrome.storage` area whose three methods are recording mocks. */
interface MemoryStorage {
  readonly items: Map<string, unknown>;
  readonly get: Mock<(key: string) => Promise<Record<string, unknown>>>;
  readonly set: Mock<(next: Readonly<Record<string, unknown>>) => Promise<void>>;
  readonly remove: Mock<(key: string) => Promise<void>>;
}

function createMemoryStorage(initial: Readonly<Record<string, unknown>> = {}): MemoryStorage {
  const items = new Map<string, unknown>(Object.entries(initial));
  return {
    items,
    get: vi.fn((key: string) =>
      Promise.resolve<Record<string, unknown>>(items.has(key) ? { [key]: items.get(key) } : {}),
    ),
    set: vi.fn((next: Readonly<Record<string, unknown>>) => {
      for (const [key, value] of Object.entries(next)) {
        items.set(key, value);
      }
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      items.delete(key);
      return Promise.resolve();
    }),
  };
}

describe('parseServiceEndpoint, readServiceEndpoint and writeServiceEndpoint', () => {
  it('names exactly the two hosts the manifest grants', () => {
    expect([...SERVICE_ENDPOINT_HOSTNAMES].sort()).toEqual(['127.0.0.1', 'localhost']);
  });

  it.each([
    ['http://127.0.0.1:20150', 'http://127.0.0.1:20150'],
    ['  http://localhost:20150  ', 'http://localhost:20150'],
    ['http://LOCALHOST:20150/', 'http://localhost:20150'],
    [DEFAULT_SERVICE_BASE_URL, DEFAULT_SERVICE_BASE_URL],
  ])('accepts %j as %s', (raw, canonical) => {
    expect(okValue(parseServiceEndpoint(raw))).toBe(canonical);
  });

  it.each<[unknown, string]>([
    ['https://127.0.0.1:20150', 'scheme'],
    ['http://127.0.0.2:20150', 'host-permission'],
    ['http://[::1]:20150', 'host-permission'],
    ['http://127.0.0.1:20150/api', 'path'],
    // Assembled at run time, as the protocol's own spec does, so no
    // credential-shaped literal is committed (scripts/check-secrets.mjs).
    ['http://' + ['user', 'secret-marker'].join(':') + '@127.0.0.1:20150', 'userinfo'],
    [NON_LOOPBACK_SERVICE_URL, 'not-loopback'],
    ['', 'empty'],
    ['not a service address', 'unparseable'],
    [20150, 'unparseable'],
    [undefined, 'unparseable'],
  ])('refuses %j with rule %s, naming no part of the value', (raw, rule) => {
    const refusal = endpointRefusal(raw);

    expect(refusal.code).toBe('CONFIG_INVALID');
    expect(refusal.details).toEqual({ rule });
    expect(refusal.hint?.length ?? 0).toBeGreaterThan(0);
    const rendered = JSON.stringify([refusal.message, refusal.hint, refusal.details]);
    if (typeof raw === 'string' && raw.trim() !== '') {
      expect(rendered).not.toContain(raw.trim());
    }
    expect(rendered).not.toContain('secret-marker');
  });

  it('reads no setting as ok(undefined), a stored address as itself, and an unusable one as its refusal', async () => {
    expect(okValue(await readServiceEndpoint(createMemoryStorage()))).toBeUndefined();
    expect(
      okValue(
        await readServiceEndpoint(
          createMemoryStorage({ [SERVICE_ENDPOINT_STORAGE_KEY]: OTHER_SERVICE_URL }),
        ),
      ),
    ).toBe(OTHER_SERVICE_URL);

    const refused = await readServiceEndpoint(
      createMemoryStorage({ [SERVICE_ENDPOINT_STORAGE_KEY]: 'http://[::1]:20150' }),
    );
    expect(errOf(refused).details).toEqual({ rule: 'host-permission' });
    const corrupt = await readServiceEndpoint(
      createMemoryStorage({ [SERVICE_ENDPOINT_STORAGE_KEY]: { port: 20150 } }),
    );
    expect(errOf(corrupt).code).toBe('CONFIG_INVALID');
  });

  it('reads a storage failure as STORE_ERROR, never as the default', async () => {
    const storage = createMemoryStorage();
    storage.get.mockRejectedValueOnce(new Error('extension storage is unavailable'));

    expect(errOf(await readServiceEndpoint(storage)).code).toBe('STORE_ERROR');
  });

  it('saves a valid address in canonical form, and removes the key for a blank value or the default', async () => {
    const storage = createMemoryStorage();

    expect(okValue(await writeServiceEndpoint(storage, '  http://localhost:20150/ '))).toBe(
      'http://localhost:20150',
    );
    expect(storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe('http://localhost:20150');

    expect(okValue(await writeServiceEndpoint(storage, '   '))).toBeUndefined();
    expect(storage.items.has(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(false);

    storage.items.set(SERVICE_ENDPOINT_STORAGE_KEY, OTHER_SERVICE_URL);
    expect(okValue(await writeServiceEndpoint(storage, `${DEFAULT_SERVICE_BASE_URL}/`))).toBe(
      undefined,
    );
    expect(storage.items.has(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(false);
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledTimes(2);
  });

  it('refuses an invalid address without writing anything, so a typo never replaces an address that works', async () => {
    const storage = createMemoryStorage({ [SERVICE_ENDPOINT_STORAGE_KEY]: OTHER_SERVICE_URL });

    const written = await writeServiceEndpoint(storage, 'https://127.0.0.1:20150');

    expect(errOf(written).details).toEqual({ rule: 'scheme' });
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(OTHER_SERVICE_URL);
  });

  it('reports a write storage refused as STORE_ERROR, with a hint', async () => {
    const storage = createMemoryStorage();
    storage.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));

    const failure = errOf(await writeServiceEndpoint(storage, OTHER_SERVICE_URL));

    expect(failure.code).toBe('STORE_ERROR');
    expect(failure.hint?.length ?? 0).toBeGreaterThan(0);
  });

  it('createServiceEndpointAccessor binds both helpers to one area, reading nothing until called', async () => {
    const storage = createMemoryStorage();
    const accessor = createServiceEndpointAccessor(storage);
    expect(storage.get).not.toHaveBeenCalled();

    expect(okValue(await accessor.write(OTHER_SERVICE_URL))).toBe(OTHER_SERVICE_URL);
    expect(okValue(await accessor.read())).toBe(OTHER_SERVICE_URL);
  });
});

/*
 * ===========================================================================
 * `../src/background/service-worker.ts` — the composition that puts the
 * setting in force on both paths
 * ===========================================================================
 */

/** A Chrome event fake: records its listeners, and fires them on demand. */
interface FakeEvent<Args extends unknown[]> {
  addListener(listener: (...args: Args) => void): void;
  removeListener(listener: (...args: Args) => void): void;
  fire(...args: Args): void;
}

function createFakeEvent<Args extends unknown[]>(): FakeEvent<Args> {
  const listeners = new Set<(...args: Args) => void>();
  return {
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

/** The runtime id the worker's port hub validates panel senders against. */
const TEST_EXTENSION_ID = 'debuggen-test-extension';

/** The credential `POST /pair/complete` issues in these cases. Obviously fake. */
const PAIRED_TOKEN = 'test-paired-devtools-token';

/**
 * The read proof `POST /pair/complete` issues with {@link PAIRED_TOKEN}: the
 * service answers both together, and a reply without it is not a pairing.
 */
const PAIRED_READ_PROOF = 'p'.repeat(READ_PROOF_LENGTH);

/** A well-sized, obviously synthetic pairing code. */
const PAIRING_CODE = 'TESTCODE';

/** A panel's runtime port as the worker's hub sees it, and what it was sent. */
interface FakePanelPort {
  readonly port: chrome.runtime.Port;
  readonly posted: readonly unknown[];
  send(message: unknown): void;
  /** The document went away: fires the port's `onDisconnect`. */
  detach(): void;
}

/**
 * A panel port: named `PORT_PANEL`, sent from this extension (no tab, no URL —
 * a DevTools panel document), recording every frame the worker posts to it.
 * The hub uses only `name`, `sender`, the two events' add/remove and
 * `postMessage`/`disconnect`, so the fake carries exactly those; the cast
 * stands in for the dozen `chrome.events.Event` members nothing here calls.
 */
function createPanelPort(name: string = PORT_PANEL): FakePanelPort {
  const onMessage = createFakeEvent<[message: unknown]>();
  const onDisconnect = createFakeEvent<[]>();
  const posted: unknown[] = [];
  const port = {
    name,
    sender: { id: TEST_EXTENSION_ID },
    onMessage,
    onDisconnect,
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    disconnect: () => undefined,
  };
  return {
    port: port as unknown as chrome.runtime.Port,
    posted,
    send: (message) => {
      onMessage.fire(message);
    },
    detach: () => {
      onDisconnect.fire();
    },
  };
}

/** A `devtools.hello` frame announcing the inspected tab, as the devtools page sends it. */
function devtoolsHello(tabId: TabId): unknown {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'devtools.hello',
    payload: { tabId },
  };
}

/** The relayed protocol frames a panel was pushed, in order. */
function protocolPushes(panel: FakePanelPort): ProtocolMessage[] {
  const messages: ProtocolMessage[] = [];
  for (const frame of panel.posted) {
    if (isFrameRecord(frame) && frame.direction === 'push' && frame.kind === 'protocol') {
      const message: unknown = frame.message;
      if (isRelayedMessage(message)) {
        messages.push(message);
      }
    }
  }
  return messages;
}

/** Whether a posted frame is a plain record. */
function isFrameRecord(frame: unknown): frame is Readonly<Record<string, unknown>> {
  return typeof frame === 'object' && frame !== null && !Array.isArray(frame);
}

/** The frame the worker answered one panel request with, or a failure saying none arrived. */
function responseTo(panel: FakePanelPort, requestId: string): Readonly<Record<string, unknown>> {
  const response = panel.posted.find(
    (frame) => isFrameRecord(frame) && frame.requestId === requestId,
  );
  if (!isFrameRecord(response)) {
    throw new Error('the worker posted no response to the request');
  }
  return response;
}

/** A `pair.complete` port request, framed exactly as the panel connection frames it. */
function pairCompleteRequest(requestId: string): unknown {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'request',
    requestId,
    kind: 'pair.complete',
    payload: { code: PAIRING_CODE },
  };
}

/** A `session.snapshot` port request, framed as the panel connection frames its handshake. */
function snapshotRequest(requestId: string, sessionId?: SessionId): unknown {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'request',
    requestId,
    kind: 'session.snapshot',
    payload: sessionId === undefined ? {} : { sessionId },
  };
}

/** How many `fetch` calls went to `path`. */
function callsTo(fetch: Mock<FetchLike>, path: string): number {
  return fetch.mock.calls.filter(([url]) => new URL(url).pathname === path).length;
}

interface WorkerHarnessOptions {
  /** The stored service address setting; none by default. */
  readonly stored?: unknown;
  /** The environment's `serviceBaseUrl`; none by default. */
  readonly serviceBaseUrl?: string;
  /** Whether a devtools credential is stored. Defaults to `true`. */
  readonly credentialStored?: boolean;
  /** The tab bindings `chrome.storage.session` holds at start-up; none by default. */
  readonly bindings?: readonly TabBindingRecord[];
  /**
   * Stands in for `chrome.storage.local.get` of the service address key only —
   * a read that fails or has not settled yet; every other key, the credential
   * included, is read from the memory storage as usual.
   */
  readonly readEndpoint?: () => Promise<Record<string, unknown>>;
}

interface WorkerHarness {
  readonly worker: DebugGeneratorWorker;
  readonly sockets: readonly FakeSocket[];
  /** `chrome.storage.local`. */
  readonly local: MemoryStorage;
  /** `chrome.storage.local.onChanged`. */
  readonly localChanges: FakeEvent<Parameters<CredentialStorageChangeListener>>;
  /** The platform `fetch` the worker's `HttpClient` resolves at call time. */
  readonly fetch: Mock<FetchLike>;
  readonly routes: Map<string, RouteHandler>;
  readonly logs: readonly LogEntry[];
  /** Open a panel port, as a DevTools panel does. */
  connectPanel(): FakePanelPort;
  /** Open a devtools-page port, as a DevTools window's devtools page does. */
  connectDevtools(): FakePanelPort;
}

/**
 * Compose the real worker over fakes of every Chrome surface it is given. The
 * platform `fetch` is replaced by a routed mock for the case (the worker builds
 * its `HttpClient` without an injected `fetch`, as in the extension).
 */
function createWorkerHarness(options: WorkerHarnessOptions = {}): WorkerHarness {
  const local = createMemoryStorage({
    ...(options.credentialStored === false
      ? {}
      : { [DEVTOOLS_TOKEN_STORAGE_KEY]: { version: STORED_CREDENTIAL_VERSION, token: TOKEN } }),
    ...(options.stored === undefined ? {} : { [SERVICE_ENDPOINT_STORAGE_KEY]: options.stored }),
  });
  const localChanges = createFakeEvent<Parameters<CredentialStorageChangeListener>>();
  const onConnect = createFakeEvent<[port: chrome.runtime.Port]>();
  const { ctor, sockets } = createSocketFactory();
  const logs: LogEntry[] = [];
  const readEndpoint = options.readEndpoint;
  const localGet = (key: string): Promise<Record<string, unknown>> =>
    readEndpoint !== undefined && key === SERVICE_ENDPOINT_STORAGE_KEY
      ? readEndpoint()
      : local.get(key);

  const routes = new Map<string, RouteHandler>([
    [healthPath(), () => Promise.resolve(jsonResponse(200, HEALTH_BODY))],
    [
      pairCompletePath(),
      () =>
        Promise.resolve(jsonResponse(200, { token: PAIRED_TOKEN, readProof: PAIRED_READ_PROOF })),
    ],
  ]);
  const fetch = vi.fn<FetchLike>((url, init) => {
    const route = routes.get(new URL(url).pathname);
    return route === undefined
      ? Promise.reject(new TypeError('the test fetch has no route for this request'))
      : route(init);
  });
  vi.stubGlobal('fetch', fetch);

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

  const worker = createWorker({
    runtime: {
      id: TEST_EXTENSION_ID,
      onConnect,
      onInstalled: createFakeEvent(),
      onStartup: createFakeEvent(),
    },
    tabs: {
      get: () => Promise.resolve({}),
      reload: () => Promise.resolve(),
      onUpdated: createFakeEvent(),
      onRemoved: createFakeEvent(),
    },
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(true),
      onAlarm: createFakeEvent(),
    },
    storage: {
      local: { get: localGet, set: local.set, remove: local.remove, onChanged: localChanges },
      session: createMemoryStorage(
        options.bindings === undefined
          ? {}
          : {
              [BINDING_STORAGE_KEY]: Object.fromEntries(
                options.bindings.map((record) => [String(record.tabId), record]),
              ),
            },
      ),
    },
    webSocketConstructor: ctor,
    timers,
    random: () => 1,
    logger: createRecordingLogger(logs),
    ...(options.serviceBaseUrl === undefined ? {} : { serviceBaseUrl: options.serviceBaseUrl }),
  });

  return {
    worker,
    sockets,
    local,
    localChanges,
    fetch,
    routes,
    logs,
    connectPanel: () => {
      const panel = createPanelPort();
      onConnect.fire(panel.port);
      return panel;
    },
    connectDevtools: () => {
      const devtools = createPanelPort(PORT_DEVTOOLS);
      onConnect.fire(devtools.port);
      return devtools;
    },
  };
}

describe('the service worker puts the configured address in force on both paths', () => {
  const workers: DebugGeneratorWorker[] = [];

  /** Build a worker harness that is disposed after the case. */
  function workerHarness(options?: WorkerHarnessOptions): WorkerHarness {
    const h = createWorkerHarness(options);
    workers.push(h.worker);
    return h;
  }

  afterEach(() => {
    for (const worker of workers.splice(0)) {
      worker.dispose();
    }
  });

  it("uses a stored address for the socket and every HTTP call, ahead of the environment's", async () => {
    const h = workerHarness({ stored: OTHER_SERVICE_URL, serviceBaseUrl: ENV_SERVICE_URL });

    await h.worker.ready;
    await h.worker.wsBridge.probeService();

    expect(h.sockets.map((socket) => socket.url)).toEqual([socketUrlOf(OTHER_SERVICE_URL)]);
    expect(h.worker.httpClient.baseUrl).toBe(OTHER_SERVICE_URL);
    expect(requestOrigins(h.fetch)).toEqual([OTHER_SERVICE_URL]);
    expect(h.worker.wsBridge.snapshot().serviceUrl).toBe(OTHER_SERVICE_URL);
  });

  it("uses the environment's address when none is stored, and DEFAULT_SERVICE_BASE_URL when neither is set", async () => {
    const withEnvironment = workerHarness({ serviceBaseUrl: ENV_SERVICE_URL });
    const bare = workerHarness();

    await Promise.all([withEnvironment.worker.ready, bare.worker.ready]);

    expect(withEnvironment.sockets.map((socket) => socket.url)).toEqual([
      socketUrlOf(ENV_SERVICE_URL),
    ]);
    expect(withEnvironment.worker.httpClient.baseUrl).toBe(ENV_SERVICE_URL);
    expect(bare.sockets.map((socket) => socket.url)).toEqual([defaultSocketUrl()]);
    expect(bare.worker.httpClient.baseUrl).toBe(DEFAULT_SERVICE_BASE_URL);
  });

  it('follows a change of the stored address at once — a new socket at the new port and a rebuilt HTTP client — and returns to the default when it is removed', async () => {
    const h = workerHarness();
    await h.worker.ready;
    const first = h.sockets[0];
    first?.accept();
    await flush();
    const clientBefore = h.worker.httpClient;

    // A change to another key moves nothing.
    h.localChanges.fire({ 'another.key': { newValue: 'unrelated' } });
    await flush();
    expect(h.sockets).toHaveLength(1);

    h.local.items.set(SERVICE_ENDPOINT_STORAGE_KEY, OTHER_SERVICE_URL);
    h.localChanges.fire({ [SERVICE_ENDPOINT_STORAGE_KEY]: { newValue: OTHER_SERVICE_URL } });
    await flush();

    expect(first?.closeCalls).toHaveLength(1);
    expect(h.sockets.at(-1)?.url).toBe(socketUrlOf(OTHER_SERVICE_URL));
    expect(h.worker.httpClient).not.toBe(clientBefore);
    expect(h.worker.httpClient.baseUrl).toBe(OTHER_SERVICE_URL);
    await h.worker.wsBridge.probeService();
    expect(requestOrigins(h.fetch).at(-1)).toBe(OTHER_SERVICE_URL);

    h.local.items.delete(SERVICE_ENDPOINT_STORAGE_KEY);
    h.localChanges.fire({ [SERVICE_ENDPOINT_STORAGE_KEY]: { oldValue: OTHER_SERVICE_URL } });
    await flush();

    expect(h.sockets.at(-1)?.url).toBe(defaultSocketUrl());
    expect(h.worker.httpClient.baseUrl).toBe(DEFAULT_SERVICE_BASE_URL);
  });

  it('shows an unusable stored address as Service not running with its hint — no socket, no request, no fallback to the default — until a usable one is stored', async () => {
    const stored = 'https://127.0.0.1:20150';
    const h = workerHarness({ stored });

    await h.worker.ready;

    expect(h.sockets).toHaveLength(0);
    const snapshot = h.worker.wsBridge.snapshot();
    expect(snapshot.status).toBe<PanelConnectionStatus>('service-not-running');
    expect(snapshot.hint).toBe(endpointRefusal(stored).hint);
    expect(snapshot.serviceUrl).toBeUndefined();
    expect(isErr(await h.worker.wsBridge.getSession(SESSION_A, { tabId: TAB_A }))).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logs)).not.toContain(stored);

    h.local.items.set(SERVICE_ENDPOINT_STORAGE_KEY, OTHER_SERVICE_URL);
    h.localChanges.fire({
      [SERVICE_ENDPOINT_STORAGE_KEY]: { oldValue: stored, newValue: OTHER_SERVICE_URL },
    });
    await flush();

    expect(h.sockets.map((socket) => socket.url)).toEqual([socketUrlOf(OTHER_SERVICE_URL)]);
    expect(h.worker.wsBridge.snapshot().hint).toBeUndefined();
  });

  it('bounds every HTTP call that names no deadline, so it fails with a typed, retryable timeout before the panel port gives up', async () => {
    const h = workerHarness();
    await h.worker.ready;
    h.routes.set(sessionPath(SESSION_A), () => new Promise<HttpResponseLike>(() => {}));
    const deadline = PORT_REQUEST_TIMEOUT_MS - 5_000;

    const pending = h.worker.wsBridge.getSession(SESSION_A, { tabId: TAB_A });
    const settled = vi.fn();
    void pending.then(settled);
    await advance(deadline - 1);
    expect(settled).not.toHaveBeenCalled();
    await advance(1);

    expect(settled).toHaveBeenCalledTimes(1);
    const failure = errOf(await pending);
    expect(failure.code).toBe('TRANSPORT_DISCONNECTED');
    expect(failure.details).toMatchObject({ cancelled: 'timeout', timeoutMs: deadline });
    expect(failure.hint?.length ?? 0).toBeGreaterThan(0);
    expect(deadline).toBeLessThan(PORT_REQUEST_TIMEOUT_MS);
  });

  it('redeems a pairing code at the address the dialog saved just before, without waiting for the storage change event', async () => {
    const h = workerHarness({ credentialStored: false });
    await h.worker.ready;
    expect(h.sockets).toHaveLength(0);
    // The dialog's write has landed; its change event has not been delivered.
    h.local.items.set(SERVICE_ENDPOINT_STORAGE_KEY, OTHER_SERVICE_URL);
    const panel = h.connectPanel();
    const requestId = newPortRequestId();

    panel.send(pairCompleteRequest(requestId));
    await flush();

    const redemptions = h.fetch.mock.calls.filter(
      ([url]) => new URL(url).pathname === pairCompletePath(),
    );
    expect(redemptions.map(([url]) => new URL(url).origin)).toEqual([OTHER_SERVICE_URL]);
    expect(responseTo(panel, requestId)).toMatchObject({
      direction: 'response',
      ok: true,
      payload: { paired: true },
    });
    expect(h.worker.httpClient.baseUrl).toBe(OTHER_SERVICE_URL);
    expect(h.sockets.map((socket) => socket.url)).toEqual([socketUrlOf(OTHER_SERVICE_URL)]);
  });

  it('refuses to redeem a code at an unusable saved address, and answers the panel with why', async () => {
    const h = workerHarness({ credentialStored: false });
    await h.worker.ready;
    h.local.items.set(SERVICE_ENDPOINT_STORAGE_KEY, 'http://[::1]:20150');
    const panel = h.connectPanel();
    const requestId = newPortRequestId();

    panel.send(pairCompleteRequest(requestId));
    await flush();

    expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === pairCompletePath())).toBe(
      false,
    );
    expect(responseTo(panel, requestId)).toMatchObject({
      direction: 'response',
      ok: false,
      error: { code: 'CONFIG_INVALID' },
    });
    expect(h.sockets).toHaveLength(0);
  });
});

describe('the service address is established before anything is sent: the worker fails closed', () => {
  const workers: DebugGeneratorWorker[] = [];
  const unreadable = (): Promise<Record<string, unknown>> =>
    Promise.reject(new Error('extension storage is unavailable'));

  /** Build a worker harness that is disposed after the case. */
  function workerHarness(options?: WorkerHarnessOptions): WorkerHarness {
    const h = createWorkerHarness(options);
    workers.push(h.worker);
    return h;
  }

  afterEach(() => {
    for (const worker of workers.splice(0)) {
      worker.dispose();
    }
  });

  it('holds the socket and every HTTP call until the first read of the stored address settles, then sends them to the address it found', async () => {
    const reads: ((value: Record<string, unknown>) => void)[] = [];
    const h = workerHarness({
      readEndpoint: () =>
        new Promise<Record<string, unknown>>((resolve) => {
          reads.push(resolve);
        }),
    });

    const pending = h.worker.wsBridge.getSession(SESSION_A, { tabId: TAB_A });
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.sockets).toHaveLength(0);

    expect(reads).toHaveLength(1);
    reads[0]?.({ [SERVICE_ENDPOINT_STORAGE_KEY]: OTHER_SERVICE_URL });
    await h.worker.ready;
    await pending;

    expect(requestOrigins(h.fetch)).toEqual([OTHER_SERVICE_URL]);
    expect(h.sockets.map((socket) => socket.url)).toEqual([socketUrlOf(OTHER_SERVICE_URL)]);
  });

  it('sends nothing — no socket, no request carrying the credential — when the stored address cannot be read, although the credential can', async () => {
    const h = workerHarness({ readEndpoint: unreadable });

    await h.worker.ready;
    await h.worker.wsBridge.connect();
    const session = await h.worker.wsBridge.getSession(SESSION_A, { tabId: TAB_A });
    await h.worker.wsBridge.probeService();
    await flush();

    expect(h.worker.wsBridge.snapshot().hasCredential).toBe(true);
    expect(h.sockets).toHaveLength(0);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(errOf(session).code).toBe('STORE_ERROR');
    const snapshot = h.worker.wsBridge.snapshot();
    expect(snapshot.status).toBe<PanelConnectionStatus>('service-not-running');
    expect(snapshot.hint?.length ?? 0).toBeGreaterThan(0);
    expect(snapshot.serviceUrl).toBeUndefined();
  });

  it('redeems no pairing code while the stored address cannot be read, and answers the panel with why', async () => {
    const h = workerHarness({ credentialStored: false, readEndpoint: unreadable });
    await h.worker.ready;
    const panel = h.connectPanel();
    const requestId = newPortRequestId();

    panel.send(pairCompleteRequest(requestId));
    await flush();

    expect(h.fetch).not.toHaveBeenCalled();
    expect(responseTo(panel, requestId)).toMatchObject({
      direction: 'response',
      ok: false,
      error: { code: 'STORE_ERROR' },
    });
    expect(h.sockets).toHaveLength(0);
  });

  it('reads the address again when a panel opens, and connects at the address that read finds', async () => {
    const readEndpoint = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error('extension storage is unavailable'))
      .mockResolvedValue({ [SERVICE_ENDPOINT_STORAGE_KEY]: OTHER_SERVICE_URL });
    const h = workerHarness({ readEndpoint });
    await h.worker.ready;
    expect(h.sockets).toHaveLength(0);
    const panel = h.connectPanel();

    panel.send(snapshotRequest(newPortRequestId()));
    await flush();

    expect(readEndpoint).toHaveBeenCalledTimes(2);
    expect(h.sockets.map((socket) => socket.url)).toEqual([socketUrlOf(OTHER_SERVICE_URL)]);
    expect(h.worker.httpClient.baseUrl).toBe(OTHER_SERVICE_URL);
    expect(h.worker.wsBridge.snapshot().hint).toBeUndefined();
  });

  it('keeps the address an earlier read established when a later read fails, and redeems the code there', async () => {
    const readEndpoint = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValueOnce({ [SERVICE_ENDPOINT_STORAGE_KEY]: OTHER_SERVICE_URL })
      .mockRejectedValue(new Error('extension storage is unavailable'));
    const h = workerHarness({ credentialStored: false, readEndpoint });
    await h.worker.ready;
    const panel = h.connectPanel();
    const requestId = newPortRequestId();

    panel.send(pairCompleteRequest(requestId));
    await flush();

    expect(readEndpoint).toHaveBeenCalledTimes(2);
    const redemptions = h.fetch.mock.calls.filter(
      ([url]) => new URL(url).pathname === pairCompletePath(),
    );
    expect(redemptions.map(([url]) => new URL(url).origin)).toEqual([OTHER_SERVICE_URL]);
    expect(responseTo(panel, requestId)).toMatchObject({ ok: true, payload: { paired: true } });
    expect(h.sockets.map((socket) => socket.url)).toEqual([socketUrlOf(OTHER_SERVICE_URL)]);
  });
});

describe('background hydration of an adopted panel: surfaced when it fails, cancelled when its panel detaches', () => {
  const workers: DebugGeneratorWorker[] = [];

  /** Build a worker harness holding BINDING_A, disposed after the case. */
  function boundWorker(): WorkerHarness {
    const h = createWorkerHarness({ bindings: [BINDING_A] });
    workers.push(h.worker);
    return h;
  }

  /**
   * A waiting panel — one that asked for its snapshot without naming a tab
   * while no DevTools page awaited a panel, so it is left unassociated — then
   * its DevTools page announcing TAB_A: the order a worker revival produces,
   * and the one-to-one match that adopts the panel and starts a background
   * hydration. A panel that has not asked is never adopted.
   */
  async function waitingPanel(h: WorkerHarness): Promise<FakePanelPort> {
    const panel = h.connectPanel();
    panel.send(snapshotRequest(newPortRequestId()));
    await flush();
    return panel;
  }

  /** {@link waitingPanel}, adopted by its DevTools page's announcement of TAB_A. */
  async function adoptPanel(h: WorkerHarness): Promise<FakePanelPort> {
    const panel = await waitingPanel(h);
    const devtools = h.connectDevtools();
    devtools.send(devtoolsHello(TAB_A));
    await flush();
    return panel;
  }

  afterEach(() => {
    for (const worker of workers.splice(0)) {
      worker.dispose();
    }
  });

  it('pushes the failed read to the adopted panel as a protocol error frame for the bound session', async () => {
    const h = boundWorker();
    await h.worker.ready;
    // Neither session read has a route: the transport refuses both.

    const panel = await adoptPanel(h);

    const errors = protocolPushes(panel).filter((message) => message.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.sessionId).toBe(SESSION_A);
    expect(errors[0]?.payload).toMatchObject({ code: 'TRANSPORT_DISCONNECTED' });
    expect(protocolPushes(panel).some((message) => message.type === 'session.updated')).toBe(false);
  });

  it('bounds a stalled hydration by the default deadline and then surfaces its timeout', async () => {
    const h = boundWorker();
    await h.worker.ready;
    const stalled: RouteHandler = () => new Promise<HttpResponseLike>(() => {});
    h.routes.set(sessionPath(SESSION_A), stalled);
    h.routes.set(panelPath(SESSION_A), stalled);

    const panel = await adoptPanel(h);
    expect(protocolPushes(panel).filter((message) => message.type === 'error')).toEqual([]);

    await advance(PORT_REQUEST_TIMEOUT_MS - 5_000);

    const errors = protocolPushes(panel).filter((message) => message.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toMatchObject({ code: 'TRANSPORT_DISCONNECTED' });
  });

  it('aborts the reads of a hydration whose last panel detached, and surfaces nothing afterwards', async () => {
    const h = boundWorker();
    await h.worker.ready;
    const signals: AbortSignal[] = [];
    const stalled: RouteHandler = (init) => {
      const signal = init?.signal;
      if (signal !== undefined && signal !== null) {
        signals.push(signal);
      }
      return new Promise<HttpResponseLike>(() => {});
    };
    h.routes.set(sessionPath(SESSION_A), stalled);
    h.routes.set(panelPath(SESSION_A), stalled);

    const panel = await adoptPanel(h);
    expect(signals).toHaveLength(2);
    expect(signals.some((signal) => signal.aborted)).toBe(false);

    panel.detach();
    await flush();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await advance(PORT_REQUEST_TIMEOUT_MS);
    expect(protocolPushes(panel).filter((message) => message.type === 'error')).toEqual([]);
  });

  it('starts no reads for a panel that detached while its binding was still being read', async () => {
    const h = boundWorker();
    await h.worker.ready;
    const panel = await waitingPanel(h);
    // Only its unbound snapshot answer so far.
    const answered = panel.posted.length;
    const devtools = h.connectDevtools();

    // The announcement adopts the waiting panel and starts its hydration,
    // which is still awaiting the binding when the panel goes.
    devtools.send(devtoolsHello(TAB_A));
    panel.detach();
    await flush();

    expect(
      h.logs.some(
        (entry) => entry.message === 'Waiting panel associated with the announced DevTools page.',
      ),
    ).toBe(true);
    expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(0);
    expect(callsTo(h.fetch, panelPath(SESSION_A))).toBe(0);
    expect(panel.posted).toHaveLength(answered);
  });

  it('tries a transiently failed hydration again on its bounded schedule, and then stops', async () => {
    const h = boundWorker();
    await h.worker.ready;
    // Neither session read has a route: every attempt fails with a transport error.

    const panel = await adoptPanel(h);
    const errorPushes = (): number =>
      protocolPushes(panel).filter((message) => message.type === 'error').length;
    expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(1);
    expect(errorPushes()).toBe(1);

    for (const [index, delayMs] of HYDRATION_RETRY_DELAYS_MS.entries()) {
      await advance(delayMs - 1);
      expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(index + 1);
      await advance(1);
      expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(index + 2);
      expect(errorPushes()).toBe(index + 2);
    }

    await advance(10 * 60_000);
    expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(HYDRATION_RETRY_DELAYS_MS.length + 1);
  });

  it('cancels the pending retry when the last panel detaches', async () => {
    const h = boundWorker();
    await h.worker.ready;
    const panel = await adoptPanel(h);
    expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(1);

    panel.detach();
    await flush();
    await advance(10 * 60_000);

    expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(1);
  });

  it('answers a bound panel’s snapshot with the failed read — a retryable error, not an empty session — after pushing its binding, and tries the reads again', async () => {
    const h = boundWorker();
    await h.worker.ready;
    const devtools = h.connectDevtools();
    devtools.send(devtoolsHello(TAB_A));
    await flush();
    const panel = h.connectPanel();
    const requestId = newPortRequestId();

    panel.send(snapshotRequest(requestId, SESSION_A));
    await flush();

    const response = responseTo(panel, requestId);
    expect(response).toMatchObject({
      direction: 'response',
      ok: false,
      error: { code: 'TRANSPORT_DISCONNECTED' },
    });
    const bindingIndex = panel.posted.findIndex(
      (frame) =>
        isFrameRecord(frame) &&
        frame.kind === 'binding' &&
        isFrameRecord(frame.state) &&
        frame.state.kind === 'bound',
    );
    expect(bindingIndex).toBeGreaterThanOrEqual(0);
    expect(bindingIndex).toBeLessThan(panel.posted.indexOf(response));
    expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(1);

    await advance(HYDRATION_RETRY_DELAYS_MS[0] ?? 0);

    expect(callsTo(h.fetch, sessionPath(SESSION_A))).toBe(2);
    expect(protocolPushes(panel).filter((message) => message.type === 'error')).toHaveLength(1);
  });
});
