/**
 * `service-worker.ts` composed for real — the port hub, the tab registry, the
 * agent control and the service bridge wired by `createWorker` — driven through
 * typed fakes of the `chrome.*` surface it is given.
 *
 * The subject is the panel's `page.reload` request, the developer's one-click
 * consent to reload the inspected page (AAP §0.7.1 Group 2), and above all its
 * scope: the consent names one tab, and the worker must reload that tab and no
 * other — never a tab a fresh (reconnecting) port was not associated with, a
 * tab another panel inspects, or a tab the session was rebound to after the
 * offer was shown (AAP §0.5.6: a devtools principal acts only for the session
 * bound to its tab). Beside it: the capture-ownership conflict reaching the
 * panel with the owning session named (AAP §0.4.2, `409 { owningSessionId }`).
 *
 * Every frame the worker posts is read back through the panel's own parsers
 * (`parsePortResponse`, `parsePortPush`), so a frame the panel would refuse
 * fails here too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { parseSessionRecord } from '@debuggen/protocol';
import type { WebSocketLike } from '@debuggen/protocol';
import { isErr, noopLogger } from '@debuggen/shared';
import type { SessionId } from '@debuggen/shared';

import { DEVTOOLS_TOKEN_STORAGE_KEY } from '../src/background/auth';
import { createWorker } from '../src/background/service-worker';
import type {
  DebugGeneratorWorker,
  WorkerTab,
  WorkerTabChange,
} from '../src/background/service-worker';
import { BINDING_STORAGE_KEY } from '../src/background/tab-registry';
import {
  EXTENSION_CHANNEL,
  newPortRequestId,
  PORT_CONTENT_BRIDGE,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
  parsePortPush,
  parsePortResponse,
} from '../src/shared/messages';
import type {
  BridgeUpstreamFrame,
  PanelReloadState,
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

const EXTENSION_ID = 'extension-under-test';
const TAB = 101;
const OTHER_TAB = 202;
const SESSION: SessionId = 'session-under-test';
const OWNER_SESSION: SessionId = 'session-holding-capture';
const APP_ORIGIN = 'http://127.0.0.1:4100';
const APP_URL = `${APP_ORIGIN}/`;
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/src/panel/panel.html`;

/*
 * The page agent's document ids have the canonical opaque shape (`doc_` and
 * sixteen `[0-9a-z]`): the port hub refuses a bridge frame whose ids the agent
 * could not have minted.
 */

/** The document the reloaded page's agent announces. */
const RELOADED_DOCUMENT_ID = 'doc_afterreload00001';

/** The document of a page whose agent was installed before React. */
const OBSERVED_DOCUMENT_ID = 'doc_observed00000001';

type TabId = number;

/*
 * ===========================================================================
 * Typed fakes of the chrome.* surface
 * ===========================================================================
 */

/** A `chrome.events.Event` the test can fire; rules are not used by the worker. */
interface FakeChromeEvent<Args extends unknown[]> extends chrome.events.Event<
  (...args: Args) => void
> {
  fire(...args: Args): void;
}

function createChromeEvent<Args extends unknown[]>(): FakeChromeEvent<Args> {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (callback: (...args: Args) => void): void => {
      listeners.add(callback);
    },
    removeListener: (callback: (...args: Args) => void): void => {
      listeners.delete(callback);
    },
    hasListener: (callback: (...args: Args) => void): boolean => listeners.has(callback),
    hasListeners: (): boolean => listeners.size > 0,
    getRules: (): void => undefined,
    removeRules: (): void => undefined,
    addRules: (): void => undefined,
    fire: (...args: Args): void => {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
  };
}

/** A `chrome.runtime.Port` the test drives from the page or panel side. */
interface FakePort extends chrome.runtime.Port {
  readonly onMessage: FakeChromeEvent<[message: unknown, port: chrome.runtime.Port]>;
  readonly onDisconnect: FakeChromeEvent<[port: chrome.runtime.Port]>;
  /** Every frame the worker posted on this port, in order. */
  readonly posted: unknown[];
  /** Deliver a frame to the worker, as the port's other end would. */
  send(message: unknown): void;
  /** Close the port from its other end. */
  close(): void;
}

function createFakePort(name: string, sender: chrome.runtime.MessageSender): FakePort {
  const onMessage = createChromeEvent<[message: unknown, port: chrome.runtime.Port]>();
  const onDisconnect = createChromeEvent<[port: chrome.runtime.Port]>();
  const posted: unknown[] = [];
  const port: FakePort = {
    name,
    sender,
    onMessage,
    onDisconnect,
    posted,
    postMessage: (message: unknown): void => {
      posted.push(message);
    },
    disconnect: (): void => undefined,
    send: (message: unknown): void => {
      onMessage.fire(message, port);
    },
    close: (): void => {
      onDisconnect.fire(port);
    },
  };
  return port;
}

