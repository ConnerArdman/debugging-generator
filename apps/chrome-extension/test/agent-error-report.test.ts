/**
 * Unit spec for what the service worker logs and shows about the page agent's
 * frames — `agentErrorReport` and the composed worker in
 * `../src/background/service-worker.ts`, and the `agent.ready` log lines of
 * `../src/background/agent-control.ts` (`ws-bridge.ts`'s relay has its own
 * cases in `./ws-bridge.test.ts`).
 *
 * Every page agent frame is produced in the page's own realm, so a page script
 * can forge one carrying a URL, a token or any other private text (CWE-532,
 * AAP §0.5.2). The spec holds two guarantees, each both at the unit and
 * through the whole composition:
 *
 * - **Only the closed vocabulary travels.** An `agent.error` is recognised by
 *   its `code` or, code-less, by its loss `reason`, against
 *   `PAGE_AGENT_ERROR_CODES` and `PAGE_AGENT_LOSS_REASONS`. A recognised frame
 *   is logged with its tab and kind alone, and shown with its kind's fixed
 *   sentence from `PAGE_AGENT_ERROR_PUBLIC_MESSAGES` under `CLEANUP_PARTIAL`
 *   (`hooks-not-released`) or `INSTRUMENTATION_UNAVAILABLE` (every other
 *   kind); its `captureId` becomes the panel's `ref` only when it has the
 *   exact shape of a service-minted capture id. An unrecognised frame is never
 *   shown, and its log line carries no page byte.
 * - **Page-supplied ids are fingerprinted before they are logged.**
 *   `agent.ready`'s `documentId` is kept raw in the readiness memo and the
 *   relayed report — readiness and the stale-report check need it — while
 *   every agent-control log line, on the relay's failure branches and on every
 *   branch of the consented reload, names a document by its
 *   `fingerprintPageId` digest alone.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). The composition cases build the real
 * worker through `createWorker` over recording fakes local to this file — the
 * module is injectable and its bootstrap attaches nothing outside an extension
 * service worker — and drive it only through Chrome-shaped runtime ports: a
 * panel, a DevTools page announcing the tab, and the content bridge that
 * relays the forged frames. No credential is stored, so no socket is opened
 * and no HTTP request is made; the global `fetch` is a spy that must record
 * zero calls. Frames the composition cases send use only the shapes and the
 * canonical ids the real agent posts (`packages/telemetry/src/browser/
 * agent.ts`), so they pass whatever structural check the bridge port applies;
 * ids of any other shape are driven into `createAgentControl` directly. Every
 * forged value is a private sentinel that must appear in no log record and no
 * panel frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { parseErrorPayload } from '@debuggen/protocol';
import type { ErrorPayload, FetchLike, SendOutcome, WebSocketLike } from '@debuggen/protocol';
import { err, ok } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import { createAgentControl } from '../src/background/agent-control';
import type { AgentControl, AgentTabsApi } from '../src/background/agent-control';
import { workerError } from '../src/background/messages';
import type { ProtocolSend, WorkerTimerApi } from '../src/background/messages';
import { agentErrorReport, createWorker } from '../src/background/service-worker';
import type {
  DebugGeneratorWorker,
  WorkerEnvironment,
  WorkerEvent,
  WorkerTab,
} from '../src/background/service-worker';
import {
  EXTENSION_CHANNEL,
  fingerprintPageId,
  newPortRequestId,
  PAGE_AGENT_ERROR_CODES,
  PAGE_AGENT_ERROR_PUBLIC_MESSAGES,
  PAGE_AGENT_LOSS_REASONS,
  parsePortResponse,
  PORT_CONTENT_BRIDGE,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
} from '../src/shared/messages';
import type {
  BridgeUpstreamMessage,
  DevtoolsUpstreamMessage,
  PageAgentErrorKind,
  PageAgentErrorPayload,
  PageAgentReadyPayload,
  PortRequestFrame,
  PortRequestKind,
  PortRequestPayloads,
  PortResponse,
} from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/**
 * The private text a forged frame carries: a credential-shaped pair, a URL and
 * a query value. None of it may reach a log record or a panel frame.
 */
const SENTINEL = 'PRIVATE-SENTINEL token=abc https://x/?q=secret';

