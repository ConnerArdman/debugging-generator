/**
 * Unit spec for the read proof on the Chrome side of the access boundary
 * (AAP §0.5.6): how the credential store in `../src/background/auth.ts` keeps
 * the proof pairing issued, and how `../src/background/ws-bridge.ts` presents
 * it on the four DevTools reads.
 *
 * Chrome attaches `Origin: chrome-extension://<id>` to the worker's `POST`s and
 * to its WebSocket upgrade, but to none of its `GET`s, and an `Origin` is only
 * a claim any local process holding the credential can write. The service
 * therefore issues a second secret with the credential when the pairing code
 * is redeemed — `POST /pair/complete` answers `{ token, readProof }` exactly
 * once — and refuses every DevTools read that does not carry it as
 * `x-debuggen-read-proof`, whatever `Origin` it claims. Nothing sent on a
 * connection registers or replaces the proof. What this spec holds:
 *
 * - **The store keeps the proof with its credential.** A pairing writes both
 *   to extension storage in one record; a fresh worker generation reads both
 *   back; a record written before proofs existed still reads as paired, with
 *   no proof, so its first read is refused and the developer pairs again; a
 *   record whose proof is malformed is unreadable as a whole; the proof goes
 *   when the credential goes (refusal, unpair, another context's change); and
 *   a pairing answer without a well-formed proof stores nothing.
 * - **On the four reads, and nowhere else.** Each read asks for the proof at
 *   the moment it is issued and carries it beside its acting tab; the writes,
 *   the panel-data query, the health probe and every `client.hello` carry
 *   none and never ask.
 * - **No proof, no admitted read.** A read with no proof is sent without the
 *   header, and the service's `UNAUTHORIZED` is handled as a refused
 *   credential; a provider that throws or rejects is contained as `INTERNAL`
 *   and nothing is sent; a malformed proof is refused locally.
 * - **Secret.** The proof reaches no log record, status snapshot or error.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project. Every collaborator of `createWsBridge` and
 * `createDevtoolsCredentialStore` is a recording fake built per case and local
 * to this file; the HTTP client is the protocol's real `HttpClient` over an
 * injected `fetch` answering from an in-memory route table, the global `fetch`
 * is a spy that must record no call, and Vitest's fake timers drive every
 * delay. The companion `./ws-bridge.test.ts` holds the bridge's other
 * guarantees. No proof value is written in this file: each is computed at run
 * time from deterministic bytes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  ACTING_TAB_HEADER,
  captureStartPath,
  captureStopPath,
  decodeMessage,
  healthPath,
  HttpClient,
  isMessageOfType,
  isReadProof,
  modificationsPath,
  pairCompletePath,
  panelByIdPath,
  panelDataPath,
  panelPath,
  PROTOCOL_VERSION,
  READ_PROOF_BYTES,
  READ_PROOF_HEADER,
  sessionPath,
} from '@debuggen/protocol';
import type {
  DataQuery,
  FetchLike,
  HttpFetchInit,
  HttpResponseLike,
  TokenProvider,
  WebSocketConstructorLike,
  WebSocketLike,
  WsEventMapLike,
} from '@debuggen/protocol';
import { DebuggenError, isErr } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel, Result } from '@debuggen/shared';

import {
  createDevtoolsCredentialStore,
  DEVTOOLS_TOKEN_STORAGE_KEY,
  STORED_CREDENTIAL_VERSION,
} from '../src/background/auth';
import type {
  CredentialStorageArea,
  CredentialStorageChangeListener,
  DevtoolsCredentialStore,
  UnauthorizedEvidence,
  UnauthorizedHandling,
} from '../src/background/auth';
import type {
  RelayPush,
  WorkerAlarmsApi,
  WorkerStatusSink,
  WorkerTimerApi,
} from '../src/background/messages';
import { createWsBridge } from '../src/background/ws-bridge';
import type { WsBridge, WsBridgeDeps } from '../src/background/ws-bridge';
import { DEFAULT_SERVICE_BASE_URL } from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/** The devtools credential every bridge harness presents. Obviously fake. */
const TOKEN = 'test-devtools-token';