/** A tab as Chrome describes a content script's sender tab. */
function senderTab(tabId: TabId): chrome.tabs.Tab {
  return {
    id: tabId,
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
    lastAccessed: 0,
  };
}

/** A `chrome.storage` area over a plain record. */
function createStorageArea(initial: Readonly<Record<string, unknown>> = {}): {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: string): Promise<void>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (keys: string): Promise<Record<string, unknown>> =>
      Promise.resolve(data.has(keys) ? { [keys]: data.get(keys) } : {}),
    set: (items: Readonly<Record<string, unknown>>): Promise<void> => {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
      return Promise.resolve();
    },
    remove: (keys: string): Promise<void> => {
      data.delete(keys);
      return Promise.resolve();
    },
  };
}

/** A socket that never opens: these flows never need the service's socket. */
class InertSocket implements WebSocketLike {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

/*
 * ===========================================================================
 * The composed worker under test
 * ===========================================================================
 */

interface Harness {
  readonly worker: DebugGeneratorWorker;
  /** `chrome.tabs.reload`, as the worker's agent control calls it. */
  readonly reload: Mock<(tabId: TabId) => Promise<void>>;
  /** Open a port to the worker, as Chrome's `runtime.onConnect` does. */
  connect(port: FakePort): void;
  /** `chrome.tabs.onUpdated`, for dispatching a tab's load events. */
  readonly onUpdated: FakeChromeEvent<[tabId: TabId, changeInfo: WorkerTabChange, tab: WorkerTab]>;
}

function build(options: { readonly paired?: boolean } = {}): Harness {
  const onConnect = createChromeEvent<[port: chrome.runtime.Port]>();
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let nextHandle = 0;
  const reload = vi.fn<(tabId: TabId) => Promise<void>>(() => Promise.resolve());
  const onUpdated =
    createChromeEvent<[tabId: TabId, changeInfo: WorkerTabChange, tab: WorkerTab]>();
  const worker = createWorker({
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      onConnect,
      onInstalled: createChromeEvent<[details: { readonly reason: string }]>(),
      onStartup: createChromeEvent<[]>(),
    },
    tabs: {
      reload,
      get: (): Promise<WorkerTab> => Promise.resolve({ url: APP_URL }),
      onUpdated,
      onRemoved: createChromeEvent<[tabId: TabId]>(),
    },
    alarms: {
      create: (): Promise<void> => Promise.resolve(),
      clear: (): Promise<boolean> => Promise.resolve(true),
      onAlarm: createChromeEvent<[alarm: { readonly name: string }]>(),
    },
    storage: {
      local: createStorageArea(
        options.paired === true
          ? { [DEVTOOLS_TOKEN_STORAGE_KEY]: { version: 1, token: 'devtools-token-under-test' } }
          : {},
      ),
      session: createStorageArea({
        [BINDING_STORAGE_KEY]: {
          [String(TAB)]: {
            tabId: TAB,
            sessionId: SESSION,
            url: APP_URL,
            origin: APP_ORIGIN,
            boundAt: 1_700_000_000_000,
          },
        },
      }),
    },
    webSocketConstructor: InertSocket,
    timers: {
      setTimeout: (handler: () => void, ms: number): number => {
        nextHandle += 1;
        const handle = nextHandle;
        live.set(
          handle,
          setTimeout(() => {
            live.delete(handle);
            handler();
          }, ms),
        );
        return handle;
      },
      clearTimeout: (handle: number): void => {
        clearTimeout(live.get(handle));
        live.delete(handle);
      },
    },
    serviceBaseUrl: 'http://127.0.0.1:43117',
    logger: noopLogger,
  });
  return { worker, reload, connect: (port) => onConnect.fire(port), onUpdated };
}

function panelPort(): FakePort {
  return createFakePort(PORT_PANEL, { id: EXTENSION_ID, url: PANEL_URL });
}

function bridgePort(tabId: TabId): FakePort {
  return createFakePort(PORT_CONTENT_BRIDGE, {
    id: EXTENSION_ID,
    tab: senderTab(tabId),
    frameId: 0,
    url: APP_URL,
    origin: APP_ORIGIN,
  });
}

function request<Kind extends PortRequestKind>(
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

function agentReady(documentId: string): BridgeUpstreamFrame<'agent.ready'> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'upstream',
    type: 'agent.ready',
    payload: {
      documentId,
      producerId: documentId.replace(/^doc_/u, 'prd_'),
      url: APP_URL,
      installedBeforeReact: true,
      reactDetected: true,
    },
  };
}