/** The fragments of {@link SENTINEL} searched for, so a partial copy is caught too. */
const SENTINEL_FRAGMENTS: readonly string[] = ['PRIVATE-SENTINEL', 'token=abc', 'q=secret'];

/** A capture id of the exact shape the service mints. */
const CANONICAL_CAPTURE_ID = 'cap_0123456789abcdef';

/** Capture-id-like values of every other shape; none may become a `ref`. */
const NON_CANONICAL_CAPTURE_IDS: readonly unknown[] = [
  SENTINEL,
  'cap_0123456789ABCDEF',
  'cap_0123456789abcde',
  'cap_0123456789abcdef0',
  'ses_0123456789abcdef',
  ' cap_0123456789abcdef',
  '',
  42,
  null,
  { id: CANONICAL_CAPTURE_ID },
];

/** Every kind the closed vocabulary recognises. */
const ALL_KINDS: readonly PageAgentErrorKind[] = [
  ...PAGE_AGENT_ERROR_CODES,
  ...PAGE_AGENT_LOSS_REASONS,
];

/** The only kind shown as a partial return to dormant. */
const CLEANUP_KIND: PageAgentErrorKind = 'hooks-not-released';

/**
 * Document ids a page script forged: private text within the protocol's
 * 64-character id bound, of no canonical shape.
 */
const FORGED_DOCUMENT_ID = SENTINEL;
const FORGED_DOCUMENT_ID_2 = 'PRIVATE-SENTINEL-2 token=abc https://y/?q=secret';

/** Document and producer ids of the exact shape the agent mints. */
const CANONICAL_DOCUMENT_ID = 'doc_0123456789abcdef';
const CANONICAL_DOCUMENT_ID_2 = 'doc_fedcba9876543210';
const CANONICAL_PRODUCER_ID = 'prd_0123456789abcdef';
const CANONICAL_PRODUCER_ID_2 = 'prd_fedcba9876543210';

/** This extension's id, as `chrome.runtime.id` reports it. */
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** The tab whose page the agent runs in. */
const TAB_ID = 7;

/** The session the tab is bound to where a case needs a binding. */
const SESSION_ID = 'ses_0123456789abcdef';

/** The local app's origin — a neutral loopback port. */
const APP_ORIGIN = 'http://127.0.0.1:4100';

/** The app document's (already query-redacted) URL. */
const APP_URL = `${APP_ORIGIN}/workspace/overview`;

/** A fixed epoch-millisecond instant for the fake tab. */
const BASE_EPOCH_MS = 1_700_000_000_000;

/** The protocol code a kind is expected to be shown under. */
function expectedProtocolCode(kind: PageAgentErrorKind): ErrorPayload['code'] {
  return kind === CLEANUP_KIND ? 'CLEANUP_PARTIAL' : 'INSTRUMENTATION_UNAVAILABLE';
}

/**
 * The smallest frame of a kind: a code-bearing frame for one of
 * `PAGE_AGENT_ERROR_CODES`, a code-less loss frame for one of
 * `PAGE_AGENT_LOSS_REASONS`.
 */
function minimalFrame(
  kind: PageAgentErrorKind,
  extra: Readonly<Record<string, unknown>> = {},
): PageAgentErrorPayload {
  return PAGE_AGENT_ERROR_CODES.some((code) => code === kind)
    ? { ...extra, code: kind }
    : { ...extra, reason: kind };
}

/** Whether a serialized value contains any fragment of {@link SENTINEL}. */
function leaksSentinel(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return SENTINEL_FRAGMENTS.some((fragment) => serialized.includes(fragment));
}

/*
 * ===========================================================================
 * The pure classifier
 * ===========================================================================
 */

