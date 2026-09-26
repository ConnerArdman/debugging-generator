/**
 * Tests for the WebSocket half of the transport SDK — `../client/ws-client.ts`
 * — in the directory `packages/protocol/tsconfig.json` names for this
 * package's suites (AAP 0.8.3).
 *
 * `ReconnectingWsClient` is the one socket the VS Code extension host, the
 * Chrome MV3 service worker and the service's own tooling hold to the local
 * service, so every rule it encodes is a rule three processes inherit at once.
 * Nothing here opens a real socket or waits on a clock: the WebSocket
 * constructor and the timer pair are the client's own injected seams
 * (`WebSocketConstructorLike`, `TimerApi`), and the fakes below record every
 * frame, listener, close call and timer so that each rule is an equality
 * assertion rather than a race.
 *
 * - **The hello frame is first, on every connection.** AAP 0.5.6 makes the
 *   `client.hello` frame the credential's only carrier and the service closes
 *   a connection that sends anything else first, so the cases prove it precedes
 *   every queued frame — including one sent from the consumer's own
 *   `onStateChange('open')` hook — on the first connection and on each
 *   reconnect, with a fresh frame id each time.
 * - **A refused or missing credential is terminal.** `WS_CLOSE_UNAUTHORIZED`
 *   and every local refusal (no credential, a provider that threw, rejected or
 *   stalled past `CLIENT_HELLO_TIMEOUT_MS`) leave the client `closed` with no
 *   reconnect scheduled, because retrying a refused credential is a loop and,
 *   against the pairing rate limit, a lockout.
 * - **The credential deadline dies with its attempt.** A pending asynchronous
 *   credential read keeps a deadline timer; `close()`, the socket's own close
 *   event, a replacement socket and a refusal must each clear it and make the
 *   provider's late answer a no-op, so no timer outlives the attempt it was
 *   started for and no hello is written to a dead connection.
 * - **"Connecting" is bounded.** Every socket carries an opening deadline
 *   (`DEFAULT_WS_OPEN_TIMEOUT_MS` unless configured) from construction to its
 *   `open` event. A socket that stalls past it is closed and retried on the
 *   backoff curve; `open`, `close()`, the socket's own close event and a
 *   replacement each clear it. Cases that count pending timers while a socket
 *   is still opening therefore see that deadline, and say so.
 * - **The backoff curve is the documented one.** 500 → 10 000 ms with equal
 *   jitter (AAP 0.5.5), sanitised overrides, a counter that resets after a
 *   successful hello, and exactly one reconnect per failure however the
 *   transport reports it.
 * - **The queue is bounded and ordered.** FIFO, oldest dropped first, the drop
 *   reported by type and depth, `0` meaning "never queue".
 * - **Only loopback receives a credential.** The hello frame carries the bearer
 *   credential and the project root, so a configured URL naming any other host
 *   — or carrying userinfo, a stray path, a query or a fragment — must leave the
 *   client unable to construct a socket at all, without the credential provider
 *   ever being asked (CWE-200, CWE-918).
 * - **Nothing leaks (AAP 0.5.2).** The credential, a refused URL and a
 *   malformed inbound frame never appear in a log record, an error's message,
 *   hint, details or cause, a state detail or an unauthorized detail: each leak
 *   case plants a unique marker and asserts its absence from everything the
 *   client reported.
 *
 * Two literals are deliberately never written here: the refusal close code and
 * the hello deadline are `WS_CLOSE_UNAUTHORIZED` and `CLIENT_HELLO_TIMEOUT_MS`,
 * imported from the module that owns them, so this suite cannot pin a second
 * definition of either (AAP 0.9.1). Every URL carrying userinfo is assembled at
 * run time from fragments, and every credential is a short, obviously fake
 * value, because `scripts/check-secrets.mjs` scans this file like any other.
 */

import { describe, expect, it, vi } from 'vitest';

import { createConsoleLogger, isErr } from '@debuggen/shared';
import type { DebuggenError, LogRecord } from '@debuggen/shared';

import {
  CONNECTION_STATES,
  DEFAULT_MAX_QUEUED_MESSAGES,
  DEFAULT_WS_BACKOFF,
  DEFAULT_WS_OPEN_TIMEOUT_MS,
  ReconnectingWsClient,
  resolveWsUrl,
} from '../client/ws-client.js';
import type {
  ConnectionState,
  ReconnectingWsClientOptions,
  TimerApi,
  WebSocketConstructorLike,
  WebSocketLike,
  WsBackoffOptions,
  WsClientIdentity,
  WsEventMapLike,
  WsQueueDropDetail,
  WsStateChangeDetail,
  WsUnauthorizedDetail,
} from '../client/ws-client.js';
import { createEnvelope, decodeMessage, encodeMessage, isMessageOfType } from '../envelope.js';
import type { ProtocolMessage } from '../envelope.js';
import { WS_PATH } from '../http.js';
import {
  CLIENT_HELLO_TIMEOUT_MS,
  WS_CLOSE_UNAUTHORIZED,
  clientHelloPayloadSchema,
} from '../messages/index.js';
import type { ClientHelloPayload } from '../messages/index.js';
import { PROTOCOL_VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// Deterministic throughout: every id, credential and URL is a literal, the
// jitter source is injected, and no case reads a clock.
// ---------------------------------------------------------------------------

/** The service base URL every accepted-configuration case starts from. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/** The canonical socket URL {@link SERVICE_URL} resolves to. */
const SOCKET_URL = `ws://127.0.0.1:43117${WS_PATH}`;

/**
 * An obviously fake devtools credential: short and low-entropy, so no provider
 * pattern and no entropy rule of `scripts/check-secrets.mjs` can mistake it for
 * a real one.
 */
const TOKEN = 'tok-devtools-1';

/** The credential a rotation hands out next. */
const ROTATED_TOKEN = 'tok-devtools-2';

/** The inspected Chrome tab. Never `-1`, which is `chrome.tabs.TAB_ID_NONE`. */
const TAB_ID = 7;

/** The editor's workspace folder: absolute and POSIX. */
const PROJECT_ROOT = '/home/example/workspace/site';

/** The session the inbound progress frames report on. */
const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

/** A DevTools connection's identity: a tab, no project root. */
const DEVTOOLS_IDENTITY: WsClientIdentity = { client: 'devtools', tabId: TAB_ID };

/** An editor connection's identity: a project root, no tab. */
const EDITOR_IDENTITY: WsClientIdentity = { client: 'vscode', projectRoot: PROJECT_ROOT };

/** The WebSocket protocol's "normal closure", which the client closes with. */
const NORMAL_CLOSURE = 1000;

/** The WebSocket protocol's "abnormal closure": a drop with no close frame. */
const ABNORMAL_CLOSURE = 1006;

/** The four `readyState` values the WebSocket API fixes. */
const READY_STATE = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 });

/**
 * The nominal reconnect curve AAP 0.5.5 prescribes, spelled out so that a
 * change to `DEFAULT_WS_BACKOFF` fails here rather than quietly redefining it.
 */
const NOMINAL_CURVE = [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000];

// The user-facing sentences the client reports. Pinned literally because both
// user interfaces render them, so a change to one is a change to the product.

/** Reported when no credential could be resolved at all. */
const NO_CREDENTIAL_REASON = 'no credential is available for this client';

/** Reported when an asynchronous provider outlived the hello deadline. */
const CREDENTIAL_TIMEOUT_REASON = 'the credential provider did not answer in time';

/** Reported for a `WS_CLOSE_UNAUTHORIZED` close that carried no reason. */
const REFUSED_CREDENTIAL_REASON = 'the service refused this credential';

/** Reported for a socket constructor that threw. */
const SOCKET_OPEN_FAILED_REASON = 'the socket could not be opened';

/** Reported for a socket that died before its hello frame was written. */
const HELLO_WRITE_FAILED_REASON = 'the connection closed before the handshake was sent';

/** Reported for an identity the hello schema refuses. */
const INVALID_HELLO_REASON = 'this client could not assemble a valid handshake';

/** Reported when `connect()` meets a refused service URL. */
const CONFIGURATION_REFUSED_REASON =
  'the configured service URL is not a loopback address of the local service';

/** Reported for a socket that did not reach `open` within its opening deadline. */
const OPEN_TIMEOUT_REASON = 'the socket did not open in time';

/** The failure message reported with it. */
const OPEN_TIMEOUT_MESSAGE = 'The connection to the local service did not open in time';

/** The close reason of a socket retired because the configured URL changed. */
const ENDPOINT_CHANGED_REASON = 'the configured service URL changed';

/** A second service instance's base URL: another loopback port. */
const OTHER_SERVICE_URL = 'http://127.0.0.1:20150';

/** The canonical socket URL {@link OTHER_SERVICE_URL} resolves to. */
const OTHER_SOCKET_URL = `ws://127.0.0.1:20150${WS_PATH}`;

/** The reason an owner restarts a socket its liveness probe found dead. */
const RESTART_REASON = 'the local service stopped answering';

// ---------------------------------------------------------------------------
// The fake transport
// ---------------------------------------------------------------------------

/**
 * One listener set per event, keyed exactly as {@link WsEventMapLike} is, so a
 * listener's parameter type follows from the event name without a cast.
 */
type ListenerSets = {
  [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void>;
};

/** One `close()` call the client made on a socket. */
interface CloseCall {
  /** The close code passed, if any. */
  readonly code: number | undefined;
  /** The close reason passed, if any. */
  readonly reason: string | undefined;
}

/**
 * A socket that records everything the client does to it and lets a case fire
 * every event the client listens for.
 *
 * `send` refuses a frame unless the socket is open — as both real
 * implementations do — and can be told to throw on demand, as can `close` and
 * `removeEventListener`, so the client's failure paths are reachable.
 */
class FakeWebSocket implements WebSocketLike {
  /** The socket's state; {@link FakeWebSocket.open} makes it writable. */
  readyState: number = READY_STATE.connecting;

  /** Every frame written, in order. */
  readonly sent: string[] = [];

  /** Every `close()` call, in order. */
  readonly closeCalls: CloseCall[] = [];

  /** When set, every `send` throws. */
  throwOnSend = false;

  /** When set, `send` throws once this many frames have been written. */
  failSendsFrom: number | undefined;

  /** When set, `close` throws after recording the call. */
  throwOnClose = false;

  /** When set, `removeEventListener` throws. */
  throwOnRemove = false;

  /**
   * When set, the socket moves to `closing` once this many frames have been
   * written — a connection the peer started closing mid-flush.
   */
  closingAfterFrames: number | undefined;

  /** The listeners currently attached, per event. */
  private readonly listeners: ListenerSets = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  /**
   * @param url The URL the client constructed this socket with.
   * @param protocols The subprotocols it passed, if any.
   * @param argumentCount How many constructor arguments it passed, which is
   * what tells an absent subprotocol list from an explicit `undefined`.
   */
  constructor(
    readonly url: string,
    readonly protocols: string | string[] | undefined,
    readonly argumentCount: number,
  ) {}

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
    if (this.throwOnRemove) {
      throw new Error('the runtime refused to remove a listener');
    }

    this.listeners[type].delete(listener);
  }

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error('the socket is not writable');
    }

    if (this.failSendsFrom !== undefined && this.sent.length >= this.failSendsFrom) {
      throw new Error('the socket stopped accepting frames');
    }

    if (this.readyState !== READY_STATE.open) {
      throw new Error('the socket is not open');
    }

    this.sent.push(data);

    if (this.closingAfterFrames !== undefined && this.sent.length >= this.closingAfterFrames) {
      this.readyState = READY_STATE.closing;
    }
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });

    if (this.throwOnClose) {
      throw new Error('the socket refused to close');
    }

    this.readyState = READY_STATE.closing;
  }

  /** How many listeners are still attached, across all four events. */
  listenerCount(): number {
    return (
      this.listeners.open.size +
      this.listeners.message.size +
      this.listeners.close.size +
      this.listeners.error.size
    );
  }

  /** The transport opened: the socket becomes writable and `open` fires. */
  open(): void {
    this.readyState = READY_STATE.open;
    this.emit('open', { type: 'open' });
  }

  /** A frame arrived, carrying `data` exactly as a runtime would deliver it. */
  receive(data: unknown): void {
    this.emit('message', { data });
  }

  /** The connection closed with `code` and `reason`. */
  drop(code: number, reason = ''): void {
    this.readyState = READY_STATE.closed;
    this.emit('close', { code, reason });
  }

  /** The transport failed; a real runtime follows this with a close. */
  fail(): void {
    this.emit('error', { message: 'connection reset' });
  }

  /** Fires one event to a snapshot of its listeners. */
  private emit<K extends keyof WsEventMapLike>(type: K, event: WsEventMapLike[K]): void {
    for (const listener of [...this.listeners[type]]) {
      listener(event);
    }
  }
}

