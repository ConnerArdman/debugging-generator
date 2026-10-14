/**
 * Tests for the connection retention of `./client.ts`: the rules that keep a
 * socket announcing the project to the service that owns a session for as
 * long as a request to that service needs the announcement (AAP §0.5.1,
 * §0.5.6 — the service admits an editor's session request only while one of
 * its live sockets announces the project).
 *
 * - **Disposal defers the close.** `dispose()` releases listeners at once but
 *   closes the sockets only once every operation registered with
 *   `keepConnectionsFor` settled, and after `CONNECTION_HOLD_TIMEOUT_MS` at the
 *   latest; HTTP keeps working meanwhile.
 * - **The retained endpoint keeps its socket.** `setBaseUrl` away from the
 *   service `retainedEndpoint` names keeps its socket open, a request addressed
 *   there travels while it is open, `pruneRetainedConnections` closes it once
 *   the retained endpoint moved on, and switching back reuses it.
 * - **Another service gets an announcement first.** A session request to a
 *   non-current endpoint with no socket opens one and is sent only once it is
 *   open — bounded — and is repeated exactly once when it was refused
 *   `PATH_OUTSIDE_PROJECT` while that socket had only just opened.
 * - **No credential in a log record**, whatever the path.
 *
 * ## The substitutes
 *
 * The client imports `vscode` only for its default configuration source, which
 * every case replaces, so `vi.mock` supplies an inert module. The socket is a
 * scripted {@link FakeWebSocket} (the case fires `open` itself) and HTTP a
 * scripted {@link FetchLike} that records, for every request, which sockets
 * were open when it left.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MODIFICATIONS_PAGE_DEFAULT_LIMIT } from '@debuggen/protocol';
import type {
  FetchLike,
  HttpFetchInit,
  HttpResponseLike,
  WebSocketConstructorLike,
  WebSocketLike,
  WsEventMapLike,
} from '@debuggen/protocol';
import { isOk, ok } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';

import {
  ANNOUNCEMENT_SETTLE_DELAY_MS,
  CONNECTION_HOLD_TIMEOUT_MS,
  ENDPOINT_SOCKET_OPEN_TIMEOUT_MS,
  createServiceClient,
} from './client';
import type { ServiceClient, ServiceClientConfiguration, ServiceCredential } from './client';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The editor credential every case presents; asserted absent from every log
 * record. Assembled from low-entropy parts, so the repository's secret scan
 * never mistakes a fixture for a committed credential.
 */
const TOKEN = ['editor', 'credential', 'retention', 'sentinel'].join('_');

/** The service `debuggen.serviceUrl` names at the start of a case. */
const SERVICE_A = 'http://127.0.0.1:43117';

/** A second service on the same machine. */
const SERVICE_B = 'http://127.0.0.1:43118';

/** The project every socket announces. */
const PROJECT_ROOT = '/workspace/client-fixture';

/** The session every request is about. */
const SESSION_ID = 'ses_client_fixture';

/** The close reason of a disposal, as the service logs it. */
const DISPOSED_CLOSE_REASON = 'the editor client was disposed';

/** The close reason of a released kept socket. */
const RETAINED_RELEASED_CLOSE_REASON = 'the editor no longer tracks a session at this service';

/** The close reason of a replaced socket that is not kept. */
const REPLACED_CLOSE_REASON = 'the editor client is reconnecting with a new configuration';

/** The WebSocket close code the protocol client closes with: normal closure. */
const NORMAL_CLOSURE = 1000;

/** The WebSocket API's `readyState` values. */
const READY_STATE = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 });

