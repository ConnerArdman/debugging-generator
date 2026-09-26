/**
 * Unit spec for the service worker's custody of the page agent's telemetry —
 * the `agent.ready` and `telemetry.batch` handlers of the composed worker in
 * `../src/background/service-worker.ts`, and its pure `telemetryLossNotice`.
 *
 * The content bridge hands a batch to the worker's runtime port and the page
 * agent forgets it once `port.postMessage` returns, so from then on the worker
 * is the batch's only custodian. The spec holds three guarantees:
 *
 * - **A cold start loses nothing it can hold.** A page load is what usually
 *   wakes a Manifest V3 worker, so batches routinely arrive while `start()`
 *   has not yet run `wsBridge.connect()` and the socket client is `closed`.
 *   Each tab's frames wait for the worker's `ready` in one ordered chain, and
 *   reach the socket — after the hello, and a bound tab's telemetry only once
 *   the service has confirmed the tab's route with `session.bound` — in
 *   arrival order, `agent.ready` included. What waits is bounded per tab by
 *   `COLD_START_HELD_EVENTS_PER_TAB`; events beyond it are counted as lost.
 * - **Loss is shown to the developer, not only logged.** Events the worker
 *   could not hand to the service — beyond the hold, beyond the tab's lane
 *   bound, or refused after start-up because the tab's route was not
 *   confirmed within `TELEMETRY_ROUTE_WAIT_MS` (never paired, service
 *   unreachable) or cannot be (credential refused) — and events the page
 *   reports it dropped before the batch (`droppedCount`) reach the tab's
 *   panel as a protocol `error` whose fixed copy names only a number:
 *   `TRANSPORT_DISCONNECTED` and `INSTRUMENTATION_UNAVAILABLE`. A notice no
 *   panel saw is shown again once a panel is associated with the tab.
 * - **Notices are coalesced.** At most one notice per kind per tab every
 *   `TELEMETRY_LOSS_NOTICE_INTERVAL_MS`; loss inside an interval is
 *   accumulated and the burst's running total is shown when it ends, and an
 *   interval without loss ends the burst. Logs about loss carry counts only.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). The real worker is built through
 * `createWorker` over recording fakes local to this file, following the
 * composition harness of `./agent-error-report.test.ts`: Chrome-shaped
 * runtime ports for a panel, a DevTools page and the content bridge; in-memory
 * storage areas, the local one holding a stored devtools credential when the
 * case is paired and the session one the tabs a case starts bound; a
 * recording `WebSocketConstructorLike` the case accepts, answers
 * (`session.bound` for each `session.bind`) or drops by hand, as in
 * `./ws-bridge.test.ts`; and one-shot timers held until the case fires them.
 * The bridge announces its document (`agent.ready`) before its batches, as the
 * page agent does, since the port hub forwards only a pinned document's
 * batches. The global `fetch` is a spy answering only the health probe and a
 * bound panel's two snapshot reads (the session record and its current panel);
 * every call must be one of those `GET`s and carry no page data, so no
 * telemetry travels over HTTP. Every event carries a private sentinel that
 * must appear in no log record and no panel frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEnvelope,
  decodeMessage,
  encodeMessage,
  isMessageOfType,
  parseErrorPayload,
  parseSessionRecord,
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
} from '@debuggen/protocol';
import type {
  ErrorPayload,
  FetchLike,
  HttpResponseLike,
  MessageByType,
  ProtocolMessage,
  TelemetryEventIngress,
  WebSocketConstructorLike,
  WebSocketLike,
  WsEventMapLike,
} from '@debuggen/protocol';
import { isErr } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import { DEVTOOLS_TOKEN_STORAGE_KEY, STORED_CREDENTIAL_VERSION } from '../src/background/auth';
import type { TabBindingRecord } from '../src/background/messages';
import {
  COLD_START_HELD_EVENTS_PER_TAB,
  createWorker,
  TELEMETRY_LOSS_NOTICE_INTERVAL_MS,
  telemetryLossNotice,
} from '../src/background/service-worker';
import type {
  DebugGeneratorWorker,
  TelemetryLossKind,
  WorkerEnvironment,
  WorkerEvent,
  WorkerTab,
} from '../src/background/service-worker';
import { BINDING_STORAGE_KEY } from '../src/background/tab-registry';
import { TELEMETRY_ROUTE_WAIT_MS } from '../src/background/ws-bridge';
import {
  EXTENSION_CHANNEL,
  newPortRequestId,
  PORT_CONTENT_BRIDGE,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
} from '../src/shared/messages';
import type {
  BridgeUpstreamMessage,
  DevtoolsUpstreamMessage,
  PageAgentReadyPayload,
  PageTelemetryBatchPayload,
  PortRequestFrame,
  PortRequestId,
} from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/** Private page text every event carries; it may reach no log and no panel. */
const SENTINEL = 'PRIVATE-SENTINEL token=abc https://x/?q=secret';

/** The fragments of {@link SENTINEL} searched for, so a partial copy is caught too. */
const SENTINEL_FRAGMENTS: readonly string[] = ['PRIVATE-SENTINEL', 'token=abc', 'q=secret'];

/** The devtools credential a paired case stores. Obviously fake. */
const TOKEN = 'test-devtools-token';

/** This extension's id, as `chrome.runtime.id` reports it. */
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** The tab whose page the agent runs in and whose panel is open. */
const TAB_ID = 7;

/** A second application tab, with a bridge and no panel. */
const OTHER_TAB_ID = 8;

/** The local app's origin — a neutral loopback port. */
const APP_ORIGIN = 'http://127.0.0.1:4100';

/** The app document's (already query-redacted) URL. */
const APP_URL = `${APP_ORIGIN}/workspace/overview`;

/** A fixed epoch-millisecond instant for the fake tab and the events. */
const BASE_EPOCH_MS = 1_700_000_000_000;

/** Document and producer ids of the exact shape the agent mints. */
const DOCUMENT_ID = 'doc_0123456789abcdef';
const DOCUMENT_ID_2 = 'doc_fedcba9876543210';
const PRODUCER_ID = 'prd_0123456789abcdef';
const PRODUCER_ID_2 = 'prd_fedcba9876543210';

/** The sessions the service binds {@link TAB_ID} and {@link OTHER_TAB_ID} to. */
const SESSION_ID = 'ses_0123456789abcdef';
const OTHER_SESSION_ID = 'ses_fedcba9876543210';

/**
 * The log line the worker writes when a batch it accepted could not be
 * delivered to the service: its tab's route was not confirmed in time or was
 * refused, or the send failed.
 */
const LOSS_LOG = 'A telemetry batch was dropped: it could not be delivered to the local service.';

/** The log line the worker writes when a batch arrives at its tab's full lane. */
const LANE_OVERFLOW_LOG =
  'A telemetry batch was dropped: too many batches are waiting for its tab.';

/** The most batches one tab may have waiting — the worker's documented bound. */
const LANE_BOUND = 64;

/** A running service's `GET /health` answer. */
const HEALTH_BODY = Object.freeze({
  version: '0.1.0-test',
  protocolVersion: PROTOCOL_VERSION,
  pairingAvailable: true,
});