/** The injected constructor and what it has been asked to build. */
interface FakeTransport {
  /** The constructor handed to the client. */
  readonly webSocketConstructor: WebSocketConstructorLike;
  /** Every socket successfully constructed, in order. */
  readonly sockets: FakeWebSocket[];
  /** How many times the constructor was invoked, including ones that threw. */
  constructions(): number;
  /** Makes the next `count` constructions throw. */
  failNextConstructions(count: number): void;
}

/**
 * Builds a fresh constructor with its own registry, so no case can observe
 * another case's sockets.
 */
function createTransport(): FakeTransport {
  const sockets: FakeWebSocket[] = [];
  const counters = { constructions: 0, failuresRemaining: 0 };

  class RecordingWebSocket extends FakeWebSocket {
    constructor(...args: ConstructorParameters<WebSocketConstructorLike>) {
      counters.constructions += 1;

      if (counters.failuresRemaining > 0) {
        counters.failuresRemaining -= 1;
        throw new Error('the runtime refused to open a socket');
      }

      super(args[0], args[1], args.length);
      sockets.push(this);
    }
  }

  return {
    webSocketConstructor: RecordingWebSocket,
    sockets,
    constructions: () => counters.constructions,
    failNextConstructions: (count) => {
      counters.failuresRemaining = count;
    },
  };
}

/** The most recently constructed socket; fails the case when there is none. */
function latestSocket(transport: FakeTransport): FakeWebSocket {
  const socket = transport.sockets.at(-1);

  if (socket === undefined) {
    throw new Error('expected the client to have constructed a socket');
  }

  return socket;
}

// ---------------------------------------------------------------------------
// The fake timers
// ---------------------------------------------------------------------------

/** One timer the client scheduled. */
interface ScheduledTimer {
  /** The handle `setTimeout` answered. */
  readonly handle: number;
  /** The delay the client asked for. */
  readonly ms: number;
  /** What the client scheduled. */
  readonly handler: () => void;
  /** Whether it is still pending, has fired, or was cleared. */
  status: 'pending' | 'fired' | 'cleared';
}

/**
 * A {@link TimerApi} that never fires on its own: a case fires a timer
 * explicitly, and can ask what is pending and what was cleared.
 */
class FakeTimers implements TimerApi {
  /** Every timer ever scheduled, in order. */
  readonly scheduled: ScheduledTimer[] = [];

  /** Every handle passed to `clearTimeout`, in order. */
  readonly clearedHandles: number[] = [];

  /** The next handle to mint. */
  private nextHandle = 1;

  setTimeout(handler: () => void, ms: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduled.push({ handle, ms, handler, status: 'pending' });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.clearedHandles.push(handle);
    const timer = this.scheduled.find((candidate) => candidate.handle === handle);

    if (timer?.status === 'pending') {
      timer.status = 'cleared';
    }
  }

  /** The timers that have neither fired nor been cleared. */
  pending(): ScheduledTimer[] {
    return this.scheduled.filter((timer) => timer.status === 'pending');
  }

  /** The one pending timer; fails the case unless there is exactly one. */
  onlyPending(): ScheduledTimer {
    const pending = this.pending();
    expect(pending).toHaveLength(1);
    const [timer] = pending;

    if (timer === undefined) {
      throw new Error('expected exactly one pending timer');
    }

    return timer;
  }

  /** Fires one pending timer. */
  fire(timer: ScheduledTimer): void {
    expect(timer.status).toBe('pending');
    timer.status = 'fired';
    timer.handler();
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** One `onStateChange` call, with the state the client reported at the time. */
interface StateEvent {
  /** The state passed to the hook. */
  readonly state: ConnectionState;
  /** The detail passed with it, if any. */
  readonly detail: WsStateChangeDetail | undefined;
}

/** Everything the client reported through its hooks and its logger. */
interface RecordedEvents {
  /** Every state transition, in order. */
  readonly states: StateEvent[];
  /** Every `onProtocolError` call, in order. */
  readonly errors: DebuggenError[];
  /** Every `onUnauthorized` call, in order. */
  readonly unauthorized: WsUnauthorizedDetail[];
  /** Every `onQueueDrop` call, in order. */
  readonly drops: WsQueueDropDetail[];
  /** Every `onMessage` call, in order. */
  readonly messages: ProtocolMessage[];
  /** Every log record, at every level. */
  readonly logs: LogRecord[];
  /** The state the client's getter answered inside each `onStateChange`. */
  readonly observedStates: ConnectionState[];
}

/** What a case may override when building a client. */
interface HarnessOptions {
  readonly url?: string;
  readonly identity?: WsClientIdentity;
  readonly token?: ReconnectingWsClientOptions['token'];
  readonly protocols?: string | string[];
  readonly backoff?: WsBackoffOptions;
  readonly maxQueuedMessages?: number;
  readonly openTimeoutMs?: number;
  readonly random?: () => number;
  /** Runs after the harness has recorded the call. */
  readonly onStateChange?: (
    state: ConnectionState,
    detail: WsStateChangeDetail | undefined,
  ) => void;
  /** Runs after the harness has recorded the call. */
  readonly onMessage?: (message: ProtocolMessage) => void;
  /** Runs after the harness has recorded the call. */
  readonly onProtocolError?: (error: DebuggenError) => void;
  /** Runs after the harness has recorded the call. */
  readonly onUnauthorized?: (detail: WsUnauthorizedDetail) => void;
  /** Runs after the harness has recorded the call. */
  readonly onQueueDrop?: (detail: WsQueueDropDetail) => void;
}

/** A client wired to the fakes, and everything needed to drive and read it. */
interface Harness {
  readonly client: ReconnectingWsClient;
  readonly transport: FakeTransport;
  readonly timers: FakeTimers;
  readonly events: RecordedEvents;
}

/**
 * Builds a client over a fresh fake transport, fresh fake timers and a
 * recording logger.
 *
 * The jitter source defaults to `() => 1`, which reproduces the nominal curve
 * exactly, so a delay assertion never depends on randomness.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  const transport = createTransport();
  const timers = new FakeTimers();
  const events: RecordedEvents = {
    states: [],
    errors: [],
    unauthorized: [],
    drops: [],
    messages: [],
    logs: [],
    observedStates: [],
  };
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      events.logs.push(record);
    },
  });

  const client: ReconnectingWsClient = new ReconnectingWsClient({
    url: options.url ?? SERVICE_URL,
    webSocketConstructor: transport.webSocketConstructor,
    identity: options.identity ?? DEVTOOLS_IDENTITY,
    token: options.token ?? TOKEN,
    protocols: options.protocols,
    backoff: options.backoff,
    maxQueuedMessages: options.maxQueuedMessages,
    openTimeoutMs: options.openTimeoutMs,
    logger,
    timers,
    random: options.random ?? (() => 1),
    onStateChange: (state, detail) => {
      events.states.push({ state, detail });
      events.observedStates.push(client.state);
      options.onStateChange?.(state, detail);
    },
    onMessage: (message) => {
      events.messages.push(message);
      options.onMessage?.(message);
    },
    onProtocolError: (error) => {
      events.errors.push(error);
      options.onProtocolError?.(error);
    },
    onUnauthorized: (detail) => {
      events.unauthorized.push(detail);
      options.onUnauthorized?.(detail);
    },
    onQueueDrop: (detail) => {
      events.drops.push(detail);
      options.onQueueDrop?.(detail);
    },
  });

  return { client, transport, timers, events };
}

/** Connects and completes the handshake on the first socket. */
function connectAndOpen(harness: Harness): FakeWebSocket {
  harness.client.connect();
  const socket = latestSocket(harness.transport);
  socket.open();
  return socket;
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

/** Decodes every frame a socket was sent, failing the case on any that is invalid. */
function decodeSent(socket: FakeWebSocket): ProtocolMessage[] {
  return socket.sent.map((frame) => {
    const decoded = decodeMessage(frame);

    if (isErr(decoded)) {
      throw decoded.error;
    }

    return decoded.value;
  });
}

/** The message types a socket was sent, in order. */
function sentTypes(socket: FakeWebSocket): string[] {
  return decodeSent(socket).map((message) => message.type);
}

/** The hello payload of a frame, validated by the schema the service applies. */
function helloPayload(message: ProtocolMessage | undefined): ClientHelloPayload {
  if (message === undefined || !isMessageOfType(message, 'client.hello')) {
    throw new Error('expected a client.hello frame');
  }

  return clientHelloPayloadSchema.parse(message.payload);
}

/** The tab ids of every `session.unbind` frame a socket was sent, in order. */
function sentUnbindTabIds(socket: FakeWebSocket): number[] {
  return decodeSent(socket).flatMap((message) =>
    isMessageOfType(message, 'session.unbind') ? [message.payload.tabId] : [],
  );
}

/** A valid inbound `session.progress` frame, as text. */
function progressFrame(message = 'Traced event handler'): string {
  return encodeMessage(
    createEnvelope('session.progress', {
      sessionId: SESSION_ID,
      stage: 'investigate',
      status: 'done',
      message,
    }),
  );
}

/** A valid inbound `tab.navigated` frame, as text. */
function navigatedFrame(): string {
  return encodeMessage(
    createEnvelope('tab.navigated', { tabId: TAB_ID, url: 'http://localhost:3000/items' }),
  );
}

// ---------------------------------------------------------------------------
// Leak helpers
// ---------------------------------------------------------------------------

/** A cause, reduced to text without invoking a foreign `toString`. */
function describeCause(cause: unknown): string {
  if (cause === undefined) {
    return '';
  }

  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }

  return typeof cause === 'string' ? cause : typeof cause;
}

/** Every field of an error a user interface or a log could show, as text. */
function describeError(error: DebuggenError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    hint: error.hint ?? null,
    details: error.details ?? null,
    cause: describeCause(error.cause),
    stack: error.stack ?? null,
  });
}

/**
 * Everything the client reported — errors, the configuration error, state
 * details, unauthorized details, drop details and every log record — as one
 * string a leak case searches.
 */
function reportedText(harness: Harness): string {
  const configurationError = harness.client.configurationError;

  return JSON.stringify({
    errors: harness.events.errors.map(describeError),
    configurationError: configurationError === undefined ? null : describeError(configurationError),
    states: harness.events.states,
    unauthorized: harness.events.unauthorized,
    drops: harness.events.drops,
    logs: harness.events.logs.map((record) => ({
      level: record.level,
      message: record.message,
      fields: record.fields,
    })),
  });
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/** A promise a case settles by hand. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}

/** Builds a {@link Deferred}. */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });

  return { promise, resolve, reject };
}