/** The credential a pairing issues in the store cases. Obviously fake. */
const PAIRED_TOKEN = 'test-paired-devtools-token';

/** A second credential, written by another extension context. Obviously fake. */
const OTHER_TOKEN = 'test-other-devtools-token';

/** A well-sized, obviously synthetic pairing code. */
const PAIRING_CODE = 'TESTCODE';

/** The tab every read acts for. */
const TAB_A = 11;

/** The session every read names. */
const SESSION_A = 'session-test-a';

/** The panel `getPanel` names. */
const PANEL_A = 'panel-test-a';

/** A WebSocket `readyState`, as both real implementations number them. */
const READY_STATE = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 });

/** A running service's `GET /health` answer. */
const HEALTH_BODY = Object.freeze({
  version: '0.1.0-test',
  protocolVersion: PROTOCOL_VERSION,
  pairingAvailable: true,
});

/** A panel-data query for one trace. */
const TRACE_QUERY: DataQuery = { source: 'trace', filter: { traceId: '0'.repeat(32) } };

/** An answer that names no session: an error the bridge returns unchanged. */
const NO_SESSION = Object.freeze({ code: 'SESSION_NOT_FOUND', message: 'No such session' });

/** The service's answer to a DevTools read without the proof issued with its credential. */
const READ_PROOF_REFUSED = Object.freeze({
  code: 'UNAUTHORIZED',
  message: 'A DevTools read must carry the read proof issued with its credential.',
});

/** A `GET /sessions/:id/panel` answer the protocol's schema accepts. */
const NO_PANEL = Object.freeze({ panel: null });

/** The bytes a deterministic source answers: distinct, and not all equal. */
function patternBytes(size: number, seed: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 37 + seed) & 0xff);
}

/**
 * Bytes as base64url without padding, computed independently of any product
 * encoder: `btoa` over the binary string, then the RFC 4648 §5 alphabet.
 */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A read proof of the shape the service issues, drawn from deterministic bytes. */
function proofFrom(seed: number): string {
  return base64Url(patternBytes(READ_PROOF_BYTES, seed));
}

/** The proof pairing issued with the credential a case holds. */
const PROOF = proofFrom(11);

/** The proof a later pairing issued, for the cases that change it. */
const NEXT_PROOF = proofFrom(23);

/**
 * Values that are not read proofs: the standard alphabet, padding, a short
 * one, surrounding whitespace, and a value of the wrong type.
 */
const MALFORMED_PROOFS: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: 'standard base64', value: `+/${PROOF.slice(2)}` },
  { label: 'padded', value: `${PROOF.slice(0, -1)}=` },
  { label: 'short', value: PROOF.slice(1) },
  { label: 'whitespace-padded', value: ` ${PROOF}` },
  { label: 'a number', value: 42 },
];

/** A JSON reply the injected `fetch` answers with. */
function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** The record the store writes for a credential and its proof. */
function storedRecord(token: string, readProof?: unknown): Record<string, unknown> {
  return readProof === undefined
    ? { version: STORED_CREDENTIAL_VERSION, token }
    : { version: STORED_CREDENTIAL_VERSION, token, readProof };
}

/*
 * ===========================================================================
 * The fake socket
 * ===========================================================================
 */

/** A socket the spec drives by hand. */
interface FakeSocket extends WebSocketLike {
  readonly sent: readonly string[];
  /** The server accepted the connection: `readyState` OPEN, then `open`. */
  accept(): void;
}

type SocketListeners = {
  [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void>;
};

/** A recording socket constructor and the sockets it built, in order. */
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
      for (const listener of [...this.listeners.open]) {
        listener({ type: 'open' });
      }
    }
  }

  return { ctor: RecordingSocket, sockets };
}