/** One `close()` the client made on a socket. */
interface CloseCall {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

type ListenerSets = {
  [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void>;
};

/**
 * A socket the case drives: it opens only when {@link FakeWebSocket.open} is
 * called, records every frame and every close, and refuses a write unless open.
 */
class FakeWebSocket implements WebSocketLike {
  readyState: number = READY_STATE.connecting;
  readonly sent: string[] = [];
  readonly closeCalls: CloseCall[] = [];
  readonly #listeners: ListenerSets = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  constructor(readonly url: string) {}

  addEventListener<K extends keyof WsEventMapLike>(
    type: K,
    listener: (event: WsEventMapLike[K]) => void,
  ): void {
    this.#listeners[type].add(listener);
  }

  removeEventListener<K extends keyof WsEventMapLike>(
    type: K,
    listener: (event: WsEventMapLike[K]) => void,
  ): void {
    this.#listeners[type].delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== READY_STATE.open) {
      throw new Error('the socket is not open');
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = READY_STATE.closing;
  }

  /** Whether the client has not closed this socket. */
  get live(): boolean {
    return this.closeCalls.length === 0;
  }

  /** The transport opened: the client writes its hello next. */
  open(): void {
    this.readyState = READY_STATE.open;
    for (const listener of [...this.#listeners.open]) {
      listener({ type: 'open' });
    }
  }
}

/** A socket constructor bound to one case, and every socket it built. */
interface SocketFactory {
  readonly constructor: WebSocketConstructorLike;
  readonly sockets: FakeWebSocket[];
  /** The sockets opened for `origin`'s service, in creation order. */
  to(origin: string): FakeWebSocket[];
}

function socketFactory(): SocketFactory {
  const sockets: FakeWebSocket[] = [];
  class RecordedWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  return {
    constructor: RecordedWebSocket,
    sockets,
    to: (origin) => {
      const socketUrl = `${origin.replace(/^http/, 'ws')}/ws`;
      return sockets.filter((socket) => socket.url === socketUrl);
    },
  };
}

/** One request as it left the transport, with the sockets open at that instant. */
interface SentRequest {
  readonly origin: string;
  readonly pathname: string;
  readonly method: string;
  /** The URLs of the sockets that were open when the request left. */
  readonly openSockets: readonly string[];
}

/** A scripted reply: a status and a JSON body. */
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** The transport of one case: it records each request and answers from `replies`, in order. */
interface ScriptedFetch {
  readonly fetch: FetchLike;
  readonly requests: SentRequest[];
  /** Replies consumed in order; once empty, every request answers `{ cleanup: 'clean' }`. */
  readonly replies: Reply[];
}

function scriptedFetch(factory: SocketFactory): ScriptedFetch {
  const requests: SentRequest[] = [];
  const replies: Reply[] = [];
  const fetch: FetchLike = (url: string, init?: HttpFetchInit): Promise<HttpResponseLike> => {
    const target = new URL(url);
    requests.push({
      origin: target.origin,
      pathname: target.pathname,
      method: init?.method ?? 'GET',
      openSockets: factory.sockets
        .filter((socket) => socket.readyState === READY_STATE.open && socket.live)
        .map((socket) => socket.url),
    });
    const reply = replies.shift() ?? { status: 200, body: { cleanup: 'clean' } };
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status <= 299,
      status: reply.status,
      statusText: '',
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    });
  };
  return { fetch, requests, replies };
}

/**
 * The `GET /sessions/:id/modifications` answer for a session that patched no
 * file: one page of the service's default window, with no record and the end
 * of the journal reached.
 */
const EMPTY_JOURNAL_PAGE = Object.freeze({
  modifications: [],
  total: 0,
  limit: MODIFICATIONS_PAGE_DEFAULT_LIMIT,
  offset: 0,
  nextOffset: null,
});

/** The refusal the service answers for a project no live editor socket announced. */
const NOT_ANNOUNCED: Reply = Object.freeze({
  status: 403,
  body: {
    code: 'PATH_OUTSIDE_PROJECT',
    message: 'The presented credential is not scoped to this project.',
  },
});

/** One recorded log call. */
interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

function recordingLogger(entries: LogEntry[]): Logger {
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  };
  return logger;
}

/** An editor credential store that always holds {@link TOKEN}. */
const credential: ServiceCredential = {
  token: () => TOKEN,
  read: () => Promise.resolve(ok(TOKEN)),
  refresh: () => Promise.resolve(ok(TOKEN)),
};

/** Everything one case drives and inspects. */
interface Harness {
  readonly client: ServiceClient;
  readonly sockets: SocketFactory;
  readonly http: ScriptedFetch;
  readonly logs: LogEntry[];
  /** The value `retainedEndpoint` answers. */
  retained: string | undefined;
  /** Points `debuggen.serviceUrl` at `url`, the way a settings change does. */
  switchServiceUrl(url: string): void;
}

/** Every client a case built, disposed after it. */
const opened: ServiceClient[] = [];

/** How a case configures its client. */
interface HarnessOptions {
  /** What `retainedEndpoint` answers at first; the case may change it. */
  readonly retained?: string | undefined;
  /** Replaces the `retainedEndpoint` callback outright, for a failing one. */
  readonly retainedEndpoint?: () => string | undefined;
}