/**
 * Lets every pending microtask run, by waiting one real macrotask. The client
 * under test uses the injected {@link FakeTimers}, so the real timer this
 * schedules cannot interleave with anything the case is asserting on.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

describe('the client.hello handshake', () => {
  it('writes the hello frame first, with the protocol version, the identity and the credential', () => {
    const harness = createHarness({ identity: EDITOR_IDENTITY });

    harness.client.connect();
    const socket = latestSocket(harness.transport);

    expect(harness.client.state).toBe('connecting');
    expect(socket.url).toBe(SOCKET_URL);
    expect(socket.sent).toEqual([]);

    socket.open();

    const frames = decodeSent(socket);
    expect(frames).toHaveLength(1);
    const payload = helloPayload(frames[0]);
    expect(payload).toEqual({
      client: 'vscode',
      projectRoot: PROJECT_ROOT,
      version: PROTOCOL_VERSION,
      token: TOKEN,
    });
    // An absent optional field is an absent key, never a key holding
    // `undefined`: the hello schema is strict.
    expect('tabId' in payload).toBe(false);
    // A session-less frame carries no routing key at all.
    expect(frames[0] !== undefined && 'sessionId' in frames[0]).toBe(false);
    expect(harness.client.state).toBe('open');
    expect(harness.events.states.map((event) => event.state)).toEqual(['connecting', 'open']);
  });

  it('announces a DevTools tab without a project root', () => {
    const harness = createHarness({ identity: DEVTOOLS_IDENTITY });
    const socket = connectAndOpen(harness);
    const payload = helloPayload(decodeSent(socket)[0]);

    expect(payload).toEqual({
      client: 'devtools',
      tabId: TAB_ID,
      version: PROTOCOL_VERSION,
      token: TOKEN,
    });
    expect('projectRoot' in payload).toBe(false);
  });

  it('mints a fresh hello frame first on every connection, reconnects included', () => {
    const harness = createHarness();
    const first = connectAndOpen(harness);

    first.drop(ABNORMAL_CLOSURE, 'service restarted');
    harness.timers.fire(harness.timers.onlyPending());
    const second = latestSocket(harness.transport);
    expect(second).not.toBe(first);
    second.open();

    const firstHello = decodeSent(first)[0];
    const secondHello = decodeSent(second)[0];
    expect(sentTypes(first)).toEqual(['client.hello']);
    expect(sentTypes(second)).toEqual(['client.hello']);
    expect(helloPayload(secondHello).token).toBe(TOKEN);
    expect(firstHello?.id).toBeDefined();
    expect(secondHello?.id).not.toBe(firstHello?.id);
  });

  it('queues frames sent while connecting and flushes them after the hello, oldest first', () => {
    const harness = createHarness();
    harness.client.connect();

    const queued = [1, 2, 3].map((tabId) => harness.client.send('session.unbind', { tabId }));
    expect(queued.map((result) => (result.ok ? result.value : 'failed'))).toEqual([
      'queued',
      'queued',
      'queued',
    ]);
    expect(harness.client.queuedCount).toBe(3);

    const socket = latestSocket(harness.transport);
    socket.open();

    expect(sentTypes(socket)).toEqual([
      'client.hello',
      'session.unbind',
      'session.unbind',
      'session.unbind',
    ]);
    expect(sentUnbindTabIds(socket)).toEqual([1, 2, 3]);
    expect(harness.client.queuedCount).toBe(0);

    const direct = harness.client.send('session.unbind', { tabId: 4 });
    expect(direct).toEqual({ ok: true, value: 'sent' });
    expect(sentUnbindTabIds(socket)).toEqual([1, 2, 3, 4]);
  });

  it('keeps a frame sent from onStateChange("open") behind the frames already waiting', () => {
    const lateResults: string[] = [];
    // The hook needs the client it is a hook of, which exists only once the
    // harness has been built.
    const holder: { client?: ReconnectingWsClient } = {};
    const harness = createHarness({
      onStateChange: (state) => {
        if (state === 'open' && holder.client !== undefined) {
          const result = holder.client.send('session.unbind', { tabId: 99 });
          lateResults.push(result.ok ? result.value : 'failed');
        }
      },
    });
    holder.client = harness.client;

    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    harness.client.send('session.unbind', { tabId: 2 });
    const socket = latestSocket(harness.transport);
    socket.open();

    // Appended while the queue drained, then flushed in order behind it.
    expect(lateResults).toEqual(['queued']);
    expect(sentTypes(socket)[0]).toBe('client.hello');
    expect(sentUnbindTabIds(socket)).toEqual([1, 2, 99]);
  });

  it('forwards subprotocols only when they are configured', () => {
    const without = createHarness();
    without.client.connect();
    expect(latestSocket(without.transport).argumentCount).toBe(1);
    expect(latestSocket(without.transport).protocols).toBeUndefined();

    const withProtocols = createHarness({ protocols: ['debuggen.v1'] });
    withProtocols.client.connect();
    expect(latestSocket(withProtocols.transport).argumentCount).toBe(2);
    expect(latestSocket(withProtocols.transport).protocols).toEqual(['debuggen.v1']);
  });

  it('refuses an identity the hello schema rejects, writing no frame and scheduling nothing', () => {
    const harness = createHarness({ identity: { client: 'devtools', tabId: -1 } });
    const socket = connectAndOpen(harness);

    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: INVALID_HELLO_REASON }]);
    expect(socket.listenerCount()).toBe(0);
    expect(harness.client.state).toBe('closed');
    expect(harness.events.states.at(-1)).toEqual({
      state: 'closed',
      detail: { code: NORMAL_CLOSURE, reason: INVALID_HELLO_REASON },
    });
    expect(harness.events.errors.map((error) => error.code)).toEqual(['PROTOCOL_INVALID_MESSAGE']);
    expect(harness.events.errors[0]?.message).toMatch(/^Invalid client\.hello payload/u);
    expect(harness.events.unauthorized).toEqual([]);
    expect(harness.timers.pending()).toEqual([]);
    expect(reportedText(harness)).not.toContain(TOKEN);
  });

  it('treats a socket that dies before its hello as a failed attempt and reconnects', () => {
    const harness = createHarness();
    harness.client.connect();
    const socket = latestSocket(harness.transport);
    socket.throwOnSend = true;
    socket.open();

    expect(harness.events.errors.map((error) => error.code)).toEqual(['TRANSPORT_DISCONNECTED']);
    expect(socket.listenerCount()).toBe(0);
    expect(harness.client.state).toBe('reconnecting');
    expect(harness.events.states.at(-1)).toEqual({
      state: 'reconnecting',
      detail: { attempt: 1, delayMs: NOMINAL_CURVE[0], reason: HELLO_WRITE_FAILED_REASON },
    });
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
    expect(harness.events.unauthorized).toEqual([]);
  });

  it('writes exactly one hello when the same socket reports open twice', async () => {
    const reads = [deferred<string | undefined>(), deferred<string | undefined>()];
    let call = 0;
    const provider = vi.fn(() => {
      const read = reads[call];
      call += 1;

      if (read === undefined) {
        throw new Error('unexpected credential read');
      }

      return read.promise;
    });
    const harness = createHarness({ token: provider });
    harness.client.connect();
    const socket = latestSocket(harness.transport);

    socket.open();
    const [firstDeadline] = harness.timers.pending();
    socket.open();

    // The second read supersedes the first: its deadline is cleared at once.
    expect(firstDeadline?.status).toBe('cleared');
    expect(harness.timers.pending()).toHaveLength(1);

    reads[0]?.resolve(TOKEN);
    await flushMicrotasks();
    expect(socket.sent).toEqual([]);

    reads[1]?.resolve(TOKEN);
    await flushMicrotasks();
    expect(sentTypes(socket)).toEqual(['client.hello']);
    expect(harness.timers.pending()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('credential resolution', () => {
  it('accepts a string, a synchronous provider and an asynchronous provider', async () => {
    const fromString = createHarness({ token: TOKEN });
    expect(helloPayload(decodeSent(connectAndOpen(fromString))[0]).token).toBe(TOKEN);

    const fromSync = createHarness({ token: () => TOKEN });
    expect(helloPayload(decodeSent(connectAndOpen(fromSync))[0]).token).toBe(TOKEN);

    const fromAsync = createHarness({ token: () => Promise.resolve(TOKEN) });
    const socket = connectAndOpen(fromAsync);
    expect(socket.sent).toEqual([]);
    expect(fromAsync.client.state).toBe('connecting');
    await flushMicrotasks();
    expect(helloPayload(decodeSent(socket)[0]).token).toBe(TOKEN);
    expect(fromAsync.client.state).toBe('open');
  });

  it('asks the provider once per attempt, so a rotated credential takes effect on the next one', () => {
    const provider = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce(TOKEN)
      .mockReturnValueOnce(ROTATED_TOKEN);
    const harness = createHarness({ token: provider });
    const first = connectAndOpen(harness);

    first.drop(ABNORMAL_CLOSURE);
    harness.timers.fire(harness.timers.onlyPending());
    const second = latestSocket(harness.transport);
    second.open();

    expect(provider).toHaveBeenCalledTimes(2);
    expect(helloPayload(decodeSent(first)[0]).token).toBe(TOKEN);
    expect(helloPayload(decodeSent(second)[0]).token).toBe(ROTATED_TOKEN);
  });

  const MISSING_CREDENTIALS: ReadonlyArray<{
    readonly name: string;
    readonly token: ReconnectingWsClientOptions['token'];
  }> = [
    { name: 'an empty string credential', token: '' },
    { name: 'a provider answering undefined', token: () => undefined },
    { name: 'a provider answering an empty string', token: () => '' },
    { name: 'a provider resolving undefined', token: () => Promise.resolve(undefined) },
    { name: 'a provider resolving an empty string', token: () => Promise.resolve('') },
    {
      name: 'a provider that throws',
      token: () => {
        throw new Error('storage unavailable');
      },
    },
    {
      name: 'a provider that rejects',
      token: () => Promise.reject(new Error('storage unavailable')),
    },
  ];

  it.each(MISSING_CREDENTIALS)(
    '$name: refuses locally, reports unauthorized and schedules nothing',
    async ({ token }) => {
      const harness = createHarness({ token });
      const socket = connectAndOpen(harness);
      await flushMicrotasks();

      expect(socket.sent).toEqual([]);
      expect(socket.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: NO_CREDENTIAL_REASON }]);
      expect(socket.listenerCount()).toBe(0);
      expect(harness.client.state).toBe('closed');
      expect(harness.events.unauthorized).toEqual([
        { code: WS_CLOSE_UNAUTHORIZED, reason: NO_CREDENTIAL_REASON },
      ]);
      expect(harness.timers.pending()).toEqual([]);
      expect(harness.client.send('session.unbind', { tabId: TAB_ID }).ok).toBe(false);
    },
  );

  it('reports a throwing provider with a constant error that carries none of its text', () => {
    const marker = 'provider-secret-marker';
    const harness = createHarness({
      token: () => {
        throw new Error(`could not read ${marker} from storage`);
      },
    });
    connectAndOpen(harness);

    expect(harness.events.errors).toHaveLength(1);
    const [error] = harness.events.errors;
    expect(error?.code).toBe('UNAUTHORIZED');
    expect(error?.message).toBe('The credential provider failed');
    expect(error?.cause).toBeUndefined();
    expect(reportedText(harness)).not.toContain(marker);
  });

  it('gives up on a provider that outlives the hello deadline, as a timeout', async () => {
    const read = deferred<string | undefined>();
    const harness = createHarness({ token: () => read.promise });
    const socket = connectAndOpen(harness);

    const deadline = harness.timers.onlyPending();
    expect(deadline.ms).toBe(CLIENT_HELLO_TIMEOUT_MS);
    harness.timers.fire(deadline);
    await flushMicrotasks();

    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: CREDENTIAL_TIMEOUT_REASON },
    ]);
    expect(harness.client.state).toBe('closed');
    expect(harness.events.unauthorized).toEqual([
      { code: WS_CLOSE_UNAUTHORIZED, reason: CREDENTIAL_TIMEOUT_REASON },
    ]);
    expect(harness.timers.pending()).toEqual([]);

    // The provider answering after the deadline changes nothing.
    const statesBefore = harness.events.states.length;
    read.resolve(TOKEN);
    await flushMicrotasks();
    expect(socket.sent).toEqual([]);
    expect(harness.events.states).toHaveLength(statesBefore);
  });

  it('resumes through connect() after a refusal, re-resolving the credential', () => {
    const provider = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(ROTATED_TOKEN);
    const harness = createHarness({ token: provider });
    connectAndOpen(harness);
    expect(harness.client.state).toBe('closed');

    const resumed = connectAndOpen(harness);

    expect(harness.transport.sockets).toHaveLength(2);
    expect(helloPayload(decodeSent(resumed)[0]).token).toBe(ROTATED_TOKEN);
    expect(harness.client.state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// The credential deadline's life cycle (R1-F04)
// ---------------------------------------------------------------------------

describe('the credential deadline of an asynchronous provider', () => {
  it('is cleared by close(), and the late credential writes nothing', async () => {
    const read = deferred<string | undefined>();
    const harness = createHarness({ token: () => read.promise });
    const socket = connectAndOpen(harness);
    const deadline = harness.timers.onlyPending();

    harness.client.close();

    expect(harness.timers.pending()).toEqual([]);
    expect(harness.timers.clearedHandles).toContain(deadline.handle);
    expect(deadline.status).toBe('cleared');

    const statesBefore = harness.events.states.length;
    read.resolve(TOKEN);
    await flushMicrotasks();

    expect(socket.sent).toEqual([]);
    expect(harness.events.states).toHaveLength(statesBefore);
    expect(harness.events.unauthorized).toEqual([]);
    expect(harness.client.state).toBe('closed');
  });

  it('is cleared when the socket closes while the credential is being read', async () => {
    const read = deferred<string | undefined>();
    const harness = createHarness({ token: () => read.promise });
    const socket = connectAndOpen(harness);
    const deadline = harness.timers.onlyPending();

    socket.drop(ABNORMAL_CLOSURE, 'network changed');

    expect(harness.timers.clearedHandles).toContain(deadline.handle);
    expect(deadline.status).toBe('cleared');
    // Only the reconnect delay remains.
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);

    read.resolve(TOKEN);
    await flushMicrotasks();

    // No hello onto the dead connection, and no refusal either.
    expect(socket.sent).toEqual([]);
    expect(harness.events.unauthorized).toEqual([]);
    expect(harness.client.state).toBe('reconnecting');
  });

  it('is cleared, and the overtaken socket retired, when connect() replaces an attempt in flight', async () => {
    const reads: Array<Deferred<string | undefined>> = [];
    const harness = createHarness({
      token: () => {
        const read = deferred<string | undefined>();
        reads.push(read);
        return read.promise;
      },
    });
    const first = connectAndOpen(harness);
    first.drop(ABNORMAL_CLOSURE);
    harness.timers.fire(harness.timers.onlyPending());

    // The reconnect attempt is opening and reading its credential.
    const overtaken = latestSocket(harness.transport);
    overtaken.throwOnClose = true;
    overtaken.open();
    const deadline = harness.timers.onlyPending();
    expect(deadline.ms).toBe(CLIENT_HELLO_TIMEOUT_MS);
    expect(harness.client.state).toBe('reconnecting');

    harness.client.connect();
    const replacement = latestSocket(harness.transport);

    expect(replacement).not.toBe(overtaken);
    expect(deadline.status).toBe('cleared');
    expect(harness.timers.clearedHandles).toContain(deadline.handle);
    // Nothing of the overtaken attempt is pending; the one timer that is, is
    // the replacement's own opening deadline, armed as it was constructed.
    expect(harness.timers.pending().map((timer) => timer.ms)).toEqual([DEFAULT_WS_OPEN_TIMEOUT_MS]);
    expect(overtaken.listenerCount()).toBe(0);
    expect(overtaken.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: undefined }]);
    expect(harness.events.logs.map((record) => record.message)).toContain('websocket close failed');
    expect(harness.client.state).toBe('connecting');

    // The overtaken attempt's credential arrives late: nothing is written.
    reads[1]?.resolve(TOKEN);
    await flushMicrotasks();
    expect(overtaken.sent).toEqual([]);
    expect(replacement.sent).toEqual([]);

    // The replacement authenticates with its own read.
    replacement.open();
    reads[2]?.resolve(ROTATED_TOKEN);
    await flushMicrotasks();
    expect(helloPayload(decodeSent(replacement)[0]).token).toBe(ROTATED_TOKEN);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('is cleared by a successful asynchronous handshake', async () => {
    const read = deferred<string | undefined>();
    const harness = createHarness({ token: () => read.promise });
    const socket = connectAndOpen(harness);
    const deadline = harness.timers.onlyPending();

    read.resolve(TOKEN);
    await flushMicrotasks();

    expect(sentTypes(socket)).toEqual(['client.hello']);
    expect(deadline.status).toBe('cleared');
    expect(harness.timers.clearedHandles).toContain(deadline.handle);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('is cleared by a refusal of what the provider answered', async () => {
    const read = deferred<string | undefined>();
    const harness = createHarness({ token: () => read.promise });
    connectAndOpen(harness);
    const deadline = harness.timers.onlyPending();

    read.resolve(undefined);
    await flushMicrotasks();

    expect(deadline.status).toBe('cleared');
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.events.unauthorized).toHaveLength(1);
  });

  it('is cleared by a provider that rejects', async () => {
    const read = deferred<string | undefined>();
    const harness = createHarness({ token: () => read.promise });
    connectAndOpen(harness);
    const deadline = harness.timers.onlyPending();

    read.reject(new Error('storage unavailable'));
    await flushMicrotasks();

    expect(deadline.status).toBe('cleared');
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.events.unauthorized).toEqual([
      { code: WS_CLOSE_UNAUTHORIZED, reason: NO_CREDENTIAL_REASON },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The service's refusal
// ---------------------------------------------------------------------------

describe('a WS_CLOSE_UNAUTHORIZED close', () => {
  it('is terminal: closed, reported with the service reason, and never retried', () => {
    const harness = createHarness();
    const socket = connectAndOpen(harness);

    socket.drop(WS_CLOSE_UNAUTHORIZED, 'credential expired');

    expect(harness.client.state).toBe('closed');
    expect(harness.client.lastCloseCode).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(harness.events.unauthorized).toEqual([
      { code: WS_CLOSE_UNAUTHORIZED, reason: 'credential expired' },
    ]);
    expect(harness.events.states.at(-1)).toEqual({
      state: 'closed',
      detail: { code: WS_CLOSE_UNAUTHORIZED, reason: 'credential expired' },
    });
    // The only timer this client ever scheduled is the socket's opening
    // deadline, cleared by its `open` event: no reconnect was ever scheduled.
    expect(harness.timers.scheduled.map(({ ms, status }) => ({ ms, status }))).toEqual([
      { ms: DEFAULT_WS_OPEN_TIMEOUT_MS, status: 'cleared' },
    ]);
    expect(harness.timers.pending()).toEqual([]);
    expect(socket.listenerCount()).toBe(0);
  });

  it('stands in a constant reason when the service gave none', () => {
    const harness = createHarness();
    connectAndOpen(harness).drop(WS_CLOSE_UNAUTHORIZED);

    expect(harness.events.unauthorized).toEqual([
      { code: WS_CLOSE_UNAUTHORIZED, reason: REFUSED_CREDENTIAL_REASON },
    ]);
  });

  it('keeps the outbound queue, and delivers it after the hello once connect() resumes', () => {
    const harness = createHarness();
    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    harness.client.send('session.unbind', { tabId: 2 });

    latestSocket(harness.transport).drop(WS_CLOSE_UNAUTHORIZED, 'not paired');
    expect(harness.client.queuedCount).toBe(2);
    expect(harness.timers.pending()).toEqual([]);

    const resumed = connectAndOpen(harness);

    expect(sentTypes(resumed)).toEqual(['client.hello', 'session.unbind', 'session.unbind']);
    expect(sentUnbindTabIds(resumed)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Fails `count` consecutive attempts before any hello, answering the delay each
 * failure scheduled.
 */