/** A JSON `Response` of `status`, as the stubbed `fetch` answers. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A record of `sessionId`, as the service's `GET /sessions/:id` answers it. */
function sessionRecordOf(sessionId: SessionId): unknown {
  const parsed = parseSessionRecord({
    id: sessionId,
    projectRoot: '/home/example/workspace/site',
    projectName: 'site',
    devServerUrl: APP_ORIGIN,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
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

/** The worker's answer to one request, parsed as the panel parses it. */
function answerTo(port: FakePort, requestId: string): PortResponse | undefined {
  return port.posted
    .map((frame) => parsePortResponse(frame))
    .find((response) => response?.requestId === requestId);
}

/** Every reload offer pushed on a port, parsed as the panel parses it. */
function reloadOffers(port: FakePort): PanelReloadState[] {
  const offers: PanelReloadState[] = [];
  for (const frame of port.posted) {
    const push = parsePortPush(frame);
    if (push?.kind === 'reload') {
      offers.push(push.state);
    }
  }
  return offers;
}

/** Run every timer and microtask that is due now. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Open a panel and let its snapshot associate it with the session's tab: the
 * panel names the tab DevTools inspects, which is what associates it — the
 * session it remembers is information only.
 */
async function openAssociatedPanel(
  h: Harness,
): Promise<{ readonly panel: FakePort; readonly snapshot: PortResponse | undefined }> {
  const panel = panelPort();
  h.connect(panel);
  const request_ = request('session.snapshot', { sessionId: SESSION, inspectedTabId: TAB });
  panel.send(request_);
  await settle();
  const snapshot = answerTo(panel, request_.requestId);
  expect(snapshot?.ok, 'the snapshot is answered').toBe(true);
  return { panel, snapshot };
}

/*
 * ===========================================================================
 * Specs
 * ===========================================================================
 */

describe('service worker: the consented page reload is scoped to the inspected tab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reloads exactly the tab the consent names, answering once its new document reports', async () => {
    const h = build();
    await h.worker.ready;
    const { panel, snapshot } = await openAssociatedPanel(h);
    expect(snapshot).toMatchObject({
      ok: true,
      payload: { reload: { kind: 'offered', reason: 'agent-missing' } },
    });

    const consent = request('page.reload', { sessionId: SESSION, tabId: TAB });
    panel.send(consent);
    await settle();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledWith(TAB);
    expect(answerTo(panel, consent.requestId), 'answered only after the new report').toBe(
      undefined,
    );
    expect(reloadOffers(panel).at(-1)).toEqual({ kind: 'reloading' });

    const bridge = bridgePort(TAB);
    h.connect(bridge);
    bridge.send(agentReady(RELOADED_DOCUMENT_ID));
    await settle();

    expect(answerTo(panel, consent.requestId)).toMatchObject({
      ok: true,
      kind: 'page.reload',
      payload: {
        documentId: RELOADED_DOCUMENT_ID,
        installedBeforeReact: true,
        reactDetected: true,
      },
    });
    expect(reloadOffers(panel).at(-1)).toEqual({ kind: 'not-needed' });
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.worker.dispose();
  });

  it('reports the consented reload of a page with no agent document at once, and once', async () => {
    const h = build();
    await h.worker.ready;
    const navigated: string[] = [];
    h.worker.registry.onChange((change) => {
      if (change.reason === 'navigated') {
        navigated.push(change.current?.url ?? '');
      }
    });
    const { panel } = await openAssociatedPanel(h);
    panel.send(request('page.reload', { sessionId: SESSION, tabId: TAB }));
    await settle();
    expect(h.reload).toHaveBeenCalledWith(TAB);

    // No agent reported a document before the reload, so nothing can confirm
    // it later: the same-URL load is reported as it starts, as it always was.
    h.onUpdated.fire(TAB, { status: 'loading' }, { url: APP_URL });
    await settle();
    expect(navigated).toEqual([APP_URL]);

    const bridge = bridgePort(TAB);
    h.connect(bridge);
    bridge.send(agentReady(RELOADED_DOCUMENT_ID));
    h.onUpdated.fire(TAB, { status: 'complete' }, { url: APP_URL });
    await settle();

    // The new document's report adds no second navigation.
    expect(navigated).toEqual([APP_URL]);
    h.worker.dispose();
  });

  it('refuses a consent from a fresh port not yet associated with any tab, reloading nothing', async () => {
    const h = build();
    await h.worker.ready;
    // A reconnecting panel's queued request can reach the worker before the
    // new port's snapshot associates it: the request alone authorizes nothing.
    const panel = panelPort();
    h.connect(panel);
    const consent = request('page.reload', { sessionId: SESSION, tabId: TAB });
    panel.send(consent);
    await settle();

    expect(answerTo(panel, consent.requestId)).toMatchObject({
      ok: false,
      error: { code: 'TAB_NOT_BOUND' },
    });
    expect(h.reload).not.toHaveBeenCalled();
    h.worker.dispose();
  });

  it('refuses a consent naming a tab other than the panel’s own, reloading nothing', async () => {
    const h = build();
    await h.worker.ready;
    const { panel } = await openAssociatedPanel(h);
    const consent = request('page.reload', { sessionId: SESSION, tabId: OTHER_TAB });
    panel.send(consent);
    await settle();

    expect(answerTo(panel, consent.requestId)).toMatchObject({
      ok: false,
      error: { code: 'TAB_NOT_BOUND' },
    });
    expect(h.reload).not.toHaveBeenCalled();
    h.worker.dispose();
  });

  it('refuses a stale consent after the session was rebound to another tab, reloading neither tab', async () => {
    const h = build();
    await h.worker.ready;
    const { panel, snapshot } = await openAssociatedPanel(h);
    expect(snapshot, 'the offer was shown to this panel').toMatchObject({
      payload: { reload: { kind: 'offered', reason: 'agent-missing' } },
    });

    // The session moves to another tab after this panel was shown the offer.
    await h.worker.registry.unbind(TAB, 'session-ended');
    const rebound = await h.worker.registry.applyBound({
      sessionId: SESSION,
      tabId: OTHER_TAB,
      url: APP_URL,
    });
    expect(rebound.ok, 'the session is rebound to the other tab').toBe(true);
    expect(await h.worker.registry.getTabForSession(SESSION)).toBe(OTHER_TAB);
    await settle();

    for (const tabId of [TAB, OTHER_TAB]) {
      const consent = request('page.reload', { sessionId: SESSION, tabId });
      panel.send(consent);
      await settle();
      expect(
        answerTo(panel, consent.requestId),
        `a consent naming tab ${String(tabId)}`,
      ).toMatchObject({
        ok: false,
        error: { code: 'TAB_NOT_BOUND' },
      });
    }
    expect(h.reload).not.toHaveBeenCalled();
    h.worker.dispose();
  });

  it('refuses, reloading nothing, when no reload is offered for the tab', async () => {
    const h = build();
    await h.worker.ready;
    const { panel } = await openAssociatedPanel(h);
    // The page's agent is present and reports a hook installed before React.
    const bridge = bridgePort(TAB);
    h.connect(bridge);
    bridge.send(agentReady(OBSERVED_DOCUMENT_ID));
    await settle();
    expect(reloadOffers(panel).at(-1)).toEqual({ kind: 'not-needed' });

    const consent = request('page.reload', { sessionId: SESSION, tabId: TAB });
    panel.send(consent);
    await settle();
    expect(answerTo(panel, consent.requestId)).toMatchObject({
      ok: false,
      error: { code: 'SESSION_INVALID_STATE' },
    });
    expect(h.reload).not.toHaveBeenCalled();
    h.worker.dispose();
  });
});

describe('service worker: a capture refused because another session holds it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers the panel with CAPTURE_ALREADY_ACTIVE and the owning session', async () => {
    // The capture start is refused; the reads of the bound panel's snapshot
    // — the session and its current panel — are answered, as a snapshot is
    // answered only once it read them in full.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = new URL(url).pathname;
        if (path === `/sessions/${SESSION}`) {
          return Promise.resolve(jsonResponse(200, sessionRecordOf(SESSION)));
        }
        if (path === `/sessions/${SESSION}/panel`) {
          return Promise.resolve(jsonResponse(200, { panel: null }));
        }
        return Promise.resolve(
          jsonResponse(409, {
            code: 'CAPTURE_ALREADY_ACTIVE',
            message: 'Another session is already capturing this project.',
            owningSessionId: OWNER_SESSION,
          }),
        );
      }),
    );
    const h = build({ paired: true });
    await h.worker.ready;
    const { panel } = await openAssociatedPanel(h);
    const start = request('capture.start', { sessionId: SESSION });
    panel.send(start);
    await settle();
    await settle();

    const answer = answerTo(panel, start.requestId);
    expect(answer).toMatchObject({
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'response',
      requestId: start.requestId,
      kind: 'capture.start',
      ok: false,
      error: { code: 'CAPTURE_ALREADY_ACTIVE', owningSessionId: OWNER_SESSION },
    });
    const error = answer !== undefined && !answer.ok ? answer.error : undefined;
    // The owner is the one detail the failure carries: nothing else of the
    // service's body reaches the panel.
    expect(Object.keys(error ?? {}).sort()).toEqual(['code', 'message', 'owningSessionId']);
    // The service's message, as the HTTP client reports a refused route.
    expect(error?.message).toContain('Another session is already capturing this project.');
    h.worker.dispose();
  });
});