/*
 * ===========================================================================
 * Harness
 * ===========================================================================
 */

/** One record an injected logger received, bindings merged in. */
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

/** How the injected `fetch` answers one path, call by call. */
type RouteHandler = (init: HttpFetchInit | undefined) => Promise<HttpResponseLike>;

/** The in-memory service: a route table and the `fetch` that answers from it. */
interface Network {
  readonly routes: Map<string, RouteHandler>;
  readonly fetch: Mock<FetchLike>;
}

/** A network whose only route is a running service's health probe. */
function createNetwork(): Network {
  const routes = new Map<string, RouteHandler>([
    [healthPath(), () => Promise.resolve(jsonResponse(200, HEALTH_BODY))],
  ]);
  const fetch = vi.fn<FetchLike>((url, init) => {
    const route = routes.get(new URL(url).pathname);
    return route === undefined
      ? Promise.reject(new TypeError('the test fetch has no route for this request'))
      : route(init);
  });
  return { routes, fetch };
}

/** `chrome.storage.local`, in memory: values are copied in and out, as Chrome does. */
interface FakeStorage extends CredentialStorageArea {
  readonly items: Map<string, unknown>;
}

/** A storage area holding `seed` under the credential key, when one is given. */
function createStorage(seed?: unknown): FakeStorage {
  const items = new Map<string, unknown>();
  if (seed !== undefined) {
    items.set(DEVTOOLS_TOKEN_STORAGE_KEY, structuredClone(seed));
  }
  return {
    items,
    get: (key) => Promise.resolve(items.has(key) ? { [key]: structuredClone(items.get(key)) } : {}),
    set: (entries) => {
      for (const [key, value] of Object.entries(entries)) {
        items.set(key, structuredClone(value));
      }
      return Promise.resolve();
    },
    remove: (key) => {
      items.delete(key);
      return Promise.resolve();
    },
  };
}

/** `chrome.storage.local.onChanged`, driven by hand. */
interface FakeChanges {
  readonly addListener: (listener: CredentialStorageChangeListener) => void;
  readonly removeListener: (listener: CredentialStorageChangeListener) => void;
  /** Deliver one change to every listener, as another extension context's write would. */
  readonly emit: (changes: Parameters<CredentialStorageChangeListener>[0]) => void;
}

function createChanges(): FakeChanges {
  const listeners = new Set<CredentialStorageChangeListener>();
  return {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    emit: (changes) => {
      for (const listener of [...listeners]) {
        listener(changes);
      }
    },
  };
}

/** A credential store over fresh fakes, and what a case inspects. */
interface StoreHarness {
  readonly store: DevtoolsCredentialStore;
  readonly storage: FakeStorage;
  readonly changes: FakeChanges;
  readonly net: Network;
  readonly http: HttpClient;
  readonly logs: readonly LogEntry[];
}

/**
 * Build a store whose storage holds `seed` (nothing when omitted) and whose
 * `POST /pair/complete` answers `pairReply`.
 */
function createStoreHarness(
  seed?: unknown,
  pairReply: HttpResponseLike = jsonResponse(200, { token: PAIRED_TOKEN, readProof: PROOF }),
): StoreHarness {
  const logs: LogEntry[] = [];
  const logger = createRecordingLogger(logs);
  const storage = createStorage(seed);
  const changes = createChanges();
  const net = createNetwork();
  net.routes.set(pairCompletePath(), () => Promise.resolve(pairReply));
  const http = new HttpClient({ baseUrl: DEFAULT_SERVICE_BASE_URL, fetch: net.fetch, logger });
  const store = createDevtoolsCredentialStore({ storage, httpClient: http, changes, logger });
  return { store, storage, changes, net, http, logs };
}