function failConsecutiveAttempts(harness: Harness, count: number): number[] {
  harness.client.connect();
  const delays: number[] = [];

  for (let failure = 0; failure < count; failure += 1) {
    latestSocket(harness.transport).drop(ABNORMAL_CLOSURE, 'service unavailable');
    const timer = harness.timers.onlyPending();
    delays.push(timer.ms);
    harness.timers.fire(timer);
  }

  return delays;
}

describe('the reconnect curve', () => {
  it('follows the documented curve exactly when the jitter draws 1', () => {
    const harness = createHarness({ random: () => 1 });

    expect(failConsecutiveAttempts(harness, NOMINAL_CURVE.length)).toEqual(NOMINAL_CURVE);

    const reconnecting = harness.events.states.filter((event) => event.state === 'reconnecting');
    expect(reconnecting.map((event) => event.detail)).toEqual(
      NOMINAL_CURVE.map((delayMs, index) => ({
        attempt: index + 1,
        delayMs,
        code: ABNORMAL_CLOSURE,
        reason: 'service unavailable',
      })),
    );
  });

  it('halves every delay when the jitter draws 0 at the default jitter', () => {
    const harness = createHarness({ random: () => 0 });

    expect(failConsecutiveAttempts(harness, NOMINAL_CURVE.length)).toEqual(
      NOMINAL_CURVE.map((delay) => delay / 2),
    );
  });

  it('matches the frozen default curve', () => {
    expect(DEFAULT_WS_BACKOFF).toEqual({ initialMs: 500, maxMs: 10_000, factor: 2, jitter: 0.5 });
    expect(Object.isFrozen(DEFAULT_WS_BACKOFF)).toBe(true);
  });

  it.each([
    ['NaN', () => Number.NaN],
    ['a negative number', () => -1],
    ['a number above 1', () => 2],
    [
      'a throw',
      () => {
        throw new Error('no entropy');
      },
    ],
  ])('treats a jitter source answering %s as 1', (_name, random: () => number) => {
    const harness = createHarness({ random });

    expect(failConsecutiveAttempts(harness, 2)).toEqual(NOMINAL_CURVE.slice(0, 2));
  });

  it('sanitises unusable overrides back to the defaults', () => {
    const harness = createHarness({
      backoff: { initialMs: -5, maxMs: Number.NaN, factor: 0.5, jitter: Number.POSITIVE_INFINITY },
      random: () => 0,
    });

    // Every field fell back: 500 ms, doubling, capped at 10 s, jitter 0.5.
    expect(failConsecutiveAttempts(harness, 3)).toEqual([250, 500, 1_000]);
  });

  it('never lets the cap fall below the first delay, and clamps jitter to the unit interval', () => {
    const capped = createHarness({ backoff: { initialMs: 800, maxMs: 100, factor: 3, jitter: 0 } });
    expect(failConsecutiveAttempts(capped, 3)).toEqual([800, 800, 800]);

    // A jitter of 7 would drive the delay negative; clamped to 1, a draw of
    // 0.5 gives half the nominal delay.
    const clamped = createHarness({ backoff: { jitter: 7 }, random: () => 0.5 });
    expect(failConsecutiveAttempts(clamped, 2)).toEqual([250, 500]);
  });

  it('resets the attempt counter after a successful hello', () => {
    const harness = createHarness();
    const delays = failConsecutiveAttempts(harness, 2);
    expect(delays).toEqual(NOMINAL_CURVE.slice(0, 2));

    const recovered = latestSocket(harness.transport);
    recovered.open();
    expect(harness.client.state).toBe('open');
    recovered.drop(ABNORMAL_CLOSURE);

    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
    expect(harness.events.states.at(-1)?.detail?.attempt).toBe(1);
  });

  it('uses the platform timers and Math.random when neither is injected', () => {
    vi.useFakeTimers();

    try {
      const transport = createTransport();
      const details: Array<WsStateChangeDetail | undefined> = [];
      const client = new ReconnectingWsClient({
        url: SERVICE_URL,
        webSocketConstructor: transport.webSocketConstructor,
        identity: DEVTOOLS_IDENTITY,
        token: TOKEN,
        onStateChange: (_state, detail) => {
          details.push(detail);
        },
      });

      client.connect();
      latestSocket(transport).drop(ABNORMAL_CLOSURE);

      // Equal jitter at the default 0.5 draws from the upper half of the first
      // nominal delay.
      const delayMs = details.at(-1)?.delayMs ?? -1;
      expect(delayMs).toBeGreaterThanOrEqual(
        DEFAULT_WS_BACKOFF.initialMs * (1 - DEFAULT_WS_BACKOFF.jitter),
      );
      expect(delayMs).toBeLessThanOrEqual(DEFAULT_WS_BACKOFF.initialMs);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(delayMs);
      expect(transport.sockets).toHaveLength(2);

      latestSocket(transport).drop(ABNORMAL_CLOSURE);
      expect(vi.getTimerCount()).toBe(1);
      client.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The outbound queue
// ---------------------------------------------------------------------------

describe('the outbound queue', () => {
  it('holds DEFAULT_MAX_QUEUED_MESSAGES frames and drops the oldest beyond them', () => {
    expect(DEFAULT_MAX_QUEUED_MESSAGES).toBe(200);
    const harness = createHarness();
    harness.client.connect();

    for (let tabId = 1; tabId <= DEFAULT_MAX_QUEUED_MESSAGES; tabId += 1) {
      harness.client.send('session.unbind', { tabId });
    }

    expect(harness.client.queuedCount).toBe(DEFAULT_MAX_QUEUED_MESSAGES);
    expect(harness.events.drops).toEqual([]);

    const overflow = harness.client.send('session.unbind', {
      tabId: DEFAULT_MAX_QUEUED_MESSAGES + 1,
    });

    expect(overflow).toEqual({ ok: true, value: 'queued' });
    expect(harness.client.queuedCount).toBe(DEFAULT_MAX_QUEUED_MESSAGES);
    expect(harness.events.drops).toEqual([
      { type: 'session.unbind', queued: DEFAULT_MAX_QUEUED_MESSAGES },
    ]);

    const socket = latestSocket(harness.transport);
    socket.open();

    const expected = Array.from({ length: DEFAULT_MAX_QUEUED_MESSAGES }, (_, index) => index + 2);
    expect(sentUnbindTabIds(socket)).toEqual(expected);
    expect(sentTypes(socket)[0]).toBe('client.hello');
  });

  it('holds exactly one frame at a bound of 1', () => {
    const harness = createHarness({ maxQueuedMessages: 1 });
    harness.client.connect();

    expect(harness.client.send('session.unbind', { tabId: 1 })).toEqual({
      ok: true,
      value: 'queued',
    });
    harness.client.send('tab.navigated', { tabId: 2, url: 'http://localhost:3000/next' });

    expect(harness.client.queuedCount).toBe(1);
    expect(harness.events.drops).toEqual([{ type: 'session.unbind', queued: 1 }]);

    const socket = latestSocket(harness.transport);
    socket.open();
    expect(sentTypes(socket)).toEqual(['client.hello', 'tab.navigated']);
  });

  it('refuses every frame at a bound of 0, reporting the drop', () => {
    const harness = createHarness({ maxQueuedMessages: 0 });
    harness.client.connect();

    const refused = harness.client.send('session.unbind', { tabId: TAB_ID });

    expect(refused.ok).toBe(false);

    if (!refused.ok) {
      expect(refused.error.code).toBe('TRANSPORT_DISCONNECTED');
      expect(refused.error.details).toEqual({ type: 'session.unbind' });
    }

    expect(harness.client.queuedCount).toBe(0);
    expect(harness.events.drops).toEqual([{ type: 'session.unbind', queued: 0 }]);
  });

  it.each([
    [Number.NaN, DEFAULT_MAX_QUEUED_MESSAGES],
    [-3, 0],
    [2.7, 2],
  ])('sanitises a bound of %s to %s', (configured, effective) => {
    const harness = createHarness({ maxQueuedMessages: configured });
    harness.client.connect();

    for (let tabId = 1; tabId <= effective + 1; tabId += 1) {
      harness.client.send('session.unbind', { tabId });
    }

    expect(harness.client.queuedCount).toBe(effective);
  });

  it('fails a send on a client that is closed, before connect() and after close()', () => {
    const harness = createHarness();

    const beforeConnect = harness.client.send('session.unbind', { tabId: TAB_ID });
    expect(beforeConnect.ok).toBe(false);

    connectAndOpen(harness);
    harness.client.close();
    const afterClose = harness.client.send('session.unbind', { tabId: TAB_ID });

    expect(afterClose.ok).toBe(false);

    if (!afterClose.ok) {
      expect(afterClose.error.code).toBe('TRANSPORT_DISCONNECTED');
      expect(afterClose.error.message).toBe('Cannot send a frame: this client is closed');
    }
  });

  it('is cleared by close()', () => {
    const harness = createHarness();
    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });

    harness.client.close();

    expect(harness.client.queuedCount).toBe(0);
    const resumed = connectAndOpen(harness);
    expect(sentTypes(resumed)).toEqual(['client.hello']);
  });

  it('falls back to the queue when a write to an open socket fails, and delivers after reconnecting', () => {
    const harness = createHarness();
    const socket = connectAndOpen(harness);
    socket.throwOnSend = true;

    const result = harness.client.send('session.unbind', { tabId: 5 });

    expect(result).toEqual({ ok: true, value: 'queued' });
    expect(harness.events.errors.map((error) => error.code)).toEqual(['TRANSPORT_DISCONNECTED']);

    socket.drop(ABNORMAL_CLOSURE);
    harness.timers.fire(harness.timers.onlyPending());
    const next = latestSocket(harness.transport);
    next.open();

    expect(sentUnbindTabIds(next)).toEqual([5]);
  });

  it('keeps the frame that failed mid-flush at the head of the queue', () => {
    const harness = createHarness();
    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    harness.client.send('session.unbind', { tabId: 2 });
    const socket = latestSocket(harness.transport);
    // The hello and the first queued frame are written; the second is refused.
    socket.failSendsFrom = 2;
    socket.open();

    expect(sentUnbindTabIds(socket)).toEqual([1]);
    expect(harness.client.queuedCount).toBe(1);
    expect(harness.events.errors.map((error) => error.code)).toEqual(['TRANSPORT_DISCONNECTED']);

    socket.drop(ABNORMAL_CLOSURE);
    harness.timers.fire(harness.timers.onlyPending());
    const next = latestSocket(harness.transport);
    next.open();

    expect(sentUnbindTabIds(next)).toEqual([2]);
  });

  it('stops flushing when the socket leaves the open state mid-flush, keeping the rest queued', () => {
    const harness = createHarness();
    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    harness.client.send('session.unbind', { tabId: 2 });
    const socket = latestSocket(harness.transport);
    // The peer starts closing once the hello and the first queued frame are out.
    socket.closingAfterFrames = 2;
    socket.open();

    expect(sentUnbindTabIds(socket)).toEqual([1]);
    expect(harness.client.queuedCount).toBe(1);
    expect(harness.events.errors).toEqual([]);

    socket.drop(NORMAL_CLOSURE);
    harness.timers.fire(harness.timers.onlyPending());
    const next = latestSocket(harness.transport);
    next.open();

    expect(sentUnbindTabIds(next)).toEqual([2]);
  });

  it('answers an unencodable payload with a failure rather than a throw', () => {
    const harness = createHarness();
    connectAndOpen(harness);
    const unencodable = {
      get tabId(): number {
        throw new Error('this value cannot be read');
      },
    };

    const result = harness.client.send('session.unbind', unencodable);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    }
  });
});

// ---------------------------------------------------------------------------
// Races and the socket's life cycle
// ---------------------------------------------------------------------------

describe('races and the socket life cycle', () => {
  it('schedules exactly one reconnect for an error followed by a close', () => {
    const harness = createHarness();
    const socket = connectAndOpen(harness);

    socket.fail();
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.client.state).toBe('open');

    socket.drop(ABNORMAL_CLOSURE);

    expect(harness.timers.pending()).toHaveLength(1);
    expect(harness.events.logs.map((record) => record.message)).toContain(
      'websocket transport error',
    );
  });

  it('ignores every late event of a socket it has let go of', () => {
    const harness = createHarness();
    const stale = connectAndOpen(harness);
    harness.client.close();
    const fresh = connectAndOpen(harness);
    const statesBefore = harness.events.states.length;

    stale.open();
    stale.receive(progressFrame());
    stale.fail();
    stale.drop(ABNORMAL_CLOSURE);

    expect(stale.listenerCount()).toBe(0);
    expect(sentTypes(stale)).toEqual(['client.hello']);
    expect(harness.events.messages).toEqual([]);
    expect(harness.events.states).toHaveLength(statesBefore);
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.client.state).toBe('open');
    expect(sentTypes(fresh)).toEqual(['client.hello']);
  });

  it('ignores a stale socket whose listeners the runtime refused to remove', () => {
    const harness = createHarness();
    const stale = connectAndOpen(harness);
    stale.throwOnRemove = true;
    harness.client.close();
    const fresh = connectAndOpen(harness);
    const statesBefore = harness.events.states.length;

    // Still attached, but from a finished attempt: every event is a no-op.
    expect(stale.listenerCount()).toBe(4);
    stale.open();
    stale.receive(progressFrame());
    stale.fail();
    stale.drop(ABNORMAL_CLOSURE);

    expect(sentTypes(stale)).toEqual(['client.hello']);
    expect(harness.events.messages).toEqual([]);
    expect(harness.events.states).toHaveLength(statesBefore);
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.client.state).toBe('open');
    expect(sentTypes(fresh)).toEqual(['client.hello']);
  });

  it('retires an overtaken reconnect socket cleanly when connect() opens its replacement', () => {
    const harness = createHarness();
    connectAndOpen(harness).drop(ABNORMAL_CLOSURE);
    harness.timers.fire(harness.timers.onlyPending());
    const overtaken = latestSocket(harness.transport);

    harness.client.connect();

    expect(overtaken.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: undefined }]);
    expect(overtaken.listenerCount()).toBe(0);
    expect(harness.events.logs.map((record) => record.message)).not.toContain(
      'websocket close failed',
    );
    latestSocket(harness.transport).open();
    expect(harness.client.state).toBe('open');
  });

  it('cancels a pending reconnect when closed', () => {
    const harness = createHarness();
    connectAndOpen(harness).drop(ABNORMAL_CLOSURE);
    const reconnect = harness.timers.onlyPending();

    harness.client.close();

    expect(reconnect.status).toBe('cleared');
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.client.state).toBe('closed');
    expect(harness.transport.sockets).toHaveLength(1);
  });

  it('is idempotent while connecting or open, and immediate while reconnecting', () => {
    const harness = createHarness();

    harness.client.connect();
    harness.client.connect();
    expect(harness.transport.constructions()).toBe(1);

    const socket = latestSocket(harness.transport);
    socket.open();
    harness.client.connect();
    expect(harness.transport.constructions()).toBe(1);

    socket.drop(ABNORMAL_CLOSURE);
    const reconnect = harness.timers.onlyPending();
    harness.client.connect();

    expect(reconnect.status).toBe('cleared');
    expect(harness.transport.constructions()).toBe(2);
    expect(harness.client.state).toBe('connecting');
  });

  it('reports a socket constructor that throws and retries it on the curve', () => {
    const harness = createHarness();
    harness.transport.failNextConstructions(1);

    harness.client.connect();

    expect(harness.transport.constructions()).toBe(1);
    expect(harness.transport.sockets).toEqual([]);
    expect(harness.events.errors.map((error) => error.code)).toEqual(['TRANSPORT_DISCONNECTED']);
    expect(harness.events.states.at(-1)).toEqual({
      state: 'reconnecting',
      detail: { attempt: 1, delayMs: NOMINAL_CURVE[0], reason: SOCKET_OPEN_FAILED_REASON },
    });

    harness.timers.fire(harness.timers.onlyPending());
    latestSocket(harness.transport).open();
    expect(harness.client.state).toBe('open');
  });

  it('removes every listener from a socket it is done with', () => {
    const closedByService = createHarness();
    const dropped = connectAndOpen(closedByService);
    dropped.drop(ABNORMAL_CLOSURE);
    expect(dropped.listenerCount()).toBe(0);

    const closedByOwner = createHarness();
    const owned = connectAndOpen(closedByOwner);
    expect(owned.listenerCount()).toBe(4);
    closedByOwner.client.close();
    expect(owned.listenerCount()).toBe(0);

    const refused = createHarness({ token: () => undefined });
    const refusedSocket = connectAndOpen(refused);
    expect(refusedSocket.listenerCount()).toBe(0);
  });

  it('survives a socket whose close and listener removal both throw', () => {
    const harness = createHarness();
    const socket = connectAndOpen(harness);
    socket.throwOnClose = true;
    socket.throwOnRemove = true;

    expect(() => {
      harness.client.close();
    }).not.toThrow();

    expect(harness.client.state).toBe('closed');
    const messages = harness.events.logs.map((record) => record.message);
    expect(messages).toContain('websocket close failed');
    expect(messages).toContain('websocket listener removal failed');
  });

  it('survives a socket whose close throws during a local refusal', () => {
    const harness = createHarness({ token: () => undefined });
    harness.client.connect();
    const socket = latestSocket(harness.transport);
    socket.throwOnClose = true;

    expect(() => {
      socket.open();
    }).not.toThrow();

    expect(harness.client.state).toBe('closed');
    expect(harness.events.unauthorized).toHaveLength(1);
  });

  it('is idempotent when closed, and silent when it never connected', () => {
    const idle = createHarness();
    idle.client.close();
    expect(idle.events.states).toEqual([]);

    const harness = createHarness();
    connectAndOpen(harness);
    harness.client.close();
    harness.client.close();

    expect(harness.events.states.filter((event) => event.state === 'closed')).toHaveLength(1);
  });

  it('forwards an explicit close code and reason to the socket and the state detail', () => {
    const harness = createHarness();
    const socket = connectAndOpen(harness);

    harness.client.close(4_000, 'panel disposed');

    expect(socket.closeCalls).toEqual([{ code: 4_000, reason: 'panel disposed' }]);
    expect(harness.client.lastCloseCode).toBe(4_000);
    expect(harness.events.states.at(-1)).toEqual({
      state: 'closed',
      detail: { code: 4_000, reason: 'panel disposed' },
    });
  });
});