describe('agentErrorReport — the closed agent.error vocabulary', () => {
  it.each(PAGE_AGENT_ERROR_CODES)(
    'shows the code %s under its fixed sentence and protocol code, never the frame’s own text',
    (code) => {
      const report = agentErrorReport({ code, message: SENTINEL, stage: SENTINEL });

      expect(report).toEqual({
        kind: code,
        error: {
          code: expectedProtocolCode(code),
          message: PAGE_AGENT_ERROR_PUBLIC_MESSAGES[code],
        },
      });
      expect(leaksSentinel(report)).toBe(false);
    },
  );

  it.each(PAGE_AGENT_LOSS_REASONS)(
    'shows the code-less loss reason %s under its fixed sentence as INSTRUMENTATION_UNAVAILABLE',
    (reason) => {
      const report = agentErrorReport({ reason, message: SENTINEL, frame: SENTINEL });

      expect(report).toEqual({
        kind: reason,
        error: {
          code: 'INSTRUMENTATION_UNAVAILABLE',
          message: PAGE_AGENT_ERROR_PUBLIC_MESSAGES[reason],
        },
      });
      expect(leaksSentinel(report)).toBe(false);
    },
  );

  it('maps hooks-not-released alone to CLEANUP_PARTIAL, and every other kind to INSTRUMENTATION_UNAVAILABLE', () => {
    const cleanup = ALL_KINDS.filter(
      (kind) => agentErrorReport(minimalFrame(kind))?.error.code === 'CLEANUP_PARTIAL',
    );
    const unavailable = ALL_KINDS.filter(
      (kind) => agentErrorReport(minimalFrame(kind))?.error.code === 'INSTRUMENTATION_UNAVAILABLE',
    );

    expect(cleanup).toEqual([CLEANUP_KIND]);
    expect(unavailable).toEqual(ALL_KINDS.filter((kind) => kind !== CLEANUP_KIND));
  });

  it('produces a payload the protocol’s strict error schema accepts, for every kind', () => {
    for (const kind of ALL_KINDS) {
      const report = agentErrorReport(minimalFrame(kind, { captureId: CANONICAL_CAPTURE_ID }));
      expect(report?.kind, kind).toBe(kind);
      expect(parseErrorPayload(report?.error), kind).toMatchObject({ ok: true });
    }
  });

  const unrecognised: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
    ['an unknown code carrying private text', { code: SENTINEL, message: SENTINEL }],
    [
      'an unknown code beside a recognised loss reason',
      { code: SENTINEL, reason: 'event-too-large' },
    ],
    ['a recognised code in the wrong case', { code: 'HOOKS-UNAVAILABLE', message: SENTINEL }],
    ['a recognised loss reason used as a code', { code: 'event-too-large', message: SENTINEL }],
    ['an unknown code-less loss reason', { reason: SENTINEL, message: SENTINEL }],
    ['a frame with a message and nothing else', { message: SENTINEL }],
    ['a non-string code', { code: 7, message: SENTINEL }],
    ['an empty frame', {}],
  ];

  it.each(unrecognised)('recognises nothing in %s', (_label, payload) => {
    expect(agentErrorReport(payload)).toBeUndefined();
  });

  it('makes a canonical capture id the ref', () => {
    const report = agentErrorReport({
      code: 'producer-failure',
      message: SENTINEL,
      captureId: CANONICAL_CAPTURE_ID,
    });

    expect(report?.error).toEqual({
      code: 'INSTRUMENTATION_UNAVAILABLE',
      message: PAGE_AGENT_ERROR_PUBLIC_MESSAGES['producer-failure'],
      ref: CANONICAL_CAPTURE_ID,
    });
  });

  it.each(
    NON_CANONICAL_CAPTURE_IDS.map((captureId): [string, unknown] => [
      JSON.stringify(captureId),
      captureId,
    ]),
  )('never makes the non-canonical capture id %s a ref', (_label, captureId) => {
    const report = agentErrorReport({ code: 'hooks-unavailable', captureId });

    expect(report?.kind).toBe('hooks-unavailable');
    expect(report?.error).not.toHaveProperty('ref');
    expect(leaksSentinel(report)).toBe(false);
  });

  it('never reads the frame’s own message', () => {
    let reads = 0;
    const payload: PageAgentErrorPayload = { code: 'hooks-not-released' };
    Object.defineProperty(payload, 'message', {
      enumerable: true,
      get: (): string => {
        reads += 1;
        return SENTINEL;
      },
    });

    expect(agentErrorReport(payload)?.error.message).toBe(
      PAGE_AGENT_ERROR_PUBLIC_MESSAGES['hooks-not-released'],
    );
    expect(reads).toBe(0);
  });
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
    // Port events are not declarative events: Chrome refuses the rules API on
    // them, and so does this fake.
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
  const port: FakePort = {
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
  return port;
}

/** Deliver one frame to the worker on a port. */
function sendOnPort(port: FakePort, message: unknown): void {
  for (const listener of [...port.onMessage.listeners]) {
    listener(message, port);
  }
}

/** A complete `chrome.tabs.Tab` for the app's tab, as a bridge sender carries it. */
function appTab(): chrome.tabs.Tab {
  return {
    id: TAB_ID,
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

/** A `chrome.storage` area over a map. */
function createMemoryArea(): {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Readonly<Record<string, unknown>>) => Promise<void>;
  remove: (key: string) => Promise<void>;
} {
  const items = new Map<string, unknown>();
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

/** How many sockets the worker tried to open; it must open none unpaired. */
let socketsConstructed = 0;

/** A socket constructor whose every use is a failure of the case. */
class UnreachableSocket implements WebSocketLike {
  readonly readyState = 3;

  constructor() {
    socketsConstructed += 1;
    throw new Error('the unpaired worker must not open a socket');
  }

  addEventListener(): void {
    throw new Error('the unpaired worker must not listen on a socket');
  }

  removeEventListener(): void {
    throw new Error('the unpaired worker must not listen on a socket');
  }

  send(): void {
    throw new Error('the unpaired worker must not write to a socket');
  }

  close(): void {
    throw new Error('the unpaired worker must not close a socket');
  }
}

/** Everything a composition case drives or inspects. */
interface WorkerHarness {
  readonly worker: DebugGeneratorWorker;
  readonly logs: readonly LogEntry[];
  readonly reload: Mock<(tabId: number) => Promise<void>>;
  /** Open a port of a given name from a given sender. */
  connect(name: string, sender: chrome.runtime.MessageSender): FakePort;
}

function createWorkerHarness(): WorkerHarness {
  const logs: LogEntry[] = [];
  const onConnect = createWorkerEvent<(port: chrome.runtime.Port) => void>();
  const pendingTimers = new Map<number, () => void>();
  let lastTimer = 0;
  const reload = vi.fn<(tabId: number) => Promise<void>>(() => Promise.resolve());

  const env: WorkerEnvironment = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      onConnect,
      onInstalled: createWorkerEvent(),
      onStartup: createWorkerEvent(),
    },
    tabs: {
      reload,
      get: (): Promise<WorkerTab> => Promise.resolve({ url: APP_URL }),
      onUpdated: createWorkerEvent(),
      onRemoved: createWorkerEvent(),
    },
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(true),
      onAlarm: createWorkerEvent(),
    },
    storage: { local: createMemoryArea(), session: createMemoryArea() },
    webSocketConstructor: UnreachableSocket,
    // Held, never fired: no case here waits on a worker timeout.
    timers: {
      setTimeout: (handler) => {
        lastTimer += 1;
        pendingTimers.set(lastTimer, handler);
        return lastTimer;
      },
      clearTimeout: (handle) => {
        pendingTimers.delete(handle);
      },
    },
    logger: createRecordingLogger(logs),
  };

  const worker = createWorker(env);
  return {
    worker,
    logs,
    reload,
    connect: (name, sender) => {
      const port = createPort(name, sender);
      for (const listener of [...onConnect.listeners]) {
        listener(port);
      }
      return port;
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

/** The sender of one of this extension's own pages. */
function extensionPageSender(path: string): chrome.runtime.MessageSender {
  return { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/${path}` };
}

/** The sender of the content bridge in the app tab's top frame. */
function bridgeSender(): chrome.runtime.MessageSender {
  return { id: EXTENSION_ID, tab: appTab(), frameId: 0, origin: APP_ORIGIN, url: APP_URL };
}

/** The bridge → worker frame that relays one `agent.error`. */
function agentErrorFrame(payload: PageAgentErrorPayload): BridgeUpstreamMessage<'agent.error'> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'agent.error',
    payload,
  };
}

/** One panel → worker request frame. */
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

/** The worker's answer to one panel request, parsed as the panel parses it. */
function answerTo(panel: FakePort, requestId: string): PortResponse | undefined {
  return panel.posted
    .map((frame) => parsePortResponse(frame))
    .find((response) => response?.requestId === requestId);
}

/**
 * A panel adopted by the DevTools page of {@link TAB_ID}, and that tab's
 * content bridge, over a started worker. The panel asks for its snapshot
 * without naming a tab — the request a panel is associated through — and the
 * DevTools page's announcement adopts it.
 */
async function openTab(h: WorkerHarness): Promise<{ panel: FakePort; bridge: FakePort }> {
  const panel = h.connect(PORT_PANEL, extensionPageSender('src/panel/panel.html'));
  sendOnPort(panel, panelRequest('session.snapshot', {}));
  const devtools = h.connect(PORT_DEVTOOLS, extensionPageSender('src/devtools/devtools.html'));
  const hello: DevtoolsUpstreamMessage<'devtools.hello'> = {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'devtools.hello',
    payload: { tabId: TAB_ID, url: APP_URL },
  };
  sendOnPort(devtools, hello);
  await h.worker.ready;
  await settle();
  const bridge = h.connect(PORT_CONTENT_BRIDGE, bridgeSender());
  return { panel, bridge };
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

/** Stands in for the platform `fetch`; the unpaired worker must never reach it. */
const globalFetch = vi.fn<FetchLike>(() =>
  Promise.reject(new Error('the platform fetch must never be reached from this spec')),
);

beforeEach(() => {
  socketsConstructed = 0;
  globalFetch.mockClear();
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  expect(socketsConstructed).toBe(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/*
 * ===========================================================================
 * Composition cases
 * ===========================================================================
 */

describe('the composed worker — agent.error frames from the page', () => {
  let h: WorkerHarness;

  beforeEach(() => {
    h = createWorkerHarness();
  });

  afterEach(() => {
    h.worker.dispose();
  });

  it('shows a recognised frame with its fixed sentence and code, and logs its tab and kind only', async () => {
    const { panel, bridge } = await openTab(h);
    // The page agent announces its document first: a bridge's frames are
    // attributed to the document its `agent.ready` pinned.
    sendOnPort(bridge, agentReadyFrame(readyPayload()));

    sendOnPort(
      bridge,
      agentErrorFrame({
        code: 'hooks-unavailable',
        message: SENTINEL,
        sessionId: null,
        captureId: CANONICAL_CAPTURE_ID,
        unavailable: [{ signal: 'fetch', reason: SENTINEL, hint: SENTINEL }],
        enabled: [],
      }),
    );
    sendOnPort(
      bridge,
      agentErrorFrame({
        code: 'hooks-not-released',
        message: SENTINEL,
        sessionId: null,
        captureId: null,
        unreleased: [{ signal: 'fetch', reason: SENTINEL, hint: SENTINEL }],
        enabled: [],
      }),
    );
    await settle();

    expect(errorPushes(panel)).toEqual([
      {
        code: 'INSTRUMENTATION_UNAVAILABLE',
        message: PAGE_AGENT_ERROR_PUBLIC_MESSAGES['hooks-unavailable'],
        ref: CANONICAL_CAPTURE_ID,
      },
      {
        code: 'CLEANUP_PARTIAL',
        message: PAGE_AGENT_ERROR_PUBLIC_MESSAGES['hooks-not-released'],
      },
    ]);
    const reported = h.logs.filter(
      (entry) => entry.message === 'The page agent reported an error.',
    );
    expect(
      reported.map((entry) => [entry.level, entry.fields.tabId, entry.fields.agentError]),
    ).toEqual([
      ['warn', TAB_ID, 'hooks-unavailable'],
      ['warn', TAB_ID, 'hooks-not-released'],
    ]);
    expect(reported.every((entry) => !('agentCode' in entry.fields))).toBe(true);
    expect(leaksSentinel(h.logs)).toBe(false);
    expect(leaksSentinel(panel.posted)).toBe(false);
  });

  it('shows nothing for forged frames outside the vocabulary, and no log record carries their text', async () => {
    const { panel, bridge } = await openTab(h);

    sendOnPort(bridge, agentErrorFrame({ code: SENTINEL, message: SENTINEL }));
    sendOnPort(bridge, agentErrorFrame({ reason: SENTINEL, message: SENTINEL }));
    sendOnPort(bridge, agentErrorFrame({ message: SENTINEL, captureId: SENTINEL }));
    await settle();

    expect(errorPushes(panel)).toEqual([]);
    expect(leaksSentinel(h.logs)).toBe(false);
    expect(leaksSentinel(panel.posted)).toBe(false);
    // Each frame was either refused by the bridge port's structural check or
    // reached the worker, which logged a fixed line: the tab, and the word
    // `unrecognised` in place of anything the frame said.
    const classified = h.logs.filter((entry) => 'agentError' in entry.fields);
    const refused = h.logs.filter((entry) => entry.message === 'dropped a malformed bridge frame');
    expect(classified.length + refused.length).toBe(3);
    expect(classified.every((entry) => entry.fields.agentError === 'unrecognised')).toBe(true);
    expect(classified.every((entry) => entry.level === 'debug')).toBe(true);
    expect(classified.every((entry) => entry.fields.tabId === TAB_ID)).toBe(true);
    expect(
      h.logs.some(
        (entry) => entry.level === 'warn' && entry.message === 'The page agent reported an error.',
      ),
    ).toBe(false);
  });
});

/*
 * ===========================================================================
 * agent.ready identifiers in agent-control's log lines
 * ===========================================================================
 */

/** A page agent's `agent.ready`, for the app's origin, hook in place before React. */
function readyPayload(overrides: Partial<PageAgentReadyPayload> = {}): PageAgentReadyPayload {
  return {
    documentId: CANONICAL_DOCUMENT_ID,
    producerId: CANONICAL_PRODUCER_ID,
    url: APP_URL,
    installedBeforeReact: true,
    reactDetected: true,
    ...overrides,
  };
}

/** The bridge → worker frame that relays one `agent.ready`. */
function agentReadyFrame(payload: PageAgentReadyPayload): BridgeUpstreamMessage<'agent.ready'> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'agent.ready',
    payload,
  };
}

/** The first log record with a given message; fails the case when there is none. */
function logEntry(logs: readonly LogEntry[], message: string): LogEntry {
  const entry = logs.find((candidate) => candidate.message === message);
  if (entry === undefined) {
    expect.unreachable(`expected a log record "${message}"`);
  }
  return entry;
}

/** Everything a direct agent-control case drives or inspects. */
interface ControlHarness {
  readonly control: AgentControl;
  readonly logs: readonly LogEntry[];
  readonly send: Mock<ProtocolSend>;
  readonly reload: Mock<AgentTabsApi['reload']>;
}

/** An agent controller over recording fakes, with no bridge attached and no binding. */
function createControlHarness(): ControlHarness {
  const logs: LogEntry[] = [];
  const send = vi.fn<ProtocolSend>(() => ok<SendOutcome>('sent'));
  const reload = vi.fn<AgentTabsApi['reload']>(() => Promise.resolve());
  const pending = new Map<number, () => void>();
  let lastHandle = 0;
  const timers: WorkerTimerApi = {
    setTimeout: (handler) => {
      lastHandle += 1;
      pending.set(lastHandle, handler);
      return lastHandle;
    },
    clearTimeout: (handle) => {
      pending.delete(handle);
    },
  };
  const control = createAgentControl({
    sendToBridge: () => false,
    send,
    resolveBinding: () => undefined,
    tabs: { reload },
    timers,
    now: () => BASE_EPOCH_MS,
    logger: createRecordingLogger(logs),
  });
  return { control, logs, send, reload };
}

describe('agent-control logs page-supplied document ids by fingerprint only', () => {
  let c: ControlHarness;

  beforeEach(() => {
    c = createControlHarness();
  });

  afterEach(() => {
    c.control.dispose();
  });

  it('fingerprints a forged id on both relay failure branches, while the memo and the relay keep it', () => {
    c.send.mockReturnValueOnce(
      err(workerError('TRANSPORT_DISCONNECTED', 'The service socket is closed.')),
    );
    c.control.handleAgentReady(TAB_ID, readyPayload({ documentId: FORGED_DOCUMENT_ID }));
    c.send.mockImplementationOnce(() => {
      throw new Error(SENTINEL);
    });
    c.control.handleAgentReady(TAB_ID, readyPayload({ documentId: FORGED_DOCUMENT_ID_2 }));

    expect(logEntry(c.logs, 'agent.ready not relayed')).toMatchObject({
      level: 'warn',
      fields: {
        tabId: TAB_ID,
        document: fingerprintPageId(FORGED_DOCUMENT_ID),
        documentIdCanonical: false,
        code: 'TRANSPORT_DISCONNECTED',
      },
    });
    expect(logEntry(c.logs, 'agent.ready relay threw')).toMatchObject({
      level: 'warn',
      fields: {
        tabId: TAB_ID,
        document: fingerprintPageId(FORGED_DOCUMENT_ID_2),
        documentIdCanonical: false,
        error: 'Error',
      },
    });
    const recorded = c.logs.filter((entry) => entry.message === 'agent.ready recorded');
    expect(recorded.map((entry) => entry.fields.document)).toEqual([
      fingerprintPageId(FORGED_DOCUMENT_ID),
      fingerprintPageId(FORGED_DOCUMENT_ID_2),
    ]);
    // Only log fields changed: the relay and the memo still carry the raw id.
    expect(c.send.mock.calls.map(([, payload]) => payload)).toMatchObject([
      { tabId: TAB_ID, documentId: FORGED_DOCUMENT_ID },
      { tabId: TAB_ID, documentId: FORGED_DOCUMENT_ID_2 },
    ]);
    expect(c.control.getReadiness(TAB_ID)?.documentId).toBe(FORGED_DOCUMENT_ID_2);
    expect(c.logs.every((entry) => !('documentId' in entry.fields))).toBe(true);
    expect(leaksSentinel(c.logs)).toBe(false);
  });

  it('marks a canonical id as canonical, and still logs only its fingerprint', () => {
    c.control.handleAgentReady(TAB_ID, readyPayload());

    expect(logEntry(c.logs, 'agent.ready recorded').fields).toMatchObject({
      document: fingerprintPageId(CANONICAL_DOCUMENT_ID),
      documentIdCanonical: true,
    });
    const serialized = JSON.stringify(c.logs);
    expect(serialized).not.toContain(CANONICAL_DOCUMENT_ID);
    expect(serialized).not.toContain(CANONICAL_PRODUCER_ID);
  });

  it('fingerprints the documents of a consented reload on its start, in-flight, stale and settled lines', async () => {
    c.control.handleAgentReady(
      TAB_ID,
      readyPayload({ documentId: FORGED_DOCUMENT_ID, installedBeforeReact: false }),
    );

    const reloading = c.control.requestConsentedReload(TAB_ID);
    const again = c.control.requestConsentedReload(TAB_ID);
    const stale = c.control.handleAgentReady(
      TAB_ID,
      readyPayload({ documentId: FORGED_DOCUMENT_ID, installedBeforeReact: false }),
    );
    c.control.handleAgentReady(TAB_ID, readyPayload({ documentId: FORGED_DOCUMENT_ID_2 }));

    await expect(reloading).resolves.toMatchObject({ kind: 'ready' });
    await expect(again).resolves.toMatchObject({ kind: 'ready' });
    expect(c.reload).toHaveBeenCalledTimes(1);
    expect(stale).toEqual({ kind: 'stale', tabId: TAB_ID, documentId: FORGED_DOCUMENT_ID });
    expect(logEntry(c.logs, 'consented reload started').fields).toMatchObject({
      tabId: TAB_ID,
      previousDocument: fingerprintPageId(FORGED_DOCUMENT_ID),
    });
    expect(logEntry(c.logs, 'consented reload already in flight').fields).toMatchObject({
      tabId: TAB_ID,
      previousDocument: fingerprintPageId(FORGED_DOCUMENT_ID),
    });
    expect(logEntry(c.logs, 'stale agent.ready dropped').fields).toMatchObject({
      tabId: TAB_ID,
      document: fingerprintPageId(FORGED_DOCUMENT_ID),
      documentIdCanonical: false,
    });
    expect(logEntry(c.logs, 'consented reload settled').fields).toMatchObject({
      tabId: TAB_ID,
      previousDocument: fingerprintPageId(FORGED_DOCUMENT_ID),
      outcome: 'ready',
      document: fingerprintPageId(FORGED_DOCUMENT_ID_2),
    });
    expect(
      c.logs.every(
        (entry) => !('documentId' in entry.fields) && !('previousDocumentId' in entry.fields),
      ),
    ).toBe(true);
    expect(leaksSentinel(c.logs)).toBe(false);
  });

  it('fingerprints the document on the reload refused by Chrome and the reload refused before React', async () => {
    c.control.handleAgentReady(
      TAB_ID,
      readyPayload({ documentId: FORGED_DOCUMENT_ID, installedBeforeReact: false }),
    );
    c.reload.mockImplementationOnce(() => Promise.reject(new Error(SENTINEL)));

    await expect(c.control.requestConsentedReload(TAB_ID)).resolves.toMatchObject({
      kind: 'no-tab',
    });
    c.control.handleAgentReady(TAB_ID, readyPayload({ documentId: FORGED_DOCUMENT_ID_2 }));
    await expect(c.control.requestConsentedReload(TAB_ID)).resolves.toMatchObject({
      kind: 'not-consented',
      reason: 'hook-installed-before-react',
    });

    expect(logEntry(c.logs, 'consented reload refused by Chrome')).toMatchObject({
      level: 'warn',
      fields: {
        tabId: TAB_ID,
        previousDocument: fingerprintPageId(FORGED_DOCUMENT_ID),
        error: 'Error',
      },
    });
    expect(
      logEntry(c.logs, 'reload refused: no reload is offered for the tab').fields,
    ).toMatchObject({
      tabId: TAB_ID,
      reason: 'hook-installed-before-react',
      document: fingerprintPageId(FORGED_DOCUMENT_ID_2),
      documentIdCanonical: false,
    });
    expect(
      c.logs.every(
        (entry) => !('documentId' in entry.fields) && !('previousDocumentId' in entry.fields),
      ),
    ).toBe(true);
    expect(leaksSentinel(c.logs)).toBe(false);
  });
});

describe('the composed worker — agent.ready identifiers from the page', () => {
  let h: WorkerHarness;

  beforeEach(() => {
    h = createWorkerHarness();
  });

  afterEach(() => {
    h.worker.dispose();
  });

  it('keeps the page’s ids in readiness and logs each document by fingerprint across a consented reload', async () => {
    const { panel, bridge } = await openTab(h);
    // The consent is scoped to the panel's own tab and the session bound to
    // it, so the tab is bound before its page agent reports.
    const bound = await h.worker.registry.applyBound({
      sessionId: SESSION_ID,
      tabId: TAB_ID,
      url: APP_URL,
    });
    expect(bound.ok, 'the tab is bound to the session').toBe(true);

    sendOnPort(bridge, agentReadyFrame(readyPayload({ installedBeforeReact: false })));
    await settle();
    expect(h.worker.agent.getReadiness(TAB_ID)).toMatchObject({
      documentId: CANONICAL_DOCUMENT_ID,
      producerId: CANONICAL_PRODUCER_ID,
    });

    // The developer's consent is the panel's `page.reload` request — the one
    // entry point of the consented reload.
    const consent = panelRequest('page.reload', { sessionId: SESSION_ID, tabId: TAB_ID });
    sendOnPort(panel, consent);
    await settle();
    expect(h.reload).toHaveBeenCalledWith(TAB_ID);
    expect(answerTo(panel, consent.requestId), 'answered once the new document reports').toBe(
      undefined,
    );
    // The reloaded document runs a new content script, on a new bridge port.
    const reloaded = h.connect(PORT_CONTENT_BRIDGE, bridgeSender());
    sendOnPort(
      reloaded,
      agentReadyFrame(
        readyPayload({ documentId: CANONICAL_DOCUMENT_ID_2, producerId: CANONICAL_PRODUCER_ID_2 }),
      ),
    );
    await settle();

    expect(answerTo(panel, consent.requestId)).toMatchObject({
      ok: true,
      kind: 'page.reload',
      payload: { documentId: CANONICAL_DOCUMENT_ID_2 },
    });
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.worker.agent.getReadiness(TAB_ID)?.documentId).toBe(CANONICAL_DOCUMENT_ID_2);
    // The unpaired worker cannot relay, so both relay-refusal lines are logged.
    const refused = h.logs.filter((entry) => entry.message === 'agent.ready not relayed');
    expect(refused.map((entry) => entry.fields.document)).toEqual([
      fingerprintPageId(CANONICAL_DOCUMENT_ID),
      fingerprintPageId(CANONICAL_DOCUMENT_ID_2),
    ]);
    expect(logEntry(h.logs, 'consented reload settled').fields).toMatchObject({
      previousDocument: fingerprintPageId(CANONICAL_DOCUMENT_ID),
      document: fingerprintPageId(CANONICAL_DOCUMENT_ID_2),
    });
    const serialized = JSON.stringify(h.logs);
    for (const id of [
      CANONICAL_DOCUMENT_ID,
      CANONICAL_DOCUMENT_ID_2,
      CANONICAL_PRODUCER_ID,
      CANONICAL_PRODUCER_ID_2,
    ]) {
      expect(serialized, id).not.toContain(id);
    }
  });
});