/** A bridge over fresh fakes, and what a case drives or inspects. */
interface BridgeHarness {
  readonly bridge: WsBridge;
  readonly sockets: readonly FakeSocket[];
  readonly net: Network;
  readonly onUnauthorized: Mock<(evidence: UnauthorizedEvidence) => Promise<UnauthorizedHandling>>;
  readonly pushStatus: Mock<WorkerStatusSink>;
  readonly logs: readonly LogEntry[];
}

/** What a bridge is wired to: a bare proof provider, or a whole credential store. */
interface BridgeOptions {
  /** The `readProofProvider` dep; omitted, the bridge is built without one. */
  readonly readProofProvider?: WsBridgeDeps['readProofProvider'];
  /**
   * Wire the bridge to this store as `service-worker.ts` does — its token,
   * its proof and its refusal handling — over the store's own client.
   */
  readonly store?: StoreHarness;
}

/** Build a bridge. Fake timers must already be installed. */
function createBridgeHarness(options: BridgeOptions = {}): BridgeHarness {
  const logs: LogEntry[] = [];
  const logger = createRecordingLogger(logs);
  const { ctor, sockets } = createSocketFactory();
  const { store } = options;

  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let lastHandle = 0;
  const setTimer = vi.fn<WorkerTimerApi['setTimeout']>((handler, ms) => {
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

  const net = store?.net ?? createNetwork();
  const tokenProvider: TokenProvider = store?.store.getToken ?? (() => TOKEN);
  const httpClient =
    store?.http ??
    new HttpClient({
      baseUrl: DEFAULT_SERVICE_BASE_URL,
      token: tokenProvider,
      fetch: net.fetch,
      logger,
    });
  const onUnauthorized = vi.fn<(evidence: UnauthorizedEvidence) => Promise<UnauthorizedHandling>>(
    (evidence) =>
      store === undefined ? Promise.resolve('cleared') : store.store.handleUnauthorized(evidence),
  );
  const pushStatus = vi.fn<WorkerStatusSink>();
  const alarms: WorkerAlarmsApi = {
    create: () => Promise.resolve(),
    clear: () => Promise.resolve(true),
  };

  const bridge = createWsBridge({
    webSocketConstructor: ctor,
    httpClient,
    tokenProvider,
    readProofProvider: store?.store.getReadProof ?? options.readProofProvider,
    onUnauthorized,
    hasCredential: () => Promise.resolve(tokenProvider()).then((token) => token !== undefined),
    alarms,
    timers: { setTimeout: setTimer, clearTimeout: clearTimer },
    random: () => 1,
    relayPush: vi.fn<RelayPush>(),
    pushStatus,
    listBindings: () => Promise.resolve([]),
    serviceBaseUrl: DEFAULT_SERVICE_BASE_URL,
    logger,
  });

  return { bridge, sockets, net, onUnauthorized, pushStatus, logs };
}

/** A proof provider answering each of `proofs` in turn, the last one repeating. */
function proofsInTurn(
  ...proofs: readonly (string | undefined)[]
): Mock<() => Promise<string | undefined>> {
  let index = 0;
  return vi.fn<() => Promise<string | undefined>>(() => {
    const proof = proofs[Math.min(index, proofs.length - 1)];
    index += 1;
    return Promise.resolve(proof);
  });
}

/** Let every pending promise continuation run; nothing due later fires. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Connect, let the server accept, and let the open handling settle. */
async function connectAndOpen(h: BridgeHarness): Promise<FakeSocket> {
  await h.bridge.connect();
  const socket = h.sockets.at(-1);
  if (socket === undefined) {
    throw new Error('no socket was constructed');
  }
  socket.accept();
  await flush();
  return socket;
}

/** The payload of the hello a socket carried as its first frame, as sent. */
function helloOf(socket: FakeSocket): Record<string, unknown> {
  const frame = socket.sent[0];
  if (frame === undefined) {
    throw new Error('the socket carried no frame');
  }
  const decoded = decodeMessage(frame);
  if (isErr(decoded) || !isMessageOfType(decoded.value, 'client.hello')) {
    throw new Error('the first frame is not a client.hello');
  }
  return { ...decoded.value.payload };
}

/** The requests the injected `fetch` received for one path, in order. */
function callsTo(net: Network, path: string): (HttpFetchInit | undefined)[] {
  return net.fetch.mock.calls
    .filter(([url]) => new URL(url).pathname === path)
    .map(([, init]) => init);
}

/** The read-proof header one request carried, `undefined` when it carried none. */
function proofSentWith(init: HttpFetchInit | undefined): string | undefined {
  return init?.headers?.[READ_PROOF_HEADER];
}

/** The failure a result carries, failing the case when it succeeded. */
function errOf<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (!isErr(result)) {
    throw new Error('expected a failure');
  }
  return result.error;
}

/** Everything the bridge reported outside the wire: logs and every snapshot. */
function reportedText(h: BridgeHarness): string {
  return JSON.stringify([
    h.logs,
    h.pushStatus.mock.calls,
    h.bridge.getStatus(),
    h.bridge.snapshot(),
  ]);
}

/** Answer every call of one path with `reply`. */
function answer(net: Network, path: string, reply: HttpResponseLike): void {
  net.routes.set(path, () => Promise.resolve(reply));
}

/** The four reads, each issued for `TAB_A` in `SESSION_A`, with the path it reaches. */
const READS: readonly {
  readonly name: string;
  readonly path: string;
  readonly issue: (bridge: WsBridge) => Promise<Result<unknown, DebuggenError>>;
}[] = [
  {
    name: 'getSession',
    path: sessionPath(SESSION_A),
    issue: (bridge) => bridge.getSession(SESSION_A, { tabId: TAB_A }),
  },
  {
    name: 'getCurrentPanel',
    path: panelPath(SESSION_A),
    issue: (bridge) => bridge.getCurrentPanel(SESSION_A, { tabId: TAB_A }),
  },
  {
    name: 'getPanel',
    path: panelByIdPath(SESSION_A, PANEL_A),
    issue: (bridge) => bridge.getPanel(SESSION_A, PANEL_A, { tabId: TAB_A }),
  },
  {
    name: 'getModifications',
    path: modificationsPath(SESSION_A),
    issue: (bridge) => bridge.getModifications(SESSION_A, { tabId: TAB_A }),
  },
];

/*
 * ===========================================================================
 * Suite-wide environment
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

/*
 * ===========================================================================
 * Cases
 * ===========================================================================
 */

describe('the read proof the credential store keeps', () => {
  it('stores the proof pairing issued in one record with its credential, and answers it', async () => {
    const h = createStoreHarness();

    const paired = await h.store.completePairing(PAIRING_CODE);

    expect(paired.ok).toBe(true);
    expect(isReadProof(PROOF)).toBe(true);
    expect(h.storage.items.get(DEVTOOLS_TOKEN_STORAGE_KEY)).toStrictEqual(
      storedRecord(PAIRED_TOKEN, PROOF),
    );
    expect(await h.store.getToken()).toBe(PAIRED_TOKEN);
    expect(await h.store.getReadProof()).toBe(PROOF);
    // The exchange itself presents neither secret: pairing is the one request
    // that needs no credential, and its answer is where the proof comes from.
    const [exchange] = callsTo(h.net, pairCompletePath());
    expect(proofSentWith(exchange)).toBeUndefined();
    expect(JSON.stringify(h.logs)).not.toContain(PROOF);
  });

  it('reads the proof back in a fresh worker generation', async () => {
    const h = createStoreHarness(storedRecord(PAIRED_TOKEN, PROOF));

    expect(await h.store.getReadProof()).toBe(PROOF);
    expect(await h.store.getToken()).toBe(PAIRED_TOKEN);
  });

  it('keeps a record written before read proofs existed paired, with no proof to read with', async () => {
    const h = createStoreHarness(storedRecord(PAIRED_TOKEN));

    expect(await h.store.getToken()).toBe(PAIRED_TOKEN);
    expect(await h.store.getReadProof()).toBeUndefined();
    expect(await h.store.getState()).toBe('paired');
  });

  it.each(MALFORMED_PROOFS)(
    'treats a record whose proof is $label as unreadable, credential and all',
    async ({ value }) => {
      const h = createStoreHarness(storedRecord(PAIRED_TOKEN, value));

      expect(await h.store.getToken()).toBeUndefined();
      expect(await h.store.getReadProof()).toBeUndefined();
      expect(await h.store.getState()).toBe('not-paired');
    },
  );

  it('forgets the proof with the credential the service refuses', async () => {
    const h = createStoreHarness(storedRecord(PAIRED_TOKEN, PROOF));
    expect(await h.store.getToken()).toBe(PAIRED_TOKEN);

    const handled = await h.store.handleUnauthorized(
      new DebuggenError('UNAUTHORIZED', READ_PROOF_REFUSED.message),
    );

    expect(handled).toBe('cleared');
    expect(await h.store.getReadProof()).toBeUndefined();
    expect(h.storage.items.has(DEVTOOLS_TOKEN_STORAGE_KEY)).toBe(false);
  });

  it('forgets the proof with the credential the developer unpairs', async () => {
    const h = createStoreHarness(storedRecord(PAIRED_TOKEN, PROOF));
    expect(await h.store.getReadProof()).toBe(PROOF);

    const cleared = await h.store.clearToken();

    expect(cleared.ok).toBe(true);
    expect(await h.store.getReadProof()).toBeUndefined();
    expect(h.storage.items.has(DEVTOOLS_TOKEN_STORAGE_KEY)).toBe(false);
  });

  // Another context writes storage first, and Chrome then reports the change:
  // both halves are reproduced, in that order.
  it('follows another context: its pairing brings its own proof, its removal takes it away', async () => {
    const first = storedRecord(PAIRED_TOKEN, PROOF);
    const replacement = storedRecord(OTHER_TOKEN, NEXT_PROOF);
    const h = createStoreHarness(first);
    expect(await h.store.getReadProof()).toBe(PROOF);

    h.storage.items.set(DEVTOOLS_TOKEN_STORAGE_KEY, replacement);
    h.changes.emit({ [DEVTOOLS_TOKEN_STORAGE_KEY]: { oldValue: first, newValue: replacement } });

    expect(await h.store.getToken()).toBe(OTHER_TOKEN);
    expect(await h.store.getReadProof()).toBe(NEXT_PROOF);

    h.storage.items.delete(DEVTOOLS_TOKEN_STORAGE_KEY);
    h.changes.emit({ [DEVTOOLS_TOKEN_STORAGE_KEY]: { oldValue: replacement } });

    expect(await h.store.getReadProof()).toBeUndefined();
    expect(JSON.stringify(h.logs)).not.toContain(NEXT_PROOF);
  });

  it.each([
    { label: 'without a proof', body: { token: PAIRED_TOKEN } },
    ...MALFORMED_PROOFS.map(({ label, value }) => ({
      label: `with a proof that is ${label}`,
      body: { token: PAIRED_TOKEN, readProof: value },
    })),
  ])('stores nothing from a pairing answer $label', async ({ body }) => {
    const h = createStoreHarness(undefined, jsonResponse(200, body));

    const paired = await h.store.completePairing(PAIRING_CODE);

    expect(errOf(paired).code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(h.storage.items.has(DEVTOOLS_TOKEN_STORAGE_KEY)).toBe(false);
    expect(await h.store.getToken()).toBeUndefined();
    expect(await h.store.getReadProof()).toBeUndefined();
    const reported = JSON.stringify([h.logs, errOf(paired), errOf(paired).message]);
    expect(reported).not.toContain(PAIRED_TOKEN);
  });
});

describe('where the bridge sends the read proof', () => {
  it.each(READS)(
    '$name carries the held proof as x-debuggen-read-proof, beside its acting tab',
    async ({ path, issue }) => {
      const readProofProvider = proofsInTurn(PROOF);
      const h = createBridgeHarness({ readProofProvider });
      answer(h.net, path, jsonResponse(404, NO_SESSION));

      await issue(h.bridge);

      const calls = callsTo(h.net, path);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('GET');
      expect(proofSentWith(calls[0])).toBe(PROOF);
      expect(calls[0]?.headers?.[ACTING_TAB_HEADER]).toBe(String(TAB_A));
      expect(readProofProvider).toHaveBeenCalledTimes(1);
    },
  );

  it('asks for the proof at the moment of each read, so a read after a new pairing carries the new one', async () => {
    const h = createBridgeHarness({ readProofProvider: proofsInTurn(PROOF, NEXT_PROOF) });
    answer(h.net, panelPath(SESSION_A), jsonResponse(200, NO_PANEL));

    await h.bridge.getCurrentPanel(SESSION_A, { tabId: TAB_A });
    await h.bridge.getCurrentPanel(SESSION_A, { tabId: TAB_A });

    expect(callsTo(h.net, panelPath(SESSION_A)).map(proofSentWith)).toStrictEqual([
      PROOF,
      NEXT_PROOF,
    ]);
  });

  it('puts it in no hello, on no write and not on the health probe, and never asks for it there', async () => {
    const readProofProvider = proofsInTurn(PROOF);
    const h = createBridgeHarness({ readProofProvider });
    const socket = await connectAndOpen(h);

    // No route answers the three writes, so each fails at the transport, after
    // its request, headers included, was handed to `fetch`.
    await h.bridge.queryPanelData(SESSION_A, TRACE_QUERY, { tabId: TAB_A });
    await h.bridge.startCapture(SESSION_A, { tabId: TAB_A });
    await h.bridge.stopCapture(SESSION_A, { tabId: TAB_A });
    await h.bridge.probeService();

    expect(helloOf(socket)).not.toHaveProperty('readProof');
    expect(socket.sent.join('\n')).not.toContain(PROOF);
    for (const path of [
      panelDataPath(SESSION_A),
      captureStartPath(SESSION_A),
      captureStopPath(SESSION_A),
      healthPath(),
    ]) {
      const calls = callsTo(h.net, path);
      expect(calls.length).toBeGreaterThan(0);
      for (const init of calls) {
        expect(Object.keys(init?.headers ?? {})).not.toContain(READ_PROOF_HEADER);
      }
    }
    expect(readProofProvider).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'answers no proof', options: { readProofProvider: proofsInTurn(undefined) } },
    { label: 'is not wired', options: {} },
  ])(
    'sends a read without the header when the provider $label, and handles the refusal as a refused credential',
    async ({ options }) => {
      const h = createBridgeHarness(options);
      answer(h.net, sessionPath(SESSION_A), jsonResponse(401, READ_PROOF_REFUSED));

      const result = await h.bridge.getSession(SESSION_A, { tabId: TAB_A });
      await flush();

      expect(errOf(result).code).toBe('UNAUTHORIZED');
      const [sent] = callsTo(h.net, sessionPath(SESSION_A));
      expect(Object.keys(sent?.headers ?? {})).not.toContain(READ_PROOF_HEADER);
      expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
      expect(h.onUnauthorized.mock.calls[0]?.[0]).toMatchObject({ code: 'UNAUTHORIZED' });
    },
  );

  it.each([
    {
      label: 'throws',
      provider: (): Promise<string | undefined> => {
        throw new Error(`provider failed near ${PROOF}`);
      },
    },
    {
      label: 'rejects',
      provider: (): Promise<string | undefined> =>
        Promise.reject(new Error(`provider failed near ${PROOF}`)),
    },
  ])('contains a provider that $label as INTERNAL, and sends nothing', async ({ provider }) => {
    const h = createBridgeHarness({ readProofProvider: provider });

    const results = await Promise.all(READS.map(({ issue }) => issue(h.bridge)));

    for (const [index, result] of results.entries()) {
      expect(errOf(result).code).toBe('INTERNAL');
      expect(callsTo(h.net, READS[index]?.path ?? '')).toHaveLength(0);
    }
    expect(h.onUnauthorized).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_PROOFS.filter(({ value }) => typeof value === 'string'))(
    'refuses a proof that is $label locally, before the read is sent, without quoting it',
    async ({ value }) => {
      const h = createBridgeHarness({
        readProofProvider: () => Promise.resolve(value as string),
      });

      const result = await h.bridge.getModifications(SESSION_A, { tabId: TAB_A });

      const failure = errOf(result);
      expect(failure.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(callsTo(h.net, modificationsPath(SESSION_A))).toHaveLength(0);
      expect(JSON.stringify([failure, failure.message, failure.hint ?? ''])).not.toContain(
        (value as string).trim(),
      );
      expect(h.onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it('reaches no log record, status snapshot or error', async () => {
    const h = createBridgeHarness({ readProofProvider: proofsInTurn(PROOF) });
    await h.bridge.connect();
    for (const [index, { path }] of READS.entries()) {
      answer(
        h.net,
        path,
        index % 2 === 0 ? jsonResponse(401, READ_PROOF_REFUSED) : jsonResponse(404, NO_SESSION),
      );
    }

    const results = await Promise.all(READS.map(({ issue }) => issue(h.bridge)));
    await flush();

    expect(h.logs.length).toBeGreaterThan(0);
    expect(reportedText(h)).not.toContain(PROOF);
    for (const result of results) {
      const failure = errOf(result);
      expect(JSON.stringify(failure)).not.toContain(PROOF);
      expect(failure.message).not.toContain(PROOF);
      expect(failure.hint ?? '').not.toContain(PROOF);
    }
  });
});

describe('a paired worker: the store and the bridge together', () => {
  it('reads with the proof its pairing issued, and drops it with the credential the service refuses', async () => {
    const store = createStoreHarness();
    const h = createBridgeHarness({ store });
    expect((await store.store.completePairing(PAIRING_CODE)).ok).toBe(true);
    let accepted = true;
    h.net.routes.set(sessionPath(SESSION_A), () =>
      Promise.resolve(
        accepted ? jsonResponse(404, NO_SESSION) : jsonResponse(401, READ_PROOF_REFUSED),
      ),
    );

    await h.bridge.getSession(SESSION_A, { tabId: TAB_A });
    accepted = false;
    const refused = await h.bridge.getSession(SESSION_A, { tabId: TAB_A });
    await flush();
    const afterRefusal = await h.bridge.getSession(SESSION_A, { tabId: TAB_A });

    expect(errOf(refused).code).toBe('UNAUTHORIZED');
    expect(isErr(afterRefusal)).toBe(true);
    const sent = callsTo(h.net, sessionPath(SESSION_A));
    expect(sent.slice(0, 2).map(proofSentWith)).toStrictEqual([PROOF, PROOF]);
    // Once the credential is refused, the store holds neither secret, so a
    // later read carries no proof at all.
    for (const init of sent.slice(2)) {
      expect(Object.keys(init?.headers ?? {})).not.toContain(READ_PROOF_HEADER);
    }
    expect(await store.store.getReadProof()).toBeUndefined();
    expect(store.storage.items.has(DEVTOOLS_TOKEN_STORAGE_KEY)).toBe(false);
    expect(JSON.stringify([store.logs, h.logs, reportedText(h)])).not.toContain(PROOF);
  });
});