// ---------------------------------------------------------------------------
// The opening deadline (INT-F39)
// ---------------------------------------------------------------------------

/** The one pending timer, asserted to be the opening deadline of `ms`. */
function pendingOpenDeadline(harness: Harness, ms = DEFAULT_WS_OPEN_TIMEOUT_MS): ScheduledTimer {
  const deadline = harness.timers.onlyPending();
  expect(deadline.ms).toBe(ms);
  return deadline;
}

describe('the opening deadline of a socket that has not opened', () => {
  it('is five seconds by default, and none of the other delays this client schedules', () => {
    expect(DEFAULT_WS_OPEN_TIMEOUT_MS).toBe(5_000);
    expect(NOMINAL_CURVE).not.toContain(DEFAULT_WS_OPEN_TIMEOUT_MS);
    expect(DEFAULT_WS_OPEN_TIMEOUT_MS).not.toBe(CLIENT_HELLO_TIMEOUT_MS);

    const harness = createHarness();
    harness.client.connect();

    // Armed as the socket is constructed, and the only timer running.
    pendingOpenDeadline(harness);
    expect(harness.client.state).toBe('connecting');
  });

  it('retires a socket that never opens, reports it without the URL, and retries on the curve', () => {
    const harness = createHarness();
    harness.client.connect();
    const stalled = latestSocket(harness.transport);

    harness.timers.fire(pendingOpenDeadline(harness));

    // The stalled socket is let go of and closed with a constant reason.
    expect(stalled.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: OPEN_TIMEOUT_REASON }]);
    expect(stalled.listenerCount()).toBe(0);
    expect(stalled.sent).toEqual([]);

    // One failure, naming the deadline and nothing else.
    expect(harness.events.errors).toHaveLength(1);
    const [failure] = harness.events.errors;
    expect(failure?.code).toBe('TRANSPORT_DISCONNECTED');
    expect(failure?.message).toBe(OPEN_TIMEOUT_MESSAGE);
    expect(failure?.details).toEqual({ timeoutMs: DEFAULT_WS_OPEN_TIMEOUT_MS });
    expect(reportedText(harness)).not.toContain(SOCKET_URL);
    expect(reportedText(harness)).not.toContain(TOKEN);
    expect(harness.events.unauthorized).toEqual([]);

    // A failed attempt, not a terminal one: the first delay of the curve.
    expect(harness.client.state).toBe('reconnecting');
    expect(harness.events.states.at(-1)).toEqual({
      state: 'reconnecting',
      detail: { attempt: 1, delayMs: NOMINAL_CURVE[0], reason: OPEN_TIMEOUT_REASON },
    });
    const reconnect = harness.timers.onlyPending();
    expect(reconnect.ms).toBe(NOMINAL_CURVE[0]);

    // Late events of the retired socket change nothing.
    const statesBefore = harness.events.states.length;
    stalled.open();
    stalled.drop(ABNORMAL_CLOSURE);
    expect(stalled.sent).toEqual([]);
    expect(harness.events.states).toHaveLength(statesBefore);
    expect(harness.timers.onlyPending()).toBe(reconnect);

    // The retry opens a new socket with its own deadline, and succeeds.
    harness.timers.fire(reconnect);
    expect(harness.transport.sockets).toHaveLength(2);
    const retry = latestSocket(harness.transport);
    expect(retry).not.toBe(stalled);
    pendingOpenDeadline(harness);
    retry.open();
    expect(sentTypes(retry)).toEqual(['client.hello']);
    expect(harness.client.state).toBe('open');
    expect(harness.timers.pending()).toEqual([]);
  });

  it('walks the backoff curve when every attempt stalls, and resets it once one opens', () => {
    const harness = createHarness();
    harness.client.connect();
    const delays: number[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      harness.timers.fire(pendingOpenDeadline(harness));
      const reconnect = harness.timers.onlyPending();
      delays.push(reconnect.ms);
      harness.timers.fire(reconnect);
    }

    expect(delays).toEqual(NOMINAL_CURVE.slice(0, 4));
    expect(harness.transport.sockets).toHaveLength(5);
    expect(harness.events.errors.map((error) => error.code)).toEqual(
      Array.from({ length: 4 }, () => 'TRANSPORT_DISCONNECTED'),
    );

    latestSocket(harness.transport).open();
    latestSocket(harness.transport).drop(ABNORMAL_CLOSURE);
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
  });

  it('is cleared when the socket opens in time', () => {
    const harness = createHarness();
    harness.client.connect();
    const deadline = pendingOpenDeadline(harness);

    latestSocket(harness.transport).open();

    expect(deadline.status).toBe('cleared');
    expect(harness.timers.clearedHandles).toContain(deadline.handle);
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.client.state).toBe('open');
  });

  it('is cleared by close() while connecting, and nothing is retried', () => {
    const harness = createHarness();
    harness.client.connect();
    const socket = latestSocket(harness.transport);
    const deadline = pendingOpenDeadline(harness);

    harness.client.close();

    expect(deadline.status).toBe('cleared');
    expect(harness.timers.pending()).toEqual([]);
    expect(socket.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: undefined }]);
    expect(harness.client.state).toBe('closed');
    expect(harness.events.errors).toEqual([]);
  });

  it('is cleared when the socket closes before it opens, leaving only the reconnect delay', () => {
    const harness = createHarness();
    harness.client.connect();
    const deadline = pendingOpenDeadline(harness);

    latestSocket(harness.transport).drop(ABNORMAL_CLOSURE, 'connection refused');

    expect(deadline.status).toBe('cleared');
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
    expect(harness.events.errors).toEqual([]);
  });

  it('is cleared when a refused credential closes the socket before it opens', () => {
    const harness = createHarness();
    harness.client.connect();
    const deadline = pendingOpenDeadline(harness);

    latestSocket(harness.transport).drop(WS_CLOSE_UNAUTHORIZED, 'not paired');

    expect(deadline.status).toBe('cleared');
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.client.state).toBe('closed');
  });

  it('is replaced, never duplicated, when connect() overtakes an attempt in flight', () => {
    const harness = createHarness();
    connectAndOpen(harness).drop(ABNORMAL_CLOSURE);
    harness.timers.fire(harness.timers.onlyPending());
    const overtaken = latestSocket(harness.transport);
    const overtakenDeadline = pendingOpenDeadline(harness);

    harness.client.connect();

    expect(overtakenDeadline.status).toBe('cleared');
    expect(overtaken.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: undefined }]);
    const replacementDeadline = pendingOpenDeadline(harness);
    expect(replacementDeadline).not.toBe(overtakenDeadline);

    harness.timers.fire(replacementDeadline);
    // The retired socket is not closed a second time by the replacement's expiry.
    expect(overtaken.closeCalls).toHaveLength(1);
    expect(latestSocket(harness.transport).closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: OPEN_TIMEOUT_REASON },
    ]);
    expect(harness.client.state).toBe('reconnecting');
  });

  it('survives a stalled socket whose close throws', () => {
    const harness = createHarness();
    harness.client.connect();
    latestSocket(harness.transport).throwOnClose = true;

    expect(() => {
      harness.timers.fire(pendingOpenDeadline(harness));
    }).not.toThrow();

    expect(harness.client.state).toBe('reconnecting');
    expect(harness.events.logs.map((record) => record.message)).toContain('websocket close failed');
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
  });

  it('ignores a late open from a timed-out socket whose listeners the runtime kept', () => {
    const provider = vi.fn(() => TOKEN);
    const harness = createHarness({ token: provider });
    harness.client.connect();
    const stalled = latestSocket(harness.transport);
    stalled.throwOnRemove = true;

    harness.timers.fire(pendingOpenDeadline(harness));
    expect(stalled.listenerCount()).toBe(4);
    const statesBefore = harness.events.states.length;

    stalled.open();

    // No handshake on a socket the client let go of: no credential read, no
    // frame, no state change, and still only the reconnect delay pending.
    expect(provider).not.toHaveBeenCalled();
    expect(stalled.sent).toEqual([]);
    expect(harness.events.states).toHaveLength(statesBefore);
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
  });

  it('ignores a late 4401 and a late frame from a timed-out socket whose listeners the runtime kept', () => {
    const harness = createHarness();
    harness.client.connect();
    const stalled = latestSocket(harness.transport);
    stalled.throwOnRemove = true;

    harness.timers.fire(pendingOpenDeadline(harness));
    expect(stalled.listenerCount()).toBe(4);
    const statesBefore = harness.events.states.length;

    stalled.receive(progressFrame());
    stalled.drop(WS_CLOSE_UNAUTHORIZED, 'late refusal from a retired socket');

    // The retired socket speaks for nothing: no dispatch, no unauthorized
    // signal, no terminal state — the scheduled retry stands and runs.
    expect(harness.events.messages).toEqual([]);
    expect(harness.events.unauthorized).toEqual([]);
    expect(harness.events.states).toHaveLength(statesBefore);
    expect(harness.client.state).toBe('reconnecting');
    const retry = harness.timers.onlyPending();
    expect(retry.ms).toBe(NOMINAL_CURVE[0]);

    harness.timers.fire(retry);
    expect(harness.transport.sockets).toHaveLength(2);
    expect(latestSocket(harness.transport)).not.toBe(stalled);
  });

  it('ignores a late 4401 from a socket retired by restart() whose listeners the runtime kept', () => {
    const harness = createHarness();
    const socket = connectAndOpen(harness);
    socket.throwOnRemove = true;

    harness.client.restart('the owner found the peer unresponsive');
    socket.drop(WS_CLOSE_UNAUTHORIZED, 'late refusal from a retired socket');

    expect(harness.events.unauthorized).toEqual([]);
    expect(harness.client.state).toBe('reconnecting');
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
  });

  it('honours a configured openTimeoutMs', () => {
    const harness = createHarness({ openTimeoutMs: 1_234 });
    harness.client.connect();

    harness.timers.fire(pendingOpenDeadline(harness, 1_234));

    expect(harness.events.errors[0]?.details).toEqual({ timeoutMs: 1_234 });
    expect(harness.client.state).toBe('reconnecting');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the default for an unusable openTimeoutMs of %s',
    (configured) => {
      const harness = createHarness({ openTimeoutMs: configured });
      harness.client.connect();

      pendingOpenDeadline(harness);
    },
  );

  it('runs on the platform timers when none are injected, and dies with close()', () => {
    vi.useFakeTimers();

    try {
      const transport = createTransport();
      const errors: DebuggenError[] = [];
      const client = new ReconnectingWsClient({
        url: SERVICE_URL,
        webSocketConstructor: transport.webSocketConstructor,
        identity: DEVTOOLS_IDENTITY,
        token: TOKEN,
        random: () => 1,
        onProtocolError: (error) => {
          errors.push(error);
        },
      });

      client.connect();
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(DEFAULT_WS_OPEN_TIMEOUT_MS - 1);
      expect(latestSocket(transport).closeCalls).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(latestSocket(transport).closeCalls).toEqual([
        { code: NORMAL_CLOSURE, reason: OPEN_TIMEOUT_REASON },
      ]);
      expect(errors.map((error) => error.code)).toEqual(['TRANSPORT_DISCONNECTED']);
      expect(client.state).toBe('reconnecting');

      vi.advanceTimersByTime(DEFAULT_WS_BACKOFF.initialMs);
      expect(transport.sockets).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(1);

      client.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Moving to another endpoint, and an owner-driven restart
// ---------------------------------------------------------------------------

describe('setUrl: moving a client to another service endpoint', () => {
  it('changes nothing when the value canonicalises to the current endpoint', () => {
    const harness = createHarness();
    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    const socket = latestSocket(harness.transport);
    const deadline = pendingOpenDeadline(harness);
    const statesBefore = harness.events.states.length;

    expect(harness.client.setUrl(`  ${SOCKET_URL}  `)).toEqual({ ok: true, value: SOCKET_URL });

    expect(harness.transport.sockets).toEqual([socket]);
    expect(socket.closeCalls).toEqual([]);
    expect(harness.client.queuedCount).toBe(1);
    expect(harness.events.drops).toEqual([]);
    expect(harness.events.states).toHaveLength(statesBefore);
    expect(harness.timers.onlyPending()).toBe(deadline);
  });

  it('moves a connecting client at once, dropping the frames queued for the old endpoint', () => {
    const harness = createHarness();
    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    harness.client.send('session.unbind', { tabId: 2 });
    const previous = latestSocket(harness.transport);
    const previousDeadline = pendingOpenDeadline(harness);

    expect(harness.client.setUrl(OTHER_SERVICE_URL)).toEqual({
      ok: true,
      value: OTHER_SOCKET_URL,
    });

    expect(harness.client.url).toBe(OTHER_SOCKET_URL);
    expect(harness.client.configurationError).toBeUndefined();
    // The old socket is retired with a constant reason, its deadline with it.
    expect(previous.closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: ENDPOINT_CHANGED_REASON },
    ]);
    expect(previous.listenerCount()).toBe(0);
    expect(previousDeadline.status).toBe('cleared');
    // Every queued frame is reported, oldest first, counting down to zero.
    expect(harness.events.drops).toEqual([
      { type: 'session.unbind', queued: 1 },
      { type: 'session.unbind', queued: 0 },
    ]);
    expect(harness.client.queuedCount).toBe(0);
    // A socket against the new endpoint exists already, with its own deadline.
    const moved = latestSocket(harness.transport);
    expect(moved).not.toBe(previous);
    expect(moved.url).toBe(OTHER_SOCKET_URL);
    expect(harness.client.state).toBe('connecting');
    pendingOpenDeadline(harness);

    moved.open();
    expect(sentTypes(moved)).toEqual(['client.hello']);
    expect(harness.client.state).toBe('open');
    expect(reportedText(harness)).not.toContain(TOKEN);
  });

  it('moves an open client, and its late events are ignored', () => {
    const harness = createHarness();
    const previous = connectAndOpen(harness);

    harness.client.setUrl(OTHER_SERVICE_URL);
    const moved = latestSocket(harness.transport);
    const statesBefore = harness.events.states.length;

    previous.drop(ABNORMAL_CLOSURE);
    previous.receive(progressFrame());

    expect(previous.closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: ENDPOINT_CHANGED_REASON },
    ]);
    expect(harness.events.states).toHaveLength(statesBefore);
    expect(harness.events.messages).toEqual([]);
    expect(moved.url).toBe(OTHER_SOCKET_URL);
    moved.open();
    expect(harness.client.state).toBe('open');
  });

  it('cancels a pending reconnect and starts the curve over at the new endpoint', () => {
    const harness = createHarness();
    failConsecutiveAttempts(harness, 3);
    latestSocket(harness.transport).drop(ABNORMAL_CLOSURE);
    const reconnect = harness.timers.onlyPending();
    expect(reconnect.ms).toBe(NOMINAL_CURVE[3]);

    harness.client.setUrl(OTHER_SERVICE_URL);

    expect(reconnect.status).toBe('cleared');
    expect(latestSocket(harness.transport).url).toBe(OTHER_SOCKET_URL);
    expect(harness.client.state).toBe('connecting');

    latestSocket(harness.transport).drop(ABNORMAL_CLOSURE);
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
  });

  it('stops a connected client on a refused endpoint, reporting the rule and never the value', () => {
    const marker = 'setUrlLeakMarker';
    const harness = createHarness();
    const socket = connectAndOpen(harness);

    const refused = harness.client.setUrl(`http://${marker}.example.com:43117`);

    expect(refused.ok).toBe(false);
    expect(harness.client.url).toBeUndefined();
    expect(harness.client.configurationError?.code).toBe('CONFIG_INVALID');
    expect(harness.client.configurationError?.details).toEqual({ rule: 'not-loopback' });
    expect(socket.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: ENDPOINT_CHANGED_REASON }]);
    expect(harness.client.state).toBe('closed');
    expect(harness.events.states.at(-1)).toEqual({
      state: 'closed',
      detail: { reason: CONFIGURATION_REFUSED_REASON },
    });
    expect(harness.events.errors.map((error) => error.code)).toEqual(['CONFIG_INVALID']);
    expect(harness.timers.pending()).toEqual([]);

    // Nothing can be opened against it, and nothing quotes it.
    harness.client.connect();
    expect(harness.transport.sockets).toHaveLength(1);
    expect(reportedText(harness)).not.toContain(marker);
    if (!refused.ok) {
      expect(describeError(refused.error)).not.toContain(marker);
    }
  });

  it('only records the endpoint on a closed client, which the next connect() uses', () => {
    const harness = createHarness();

    expect(harness.client.setUrl(OTHER_SERVICE_URL).ok).toBe(true);

    expect(harness.transport.constructions()).toBe(0);
    expect(harness.events.states).toEqual([]);
    expect(harness.timers.scheduled).toEqual([]);

    harness.client.connect();
    expect(latestSocket(harness.transport).url).toBe(OTHER_SOCKET_URL);
  });

  it('drops the frames a refused credential kept, once the endpoint changes', () => {
    const harness = createHarness();
    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    latestSocket(harness.transport).drop(WS_CLOSE_UNAUTHORIZED, 'not paired');
    expect(harness.client.queuedCount).toBe(1);

    harness.client.setUrl(OTHER_SERVICE_URL);

    expect(harness.events.drops).toEqual([{ type: 'session.unbind', queued: 0 }]);
    expect(harness.client.queuedCount).toBe(0);
    expect(harness.transport.sockets).toHaveLength(1);
    expect(harness.client.state).toBe('closed');
  });

  it('refuses silently on a closed client; the next connect() reports the refusal', () => {
    const harness = createHarness();

    const refused = harness.client.setUrl('wss://service.example.com/ws');

    expect(refused.ok).toBe(false);
    expect(harness.events.errors).toEqual([]);
    expect(harness.events.states).toEqual([]);

    harness.client.connect();
    expect(harness.transport.constructions()).toBe(0);
    expect(harness.events.errors.map((error) => error.code)).toEqual(['CONFIG_INVALID']);
  });

  it('lets a client built with a refused URL recover once a loopback one is supplied', () => {
    const harness = createHarness({ url: 'wss://service.example.com/ws' });
    harness.client.connect();
    expect(harness.transport.constructions()).toBe(0);

    expect(harness.client.setUrl(SERVICE_URL)).toEqual({ ok: true, value: SOCKET_URL });
    expect(harness.client.configurationError).toBeUndefined();

    const socket = connectAndOpen(harness);
    expect(socket.url).toBe(SOCKET_URL);
    expect(sentTypes(socket)).toEqual(['client.hello']);
    expect(harness.client.state).toBe('open');
  });
});