/** The log line the worker writes when events exceeded the cold-start hold. */
const HOLD_OVERFLOW_LOG = 'Telemetry beyond the cold-start hold was dropped.';

/** The log line the worker writes for every loss notice it pushes. */
const NOTICE_LOG = 'A telemetry loss notice was pushed.';

/** The log line the socket bridge writes for each queued telemetry frame it dropped. */
const QUEUE_DROP_LOG = 'a queued telemetry frame was dropped before it reached the service';

/** The log line the worker writes when it forgets the loss of a tab that closed. */
const CLOSED_TAB_LOSS_LOG = 'Telemetry loss of a closed tab was forgotten.';

/** The WHATWG `WebSocket.readyState` values the fake socket moves through. */
const READY_STATE = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 });

/** A lowercase hexadecimal identifier of `width` digits, never all zeros. */
function hexId(value: number, width: number): string {
  return (value + 1).toString(16).padStart(width, '0');
}

/** The id of the event at `index`; ids are how delivery order is read back. */
function eventId(index: number): string {
  return `event-test-${String(index)}`;
}

/**
 * One raw, ingress-shaped event exactly as the page agent emits it, carrying
 * {@link SENTINEL} in its attributes as the page's own data.
 */
function makeEvent(index: number, producerId: string = PRODUCER_ID): TelemetryEventIngress {
  return {
    id: eventId(index),
    traceId: hexId(index, 32),
    spanId: hexId(index, 16),
    kind: 'interaction',
    name: 'click',
    startTime: BASE_EPOCH_MS + index,
    duration: 1.5,
    tier: 'browser',
    attributes: { note: SENTINEL },
    status: 'ok',
    producerId,
    seq: index,
  };
}

/** `count` consecutive events, starting at index `from`. */
function makeEvents(
  from: number,
  count: number,
  producerId: string = PRODUCER_ID,
): TelemetryEventIngress[] {
  return Array.from({ length: count }, (_, offset) => makeEvent(from + offset, producerId));
}

/** The ids of `count` consecutive events starting at `from`. */
function eventIds(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, offset) => eventId(from + offset));
}

/** Whether a serialized value contains any fragment of {@link SENTINEL}. */
function leaksSentinel(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return SENTINEL_FRAGMENTS.some((fragment) => serialized.includes(fragment));
}

/*
 * ===========================================================================
 * The pure notice
 * ===========================================================================
 */

const LOSS_KINDS: readonly TelemetryLossKind[] = ['undelivered', 'dropped-in-page'];

describe('telemetryLossNotice — the fixed copy of a telemetry-loss notice', () => {
  it('shows undelivered events under TRANSPORT_DISCONNECTED, as an upper bound', () => {
    expect(telemetryLossNotice('undelivered', 3)).toEqual({
      code: 'TRANSPORT_DISCONNECTED',
      message:
        'Telemetry from this page did not reach the local service (up to 3 telemetry events), so the capture is incomplete.',
    });
  });

  it('shows events dropped inside the page under INSTRUMENTATION_UNAVAILABLE', () => {
    expect(telemetryLossNotice('dropped-in-page', 12)).toEqual({
      code: 'INSTRUMENTATION_UNAVAILABLE',
      message:
        'Telemetry was dropped inside the page before it was sent (12 telemetry events; its buffer or rate limit was exceeded), so the capture is incomplete.',
    });
  });

  it.each(LOSS_KINDS)('says "1 telemetry event" for a single %s event', (kind) => {
    const message = telemetryLossNotice(kind, 1).message;

    expect(message).toContain('1 telemetry event');
    expect(message).not.toContain('1 telemetry events');
  });

  it.each(LOSS_KINDS)('varies the %s copy by the number alone', (kind) => {
    const counts = [2, 5_000, Number.MAX_SAFE_INTEGER];
    const templates = counts.map((count) =>
      telemetryLossNotice(kind, count).message.replace(String(count), '‹n›'),
    );

    expect(new Set(templates).size).toBe(1);
    for (const count of counts) {
      expect(telemetryLossNotice(kind, count).message).toContain(String(count));
    }
  });

  it.each(LOSS_KINDS)(
    'produces a %s payload the protocol’s strict error schema accepts, with no ref',
    (kind) => {
      const notice = telemetryLossNotice(kind, Number.MAX_SAFE_INTEGER);

      expect(parseErrorPayload(notice)).toMatchObject({ ok: true });
      expect(notice).not.toHaveProperty('ref');
    },
  );
});

/*
 * ===========================================================================
 * Composition harness — Chrome-shaped fakes for `createWorker`
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

/** A worker-facing event whose listeners the case can invoke. */
interface RecordingWorkerEvent<Listener> extends WorkerEvent<Listener> {
  readonly listeners: Set<Listener>;
}

function createWorkerEvent<Listener>(): RecordingWorkerEvent<Listener> {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
  };
}

type PortMessageListener = Parameters<chrome.runtime.Port['onMessage']['addListener']>[0];
type PortDisconnectListener = Parameters<chrome.runtime.Port['onDisconnect']['addListener']>[0];

/** A listener of one of the two `chrome.runtime.Port` events. */
type PortListener = PortMessageListener | PortDisconnectListener;

/** What Chrome answers a rules call on a non-declarative event with. */
const UNSUPPORTED_RULES = 'This event does not support rules.';

/** A `chrome.runtime.Port` event over a listener set. */
interface FakeChromeEvent<Listener extends PortListener> extends chrome.events.Event<Listener> {
  readonly listeners: Set<Listener>;
}

function createChromeEvent<Listener extends PortListener>(): FakeChromeEvent<Listener> {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    hasListener: (listener) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    getRules: () => {
      throw new Error(UNSUPPORTED_RULES);
    },
    addRules: () => {
      throw new Error(UNSUPPORTED_RULES);
    },
    removeRules: () => {
      throw new Error(UNSUPPORTED_RULES);
    },
  };
}

/** A `chrome.runtime.Port` the case drives from the far side. */
interface FakePort extends chrome.runtime.Port {
  readonly onMessage: FakeChromeEvent<PortMessageListener>;
  readonly onDisconnect: FakeChromeEvent<PortDisconnectListener>;
  /** Every frame the worker posted on this port, in order. */
  readonly posted: unknown[];
}

function createPort(name: string, sender: chrome.runtime.MessageSender): FakePort {
  const posted: unknown[] = [];
  const onMessage = createChromeEvent<PortMessageListener>();
  const onDisconnect = createChromeEvent<PortDisconnectListener>();
  return {
    name,
    sender,
    posted,
    onMessage,
    onDisconnect,
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    disconnect: () => {
      onMessage.listeners.clear();
    },
  };
}

/** Deliver one frame to the worker on a port. */
function sendOnPort(port: FakePort, message: unknown): void {
  for (const listener of [...port.onMessage.listeners]) {
    listener(message, port);
  }
}

/** A complete `chrome.tabs.Tab` for an app tab, as a bridge sender carries it. */
function appTab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    url: APP_URL,
    pinned: false,
    highlighted: true,
    windowId: 1,
    active: true,
    frozen: false,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    lastAccessed: BASE_EPOCH_MS,
  };
}