function harness(options: HarnessOptions = {}): Harness {
  const sockets = socketFactory();
  const http = scriptedFetch(sockets);
  const logs: LogEntry[] = [];
  const retention: { value: string | undefined } = { value: options.retained };
  let serviceUrl = SERVICE_A;
  const listeners = new Set<() => void>();
  const configuration: ServiceClientConfiguration = {
    readServiceUrl: () => serviceUrl,
    onDidChangeServiceUrl: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  const client = createServiceClient({
    credential,
    projectRoot: PROJECT_ROOT,
    logger: recordingLogger(logs),
    configuration,
    webSocketConstructor: sockets.constructor,
    fetch: http.fetch,
    retainedEndpoint: options.retainedEndpoint ?? (() => retention.value),
  });
  opened.push(client);
  return {
    client,
    sockets,
    http,
    logs,
    get retained(): string | undefined {
      return retention.value;
    },
    set retained(value: string | undefined) {
      retention.value = value;
    },
    switchServiceUrl: (url) => {
      serviceUrl = url;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

/** Lets every queued microtask and the current macrotask turn run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

/** Connects the client and opens its first socket, to {@link SERVICE_A}. */
function connectToA(h: Harness): FakeWebSocket {
  h.client.connect();
  const [socket] = h.sockets.to(SERVICE_A);
  if (socket === undefined) {
    throw new Error('connect() opened no socket to service A');
  }
  socket.open();
  expect(h.client.state).toBe('open');
  return socket;
}

/** A promise the case settles itself. */
function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => {
      release?.();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const client of opened.splice(0)) {
    client.dispose();
  }
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe('dispose() and keepConnectionsFor()', () => {
  it('keeps the socket open until every held operation settled, then closes it', async () => {
    const h = harness();
    const socket = connectToA(h);
    const states: string[] = [];
    h.client.onStateChange((state) => {
      states.push(state);
    });
    const first = deferred();
    const second = deferred();

    expect(h.client.keepConnectionsFor(first.promise)).toBe(first.promise);
    void h.client.keepConnectionsFor(second.promise);
    h.client.dispose();

    expect(socket.live).toBe(true);
    expect(h.client.state).toBe('open');
    first.resolve();
    await flush();
    expect(socket.live).toBe(true);

    second.resolve();
    await flush();
    expect(socket.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: DISPOSED_CLOSE_REASON }]);
    expect(h.client.state).toBe('closed');
    expect(states).toEqual([]);
  });

  it('a rejected held operation releases the hold like a resolved one', async () => {
    const h = harness();
    const socket = connectToA(h);
    const failing = Promise.reject(new Error('the held operation failed'));

    const returned = h.client.keepConnectionsFor(failing);
    h.client.dispose();
    await expect(returned).rejects.toThrow('the held operation failed');
    await flush();

    expect(socket.live).toBe(false);
  });

  it('closes at once when nothing is held, and holds nothing once the sockets were closed', async () => {
    const h = harness();
    const socket = connectToA(h);

    h.client.dispose();
    expect(socket.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: DISPOSED_CLOSE_REASON }]);

    const late = deferred();
    expect(h.client.keepConnectionsFor(late.promise)).toBe(late.promise);
    // HTTP keeps working on a disposed client.
    const ended = await h.client.endSession(SESSION_ID, { endpoint: SERVICE_A });
    expect(isOk(ended) && ended.value.cleanup).toBe('clean');
    expect(h.sockets.sockets).toHaveLength(1);
    late.resolve();
  });

  it(`bounds the deferred close by CONNECTION_HOLD_TIMEOUT_MS (${String(CONNECTION_HOLD_TIMEOUT_MS)} ms)`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness();
    const socket = connectToA(h);

    void h.client.keepConnectionsFor(new Promise<never>(() => undefined));
    h.client.dispose();
    await vi.advanceTimersByTimeAsync(CONNECTION_HOLD_TIMEOUT_MS - 1);
    expect(socket.live).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: DISPOSED_CLOSE_REASON }]);
    expect(
      h.logs.some(
        (entry) =>
          entry.level === 'warn' &&
          entry.message ===
            'the registered requests did not settle in time; closing the connections',
      ),
    ).toBe(true);
  });

  it('an end sent during the hold is sent while the socket still announces the project', async () => {
    const h = harness();
    const socket = connectToA(h);

    const ending = h.client.endSession(SESSION_ID, { endpoint: SERVICE_A, timeoutMs: 4_000 });
    void h.client.keepConnectionsFor(ending);
    h.client.dispose();
    const ended = await ending;
    await flush();

    expect(isOk(ended) && ended.value.cleanup).toBe('clean');
    expect(h.http.requests).toEqual([
      {
        origin: SERVICE_A,
        pathname: `/sessions/${SESSION_ID}/end`,
        method: 'POST',
        openSockets: [socket.url],
      },
    ]);
    expect(socket.live).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The retained endpoint
// ---------------------------------------------------------------------------

describe('retainedEndpoint and pruneRetainedConnections()', () => {
  it("keeps the retained service's socket across setBaseUrl, sends an { endpoint: A } end to A while it is open, and prunes it once the retained endpoint moved on", async () => {
    const h = harness({ retained: SERVICE_A });
    const socketA = connectToA(h);

    h.switchServiceUrl(SERVICE_B);
    expect(h.client.baseUrl).toBe(SERVICE_B);
    expect(socketA.live).toBe(true);
    const [socketB] = h.sockets.to(SERVICE_B);
    expect(socketB).toBeDefined();
    socketB?.open();

    const ended = await h.client.endSession(SESSION_ID, { endpoint: SERVICE_A });
    expect(isOk(ended) && ended.value.cleanup).toBe('clean');
    expect(h.http.requests).toHaveLength(1);
    expect(h.http.requests[0]?.origin).toBe(SERVICE_A);
    expect(h.http.requests[0]?.openSockets).toContain(socketA.url);
    expect(h.sockets.sockets).toHaveLength(2);
    expect(socketA.live).toBe(true);

    h.client.pruneRetainedConnections();
    expect(socketA.live).toBe(true);

    h.retained = SERVICE_B;
    h.client.pruneRetainedConnections();
    expect(socketA.closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: RETAINED_RELEASED_CLOSE_REASON },
    ]);
    expect(socketB?.live).toBe(true);
  });

  it('switching back to the retained service makes its socket current again rather than opening a second one', () => {
    const h = harness({ retained: SERVICE_A });
    const socketA = connectToA(h);
    const states: string[] = [];
    h.client.onStateChange((state) => {
      states.push(state);
    });

    h.switchServiceUrl(SERVICE_B);
    const [socketB] = h.sockets.to(SERVICE_B);
    h.switchServiceUrl(SERVICE_A);

    expect(h.sockets.to(SERVICE_A)).toEqual([socketA]);
    expect(socketA.live).toBe(true);
    expect(socketB?.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: REPLACED_CLOSE_REASON }]);
    expect(h.client.state).toBe('open');
    expect(states.at(-1)).toBe('open');
  });

  it('a project-root change keeps the replaced socket while its service is retained', () => {
    const h = harness({ retained: SERVICE_A });
    const previous = connectToA(h);

    h.client.setProjectRoot('/workspace/another-folder');

    expect(previous.live).toBe(true);
    expect(h.sockets.to(SERVICE_A)).toHaveLength(2);
  });

  it('without a retained endpoint a replaced socket is closed, as before', () => {
    const h = harness();
    const socketA = connectToA(h);

    h.switchServiceUrl(SERVICE_B);

    expect(socketA.closeCalls).toEqual([{ code: NORMAL_CLOSURE, reason: REPLACED_CLOSE_REASON }]);
  });

  it('a retainedEndpoint callback that throws keeps nothing and is logged', () => {
    const h = harness({
      retainedEndpoint: () => {
        throw new Error('the store was not readable');
      },
    });
    const socketA = connectToA(h);

    h.switchServiceUrl(SERVICE_B);

    expect(socketA.live).toBe(false);
    expect(
      h.logs.some((entry) => entry.message === 'the retained service endpoint could not be read'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A request to another service
// ---------------------------------------------------------------------------

describe('a session request addressed to a non-current endpoint', () => {
  it('opens an announcing socket first, sends only once it is open, and releases it after the answer', async () => {
    const h = harness();
    connectToA(h);

    const ending = h.client.endSession(SESSION_ID, { endpoint: SERVICE_B, timeoutMs: 4_000 });
    await flush();
    const [socketB] = h.sockets.to(SERVICE_B);
    expect(socketB).toBeDefined();
    expect(h.http.requests).toEqual([]);

    h.client.pruneRetainedConnections();
    expect(socketB?.live).toBe(true);

    socketB?.open();
    const ended = await ending;

    expect(isOk(ended) && ended.value.cleanup).toBe('clean');
    expect(h.http.requests).toHaveLength(1);
    expect(h.http.requests[0]?.origin).toBe(SERVICE_B);
    expect(h.http.requests[0]?.openSockets).toContain(socketB?.url);
    const hello = JSON.parse(socketB?.sent[0] ?? '{}') as {
      type?: string;
      payload?: { client?: string; projectRoot?: string };
    };
    expect(hello.type).toBe('client.hello');
    expect(hello.payload?.client).toBe('vscode');
    expect(hello.payload?.projectRoot).toBe(PROJECT_ROOT);
    expect(socketB?.closeCalls).toEqual([
      { code: NORMAL_CLOSURE, reason: RETAINED_RELEASED_CLOSE_REASON },
    ]);
    expect(h.client.baseUrl).toBe(SERVICE_A);
  });

  it(`repeats a PATH_OUTSIDE_PROJECT refusal exactly once, after ${String(ANNOUNCEMENT_SETTLE_DELAY_MS)} ms, when the socket opened during the call`, async () => {
    const h = harness();
    connectToA(h);
    h.http.replies.push(NOT_ANNOUNCED, NOT_ANNOUNCED);

    const ending = h.client.endSession(SESSION_ID, { endpoint: SERVICE_B });
    await flush();
    h.sockets.to(SERVICE_B)[0]?.open();
    const ended = await ending;

    expect(h.http.requests.map((request) => request.origin)).toEqual([SERVICE_B, SERVICE_B]);
    expect(!isOk(ended) && ended.error.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(
      h.logs.filter((entry) => entry.message.includes('repeating it once')).map((e) => e.level),
    ).toEqual(['info']);
  });

  it('a repeat that is admitted answers the service verdict', async () => {
    const h = harness();
    connectToA(h);
    h.http.replies.push(NOT_ANNOUNCED);

    const ending = h.client.endSession(SESSION_ID, { endpoint: SERVICE_B });
    await flush();
    h.sockets.to(SERVICE_B)[0]?.open();
    const ended = await ending;

    expect(h.http.requests).toHaveLength(2);
    expect(isOk(ended) && ended.value.cleanup).toBe('clean');
  });

  it('never repeats when the socket was already open before the call', async () => {
    const h = harness({ retained: SERVICE_B });
    h.client.connect();
    h.switchServiceUrl(SERVICE_B);
    h.sockets.to(SERVICE_B)[0]?.open();
    h.switchServiceUrl(SERVICE_A);
    h.sockets.to(SERVICE_A).at(-1)?.open();
    h.http.replies.push(NOT_ANNOUNCED);

    const ended = await h.client.endSession(SESSION_ID, { endpoint: SERVICE_B });

    expect(h.http.requests).toHaveLength(1);
    expect(!isOk(ended) && ended.error.code).toBe('PATH_OUTSIDE_PROJECT');
  });

  it(`waits at most ENDPOINT_SOCKET_OPEN_TIMEOUT_MS (${String(ENDPOINT_SOCKET_OPEN_TIMEOUT_MS)} ms) for a socket that never opens, then sends anyway`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness();
    connectToA(h);

    const ending = h.client.getModifications(SESSION_ID, undefined, { endpoint: SERVICE_B });
    h.http.replies.push({ status: 200, body: EMPTY_JOURNAL_PAGE });
    await vi.advanceTimersByTimeAsync(ENDPOINT_SOCKET_OPEN_TIMEOUT_MS - 1);
    expect(h.http.requests).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const listed = await ending;

    expect(h.http.requests.map((request) => `${request.origin}${request.pathname}`)).toEqual([
      `${SERVICE_B}/sessions/${SESSION_ID}/modifications`,
    ]);
    expect(isOk(listed) && listed.value).toEqual(EMPTY_JOURNAL_PAGE);
  });

  it("waits at most half the call's timeoutMs, so the request keeps the rest of its budget", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness();
    connectToA(h);

    const ending = h.client.endSession(SESSION_ID, { endpoint: SERVICE_B, timeoutMs: 750 });
    await vi.advanceTimersByTimeAsync(374);
    expect(h.http.requests).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const ended = await ending;

    expect(h.http.requests).toHaveLength(1);
    expect(isOk(ended)).toBe(true);
  });

  it('never logs the credential, which only the hello and the Authorization header carry', async () => {
    const h = harness({ retained: SERVICE_A });
    const socketA = connectToA(h);
    h.http.replies.push(NOT_ANNOUNCED);

    h.switchServiceUrl(SERVICE_B);
    const ending = h.client.endSession(SESSION_ID, { endpoint: SERVICE_A });
    await h.client.endSession(SESSION_ID, { endpoint: 'http://example.com' });
    const pending = h.client.endSession(SESSION_ID, { endpoint: 'http://127.0.0.1:43119' });
    await flush();
    h.sockets.to('http://127.0.0.1:43119')[0]?.open();
    await Promise.all([ending, pending]);
    void h.client.keepConnectionsFor(Promise.resolve());
    h.client.dispose();

    expect(socketA.sent.some((frame) => frame.includes(TOKEN))).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
    expect(h.logs.length).toBeGreaterThan(0);
  });
});