describe('restart: the owner retires a socket it found dead', () => {
  it('retires an open socket onto the backoff curve and reconnects', () => {
    const harness = createHarness();
    const dead = connectAndOpen(harness);

    harness.client.restart(RESTART_REASON);

    expect(dead.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: RESTART_REASON }]);
    expect(dead.listenerCount()).toBe(0);
    expect(harness.client.state).toBe('reconnecting');
    expect(harness.events.states.at(-1)).toEqual({
      state: 'reconnecting',
      detail: { attempt: 1, delayMs: NOMINAL_CURVE[0], reason: RESTART_REASON },
    });
    const reconnect = harness.timers.onlyPending();
    expect(reconnect.ms).toBe(NOMINAL_CURVE[0]);

    // A late close of the retired socket schedules nothing further.
    dead.drop(ABNORMAL_CLOSURE);
    expect(harness.timers.onlyPending()).toBe(reconnect);

    harness.timers.fire(reconnect);
    latestSocket(harness.transport).open();
    expect(harness.client.state).toBe('open');
    expect(harness.transport.sockets).toHaveLength(2);
  });

  it('keeps the queued frames and delivers them after the next hello', () => {
    const harness = createHarness();
    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    harness.client.send('session.unbind', { tabId: 2 });
    const deadline = pendingOpenDeadline(harness);

    harness.client.restart(RESTART_REASON);

    expect(deadline.status).toBe('cleared');
    expect(harness.client.queuedCount).toBe(2);
    expect(harness.events.drops).toEqual([]);

    harness.timers.fire(harness.timers.onlyPending());
    const next = latestSocket(harness.transport);
    next.open();
    expect(sentTypes(next)).toEqual(['client.hello', 'session.unbind', 'session.unbind']);
    expect(sentUnbindTabIds(next)).toEqual([1, 2]);
  });

  it('cancels a credential read in flight', async () => {
    const read = deferred<string | undefined>();
    const harness = createHarness({ token: () => read.promise });
    const socket = connectAndOpen(harness);
    const credentialDeadline = harness.timers.onlyPending();

    harness.client.restart(RESTART_REASON);
    expect(credentialDeadline.status).toBe('cleared');

    read.resolve(TOKEN);
    await flushMicrotasks();
    expect(socket.sent).toEqual([]);
    expect(harness.client.state).toBe('reconnecting');
    expect(harness.timers.onlyPending().ms).toBe(NOMINAL_CURVE[0]);
  });

  it('leaves a reconnecting client to its curve, and a closed one alone', () => {
    const idle = createHarness();
    idle.client.restart(RESTART_REASON);
    expect(idle.events.states).toEqual([]);
    expect(idle.timers.scheduled).toEqual([]);

    const harness = createHarness();
    connectAndOpen(harness).drop(ABNORMAL_CLOSURE);
    const reconnect = harness.timers.onlyPending();
    const statesBefore = harness.events.states.length;

    harness.client.restart(RESTART_REASON);
    expect(harness.timers.onlyPending()).toBe(reconnect);
    expect(harness.events.states).toHaveLength(statesBefore);

    harness.client.close();
    harness.client.restart(RESTART_REASON);
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.client.state).toBe('closed');

    const refused = createHarness();
    connectAndOpen(refused).drop(WS_CLOSE_UNAUTHORIZED, 'revoked');
    refused.client.restart(RESTART_REASON);
    expect(refused.client.state).toBe('closed');
    expect(refused.timers.pending()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Inbound frames
// ---------------------------------------------------------------------------

describe('inbound frames', () => {
  const marker = 'inbound-frame-marker';

  const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
    ['text that is not JSON', `{"not json ${marker}`],
    [
      'JSON that is not a valid envelope',
      JSON.stringify({ id: marker, type: 'session.unbind', ts: 1, payload: { marker } }),
    ],
    ['an object instead of text', { type: 'session.unbind', marker }],
    ['bytes that are not valid UTF-8', new Uint8Array([0xc3, 0x28, 0xff])],
  ];

  it.each(MALFORMED)(
    'reports %s, dispatches nothing and keeps the connection',
    (_name, data: unknown) => {
      const handler = vi.fn();
      const harness = createHarness();
      harness.client.on('session.unbind', handler);
      const socket = connectAndOpen(harness);

      socket.receive(data);

      expect(harness.events.errors.map((error) => error.code)).toEqual([
        'PROTOCOL_INVALID_MESSAGE',
      ]);
      expect(handler).not.toHaveBeenCalled();
      expect(harness.events.messages).toEqual([]);
      expect(socket.closeCalls).toEqual([]);
      expect(harness.client.state).toBe('open');
      expect(reportedText(harness)).not.toContain(marker);
    },
  );

  it('decodes valid UTF-8 JSON bytes, as a view and as an ArrayBuffer', () => {
    const handler = vi.fn();
    const harness = createHarness();
    harness.client.on('session.progress', handler);
    const socket = connectAndOpen(harness);
    const bytes = new TextEncoder().encode(progressFrame('from bytes'));

    socket.receive(bytes);
    socket.receive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    expect(harness.events.errors).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('reports binary frames in a runtime with no TextDecoder', () => {
    vi.stubGlobal('TextDecoder', undefined);

    try {
      const harness = createHarness();
      const socket = connectAndOpen(harness);

      socket.receive(new TextEncoder().encode(progressFrame()));

      expect(harness.events.errors.map((error) => error.message)).toEqual([
        'Dropped an inbound binary frame: this runtime provides no TextDecoder to read it with',
      ]);
      expect(harness.events.messages).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Typed dispatch
// ---------------------------------------------------------------------------

describe('typed dispatch', () => {
  it('narrows each frame to its type, calling onMessage before the handlers', () => {
    const order: string[] = [];
    const harness = createHarness({
      onMessage: (message) => {
        order.push(`onMessage:${message.type}`);
      },
    });
    harness.client.on('session.progress', (message) => {
      // Compiles only because the frame is narrowed: `stage` exists on this
      // payload alone.
      const stage: string = message.payload.stage;
      order.push(`progress:${stage}`);
    });
    harness.client.on('tab.navigated', (message) => {
      order.push(`navigated:${message.payload.tabId}`);
    });
    const socket = connectAndOpen(harness);

    socket.receive(progressFrame());
    socket.receive(navigatedFrame());

    expect(order).toEqual([
      'onMessage:session.progress',
      'progress:investigate',
      'onMessage:tab.navigated',
      `navigated:${TAB_ID}`,
    ]);
  });

  it('runs every handler of a type, and unsubscribes one without disturbing the others', () => {
    const first = vi.fn();
    const second = vi.fn();
    const harness = createHarness();
    const stopFirst = harness.client.on('session.progress', first);
    const stopSecond = harness.client.on('session.progress', second);
    const socket = connectAndOpen(harness);

    socket.receive(progressFrame());
    stopFirst();
    stopFirst();
    socket.receive(progressFrame());
    stopSecond();
    // The type now has no subscriber at all; a second call is still harmless.
    stopSecond();
    socket.receive(progressFrame());

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(harness.events.messages).toHaveLength(3);
  });

  it('lets a handler unsubscribe itself mid-dispatch without skipping the next one', () => {
    const calls: string[] = [];
    const harness = createHarness();
    const stop = harness.client.on('session.progress', () => {
      calls.push('self-removing');
      stop();
    });
    harness.client.on('session.progress', () => {
      calls.push('next');
    });
    const socket = connectAndOpen(harness);

    socket.receive(progressFrame());
    socket.receive(progressFrame());

    expect(calls).toEqual(['self-removing', 'next', 'next']);
  });

  it('reports a throwing handler as INTERNAL while the others still run', () => {
    const survivor = vi.fn();
    const harness = createHarness();
    harness.client.on('session.progress', () => {
      throw new Error('handler bug');
    });
    harness.client.on('session.progress', survivor);
    const socket = connectAndOpen(harness);

    socket.receive(progressFrame());

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(harness.events.errors.map((error) => error.code)).toEqual(['INTERNAL']);
    expect(harness.client.state).toBe('open');
  });

  it('is not broken by hooks that throw', () => {
    const fail = (): never => {
      throw new Error('consumer hook bug');
    };
    const harness = createHarness({
      maxQueuedMessages: 1,
      onStateChange: fail,
      onMessage: fail,
      onProtocolError: fail,
      onUnauthorized: fail,
      onQueueDrop: fail,
    });

    harness.client.connect();
    harness.client.send('session.unbind', { tabId: 1 });
    harness.client.send('session.unbind', { tabId: 2 });
    const socket = latestSocket(harness.transport);

    expect(() => {
      socket.open();
      socket.receive(progressFrame());
      socket.receive('not json');
      socket.drop(WS_CLOSE_UNAUTHORIZED, 'revoked');
    }).not.toThrow();

    expect(sentTypes(socket)).toEqual(['client.hello', 'session.unbind']);
    expect(harness.client.state).toBe('closed');
    expect(harness.events.drops).toHaveLength(1);
    expect(harness.events.unauthorized).toHaveLength(1);
    expect(
      harness.events.logs.filter((record) => record.message === 'websocket client hook failed')
        .length,
    ).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// State events
// ---------------------------------------------------------------------------

describe('state events', () => {
  it('names exactly four states', () => {
    expect(CONNECTION_STATES).toEqual(['connecting', 'open', 'reconnecting', 'closed']);
  });

  it('reports each transition with its detail, after the state has changed', () => {
    const harness = createHarness();
    expect(harness.client.state).toBe('closed');
    expect(harness.client.lastCloseCode).toBeUndefined();

    const socket = connectAndOpen(harness);
    socket.drop(ABNORMAL_CLOSURE, 'service restarted');
    harness.timers.fire(harness.timers.onlyPending());
    latestSocket(harness.transport).open();
    harness.client.close();

    expect(harness.events.states).toEqual([
      { state: 'connecting', detail: undefined },
      { state: 'open', detail: undefined },
      {
        state: 'reconnecting',
        detail: {
          attempt: 1,
          delayMs: NOMINAL_CURVE[0],
          code: ABNORMAL_CLOSURE,
          reason: 'service restarted',
        },
      },
      { state: 'open', detail: undefined },
      { state: 'closed', detail: { code: NORMAL_CLOSURE } },
    ]);
    // Each hook saw the client already in the state it was told about.
    expect(harness.events.observedStates).toEqual(
      harness.events.states.map((event) => event.state),
    );
    expect(harness.client.lastCloseCode).toBe(NORMAL_CLOSURE);
  });

  it('records the last close code the service sent', () => {
    const harness = createHarness();
    connectAndOpen(harness).drop(ABNORMAL_CLOSURE);

    expect(harness.client.lastCloseCode).toBe(ABNORMAL_CLOSURE);
  });
});

// ---------------------------------------------------------------------------
// The loopback-only service origin (R1-F09, R5-F04)
// ---------------------------------------------------------------------------

/** One configured value the loopback-only policy must refuse. */
interface RefusedUrlCase {
  /** What the value is, for the case title. */
  readonly name: string;
  /** The `details.rule` the refusal must name. */
  readonly rule: string;
  /** Builds the value around a unique marker, which must never be echoed. */
  readonly url: (marker: string) => string;
}

/**
 * Every shape of configured value that must never receive the credential.
 *
 * The userinfo cases assemble their URL from fragments at run time: a complete
 * URI with a user and password written out in this file would be a
 * `scripts/check-secrets.mjs` finding in its own right.
 */
const REFUSED_URLS: readonly RefusedUrlCase[] = [
  { name: 'a public host name', rule: 'not-loopback', url: (m) => `wss://${m}.example.com/ws` },
  {
    name: 'a public IPv4 address',
    rule: 'not-loopback',
    url: (m) => `http://203.0.113.7:43117/${m}`,
  },
  {
    name: 'a private IPv4 address',
    rule: 'not-loopback',
    url: (m) => `ws://192.168.1.20:43117/ws?${m}`,
  },
  {
    name: 'another private IPv4 block',
    rule: 'not-loopback',
    url: (m) => `http://10.0.0.5:43117/${m}`,
  },
  {
    name: 'the unspecified address',
    rule: 'not-loopback',
    url: (m) => `http://0.0.0.0:43117/${m}`,
  },
  {
    name: 'an IPv4-mapped private address',
    rule: 'not-loopback',
    url: (m) => `http://[::ffff:10.0.0.1]:43117/${m}`,
  },
  {
    name: 'localhost with a trailing dot',
    rule: 'not-loopback',
    url: (m) => `http://localhost.:43117/${m}`,
  },
  {
    name: 'a public name that starts like a loopback address',
    rule: 'not-loopback',
    url: (m) => `http://127.0.0.1.${m}.example:43117`,
  },
  {
    name: 'a user name and password',
    rule: 'userinfo',
    url: (m) => 'ws://' + [m, 'p'].join(':') + '@' + '127.0.0.1:43117' + WS_PATH,
  },
  {
    name: 'a user name alone',
    rule: 'userinfo',
    url: (m) => 'http://' + m + '@' + '127.0.0.1:43117',
  },
  // An empty userinfo is erased by the URL parser, so these are refused on the
  // authority as written; each would otherwise open a socket to the loopback
  // host and send the hello frame.
  { name: 'an empty user name', rule: 'userinfo', url: () => `ws://@127.0.0.1:43117${WS_PATH}` },
  {
    name: 'an empty user name and password',
    rule: 'userinfo',
    url: () => 'http://' + ':' + '@' + '127.0.0.1:43117',
  },
  {
    name: 'a special scheme written without slashes',
    rule: 'unparseable',
    url: () => `ws:127.0.0.1:43117${WS_PATH}`,
  },
  { name: 'a tab inside the value', rule: 'unparseable', url: () => 'ws://127.0.0.1:43\t117/ws' },
  { name: 'a path other than /ws', rule: 'path', url: (m) => `ws://127.0.0.1:43117/${m}` },
  // Paths the parser normalises to /ws, refused as written.
  {
    name: 'a path that dot-segments back to /ws',
    rule: 'path',
    url: (m) => `ws://127.0.0.1:43117/${m}/..${WS_PATH}`,
  },
  { name: 'a dot segment before /ws', rule: 'path', url: () => `ws://127.0.0.1:43117/.${WS_PATH}` },
  { name: 'a backslash before ws', rule: 'path', url: () => 'ws://127.0.0.1:43117\\ws' },
  {
    name: 'an encoded dot segment before /ws',
    rule: 'path',
    url: () => `ws://127.0.0.1:43117/%2e${WS_PATH}`,
  },
  {
    name: 'a trailing slash after /ws',
    rule: 'path',
    url: (m) => `ws://127.0.0.1:43117${WS_PATH}/${m}/`,
  },
  {
    name: 'a query',
    rule: 'query-or-fragment',
    url: (m) => `ws://127.0.0.1:43117${WS_PATH}?${m}=1`,
  },
  {
    name: 'an empty query',
    rule: 'query-or-fragment',
    url: () => 'http://127.0.0.1:43117/?',
  },
  {
    name: 'a fragment',
    rule: 'query-or-fragment',
    url: (m) => `ws://127.0.0.1:43117${WS_PATH}#${m}`,
  },
  { name: 'an unsupported scheme', rule: 'scheme', url: (m) => `ftp://127.0.0.1:43117/${m}` },
  { name: 'text that is not a URL', rule: 'unparseable', url: (m) => `not a url ${m}` },
  { name: 'an empty value', rule: 'empty', url: () => '' },
  { name: 'whitespace alone', rule: 'empty', url: () => '   ' },
];

describe('the loopback-only service origin', () => {
  it.each(REFUSED_URLS.map((entry, index) => ({ ...entry, marker: `leakmark${index}q` })))(
    '$name: the constructor records the refusal and connect() constructs no socket',
    ({ rule, url, marker }) => {
      const provider = vi.fn(() => TOKEN);

      expect(() => {
        createHarness({ url: url(marker), token: provider });
      }).not.toThrow();

      const harness = createHarness({ url: url(marker), token: provider });
      const { client, transport, timers, events } = harness;
      expect(client.url).toBeUndefined();
      expect(client.configurationError?.code).toBe('CONFIG_INVALID');
      expect(client.configurationError?.details).toEqual({ rule });

      client.connect();
      client.connect();

      expect(transport.constructions()).toBe(0);
      expect(transport.sockets).toEqual([]);
      expect(provider).not.toHaveBeenCalled();
      expect(timers.scheduled).toEqual([]);
      expect(events.unauthorized).toEqual([]);
      expect(events.errors).toHaveLength(2);
      expect(events.errors[0]).toBe(client.configurationError);
      expect(events.states).toEqual([
        { state: 'closed', detail: { reason: CONFIGURATION_REFUSED_REASON } },
        { state: 'closed', detail: { reason: CONFIGURATION_REFUSED_REASON } },
      ]);
      expect(client.state).toBe('closed');
      expect(client.lastCloseCode).toBeUndefined();
      expect(client.send('session.unbind', { tabId: TAB_ID }).ok).toBe(false);
      expect(reportedText(harness)).not.toContain(marker);
      expect(reportedText(harness)).not.toContain(TOKEN);
    },
  );

  it.each(REFUSED_URLS.map((entry, index) => ({ ...entry, marker: `leakmark${index}r` })))(
    '$name: resolveWsUrl refuses it with the same rule and without echoing it',
    ({ rule, url, marker }) => {
      const resolved = resolveWsUrl(url(marker));

      expect(resolved.ok).toBe(false);

      if (!resolved.ok) {
        expect(resolved.error.code).toBe('CONFIG_INVALID');
        expect(resolved.error.details).toEqual({ rule });
        expect(describeError(resolved.error)).not.toContain(marker);
      }
    },
  );

  it('refuses a value that is not text at all, without throwing', () => {
    const notText = undefined as unknown as string;

    const resolved = resolveWsUrl(notText);
    expect(resolved.ok).toBe(false);

    if (!resolved.ok) {
      expect(resolved.error.code).toBe('CONFIG_INVALID');
      expect(resolved.error.details).toEqual({ rule: 'unparseable' });
    }

    // Built directly: the harness would substitute its default URL for
    // `undefined`, which is exactly the value under test.
    const transport = createTransport();
    const errors: DebuggenError[] = [];
    const client = new ReconnectingWsClient({
      url: notText,
      webSocketConstructor: transport.webSocketConstructor,
      identity: DEVTOOLS_IDENTITY,
      token: TOKEN,
      timers: new FakeTimers(),
      onProtocolError: (error) => {
        errors.push(error);
      },
    });

    client.connect();

    expect(client.url).toBeUndefined();
    expect(client.configurationError?.details).toEqual({ rule: 'unparseable' });
    expect(transport.constructions()).toBe(0);
    expect(errors.map((error) => error.code)).toEqual(['CONFIG_INVALID']);
    expect(client.state).toBe('closed');
  });

  it('is silent on close() and sends nothing to the service when refused', () => {
    const harness = createHarness({ url: 'wss://service.example.com/ws' });

    harness.client.connect();
    harness.client.close();

    expect(harness.events.states).toHaveLength(1);
    expect(harness.transport.sockets).toEqual([]);
  });

  const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
    ['http://127.0.0.1:43117', 'ws://127.0.0.1:43117/ws'],
    ['http://127.0.0.1:43117/', 'ws://127.0.0.1:43117/ws'],
    ['https://localhost:8443', 'wss://localhost:8443/ws'],
    ['ws://127.0.0.1:43117/ws', 'ws://127.0.0.1:43117/ws'],
    ['wss://[::1]:9443/ws', 'wss://[::1]:9443/ws'],
    ['http://127.0.0.1:43117/ws', 'ws://127.0.0.1:43117/ws'],
    ['http://127.255.255.254:43117', 'ws://127.255.255.254:43117/ws'],
    ['http://[::ffff:127.0.0.1]:43117', 'ws://[::ffff:7f00:1]:43117/ws'],
    ['HTTP://LOCALHOST:43117', 'ws://localhost:43117/ws'],
    ['http://127.0.0.1:80', 'ws://127.0.0.1/ws'],
    ['wss://127.0.0.1:443/ws', 'wss://127.0.0.1/ws'],
    ['  ws://127.0.0.1:43117/ws  ', 'ws://127.0.0.1:43117/ws'],
  ];

  it.each(ACCEPTED)('resolves %s to %s, idempotently', (input, expected) => {
    expect(resolveWsUrl(input)).toEqual({ ok: true, value: expected });
    expect(resolveWsUrl(expected)).toEqual({ ok: true, value: expected });
  });

  it.each(ACCEPTED)(
    'canonicalises a configured %s before opening the socket',
    (input, expected) => {
      const harness = createHarness({ url: input });

      expect(harness.client.url).toBe(expected);
      expect(harness.client.configurationError).toBeUndefined();

      harness.client.connect();
      expect(latestSocket(harness.transport).url).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// Privacy (AAP 0.5.2)
// ---------------------------------------------------------------------------

describe('the credential never leaves the hello frame', () => {
  it('appears in no log record, error, state detail or unauthorized detail', async () => {
    const pendingRead = deferred<string | undefined>();
    const reads: Array<() => string | undefined | Promise<string | undefined>> = [
      () => TOKEN,
      () => {
        throw new Error(`the stored credential ${TOKEN} could not be read`);
      },
      () => pendingRead.promise,
      () => TOKEN,
    ];
    let call = 0;
    const harness = createHarness({
      token: () => {
        const read = reads[call];
        call += 1;
        return read === undefined ? undefined : read();
      },
    });

    // A successful hello, a malformed frame, a refusal by the service.
    const first = connectAndOpen(harness);
    first.receive(`{"token":"${TOKEN}"`);
    first.receive(JSON.stringify({ type: 'client.hello', payload: { token: TOKEN } }));
    first.drop(WS_CLOSE_UNAUTHORIZED, 'credential expired');

    // A provider that throws with the credential in its message.
    connectAndOpen(harness);

    // A provider that stalls past the deadline.
    connectAndOpen(harness);
    harness.timers.fire(harness.timers.onlyPending());
    await flushMicrotasks();
    pendingRead.resolve(TOKEN);
    await flushMicrotasks();

    // A connection that drops and reconnects.
    const last = connectAndOpen(harness);
    last.drop(ABNORMAL_CLOSURE, 'service restarted');
    harness.client.close();

    // The scan can see the credential where it belongs, so its absence
    // everywhere else is meaningful.
    expect(helloPayload(decodeSent(first)[0]).token).toBe(TOKEN);
    expect(harness.events.errors.length).toBeGreaterThanOrEqual(3);
    expect(harness.events.logs.length).toBeGreaterThan(0);
    expect(reportedText(harness)).not.toContain(TOKEN);
  });

  it('is kept out of the rejection of an invalid hello payload', () => {
    const harness = createHarness({
      identity: { client: 'devtools', projectRoot: 'relative/path', tabId: -1 },
    });

    connectAndOpen(harness);

    expect(harness.events.errors).toHaveLength(1);
    expect(reportedText(harness)).not.toContain(TOKEN);
  });
});