/** A `chrome.storage` area over a map, optionally pre-filled. */
function createMemoryArea(initial: Readonly<Record<string, unknown>> = {}): {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Readonly<Record<string, unknown>>) => Promise<void>;
  remove: (key: string) => Promise<void>;
} {
  const items = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(items.has(key) ? { [key]: items.get(key) } : {}),
    set: (entries) => {
      for (const [key, value] of Object.entries(entries)) {
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

/** One `close(code, reason)` call a socket received. */
interface CloseCall {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

/** The listener sets of one socket, one per event of `WsEventMapLike`. */
type SocketListeners = {
  [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void>;
};

/** A socket the case drives by hand, recording every frame written to it. */
interface FakeSocket extends WebSocketLike {
  /** Every text frame written to it, in order. */
  readonly sent: readonly string[];
  /** The server accepted the connection: `readyState` OPEN, then `open`. */
  accept(): void;
  /** The server sent one frame. */
  receive(message: ProtocolMessage): void;
  /** The connection closed from the far side: `readyState` CLOSED, then `close`. */
  drop(code: number, reason?: string): void;
}

/** A recording socket constructor and the list every socket it builds joins. */
function createSocketFactory(): {
  readonly ctor: WebSocketConstructorLike;
  readonly sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];

  class RecordingSocket implements FakeSocket {
    readyState: number = READY_STATE.connecting;
    readonly sent: string[] = [];
    readonly closeCalls: CloseCall[] = [];
    private readonly listeners: SocketListeners = {
      open: new Set(),
      message: new Set(),
      close: new Set(),
      error: new Set(),
    };

    constructor() {
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

    accept(): void {
      this.readyState = READY_STATE.open;
      this.emit('open', { type: 'open' });
    }

    receive(message: ProtocolMessage): void {
      this.emit('message', { data: encodeMessage(message) });
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

/** One one-shot timer the worker scheduled and the case has not fired. */
interface HeldTimer {
  readonly handler: () => void;
  readonly ms: number;
}

/** Everything a composition case drives or inspects. */
interface WorkerHarness {
  readonly worker: DebugGeneratorWorker;
  readonly logs: readonly LogEntry[];
  readonly sockets: readonly FakeSocket[];
  /** How many timers of a given delay are scheduled and not yet fired or cleared. */
  timersPending(ms: number): number;
  /** Fire every held timer of a given delay, as its time passing would; answers how many. */
  fireTimers(ms: number): number;
  /** Open a port of a given name from a given sender. */
  connect(name: string, sender: chrome.runtime.MessageSender): FakePort;
  /** Close a tab: `tabs.get` no longer finds it, then `tabs.onRemoved` fires. */
  removeTab(tabId: number): void;
}

/** How a case configures its worker. */
interface WorkerHarnessOptions {
  /** Whether a devtools credential is stored. */
  readonly paired: boolean;
  /**
   * The tabs `chrome.storage.session` already records as bound when the worker
   * starts — each to its session ({@link sessionOfTab}), as a revived worker
   * finds them. Defaults to none.
   */
  readonly boundTabs?: readonly number[];
}

/** The session the fake service binds a tab to. */
function sessionOfTab(tabId: number): string {
  return tabId === OTHER_TAB_ID ? OTHER_SESSION_ID : SESSION_ID;
}

/** The registry snapshot that records every tab of `tabIds` as bound. */
function bindingSnapshot(tabIds: readonly number[]): Record<string, unknown> {
  if (tabIds.length === 0) {
    return {};
  }
  const records: Record<string, TabBindingRecord> = {};
  for (const tabId of tabIds) {
    records[String(tabId)] = {
      tabId,
      sessionId: sessionOfTab(tabId),
      url: APP_URL,
      origin: APP_ORIGIN,
      boundAt: BASE_EPOCH_MS,
    };
  }
  return { [BINDING_STORAGE_KEY]: records };
}

/** Build the real worker over fresh fakes; `paired` stores a devtools credential. */
function createWorkerHarness(options: WorkerHarnessOptions): WorkerHarness {
  const logs: LogEntry[] = [];
  const onConnect = createWorkerEvent<(port: chrome.runtime.Port) => void>();
  const onRemoved = createWorkerEvent<(tabId: number) => void>();
  /** Tabs the case closed; `tabs.get` rejects for them, as Chrome does. */
  const closedTabs = new Set<number>();
  const held = new Map<number, HeldTimer>();
  let lastTimer = 0;
  const { ctor, sockets } = createSocketFactory();
  const local = createMemoryArea(
    options.paired
      ? { [DEVTOOLS_TOKEN_STORAGE_KEY]: { version: STORED_CREDENTIAL_VERSION, token: TOKEN } }
      : {},
  );

  const env: WorkerEnvironment = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      onConnect,
      onInstalled: createWorkerEvent(),
      onStartup: createWorkerEvent(),
    },
    tabs: {
      reload: () => Promise.resolve(),
      get: (tabId): Promise<WorkerTab> =>
        closedTabs.has(tabId)
          ? Promise.reject(new Error('No tab with this id.'))
          : Promise.resolve({ url: APP_URL }),
      onUpdated: createWorkerEvent(),
      onRemoved,
    },
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(true),
      onAlarm: createWorkerEvent(),
    },
    storage: { local, session: createMemoryArea(bindingSnapshot(options.boundTabs ?? [])) },
    webSocketConstructor: ctor,
    // Held until the case fires them: the loss-notice interval (see
    // `elapseLossInterval`), a telemetry batch's bounded route wait
    // (`TELEMETRY_ROUTE_WAIT_MS`) and the zero-delay replay after a snapshot
    // answer are the only delays fired here.
    timers: {
      setTimeout: (handler, ms) => {
        lastTimer += 1;
        held.set(lastTimer, { handler, ms });
        return lastTimer;
      },
      clearTimeout: (handle) => {
        held.delete(handle);
      },
    },
    logger: createRecordingLogger(logs),
  };

  const worker = createWorker(env);
  return {
    worker,
    logs,
    sockets,
    timersPending: (ms) => [...held.values()].filter((timer) => timer.ms === ms).length,
    fireTimers: (ms) => {
      const due = [...held.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [handle, timer] of due) {
        held.delete(handle);
        timer.handler();
      }
      return due.length;
    },
    connect: (name, sender) => {
      const port = createPort(name, sender);
      for (const listener of [...onConnect.listeners]) {
        listener(port);
      }
      return port;
    },
    removeTab: (tabId) => {
      closedTabs.add(tabId);
      for (const listener of [...onRemoved.listeners]) {
        listener(tabId);
      }
    },
  };
}

/** Let every queued continuation and zero-delay task run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** How many loss-notice intervals are running. */
function lossIntervalsRunning(h: WorkerHarness): number {
  return h.timersPending(TELEMETRY_LOSS_NOTICE_INTERVAL_MS);
}

/**
 * Let one loss-notice interval pass: fire every timer scheduled for
 * {@link TELEMETRY_LOSS_NOTICE_INTERVAL_MS}, then let what they started
 * settle. The socket client's opening deadline has the same delay, so a socket
 * still connecting is retired too — as that much time passing would do; its
 * reconnect waits on a backoff timer no case fires.
 */
async function elapseLossInterval(h: WorkerHarness): Promise<void> {
  expect(h.fireTimers(TELEMETRY_LOSS_NOTICE_INTERVAL_MS)).toBeGreaterThan(0);
  await settle();
}

/** The sender of one of this extension's own pages. */
function extensionPageSender(path: string): chrome.runtime.MessageSender {
  return { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/${path}` };
}

/** The sender of the content bridge in an app tab's top frame. */
function bridgeSender(tabId: number = TAB_ID): chrome.runtime.MessageSender {
  return { id: EXTENSION_ID, tab: appTab(tabId), frameId: 0, origin: APP_ORIGIN, url: APP_URL };
}

/**
 * A panel and the DevTools page that announces its tab ({@link TAB_ID} by
 * default). The panel asks for its `session.snapshot` naming the tab it
 * inspects, as the DevTools panel does on every connect, which associates it
 * with that tab once start-up has settled; the DevTools page's hello asks for
 * the tab's binding.
 */
function openPanel(h: WorkerHarness, tabId: number = TAB_ID): FakePort {
  const panel = h.connect(PORT_PANEL, extensionPageSender('src/panel/panel.html'));
  requestSnapshot(panel, tabId);
  announceDevtools(h, tabId);
  return panel;
}

/** The DevTools page of a tab ({@link TAB_ID} by default), announcing it with its hello. */
function announceDevtools(h: WorkerHarness, tabId: number = TAB_ID): FakePort {
  const devtools = h.connect(PORT_DEVTOOLS, extensionPageSender('src/devtools/devtools.html'));
  const hello: DevtoolsUpstreamMessage<'devtools.hello'> = {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'devtools.hello',
    payload: { tabId, url: APP_URL },
  };
  sendOnPort(devtools, hello);
  return devtools;
}

/**
 * Ask for the panel's `session.snapshot`, as the panel does on every connect —
 * naming its inspected tab when given one, or none, as a panel page opened
 * outside DevTools does (a DevTools page's announcement then adopts it).
 */
function requestSnapshot(panel: FakePort, inspectedTabId?: number): PortRequestId {
  const requestId = newPortRequestId();
  const request: PortRequestFrame<'session.snapshot'> = {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'request',
    requestId,
    kind: 'session.snapshot',
    payload: inspectedTabId === undefined ? {} : { inspectedTabId },
  };
  sendOnPort(panel, request);
  return requestId;
}

/**
 * A panel that connects after its DevTools page announced the tab and asks
 * for its `session.snapshot` — the order a panel opening in an open DevTools
 * window produces. The worker associates it with the waiting page's tab while
 * it answers.
 */
function attachPanelBySnapshot(h: WorkerHarness): {
  readonly panel: FakePort;
  readonly requestId: PortRequestId;
} {
  const panel = h.connect(PORT_PANEL, extensionPageSender('src/panel/panel.html'));
  return { panel, requestId: requestSnapshot(panel) };
}

/** Where on the panel's port the answer to one request was posted; fails the case without one. */
function answerIndex(panel: FakePort, requestId: PortRequestId): number {
  const index = panel.posted.findIndex(
    (frame) => isRecord(frame) && frame.direction === 'response' && frame.requestId === requestId,
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

/** Where on the panel's port each protocol `error` push was posted. */
function errorPushIndexes(panel: FakePort): number[] {
  return panel.posted.flatMap((frame, index) =>
    isRecord(frame) &&
    frame.kind === 'protocol' &&
    isRecord(frame.message) &&
    frame.message.type === 'error'
      ? [index]
      : [],
  );
}

/** The content bridge's port in an app tab. */
function connectBridge(h: WorkerHarness, tabId: number = TAB_ID): FakePort {
  return h.connect(PORT_CONTENT_BRIDGE, bridgeSender(tabId));
}

/**
 * The content bridge of a tab whose page agent has announced its document —
 * {@link DOCUMENT_ID} on {@link TAB_ID}, {@link DOCUMENT_ID_2} on
 * {@link OTHER_TAB_ID} — as a page load delivers it. The port hub forwards a
 * bridge's batches only once its `agent.ready` pinned their document and
 * producer.
 */
function connectReadyBridge(h: WorkerHarness, tabId: number = TAB_ID): FakePort {
  const bridge = connectBridge(h, tabId);
  sendOnPort(
    bridge,
    tabId === OTHER_TAB_ID
      ? readyFrame(DOCUMENT_ID_2, PRODUCER_ID_2)
      : readyFrame(DOCUMENT_ID, PRODUCER_ID),
  );
  return bridge;
}

/**
 * Answer, as the service does, every `session.bind` a socket carried that has
 * not been answered yet: bind the tab to its session ({@link sessionOfTab})
 * and send `session.bound`. That confirmation is the service-confirmed route
 * the worker delivers a tab's telemetry along.
 */
function answerBinds(socket: FakeSocket): void {
  const binds = framesOf(socket).filter((message) => isMessageOfType(message, 'session.bind'));
  const answered = answeredBinds.get(socket) ?? 0;
  for (const bind of binds.slice(answered)) {
    socket.receive(
      createEnvelope('session.bound', {
        sessionId: sessionOfTab(bind.payload.tabId),
        tabId: bind.payload.tabId,
        url: bind.payload.url,
        reason: 'bound',
      }),
    );
  }
  answeredBinds.set(socket, binds.length);
}

/** How many of each socket's `session.bind` frames {@link answerBinds} answered. */
const answeredBinds = new WeakMap<FakeSocket, number>();

/**
 * Open the only socket and let the service confirm every binding the worker
 * announces on it, then let what that releases settle.
 */
async function openAndBind(h: WorkerHarness): Promise<FakeSocket> {
  const socket = onlySocket(h);
  socket.accept();
  await settle();
  answerBinds(socket);
  await settle();
  return socket;
}

/** The bridge → worker frame that relays one `telemetry.batch`. */
function batchFrame(
  events: TelemetryEventIngress[],
  options: {
    readonly batchSeq: number;
    readonly droppedCount?: number;
    readonly documentId?: string;
    readonly producerId?: string;
  },
): BridgeUpstreamMessage<'telemetry.batch'> {
  const payload: PageTelemetryBatchPayload = {
    events,
    producerId: options.producerId ?? PRODUCER_ID,
    documentId: options.documentId ?? DOCUMENT_ID,
    batchSeq: options.batchSeq,
    droppedCount: options.droppedCount ?? 0,
  };
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'telemetry.batch',
    payload,
  };
}

/** The bridge → worker frame that relays one `agent.ready`. */
function readyFrame(documentId: string, producerId: string): BridgeUpstreamMessage<'agent.ready'> {
  const payload: PageAgentReadyPayload = {
    documentId,
    producerId,
    url: APP_URL,
    installedBeforeReact: true,
    reactDetected: true,
  };
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'agent.ready',
    payload,
  };
}

/** The only socket the worker opened; fails the case otherwise. */
function onlySocket(h: WorkerHarness): FakeSocket {
  expect(h.sockets).toHaveLength(1);
  const socket = h.sockets[0];
  if (socket === undefined) {
    expect.unreachable('the worker opened no socket');
  }
  return socket;
}

/** Every frame a socket carried, decoded with the protocol's own validator. */
function framesOf(socket: FakeSocket): ProtocolMessage[] {
  return socket.sent.map((frame) => {
    const decoded = decodeMessage(frame);
    if (isErr(decoded)) {
      throw new Error(`a recorded frame failed to decode (${decoded.error.code})`);
    }
    return decoded.value;
  });
}

/** The `telemetry.event` frames a socket carried, in order. */
function telemetryFramesOf(socket: FakeSocket): MessageByType<'telemetry.event'>[] {
  return framesOf(socket).filter((message): message is MessageByType<'telemetry.event'> =>
    isMessageOfType(message, 'telemetry.event'),
  );
}

/** The ids of every event a socket carried, in delivery order. */
function deliveredEventIds(socket: FakeSocket): string[] {
  return telemetryFramesOf(socket).flatMap((frame) =>
    frame.payload.events.map((event) => event.id),
  );
}

/** A plain record, for narrowing what a port carried. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every protocol `error` payload the worker pushed on a panel port, validated. */
function errorPushes(panel: FakePort): ErrorPayload[] {
  const payloads: ErrorPayload[] = [];
  for (const frame of panel.posted) {
    if (
      isRecord(frame) &&
      frame.kind === 'protocol' &&
      isRecord(frame.message) &&
      frame.message.type === 'error'
    ) {
      const parsed = parseErrorPayload(frame.message.payload);
      if (!parsed.ok) {
        throw new Error(`the worker pushed an invalid error payload (${parsed.error.code})`);
      }
      payloads.push(parsed.value);
    }
  }
  return payloads;
}

/** The records of one log line, in order. */
function logsOf(h: WorkerHarness, message: string): LogEntry[] {
  return h.logs.filter((entry) => entry.message === message);
}

/** A JSON response as the stubbed `fetch` answers it. */
function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** A record of `sessionId`, as the service's `GET /sessions/:id` answers it. */
function sessionRecordOf(sessionId: string): unknown {
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

/** A session's record, or (with `/panel`) its current panel: what a bound panel's snapshot reads. */
const SESSION_READ_PATH = /^\/sessions\/([^/]+)(\/panel)?$/u;

/**
 * Stands in for the platform `fetch`. It answers only what the worker reads
 * for a paired, bound tab's panel — the session record and its current panel
 * (none) — and the health probe of a dropped socket; any other request fails
 * the case, so no telemetry and no page data travels over HTTP.
 */
const globalFetch = vi.fn<FetchLike>((url) => {
  const path = new URL(url).pathname;
  if (path === '/health') {
    return Promise.resolve(jsonResponse(200, HEALTH_BODY));
  }
  const read = SESSION_READ_PATH.exec(path);
  const sessionId = read?.[1];
  if (sessionId === undefined) {
    return Promise.reject(new Error('the platform fetch reached a route no case here reads'));
  }
  return Promise.resolve(
    read?.[2] === undefined
      ? jsonResponse(200, sessionRecordOf(decodeURIComponent(sessionId)))
      : jsonResponse(200, { panel: null }),
  );
});

beforeEach(() => {
  globalFetch.mockClear();
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  for (const [url, init] of globalFetch.mock.calls) {
    const path = new URL(url).pathname;
    expect(path === '/health' || SESSION_READ_PATH.test(path), path).toBe(true);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(leaksSentinel([url, init])).toBe(false);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/*
 * ===========================================================================
 * Composition cases
 * ===========================================================================
 */

describe('the composed worker — telemetry across a cold start', () => {
  let h: WorkerHarness;

  afterEach(() => {
    h.worker.dispose();
  });

  it('delivers a batch posted before the socket connects, in order with a later batch, once start-up completes', async () => {
    // A revived worker: the tab's binding is in session storage, where the
    // worker that was suspended left it.
    h = createWorkerHarness({ paired: true, boundTabs: [TAB_ID] });
    // The page load that woke the worker: its bridge reconnects, and the agent
    // announces its document and drains in the same turn the module is
    // evaluated in.
    const bridge = connectReadyBridge(h);
    expect(h.worker.wsBridge.getStatus().transport).toBe('closed');

    sendOnPort(bridge, batchFrame(makeEvents(0, 3), { batchSeq: 0 }));
    await h.worker.ready;
    sendOnPort(bridge, batchFrame(makeEvents(3, 2), { batchSeq: 1 }));
    await settle();
    const socket = onlySocket(h);
    // Waiting behind the handshake: nothing is written before the socket opens.
    expect(socket.sent).toHaveLength(0);

    // The socket opens and the service confirms the re-announced binding —
    // the route the batches were waiting for.
    await openAndBind(h);

    expect(framesOf(socket)[0]?.type).toBe('client.hello');
    expect(deliveredEventIds(socket)).toEqual(eventIds(0, 5));
    expect(new Set(telemetryFramesOf(socket).map((frame) => frame.sessionId))).toEqual(
      new Set([SESSION_ID]),
    );
    expect(logsOf(h, LOSS_LOG)).toEqual([]);
    expect(logsOf(h, HOLD_OVERFLOW_LOG)).toEqual([]);
    expect(lossIntervalsRunning(h)).toBe(0);
  });

  it('holds at most COLD_START_HELD_EVENTS_PER_TAB events per tab until start-up, and shows the rest as undelivered', async () => {
    h = createWorkerHarness({ paired: true, boundTabs: [TAB_ID, OTHER_TAB_ID] });
    const panel = openPanel(h);
    const bridge = connectReadyBridge(h);
    const otherBridge = connectReadyBridge(h, OTHER_TAB_ID);
    const first = 4_000;
    const second = 1_500;
    const third = 10;
    const refusedFromSecond = first + second - COLD_START_HELD_EVENTS_PER_TAB;

    sendOnPort(bridge, batchFrame(makeEvents(0, first), { batchSeq: 0 }));
    sendOnPort(bridge, batchFrame(makeEvents(first, second), { batchSeq: 1 }));
    sendOnPort(bridge, batchFrame(makeEvents(first + second, third), { batchSeq: 2 }));
    // Another tab's allowance is its own.
    sendOnPort(
      otherBridge,
      batchFrame(makeEvents(0, 200, PRODUCER_ID_2), {
        batchSeq: 0,
        producerId: PRODUCER_ID_2,
        documentId: DOCUMENT_ID_2,
      }),
    );
    await settle();

    // The first refusal is shown at once, with its own count. Start-up was
    // still pending, and a panel is associated with its tab only by its
    // snapshot, answered after start-up: the notice reached no panel, so the
    // burst is kept for the panel that is attaching.
    expect(
      logsOf(h, NOTICE_LOG).map((entry) => [
        entry.fields.tabId,
        entry.fields.loss,
        entry.fields.events,
        entry.fields.panels,
      ]),
    ).toEqual([[TAB_ID, 'undelivered', refusedFromSecond, 0]]);
    expect(errorPushes(panel)).toEqual([]);
    expect(
      logsOf(h, HOLD_OVERFLOW_LOG).map((entry) => [
        entry.level,
        entry.fields.tabId,
        entry.fields.dropped,
      ]),
    ).toEqual([
      ['warn', TAB_ID, refusedFromSecond],
      ['warn', TAB_ID, third],
    ]);

    const socket = await openAndBind(h);

    // The oldest events are kept, in order; the other tab lost nothing.
    const delivered = telemetryFramesOf(socket);
    const ids = delivered.flatMap((frame) => frame.payload.events.map((event) => event.id));
    const mine = delivered
      .flatMap((frame) => frame.payload.events)
      .filter((event) => event.producerId === PRODUCER_ID)
      .map((event) => event.id);
    expect(mine).toEqual(eventIds(0, COLD_START_HELD_EVENTS_PER_TAB));
    expect(ids).toHaveLength(COLD_START_HELD_EVENTS_PER_TAB + 200);

    // The burst's running total is shown to the attached panel when the
    // interval ends — once, not replayed a second time on its association …
    await elapseLossInterval(h);
    expect(errorPushes(panel)).toEqual([
      telemetryLossNotice('undelivered', refusedFromSecond + third),
    ]);
    // … and an interval without further loss ends the burst.
    await elapseLossInterval(h);
    expect(errorPushes(panel)).toHaveLength(1);
    expect(lossIntervalsRunning(h)).toBe(0);

    expect(leaksSentinel(h.logs)).toBe(false);
    expect(leaksSentinel(panel.posted)).toBe(false);
  });

  it('keeps agent.ready and the batches in arrival order, across the cold start and after it', async () => {
    h = createWorkerHarness({ paired: true, boundTabs: [TAB_ID] });
    const bridge = connectBridge(h);

    sendOnPort(bridge, readyFrame(DOCUMENT_ID, PRODUCER_ID));
    sendOnPort(bridge, batchFrame(makeEvents(0, 2), { batchSeq: 0 }));
    sendOnPort(bridge, batchFrame(makeEvents(2, 2), { batchSeq: 1 }));
    await h.worker.ready;
    // After start-up, before the socket opens: a later batch of the same
    // document …
    sendOnPort(bridge, batchFrame(makeEvents(4, 1), { batchSeq: 2 }));
    await settle();
    // … then the page reloads. The reloaded document is served by a new
    // content bridge (the hub pins one document per bridge, and the new
    // bridge supersedes the old one), which relays its report and first batch.
    const reloaded = connectBridge(h);
    sendOnPort(reloaded, readyFrame(DOCUMENT_ID_2, PRODUCER_ID_2));
    sendOnPort(
      reloaded,
      batchFrame(makeEvents(5, 1, PRODUCER_ID_2), {
        batchSeq: 0,
        documentId: DOCUMENT_ID_2,
        producerId: PRODUCER_ID_2,
      }),
    );
    await settle();
    const socket = await openAndBind(h);

    const sequence = framesOf(socket).flatMap((message): string[] => {
      if (isMessageOfType(message, 'agent.ready')) {
        return [`agent.ready ${message.payload.documentId}`];
      }
      if (isMessageOfType(message, 'telemetry.event')) {
        return [`telemetry ${message.payload.events.map((event) => event.id).join(',')}`];
      }
      return [];
    });
    expect(sequence).toEqual([
      `agent.ready ${DOCUMENT_ID}`,
      `telemetry ${eventIds(0, 2).join(',')}`,
      `telemetry ${eventIds(2, 2).join(',')}`,
      `telemetry ${eventId(4)}`,
      `agent.ready ${DOCUMENT_ID_2}`,
      `telemetry ${eventId(5)}`,
    ]);
    expect(logsOf(h, LOSS_LOG)).toEqual([]);
  });
});

describe('the composed worker — telemetry the service cannot receive', () => {
  let h: WorkerHarness;

  afterEach(() => {
    h.worker.dispose();
  });

  it('shows a batch refused by an unpaired worker as undelivered, with its count and no page data', async () => {
    // The tab's binding outlived the credential: nothing can confirm its route.
    h = createWorkerHarness({ paired: false, boundTabs: [TAB_ID] });
    const panel = openPanel(h);
    const bridge = connectReadyBridge(h);
    await h.worker.ready;
    await settle();

    sendOnPort(bridge, batchFrame(makeEvents(0, 3), { batchSeq: 0 }));
    await settle();
    // The batch waits for its route within its bounded delivery wait …
    expect(h.sockets).toHaveLength(0);
    expect(errorPushes(panel)).toEqual([]);
    expect(h.timersPending(TELEMETRY_ROUTE_WAIT_MS)).toBeGreaterThan(0);

    // … and is refused, and shown, once the wait expires unconfirmed.
    h.fireTimers(TELEMETRY_ROUTE_WAIT_MS);
    await settle();

    expect(h.sockets).toHaveLength(0);
    expect(errorPushes(panel)).toEqual([telemetryLossNotice('undelivered', 3)]);
    expect(
      logsOf(h, LOSS_LOG).map((entry) => [
        entry.level,
        entry.fields.tabId,
        entry.fields.errorCode,
        entry.fields.events,
      ]),
    ).toEqual([['warn', TAB_ID, 'TRANSPORT_DISCONNECTED', 3]]);
    // The notice's own log line is counts only, and says it reached the panel.
    expect(logsOf(h, NOTICE_LOG).map((entry) => entry.fields)).toEqual([
      expect.objectContaining({ tabId: TAB_ID, loss: 'undelivered', events: 3, panels: 1 }),
    ]);
    expect(leaksSentinel(h.logs)).toBe(false);
    expect(leaksSentinel(panel.posted)).toBe(false);
  });

  it('shows batches refused after the service rejected the credential as undelivered, coalesced', async () => {
    h = createWorkerHarness({ paired: true, boundTabs: [TAB_ID] });
    const panel = openPanel(h);
    const bridge = connectReadyBridge(h);
    await h.worker.ready;
    const socket = await openAndBind(h);
    sendOnPort(bridge, batchFrame(makeEvents(0, 2), { batchSeq: 0 }));
    await settle();
    expect(deliveredEventIds(socket)).toEqual(eventIds(0, 2));

    // A rotated or revoked credential: the service closes with 4401, and the
    // client stays closed — no retry with a refused credential.
    socket.drop(WS_CLOSE_UNAUTHORIZED, 'the devtools credential was refused');
    await settle();
    expect(h.worker.wsBridge.getStatus().transport).toBe('closed');

    sendOnPort(bridge, batchFrame(makeEvents(2, 4), { batchSeq: 1 }));
    sendOnPort(bridge, batchFrame(makeEvents(6, 1), { batchSeq: 2 }));
    await settle();

    expect(errorPushes(panel)).toEqual([telemetryLossNotice('undelivered', 4)]);
    await elapseLossInterval(h);
    expect(errorPushes(panel)).toEqual([
      telemetryLossNotice('undelivered', 4),
      telemetryLossNotice('undelivered', 5),
    ]);
    expect(deliveredEventIds(socket)).toEqual(eventIds(0, 2));
    expect(h.sockets).toHaveLength(1);
    expect(leaksSentinel(h.logs)).toBe(false);
    expect(leaksSentinel(panel.posted)).toBe(false);
  });

  it('shows telemetry that could not reach an unreachable service as undelivered, with its count', async () => {
    h = createWorkerHarness({ paired: true, boundTabs: [TAB_ID] });
    const panel = openPanel(h);
    const bridge = connectReadyBridge(h);
    await h.worker.ready;
    await settle();
    // The service never accepts the connection, so the tab's route is never
    // confirmed. Telemetry waits on the tab's lane — never in the socket
    // client's volatile queue — which holds at most LANE_BOUND batches.
    const socket = onlySocket(h);
    const queuedAhead = h.worker.wsBridge.getStatus().queuedFrameCount;
    const overflow = 3;
    const eventsPerBatch = 2;

    for (let batchSeq = 0; batchSeq < LANE_BOUND + overflow; batchSeq += 1) {
      sendOnPort(
        bridge,
        batchFrame(makeEvents(batchSeq * eventsPerBatch, eventsPerBatch), { batchSeq }),
      );
    }
    await settle();

    expect(socket.sent).toHaveLength(0);
    // Nothing of the telemetry entered the socket client's queue, so nothing
    // can be lost from it unseen.
    expect(h.worker.wsBridge.getStatus()).toMatchObject({ queuedFrameCount: queuedAhead });
    expect(logsOf(h, QUEUE_DROP_LOG)).toEqual([]);
    // The batches beyond the lane's bound are refused on arrival, and the
    // first refusal is shown at once.
    expect(
      logsOf(h, LANE_OVERFLOW_LOG).map((entry) => [
        entry.level,
        entry.fields.tabId,
        entry.fields.events,
      ]),
    ).toEqual(Array.from({ length: overflow }, () => ['warn', TAB_ID, eventsPerBatch]));
    expect(errorPushes(panel)).toEqual([telemetryLossNotice('undelivered', eventsPerBatch)]);

    // The waiting batches are refused when their bounded wait expires; the
    // burst's running total is shown when the interval ends.
    h.fireTimers(TELEMETRY_ROUTE_WAIT_MS);
    await settle();
    expect(
      logsOf(h, LOSS_LOG).map((entry) => [
        entry.level,
        entry.fields.tabId,
        entry.fields.errorCode,
        entry.fields.events,
      ]),
    ).toEqual(
      Array.from({ length: LANE_BOUND }, () => [
        'warn',
        TAB_ID,
        'TRANSPORT_DISCONNECTED',
        eventsPerBatch,
      ]),
    );
    expect(errorPushes(panel)).toHaveLength(1);

    await elapseLossInterval(h);
    expect(errorPushes(panel)).toEqual([
      telemetryLossNotice('undelivered', eventsPerBatch),
      telemetryLossNotice('undelivered', eventsPerBatch * (LANE_BOUND + overflow)),
    ]);
    expect(telemetryFramesOf(socket)).toEqual([]);
    expect(leaksSentinel(h.logs)).toBe(false);
    expect(leaksSentinel(panel.posted)).toBe(false);
  });
});

describe('the composed worker — loss notices no panel saw', () => {
  let h: WorkerHarness;

  afterEach(() => {
    h.worker.dispose();
  });

  /**
   * A paired worker, started, with the tab's content bridge — its document
   * announced — and no panel; answers the bridge.
   */
  async function startWithoutPanel(): Promise<FakePort> {
    h = createWorkerHarness({ paired: true });
    const bridge = connectReadyBridge(h);
    await h.worker.ready;
    await settle();
    return bridge;
  }

  /** Report `droppedCount` events lost inside the page, on a one-event batch. */
  function reportPageLoss(
    bridge: FakePort,
    batchSeq: number,
    droppedCount: number,
    identity: { readonly documentId: string; readonly producerId: string } = {
      documentId: DOCUMENT_ID,
      producerId: PRODUCER_ID,
    },
  ): void {
    sendOnPort(
      bridge,
      batchFrame(makeEvents(batchSeq, 1, identity.producerId), {
        batchSeq,
        droppedCount,
        ...identity,
      }),
    );
  }

  /** The events and panel count of every notice the worker pushed, in order. */
  function noticesPushed(): (readonly [unknown, unknown])[] {
    return logsOf(h, NOTICE_LOG).map((entry) => [entry.fields.events, entry.fields.panels]);
  }

  it('replays a notice no panel saw exactly once, with its count, to a panel attaching through session.snapshot — after the answer', async () => {
    const bridge = await startWithoutPanel();
    reportPageLoss(bridge, 0, 5);
    await settle();
    expect(noticesPushed()).toEqual([[5, 0]]);
    // The interval ends with nobody told: the burst is kept, with no timer.
    await elapseLossInterval(h);
    expect(lossIntervalsRunning(h)).toBe(0);

    announceDevtools(h);
    await settle();
    const { panel, requestId } = attachPanelBySnapshot(h);
    await settle();
    // The answer is posted first; the replay waits for a zero-delay task.
    expect(answerIndex(panel, requestId)).toBeGreaterThanOrEqual(0);
    expect(errorPushes(panel)).toEqual([]);
    expect(h.fireTimers(0)).toBe(1);
    await settle();

    expect(errorPushes(panel)).toEqual([telemetryLossNotice('dropped-in-page', 5)]);
    expect(errorPushIndexes(panel)[0]).toBeGreaterThan(answerIndex(panel, requestId));
    expect(noticesPushed()).toEqual([
      [5, 0],
      [5, 1],
    ]);

    // The same panel asking again, as a reconnecting panel does, replays nothing …
    requestSnapshot(panel);
    await settle();
    h.fireTimers(0);
    await settle();
    // … the burst ends with its interval, now that it was seen …
    await elapseLossInterval(h);
    expect(lossIntervalsRunning(h)).toBe(0);
    // … and a later attach has nothing to replay at all.
    requestSnapshot(panel);
    await settle();
    expect(h.fireTimers(0)).toBe(0);
    expect(errorPushes(panel)).toEqual([telemetryLossNotice('dropped-in-page', 5)]);
    expect(leaksSentinel(h.logs)).toBe(false);
    expect(leaksSentinel(panel.posted)).toBe(false);
  });

  it('replays it to a panel its DevTools page adopts, after the hydration pushes', async () => {
    const bridge = await startWithoutPanel();
    reportPageLoss(bridge, 0, 3);
    await settle();
    await elapseLossInterval(h);

    // The panel connects first and asks for its snapshot without naming a
    // tab, so it waits unassociated; the DevTools page's hello adopts it.
    const panel = h.connect(PORT_PANEL, extensionPageSender('src/panel/panel.html'));
    requestSnapshot(panel);
    await settle();
    expect(errorPushes(panel)).toEqual([]);
    announceDevtools(h);
    await settle();

    expect(errorPushes(panel)).toEqual([telemetryLossNotice('dropped-in-page', 3)]);
    const bindingAt = panel.posted.findIndex(
      (frame) => isRecord(frame) && frame.kind === 'binding',
    );
    expect(bindingAt).toBeGreaterThanOrEqual(0);
    expect(errorPushIndexes(panel)[0]).toBeGreaterThan(bindingAt);
    await elapseLossInterval(h);
    expect(errorPushes(panel)).toHaveLength(1);
    expect(lossIntervalsRunning(h)).toBe(0);
  });

  it('shows loss accumulated during a running interval to a panel that attached meanwhile when the interval ends, with the burst total', async () => {
    const bridge = await startWithoutPanel();
    reportPageLoss(bridge, 0, 2);
    reportPageLoss(bridge, 1, 4);
    await settle();
    // Shown to nobody; the second loss waits for the interval.
    expect(noticesPushed()).toEqual([[2, 0]]);

    announceDevtools(h);
    await settle();
    const { panel } = attachPanelBySnapshot(h);
    await settle();
    // The interval is still running, so the replay leaves the notice to its end.
    expect(h.fireTimers(0)).toBe(1);
    await settle();
    expect(errorPushes(panel)).toEqual([]);

    await elapseLossInterval(h);
    expect(errorPushes(panel)).toEqual([telemetryLossNotice('dropped-in-page', 6)]);
    await elapseLossInterval(h);
    expect(errorPushes(panel)).toHaveLength(1);
    expect(lossIntervalsRunning(h)).toBe(0);
  });

  it('shows a notice no panel saw again when its interval ends with a panel attached meanwhile', async () => {
    const bridge = await startWithoutPanel();
    reportPageLoss(bridge, 0, 2);
    await settle();

    announceDevtools(h);
    await settle();
    const { panel } = attachPanelBySnapshot(h);
    await settle();
    h.fireTimers(0);
    await settle();
    expect(errorPushes(panel)).toEqual([]);

    await elapseLossInterval(h);
    expect(errorPushes(panel)).toEqual([telemetryLossNotice('dropped-in-page', 2)]);
    await elapseLossInterval(h);
    expect(errorPushes(panel)).toHaveLength(1);
    expect(lossIntervalsRunning(h)).toBe(0);
  });

  it('shows new loss on a burst kept for a panel at once, with the burst’s running total', async () => {
    const bridge = await startWithoutPanel();
    reportPageLoss(bridge, 0, 5);
    await settle();
    await elapseLossInterval(h);
    expect(lossIntervalsRunning(h)).toBe(0);

    reportPageLoss(bridge, 1, 2);
    await settle();
    expect(noticesPushed()).toEqual([
      [5, 0],
      [7, 0],
    ]);

    announceDevtools(h);
    await settle();
    const { panel } = attachPanelBySnapshot(h);
    await settle();
    h.fireTimers(0);
    await elapseLossInterval(h);
    // The latest notice names everything the burst lost.
    expect(errorPushes(panel)).toEqual([telemetryLossNotice('dropped-in-page', 7)]);
  });

  it('forgets a closed tab’s notices, whether their interval is running or they wait for a panel', async () => {
    const bridge = await startWithoutPanel();
    const otherBridge = connectReadyBridge(h, OTHER_TAB_ID);
    const otherIdentity = { documentId: DOCUMENT_ID_2, producerId: PRODUCER_ID_2 };
    reportPageLoss(otherBridge, 0, 3, otherIdentity);
    await settle();
    await elapseLossInterval(h);
    // The other tab's burst waits for a panel, with no timer; this tab's runs.
    reportPageLoss(bridge, 0, 2);
    await settle();
    expect(lossIntervalsRunning(h)).toBe(1);

    h.removeTab(TAB_ID);
    h.removeTab(OTHER_TAB_ID);

    expect(lossIntervalsRunning(h)).toBe(0);
    const panel = openPanel(h, TAB_ID);
    const otherPanel = openPanel(h, OTHER_TAB_ID);
    await settle();
    expect(errorPushes(panel)).toEqual([]);
    expect(errorPushes(otherPanel)).toEqual([]);
  });

  it('forgets loss recorded after its tab closed once its interval ends, rather than waiting for a panel', async () => {
    const bridge = await startWithoutPanel();
    h.removeTab(TAB_ID);
    // A batch still in flight from the closed tab reports page-side loss.
    reportPageLoss(bridge, 0, 4);
    await settle();
    expect(noticesPushed()).toEqual([[4, 0]]);

    await elapseLossInterval(h);

    expect(logsOf(h, CLOSED_TAB_LOSS_LOG).map((entry) => entry.fields)).toEqual([
      expect.objectContaining({ tabId: TAB_ID }),
    ]);
    const panel = openPanel(h, TAB_ID);
    await settle();
    expect(errorPushes(panel)).toEqual([]);
    expect(lossIntervalsRunning(h)).toBe(0);
  });
});

describe('the composed worker — events the page dropped before the batch', () => {
  let h: WorkerHarness;

  afterEach(() => {
    h.worker.dispose();
  });

  it('shows droppedCount as one coalesced notice per interval, and still delivers the batches', async () => {
    h = createWorkerHarness({ paired: true, boundTabs: [TAB_ID] });
    const panel = openPanel(h);
    const bridge = connectReadyBridge(h);
    await h.worker.ready;
    const socket = await openAndBind(h);

    sendOnPort(bridge, batchFrame(makeEvents(0, 1), { batchSeq: 0, droppedCount: 7 }));
    await settle();
    expect(errorPushes(panel)).toEqual([telemetryLossNotice('dropped-in-page', 7)]);

    // A burst inside the interval adds up; nothing more is shown yet.
    sendOnPort(bridge, batchFrame(makeEvents(1, 1), { batchSeq: 1, droppedCount: 3 }));
    sendOnPort(bridge, batchFrame(makeEvents(2, 1), { batchSeq: 2, droppedCount: 2 }));
    await settle();
    expect(errorPushes(panel)).toHaveLength(1);

    await elapseLossInterval(h);
    expect(errorPushes(panel)).toEqual([
      telemetryLossNotice('dropped-in-page', 7),
      telemetryLossNotice('dropped-in-page', 12),
    ]);

    // A quiet interval ends the burst; the next loss starts a new one.
    await elapseLossInterval(h);
    expect(lossIntervalsRunning(h)).toBe(0);
    sendOnPort(bridge, batchFrame(makeEvents(3, 1), { batchSeq: 3, droppedCount: 1 }));
    await settle();
    expect(errorPushes(panel)).toEqual([
      telemetryLossNotice('dropped-in-page', 7),
      telemetryLossNotice('dropped-in-page', 12),
      telemetryLossNotice('dropped-in-page', 1),
    ]);

    expect(deliveredEventIds(socket)).toEqual(eventIds(0, 4));
    expect(
      logsOf(h, 'The page agent dropped events before this batch.').map(
        (entry) => entry.fields.dropped,
      ),
    ).toEqual([7, 3, 2, 1]);
    expect(leaksSentinel(h.logs)).toBe(false);
    expect(leaksSentinel(panel.posted)).toBe(false);
  });

  it('cancels a pending notice when the worker is disposed', async () => {
    h = createWorkerHarness({ paired: true });
    const panel = openPanel(h);
    const bridge = connectReadyBridge(h);
    await h.worker.ready;
    // Open, so the socket's opening deadline — of the same delay — is not
    // counted as a loss interval.
    onlySocket(h).accept();
    await settle();
    sendOnPort(bridge, batchFrame(makeEvents(0, 1), { batchSeq: 0, droppedCount: 2 }));
    sendOnPort(bridge, batchFrame(makeEvents(1, 1), { batchSeq: 1, droppedCount: 2 }));
    await settle();
    expect(lossIntervalsRunning(h)).toBe(1);

    h.worker.dispose();

    expect(lossIntervalsRunning(h)).toBe(0);
    expect(errorPushes(panel)).toEqual([telemetryLossNotice('dropped-in-page', 2)]);
  });
});
