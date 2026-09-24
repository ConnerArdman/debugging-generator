/**
 * The Manifest V3 module service worker of the "Debug Generator" extension —
 * the manifest's `background.service_worker` entry and the extension's
 * composition root (AAP §0.7.1 Group 4).
 *
 * Every other module in this folder is a side-effect-free factory that cannot
 * see its siblings: `auth.ts` keeps the devtools credential, `ports.ts` routes
 * runtime ports, `tab-registry.ts` mirrors the tab ↔ session bindings,
 * `agent-control.ts` arms and disarms the page agent, and `ws-bridge.ts` owns
 * the authenticated socket and the HTTP calls. This file is the one place that
 * knows all of them: it constructs each exactly once, hands each the others'
 * capabilities as injected callbacks, attaches them to Chrome's event surface
 * and supplies the decisions that belong to no single module — which tab a
 * panel inspects, when DevTools closing means `session.unbind`, which browser
 * navigation is a committed one.
 *
 * ## Manifest V3 lifetime (get this wrong and nothing else matters)
 *
 * Chrome evicts an idle worker after roughly thirty seconds and re-evaluates
 * this module from scratch when the next event arrives. An event is delivered
 * only to listeners that exist by the end of that first evaluation, so:
 *
 * - {@link createWorker} registers every `chrome.*` listener synchronously —
 *   never behind an `await`, a promise continuation or a callback — and the
 *   module calls it synchronously at the bottom. Asynchronous start-up work
 *   (hydrating the bindings, reading the credential, opening the socket) is
 *   kicked off only after registration, and a handler that needs it awaits
 *   the module-scoped {@link DebugGeneratorWorker.ready} promise **inside**
 *   the handler.
 * - Every handler is written for a cold start: after a revival the in-memory
 *   maps here and in the siblings are empty, so handlers hydrate through the
 *   owning module (`registry.getBinding` reads `chrome.storage.session`, the
 *   credential store reads `chrome.storage.local` lazily) rather than assuming
 *   warm state.
 * - The synchronous section is cheap: construction only — no network, no
 *   storage scan.
 *
 * Two recovery mechanisms coexist and neither substitutes for the other: the
 * `chrome.alarms` keepalive (created in exactly one place, `ws-bridge.ts`'s
 * `connect()`, and ticked from {@link KEEPALIVE_ALARM_NAME} here) covers worker
 * suspension, and the socket client's backoff covers a service restart. Both
 * end in a status snapshot pushed to every panel, so "Connected · ‹session›",
 * "Reconnecting…", "Not paired", "Service not running" and "Tab left ‹origin›"
 * are observable without the panel polling (AAP §0.5.5).
 *
 * ## Where the inspected tab comes from
 *
 * A panel port names no tab: its `sender` is an extension page and no panel
 * request carries a tab id. The tab is known to the worker from exactly two
 * sources — the `devtools.hello` frame of the DevTools page, and the tab bound
 * to a session a reconnecting panel names in `session.snapshot`. A panel that
 * names no session is associated with the most recently announced DevTools
 * page that has no panel yet; a DevTools page announced after its panel
 * connected adopts the waiting panel. The worker, not the panel, sends the
 * protocol's `session.bind` (AAP §0.2.3).
 *
 * ## Contract gaps recorded here
 *
 * - `../shared/messages` declares no panel or devtools frame that carries the
 *   developer's consent to reload a tab whose agent arrived after React. The
 *   consented reload is therefore exposed as
 *   {@link DebugGeneratorWorker.requestConsentedReload} — the only caller of
 *   `agent-control.ts`'s `requestConsentedReload` — and never invoked from a
 *   timer, a readiness report or a navigation.
 * - A port failure frame carries `{ code, message }` only (`portErr` drops
 *   `details`), so a capture refused because another session holds it reaches
 *   the panel as `CAPTURE_ALREADY_ACTIVE` with the service's message; the
 *   owning session's id is logged here, not forwarded.
 *
 * ## Privacy (AAP §0.5.2)
 *
 * Log lines carry lifecycle events, ids, counts, kinds and error codes only —
 * never a token, a pairing code, a URL (its path and query), a telemetry
 * attribute, a descriptor or a response body. URLs this worker produces for
 * the service (`session.bind`, `tab.navigated`) are query-redacted first by
 * {@link redactNavigationUrl}.
 *
 * Governed by AAP §0.7.1 Group 4, §0.2.3, §0.4.2, §0.5.5, §0.5.6 and §0.8.1
 * slices 4 and 6.
 *
 * @module apps/chrome-extension/src/background/service-worker
 */

import type {
  AnalysisResult,
  MessagePayload,
  PanelSpec,
  SelectedTarget,
  SessionRecord,
  WebSocketConstructorLike,
} from '@debuggen/protocol';
import {
  createEnvelope,
  HttpClient,
  parseErrorPayload,
  parseSessionBindPayload,
  parseTabNavigatedPayload,
} from '@debuggen/protocol';
import type { DebuggenError, Logger, Result, SessionId } from '@debuggen/shared';
import { createConsoleLogger, err, ok } from '@debuggen/shared';

import type { PanelBindingState, PanelSessionSnapshot, PortPush } from '../shared/messages';
import {
  DEFAULT_SERVICE_BASE_URL,
  EXTENSION_CHANNEL,
  newPortRequestId,
  PORT_DEVTOOLS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
} from '../shared/messages';

import type { AgentControl, AgentTabsApi, DisarmReason, ReloadOutcome } from './agent-control';
import { createAgentControl } from './agent-control';
import type {
  CredentialStorageArea,
  CredentialStorageChangeEvent,
  DevtoolsCredentialStore,
} from './auth';
import { createDevtoolsCredentialStore } from './auth';
import type {
  DevtoolsConnection,
  PanelConnection,
  TabBindingRecord,
  WorkerAlarmsApi,
  WorkerConnection,
  WorkerStatusSnapshot,
  WorkerTimerApi,
} from './messages';
import { isRelayedMessage, KEEPALIVE_ALARM_NAME, workerError } from './messages';
import type {
  BridgeMessageHandlers,
  DevtoolsMessageHandlers,
  PortClosedEvent,
  PortHub,
  PortRequestContext,
  PortRequestHandlers,
} from './ports';
import { connectionPushFromStatus, createPortHub } from './ports';
import type { TabBindingChange, TabRegistry, TabRegistryStorageArea } from './tab-registry';
import { createTabRegistry } from './tab-registry';
import type { WsBridge } from './ws-bridge';
import { captureConflictOwner, createWsBridge } from './ws-bridge';

/*
 * ===========================================================================
 * Section A — derived primitives
 * ===========================================================================
 */

/** A Chrome tab id, exactly as the registry's binding records type it. */
type TabId = TabBindingRecord['tabId'];

/** The binding state of a panel whose tab is not known, or not bound. */
const UNBOUND_STATE: PanelBindingState = Object.freeze({ kind: 'unbound' });

/** The origin schemes the worker binds; every other page is never bound. */
const BINDABLE_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/**
 * How an `agent.error` frame's code is reported to the panel, in the shared
 * error vocabulary: the agent's codes are its own, while the panel's `error`
 * state renders `DEBUGGEN_ERROR_CODES` members only. `hooks-not-released` is a
 * partial return to dormant; every other code (`hooks-unavailable`,
 * `agent-family-unavailable`, `producer-failure`, any future one) means a
 * signal the capture asked for is not being supplied.
 */
const AGENT_ERROR_CODE_RELEASE = 'hooks-not-released';

/*
 * ===========================================================================
 * Section B — the injected environment
 *
 * `createWorker` receives the Chrome surfaces it uses rather than reading the
 * `chrome` global, so a unit test can drive the whole composition against
 * recording fakes. `chrome.*` satisfies every interface here; the module's
 * bootstrap passes the real namespaces.
 * ===========================================================================
 */

/**
 * A Chrome event: the two members of `chrome.events.Event` the worker uses.
 * Method shorthand keeps listener parameters bivariant, so the richer
 * `chrome.*` listener types are accepted as they are.
 */
export interface WorkerEvent<Listener> {
  /** Start delivering the event to `listener`. */
  addListener(listener: Listener): void;
  /** Stop delivering the event to `listener`. */
  removeListener(listener: Listener): void;
}

/** The parts of `chrome.runtime` the worker uses. */
export interface WorkerRuntimeApi {
  /** This extension's id; the port hub validates senders against it. */
  readonly id: string;
  /** Set by the platform while an error-caused callback runs. */
  readonly lastError?: { readonly message?: string | undefined } | undefined;
  /** A panel, a devtools page or a content-script bridge opened a port. */
  readonly onConnect: WorkerEvent<(port: chrome.runtime.Port) => void>;
  /** The extension was installed, updated or Chrome was updated. */
  readonly onInstalled: WorkerEvent<(details: { readonly reason: string }) => void>;
  /** A browser profile started with the extension enabled. */
  readonly onStartup: WorkerEvent<() => void>;
  /** Best-effort notice before eviction; never relied on for correctness. */
  readonly onSuspend?: WorkerEvent<() => void> | undefined;
}

/** The fields of `chrome.tabs.onUpdated`'s change info the worker reads. */
export interface WorkerTabChange {
  /** The tab's new URL, present only when it changed. */
  readonly url?: string | undefined;
  /** `loading` or `complete`, present only when it changed. */
  readonly status?: string | undefined;
}

/** The field of a `chrome.tabs.Tab` the worker reads. */
export interface WorkerTab {
  /** The tab's URL; available because the manifest holds the `tabs` permission. */
  readonly url?: string | undefined;
}

/** The parts of `chrome.tabs` the worker uses. */
export interface WorkerTabsApi extends AgentTabsApi {
  /** Read one tab, for the URL of a DevTools page that did not report it. */
  get(tabId: TabId): Promise<WorkerTab>;
  /** A tab's properties changed; the committed-navigation signal. */
  readonly onUpdated: WorkerEvent<
    (tabId: TabId, changeInfo: WorkerTabChange, tab: WorkerTab) => void
  >;
  /** A tab closed. */
  readonly onRemoved: WorkerEvent<(tabId: TabId) => void>;
}

/** The parts of `chrome.alarms` the worker uses. */
export interface WorkerAlarmsEnvironment extends WorkerAlarmsApi {
  /** An alarm fired; only {@link KEEPALIVE_ALARM_NAME} is acted on. */
  readonly onAlarm: WorkerEvent<(alarm: { readonly name: string }) => void>;
}

/** The storage areas the worker uses. */
export interface WorkerStorageEnvironment {
  /** `chrome.storage.local`: the devtools credential, and its change event. */
  readonly local: CredentialStorageArea & {
    readonly onChanged?: CredentialStorageChangeEvent | undefined;
  };
  /** `chrome.storage.session`: the tab ↔ session bindings. */
  readonly session: TabRegistryStorageArea;
}

/** Everything {@link createWorker} needs, injected. */
export interface WorkerEnvironment {
  /** `chrome.runtime`. */
  readonly runtime: WorkerRuntimeApi;
  /** `chrome.tabs`. */
  readonly tabs: WorkerTabsApi;
  /** `chrome.alarms`. */
  readonly alarms: WorkerAlarmsEnvironment;
  /** `chrome.storage`. */
  readonly storage: WorkerStorageEnvironment;
  /** The platform `WebSocket` constructor. */
  readonly webSocketConstructor: WebSocketConstructorLike;
  /** One-shot timers with numeric handles. */
  readonly timers: WorkerTimerApi;
  /** The service's base URL; defaults to {@link DEFAULT_SERVICE_BASE_URL}. */
  readonly serviceBaseUrl?: string | undefined;
  /** Where diagnostics go; defaults to a console logger at `info`. */
  readonly logger?: Logger | undefined;
  /** The jitter source of the socket's backoff; defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
}

/**
 * The composed worker, returned so tests can drive and inspect it. The real
 * worker is created once, at module evaluation ({@link serviceWorker}).
 */
export interface DebugGeneratorWorker {
  /**
   * Settles once the cold-start work is done: bindings hydrated from
   * `chrome.storage.session`, the credential read and — when one is held —
   * the socket started. Never rejects.
   */
  readonly ready: Promise<void>;
  /** The shared HTTP client (one instance, so `setToken` after pairing reaches every call). */
  readonly httpClient: HttpClient;
  /** The devtools credential store. */
  readonly store: DevtoolsCredentialStore;
  /** The runtime-port hub. */
  readonly hub: PortHub;
  /** The tab ↔ session registry. */
  readonly registry: TabRegistry;
  /** The page-agent controller. */
  readonly agent: AgentControl;
  /** The socket and HTTP bridge to the local service. */
  readonly wsBridge: WsBridge;
  /**
   * Reload a tab whose page agent was installed after React, with the
   * developer's consent — see the module notes on this contract gap. Calling
   * it **is** the consent; nothing in this module calls it on its own.
   */
  readonly requestConsentedReload: (tabId: TabId) => Promise<ReloadOutcome>;
  /** Remove every listener and subscription and release every resource. */
  readonly dispose: () => void;
}

/*
 * ===========================================================================
 * Section C — pure helpers
 * ===========================================================================
 */

/**
 * Query-redact a URL before the worker sends it to the service.
 *
 * The protocol requires `session.bind` and `tab.navigated` URLs to arrive
 * query-redacted by their producer (AAP §0.5.2); the page agent redacts the
 * URLs it reports, and this is the worker's equivalent for the URLs it reads
 * from `chrome.tabs` and the DevTools page. It follows the telemetry
 * convention: every query value becomes `?` with keys and order kept
 * (`a=1&b=2` → `a=?&b=?`), a bare flag stays bare, an empty value stays
 * empty, a non-empty fragment becomes `#?`, and userinfo is dropped. Scheme,
 * host, port and path are kept.
 *
 * A URL that is not HTTP(S) is never a page the worker binds; the service
 * needs only to see its origin change, and the path of a `data:` or `blob:`
 * URL can be page content, so only its scheme and host are kept.
 *
 * @param raw The URL as Chrome or the DevTools page reported it.
 * @returns The redacted absolute URL, or `undefined` when `raw` is not one.
 */
export function redactNavigationUrl(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (!BINDABLE_PROTOCOLS.includes(parsed.protocol)) {
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}/` : parsed.protocol;
  }
  const query =
    parsed.search.length > 1
      ? `?${parsed.search.slice(1).split('&').map(maskQueryPair).join('&')}`
      : '';
  const fragment = parsed.hash.length > 1 ? '#?' : '';
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}${fragment}`;
}

/** One `key=value` query pair with its value masked; a bare flag stays bare. */
function maskQueryPair(pair: string): string {
  const separator = pair.indexOf('=');
  if (separator === -1) {
    return pair;
  }
  const key = pair.slice(0, separator);
  return separator === pair.length - 1 ? `${key}=` : `${key}=?`;
}

/**
 * The serialized origin of an HTTP(S) URL, or `undefined` for any other URL —
 * the only pages the worker ever asks the service to bind.
 */
function bindableOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return BINDABLE_PROTOCOLS.includes(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shorter forms of a redacted URL to fall back to when the protocol's
 * binding schema refuses the full one (for its length): the path without the
 * query and fragment, then the origin's root. Derived rather than bounded by a
 * restated limit, so the schema remains the single statement of the bound.
 */
function urlFallbacks(redacted: string): readonly string[] {
  const candidates = [redacted];
  try {
    const parsed = new URL(redacted);
    if (parsed.host.length > 0) {
      candidates.push(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
      candidates.push(`${parsed.protocol}//${parsed.host}/`);
    }
  } catch {
    // `redacted` came from `redactNavigationUrl`, so it parses; nothing to add.
  }
  return candidates;
}

/** The session's latest validated analysis: the last of `analyses`, oldest first. */
function latestAnalysis(record: SessionRecord): AnalysisResult | undefined {
  return record.analyses.length > 0 ? record.analyses[record.analyses.length - 1] : undefined;
}

/** A string field of an untrusted frame, or `undefined`. */
function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Newest first: the ordering behind every "most recent connection" choice. */
function byNewest(left: WorkerConnection, right: WorkerConnection): number {
  return right.connectedAt - left.connectedAt;
}

/** The first error code of a `Result`, for a log line; `undefined` for `ok`. */
function errorCode(result: Result<unknown, DebuggenError>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

/** The name of a thrown value, for a log line that must not carry its message. */
function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/** Whether a connection is a DevTools panel document. */
function isPanelConnection(connection: WorkerConnection): connection is PanelConnection {
  return connection.role === PORT_PANEL;
}

/** Whether a connection is the devtools page of a DevTools window. */
function isDevtoolsConnection(connection: WorkerConnection): connection is DevtoolsConnection {
  return connection.role === PORT_DEVTOOLS;
}

/**
 * The page agent's reason to disarm a tab whose binding was removed, or
 * `undefined` when another path already returns it to dormant: a closed tab
 * has no agent left (`agent.clear` forgets it), and a cross-origin navigation
 * is handled by `agent.handleNavigationDecision`, which clears the
 * configuration rather than sending the old session's dormant one to a
 * document of another origin.
 */
function disarmReasonFor(change: TabBindingChange): DisarmReason | undefined {
  switch (change.cause) {
    case 'session-ended':
      return 'session-ended';
    case 'devtools-closed':
      return 'unbound';
    case 'tab-closed':
      return undefined;
    case undefined:
      if (change.reason === 'origin-changed') {
        return undefined;
      }
      return change.reason === 'replaced' ? 'displaced' : 'unbound';
  }
}

/** The protocol error code an `agent.error` frame is shown under. */
function agentErrorCode(
  agentCode: string | undefined,
): 'CLEANUP_PARTIAL' | 'INSTRUMENTATION_UNAVAILABLE' {
  return agentCode === AGENT_ERROR_CODE_RELEASE ? 'CLEANUP_PARTIAL' : 'INSTRUMENTATION_UNAVAILABLE';
}

/*
 * ===========================================================================
 * Section D — the composition
 * ===========================================================================
 */

/** What the worker needs to ask the service to bind one tab. */
interface BindTarget {
  /** The tab's query-redacted URL. */
  readonly url: string;
  /** The tab's HTTP(S) origin. */
  readonly origin: string;
}

/** The last URL and load status seen for one tab, to de-duplicate navigation reports. */
interface NavigationMemo {
  readonly url: string | undefined;
  readonly status: string | undefined;
}

/** The parts of a bound session the panel renders from, as far as they exist. */
interface SessionDetails {
  readonly session?: SessionRecord;
  readonly panel?: PanelSpec;
  readonly analysis?: AnalysisResult;
}

/** The protocol push that carries a relayed envelope. */
type ProtocolPush = Extract<PortPush, { readonly kind: 'protocol' }>;

/**
 * Compose the worker: construct every background module once, wire them to
 * one another through injected callbacks, register every Chrome listener and
 * socket subscription **synchronously**, then start the cold-start work.
 *
 * Side-effect-free apart from what it is given: every listener is added to an
 * event of `env`, and {@link DebugGeneratorWorker.dispose} removes them all.
 *
 * @example
 * ```ts
 * // A unit test drives the composition against fakes:
 * const worker = createWorker({ runtime, tabs, alarms, storage, webSocketConstructor, timers });
 * await worker.ready;
 * ```
 *
 * @param env The Chrome surfaces, the socket constructor and the timers.
 * @returns The composed worker.
 */
export function createWorker(env: WorkerEnvironment): DebugGeneratorWorker {
  const rootLogger = env.logger ?? createConsoleLogger({ name: 'extension', level: 'info' });
  const log = rootLogger.child({ component: 'service-worker' });
  const serviceBaseUrl = env.serviceBaseUrl ?? DEFAULT_SERVICE_BASE_URL;
  const { runtime, tabs, alarms, storage, timers } = env;

  // Worker-generation memory. None of it is persisted, because all of it is
  // rebuilt by what follows a revival: a DevTools page re-sends its hello when
  // its port reconnects, Chrome keeps reporting tab events, and the bindings
  // themselves live in `chrome.storage.session` behind the registry.
  /** Tabs whose DevTools page announced itself, with what binding them needs. */
  const announcedTabs = new Map<TabId, BindTarget>();
  /** The last URL and load status seen per tab. */
  const navigationMemo = new Map<TabId, NavigationMemo>();
  /** A synchronous mirror of the bound tabs, for `primaryTabId`. */
  const boundTabs = new Set<TabId>();
  /** Undo actions for every listener and subscription, run by `dispose`. */
  const teardown: (() => void)[] = [];
  /** The tab of the most recent `devtools.hello`. */
  let lastDevtoolsTab: TabId | undefined;
  /** The pill status last published, to detect the transition to `connected`. */
  let lastPublishedStatus: WorkerStatusSnapshot['status'] | undefined;
  let disposed = false;

  /**
   * Run a task without awaiting it. Every sibling method fulfils rather than
   * rejects; this still guarantees no rejection escapes a Chrome listener.
   */
  function background(task: Promise<unknown>, what: string): void {
    task.then(undefined, (cause: unknown) => {
      log.error('A background task failed.', { task: what, error: errorName(cause) });
    });
  }

  // -------------------------------------------------------------------------
  // The shared HTTP client and the credential store
  // -------------------------------------------------------------------------

  // One client for the whole worker. Its token delegates to the credential
  // store, and the store redeems pairing codes through the client: a mutual
  // reference, resolved with thunks that are dereferenced only inside calls,
  // by which time both constants exist. Sharing the one instance is what makes
  // the store's post-pairing `setToken` reach every call `ws-bridge.ts` makes.
  const httpClient = new HttpClient({
    baseUrl: serviceBaseUrl,
    token: () => store.getToken(),
    logger: rootLogger.child({ component: 'http-client' }),
  });

  const store = createDevtoolsCredentialStore({
    storage: storage.local,
    httpClient: () => httpClient,
    changes: storage.local.onChanged,
    logger: rootLogger,
  });

  // -------------------------------------------------------------------------
  // Panel requests
  // -------------------------------------------------------------------------

  /**
   * Refuse a request whose panel inspects a tab bound to a different session
   * than the one it names. A panel whose tab is not bound (or not known) is
   * forwarded as it is: the service authorizes every devtools request against
   * the session bound to the requesting credential's tab (AAP §0.5.6), so this
   * is a consistency check, not the boundary.
   */
  async function checkPanelScope(
    sessionId: SessionId,
    context: PortRequestContext,
  ): Promise<Result<SessionId, DebuggenError>> {
    if (context.tabId === undefined) {
      return ok(sessionId);
    }
    const binding = await registry.getBinding(context.tabId);
    if (binding !== undefined && binding.sessionId !== sessionId) {
      return err(
        workerError('TAB_NOT_BOUND', 'The inspected tab is bound to a different session.', {
          hint: 'Reopen the Debug Generator panel so it picks up the current session.',
        }),
      );
    }
    return ok(sessionId);
  }

  /** The tab bound to a session, when it is the requesting panel's tab (or the panel names none). */
  async function resolveSessionTab(
    sessionId: SessionId,
    context: PortRequestContext,
  ): Promise<Result<TabId, DebuggenError>> {
    const tabId = await registry.getTabForSession(sessionId);
    if (tabId === undefined || (context.tabId !== undefined && context.tabId !== tabId)) {
      return err(
        workerError('TAB_NOT_BOUND', 'No inspected tab is bound to this session.', {
          hint: 'Open DevTools on the application tab of this session.',
        }),
      );
    }
    return ok(tabId);
  }

  const requestHandlers: PortRequestHandlers = {
    'panelData.query': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      // The proxy that keeps the panel free of any socket or `fetch`: the
      // `DataResult` is answered verbatim, paging echo included.
      return wsBridge.queryPanelData(payload.sessionId, payload.query, { signal: context.signal });
    },

    'source.open': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      // Forwarded unmodified: the service validates the location against the
      // session's project root, and VS Code validates it again (AAP §0.4.2).
      const sent = wsBridge.send('source.open', payload);
      if (!sent.ok) {
        log.warn('A source.open request could not be forwarded.', {
          sessionId: payload.sessionId,
          errorCode: sent.error.code,
        });
        return sent;
      }
      return ok({ forwarded: true });
    },

    'capture.start': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      const started = await wsBridge.startCapture(payload.sessionId, { signal: context.signal });
      if (!started.ok) {
        // The failure is answered unchanged so its code — `CAPTURE_ALREADY_ACTIVE`
        // for the documented `409` — reaches the panel; the port frame cannot
        // carry the owning session, so it is logged here instead.
        log.info('capture.start was refused.', {
          sessionId: payload.sessionId,
          errorCode: started.error.code,
          owningSessionId: captureConflictOwner(started.error),
        });
      }
      return started;
    },

    'capture.stop': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      const stopped = await wsBridge.stopCapture(payload.sessionId, { signal: context.signal });
      if (!stopped.ok) {
        log.info('capture.stop was refused.', {
          sessionId: payload.sessionId,
          errorCode: stopped.error.code,
        });
      }
      return stopped;
    },

    'target.pick': async (payload, context) => {
      if (!payload.enabled) {
        // The agent's pick is one request and one answer; leaving picker mode
        // has nothing to cancel.
        return ok({ active: false });
      }
      const tab = await resolveSessionTab(payload.sessionId, context);
      if (!tab.ok) {
        return tab;
      }
      const requestId = newPortRequestId();
      // The page agent's picker, through the ISOLATED-world bridge; its answer
      // arrives as `target.described` and is forwarded as `target.selected`.
      if (
        hub.sendToBridge(tab.value, {
          channel: EXTENSION_CHANNEL,
          version: PORT_PROTOCOL_VERSION,
          direction: 'downstream',
          type: 'target.request',
          payload: { requestId },
        })
      ) {
        return ok({ active: true });
      }
      // No agent on the page (an origin outside the host permissions, or a
      // document that predates the extension): the DevTools page can still
      // describe the Elements panel's selection.
      if (
        hub.sendToDevtools(tab.value, {
          channel: EXTENSION_CHANNEL,
          version: PORT_PROTOCOL_VERSION,
          direction: 'downstream',
          type: 'devtools.describeRequest',
          payload: { requestId },
        })
      ) {
        return ok({ active: true });
      }
      return err(
        workerError(
          'AGENT_NOT_READY',
          'Neither the page agent nor DevTools is connected for the tab.',
          {
            hint: 'Reload the application page, then pick the element again.',
          },
        ),
      );
    },

    'target.selected': async (payload, context) => {
      const scope = await checkPanelScope(payload.sessionId, context);
      if (!scope.ok) {
        return scope;
      }
      const sent = wsBridge.send('target.selected', payload);
      if (!sent.ok) {
        log.warn('A target.selected request could not be forwarded.', {
          sessionId: payload.sessionId,
          errorCode: sent.error.code,
        });
        return sent;
      }
      return ok({ accepted: true });
    },

    'pair.complete': async (payload) => {
      const paired = await store.completePairing(payload.code);
      // `STORE_ERROR` means the exchange succeeded and the credential is held
      // for this worker generation, only not saved — so the socket starts in
      // both cases, and the failure is still answered so the panel can say so.
      if (paired.ok || paired.error.code === 'STORE_ERROR') {
        background(wsBridge.connect(), 'connect after pairing');
      }
      if (!paired.ok) {
        log.info('Pairing did not complete.', { errorCode: paired.error.code });
        return paired;
      }
      log.info('Paired with the local service.');
      return ok({ paired: true });
    },

    'session.snapshot': async (payload, context) => {
      // A cold start: the credential and the bindings must be read before the
      // answer, or a freshly revived worker would report a false "Not paired".
      await ready;
      const tabId = await associatePanel(payload.sessionId, context);
      const binding =
        tabId === undefined ? UNBOUND_STATE : await registry.getPanelBindingState(tabId);
      const status = wsBridge.snapshot();
      const snapshot: PanelSessionSnapshot = {
        connection: connectionPushFromStatus(status).state,
        binding,
      };
      if (binding.kind !== 'bound' || !status.hasCredential) {
        return ok(snapshot);
      }
      const details = await loadSessionDetails(binding.sessionId, context.signal);
      return ok({ ...snapshot, ...details });
    },
  };

  // -------------------------------------------------------------------------
  // Frames from the page (the content-script bridge)
  // -------------------------------------------------------------------------

  /**
   * Forward an element descriptor — from the page agent's picker or the
   * Elements panel's selection — as the protocol's `target.selected` for the
   * session bound to its tab. The descriptor was bounded and redacted by the
   * agent; it is forwarded verbatim and never logged.
   */
  async function forwardSelectedTarget(
    tabId: TabId,
    target: SelectedTarget,
    source: 'agent' | 'devtools',
  ): Promise<void> {
    const binding = await registry.getBinding(tabId);
    if (binding === undefined) {
      log.debug('A selected element on an unbound tab was not forwarded.', { tabId, source });
      return;
    }
    const sent = wsBridge.send('target.selected', { sessionId: binding.sessionId, target });
    log.info('Selected element forwarded.', {
      tabId,
      sessionId: binding.sessionId,
      source,
      errorCode: errorCode(sent),
    });
  }

  /**
   * Surface an `agent.error` on the tab's panels as a protocol `error` push,
   * the one failure state the panel renders, and log only the agent's code.
   * The payload is validated against the protocol's error schema first.
   */
  async function reportAgentError(
    tabId: TabId,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const agentCode = stringField(payload, 'code');
    log.warn('The page agent reported an error.', { tabId, agentCode: agentCode?.slice(0, 64) });
    const binding = await registry.getBinding(tabId);
    const code = agentErrorCode(agentCode);
    const captureId = stringField(payload, 'captureId');
    const candidate = {
      code,
      message: stringField(payload, 'message') ?? agentCode ?? code,
      ...(captureId === undefined ? {} : { ref: captureId }),
    };
    const parsed = parseErrorPayload(candidate);
    const errorPayload = parsed.ok ? parsed : parseErrorPayload({ code, message: code });
    if (!errorPayload.ok) {
      return;
    }
    pushProtocol(
      tabId,
      createEnvelope(
        'error',
        errorPayload.value,
        binding === undefined ? undefined : { sessionId: binding.sessionId },
      ),
    );
  }

  const bridgeHandlers: BridgeMessageHandlers = {
    'agent.ready': async (payload, context) => {
      // A page load is what usually wakes a suspended worker, so this report
      // routinely arrives while `start()` is still reading the credential.
      // Until `wsBridge.connect()` has run, the socket client is `closed` and
      // refuses the frame outright; once it has, the frame is queued and
      // flushed after the hello. Waiting for `ready` turns a dropped report
      // into a delivered one.
      await ready;
      // agent-control relays `agent.ready` upward with the tab filled in,
      // memoizes readiness and re-delivers the tab's desired configuration.
      const outcome = agent.handleAgentReady(context.tabId, payload);
      log.debug('agent.ready handled.', { tabId: context.tabId, outcome: outcome.kind });
    },

    'telemetry.batch': (payload, context) => {
      // Where raw agent batches become protocol `telemetry.event` envelopes,
      // chunked to the protocol's per-frame bound by the bridge.
      const sent = wsBridge.sendTelemetryBatch(context.tabId, payload.events);
      if (!sent.ok) {
        log.warn('A telemetry batch could not be sent.', {
          tabId: context.tabId,
          errorCode: sent.error.code,
        });
        return;
      }
      if (payload.droppedCount > 0) {
        log.info('The page agent dropped events before this batch.', {
          tabId: context.tabId,
          dropped: payload.droppedCount,
        });
      }
    },

    'target.described': async (payload, context) => {
      if (payload.target === null) {
        log.debug('The page agent had no element to describe.', { tabId: context.tabId });
        return;
      }
      await forwardSelectedTarget(context.tabId, payload.target, 'agent');
    },

    'agent.error': (payload, context) => reportAgentError(context.tabId, payload),
  };

  // -------------------------------------------------------------------------
  // Frames from the DevTools page
  // -------------------------------------------------------------------------

  /**
   * What binding a tab needs: its HTTP(S) origin and query-redacted URL. The
   * URL comes from the DevTools page when it read one, otherwise from
   * `chrome.tabs.get` (the `tabs` permission exists for this). The origin is
   * always derived from that URL, so the two can never disagree.
   */
  async function resolveBindTarget(
    tabId: TabId,
    reportedUrl: string | undefined,
  ): Promise<BindTarget | undefined> {
    let raw = reportedUrl;
    if (raw === undefined) {
      const tab = await Promise.resolve()
        .then(() => tabs.get(tabId))
        .then(
          (value) => value,
          () => undefined,
        );
      raw = tab?.url;
    }
    if (raw === undefined) {
      return undefined;
    }
    const origin = bindableOrigin(raw);
    const url = redactNavigationUrl(raw);
    return origin === undefined || url === undefined ? undefined : { url, origin };
  }

  /**
   * Ask the service to bind a tab — the one origin of `session.bind` — unless
   * the registry already holds a binding for the same origin, which
   * `ws-bridge.ts` re-announces on every socket open. The first URL form the
   * protocol's schema accepts is sent (see {@link urlFallbacks}).
   */
  async function requestBindIfNeeded(tabId: TabId, target: BindTarget): Promise<void> {
    const existing = await registry.getBinding(tabId);
    if (existing?.origin === target.origin) {
      return;
    }
    const url = urlFallbacks(target.url).find(
      (candidate) => parseSessionBindPayload({ tabId, url: candidate, origin: target.origin }).ok,
    );
    if (url === undefined) {
      log.debug('The inspected tab has no URL the service accepts.', { tabId });
      return;
    }
    const sent = await registry.requestBind({ tabId, url, origin: target.origin });
    log.debug('session.bind requested.', {
      tabId,
      origin: target.origin,
      errorCode: errorCode(sent),
    });
  }

  /**
   * Re-request a binding for every announced DevTools tab that has none —
   * after the socket opens (a bind sent while it was closed was refused) and
   * after a session is created (a new session may match a tab's origin).
   */
  async function rebindAnnouncedTabs(trigger: string): Promise<void> {
    await ready;
    for (const [tabId, target] of announcedTabs) {
      if (!hasDevtools(tabId)) {
        announcedTabs.delete(tabId);
        continue;
      }
      await requestBindIfNeeded(tabId, target);
    }
    log.debug('Announced tabs re-checked for a binding.', { trigger, tabs: announcedTabs.size });
  }

  const devtoolsHandlers: DevtoolsMessageHandlers = {
    'devtools.hello': async (payload, context) => {
      // The inspected tab's only reliable source: remember it, adopt a panel
      // that connected before this page announced itself, then bind.
      lastDevtoolsTab = context.tabId;
      adoptWaitingPanel(context.tabId);
      await ready;
      const target = await resolveBindTarget(context.tabId, payload.url);
      if (target === undefined) {
        announcedTabs.delete(context.tabId);
        log.debug('DevTools inspects a page the worker does not bind.', { tabId: context.tabId });
        return;
      }
      announcedTabs.set(context.tabId, target);
      await requestBindIfNeeded(context.tabId, target);
    },

    'devtools.element': async (payload, context) => {
      if (payload.target === null) {
        log.debug('The Elements selection could not be described.', { tabId: context.tabId });
        return;
      }
      // Selecting an element in DevTools is the developer choosing the
      // session's target (AAP §0.1.1 step "optionally selects an element").
      await forwardSelectedTarget(context.tabId, payload.target, 'devtools');
    },
  };

  // -------------------------------------------------------------------------
  // Which tab a panel inspects
  // -------------------------------------------------------------------------

  /** Whether a DevTools page currently announces this tab. */
  function hasDevtools(tabId: TabId): boolean {
    return hub
      .listConnections()
      .some((connection) => isDevtoolsConnection(connection) && connection.tabId === tabId);
  }

  /**
   * The most recently announced DevTools tab that has no panel yet — the
   * DevTools window whose panel is being opened. `undefined` when none waits.
   */
  function devtoolsTabAwaitingPanel(connectionId: string): TabId | undefined {
    const connections = hub.listConnections();
    const tabsWithPanels = new Set(
      connections
        .filter(isPanelConnection)
        .filter((connection) => connection.connectionId !== connectionId)
        .map((connection) => connection.tabId),
    );
    const waiting = connections
      .filter(isDevtoolsConnection)
      .filter(
        (connection) => connection.tabId !== undefined && !tabsWithPanels.has(connection.tabId),
      )
      .sort(byNewest);
    return waiting[0]?.tabId;
  }

  /**
   * Associate a panel connection with its inspected tab, in order of
   * certainty: the tab bound to the session the panel names (a panel
   * reconnecting after an eviction), the tab it is already bound to, then the
   * DevTools page awaiting a panel.
   */
  async function associatePanel(
    sessionId: SessionId | undefined,
    context: PortRequestContext,
  ): Promise<TabId | undefined> {
    if (sessionId !== undefined) {
      const sessionTab = await registry.getTabForSession(sessionId);
      if (sessionTab !== undefined) {
        if (sessionTab !== context.tabId) {
          hub.bindPanelTab(context.connectionId, sessionTab);
        }
        return sessionTab;
      }
    }
    if (context.tabId !== undefined) {
      return context.tabId;
    }
    const candidate = devtoolsTabAwaitingPanel(context.connectionId);
    if (candidate !== undefined && hub.bindPanelTab(context.connectionId, candidate)) {
      log.debug('Panel associated with its DevTools page.', { tabId: candidate });
      return candidate;
    }
    return undefined;
  }

  /**
   * A DevTools page announced a tab after that window's panel connected (the
   * order a worker revival can produce): bind the newest waiting panel to it
   * and push the state its snapshot answer lacked.
   */
  function adoptWaitingPanel(tabId: TabId): void {
    const panels = hub.listConnections().filter(isPanelConnection);
    if (panels.some((connection) => connection.tabId === tabId)) {
      return;
    }
    const waiting = panels.filter((connection) => connection.tabId === undefined).sort(byNewest)[0];
    if (waiting === undefined || !hub.bindPanelTab(waiting.connectionId, tabId)) {
      return;
    }
    log.debug('Waiting panel associated with the announced DevTools page.', { tabId });
    background(pushTabStateToPanels(tabId), 'panel hydration');
  }

  /** Push one relayed-type envelope to a tab's panels. */
  function pushProtocol(tabId: TabId, envelope: unknown): void {
    if (!isRelayedMessage(envelope)) {
      return;
    }
    const push: ProtocolPush = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'protocol',
      message: envelope,
    };
    hub.pushToPanels(tabId, push);
  }

  /**
   * The bound session's record, latest analysis and current panel, read over
   * HTTP. A part the service cannot supply is omitted (and its code logged),
   * because the panel renders every other part without it.
   */
  async function loadSessionDetails(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionDetails> {
    const options = signal === undefined ? undefined : { signal };
    const [session, current] = await Promise.all([
      wsBridge.getSession(sessionId, options),
      wsBridge.getCurrentPanel(sessionId, options),
    ]);
    if (!session.ok || !current.ok) {
      log.debug('Part of the session could not be read.', {
        sessionId,
        sessionError: errorCode(session),
        panelError: errorCode(current),
      });
    }
    const analysis = session.ok ? latestAnalysis(session.value) : undefined;
    const panel = current.ok ? current.value.panel : null;
    return {
      ...(session.ok ? { session: session.value } : {}),
      ...(analysis === undefined ? {} : { analysis }),
      ...(panel === null ? {} : { panel }),
    };
  }

  /**
   * Bring a tab's newly associated panels up to date: its binding state and,
   * when bound, the session record, analysis and panel — what a
   * `session.snapshot` answer would have carried, as the pushes that carry
   * them after it.
   */
  async function pushTabStateToPanels(tabId: TabId): Promise<void> {
    await ready;
    const state = await registry.getPanelBindingState(tabId);
    hub.pushToPanels(tabId, {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'binding',
      state,
    });
    if (state.kind !== 'bound' || !wsBridge.snapshot().hasCredential) {
      return;
    }
    const { sessionId } = state;
    const details = await loadSessionDetails(sessionId);
    if (details.session !== undefined) {
      pushProtocol(tabId, createEnvelope('session.updated', { session: details.session }));
    }
    if (details.analysis !== undefined) {
      pushProtocol(
        tabId,
        createEnvelope('analysis.completed', { sessionId, analysis: details.analysis }),
      );
    }
    const { panel } = details;
    if (panel !== undefined) {
      // The HTTP view types the layout read-only; the frame's payload type is
      // the schema's mutable inference, so the array is copied, not cast.
      pushProtocol(
        tabId,
        createEnvelope('panel.generated', {
          sessionId,
          panelId: panel.id,
          panel: { ...panel, layout: [...panel.layout] },
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Port lifecycle: DevTools closing is the unbind trigger (AAP §0.2.3)
  // -------------------------------------------------------------------------

  /**
   * A DevTools page left: DevTools closed on that tab (or its page reloaded,
   * after which it announces itself again and the tab re-binds). A disconnect
   * caused by the worker's own teardown is never a close.
   */
  async function handleDevtoolsClosed(event: PortClosedEvent<DevtoolsConnection>): Promise<void> {
    const tabId = event.connection.tabId;
    if (event.reason === 'disposed' || tabId === undefined || hasDevtools(tabId)) {
      return;
    }
    announcedTabs.delete(tabId);
    if (lastDevtoolsTab === tabId) {
      lastDevtoolsTab = undefined;
    }
    await ready;
    const removed = await registry.unbind(tabId, 'devtools-closed');
    log.info('DevTools closed on a tab.', { tabId, unbound: removed !== undefined });
  }

  /**
   * A panel left. While the tab's DevTools page (or another panel) remains,
   * this is only the panel document reloading, and changes nothing; with
   * neither left and a binding recorded, DevTools closed without its page
   * reporting it, so the tab is unbound the same way.
   */
  async function handlePanelClosed(event: PortClosedEvent<PanelConnection>): Promise<void> {
    const tabId = event.connection.tabId;
    if (event.reason === 'disposed' || tabId === undefined) {
      return;
    }
    const stillInspected = hub
      .listConnections()
      .some(
        (connection) =>
          (isDevtoolsConnection(connection) || isPanelConnection(connection)) &&
          connection.tabId === tabId,
      );
    if (stillInspected) {
      return;
    }
    await ready;
    if ((await registry.getBinding(tabId)) === undefined) {
      return;
    }
    await registry.unbind(tabId, 'devtools-closed');
    log.info('The last panel of a bound tab closed.', { tabId });
  }

  // -------------------------------------------------------------------------
  // The modules, each constructed exactly once
  // -------------------------------------------------------------------------

  const hub: PortHub = createPortHub({
    runtime,
    timers,
    handlers: requestHandlers,
    bridgeHandlers,
    devtoolsHandlers,
    events: {
      onConnected: (connection) => {
        log.debug('Port connected.', { role: connection.role, tabId: connection.tabId });
      },
      onPanelDisconnected: (event) => handlePanelClosed(event),
      onDevtoolsDisconnected: (event) => handleDevtoolsClosed(event),
      onBridgeDisconnected: (event) => {
        log.debug('Content bridge disconnected.', {
          tabId: event.connection.tabId,
          reason: event.reason,
        });
      },
    },
    resolveTabForSession: (sessionId) => registry.getTabForSession(sessionId),
    logger: rootLogger,
  });

  const registry: TabRegistry = createTabRegistry({
    storage: storage.session,
    send: (type, payload, options) => wsBridge.send(type, payload, options),
    notify: hub.pushToPanels,
    logger: rootLogger,
  });

  const agent: AgentControl = createAgentControl({
    sendToBridge: hub.sendToBridge,
    send: (type, payload, options) => wsBridge.send(type, payload, options),
    resolveBinding: async (sessionId) => {
      const tabId = await registry.getTabForSession(sessionId);
      return tabId === undefined ? undefined : registry.getBinding(tabId);
    },
    tabs,
    timers,
    pushStatus: hub.pushToPanels,
    logger: rootLogger,
  });

  /**
   * Every status snapshot the bridge publishes: fanned out to every panel
   * (the pill is global) and watched for the transition to `connected`, after
   * which binds refused while the socket was closed are sent again.
   */
  function publishStatus(snapshot: WorkerStatusSnapshot): void {
    hub.broadcastToPanels(snapshot);
    const previous = lastPublishedStatus;
    lastPublishedStatus = snapshot.status;
    if (previous === snapshot.status) {
      return;
    }
    log.info('Connection status changed.', { status: snapshot.status, previous });
    if (snapshot.status === 'connected') {
      background(rebindAnnouncedTabs('connected'), 'rebind after connect');
    }
  }

  /**
   * The tab `client.hello` names, read synchronously at every hello: the tab
   * of the most recent DevTools page still connected, else a bound tab.
   */
  function primaryTabId(): TabId | undefined {
    if (lastDevtoolsTab !== undefined && hasDevtools(lastDevtoolsTab)) {
      return lastDevtoolsTab;
    }
    const first = boundTabs.values().next();
    return first.done === true ? undefined : first.value;
  }

  const wsBridge: WsBridge = createWsBridge({
    webSocketConstructor: env.webSocketConstructor,
    httpClient,
    tokenProvider: store.getToken,
    onUnauthorized: store.handleUnauthorized,
    hasCredential: store.hasToken,
    alarms,
    timers,
    random: env.random,
    relayPush: hub.relayPush,
    pushStatus: publishStatus,
    listBindings: registry.listBindings,
    serviceBaseUrl,
    primaryTabId,
    logger: rootLogger,
  });

  // -------------------------------------------------------------------------
  // Binding changes and committed navigations
  // -------------------------------------------------------------------------

  /** Keep the page agent in step with the tab's binding. */
  function handleBindingChange(change: TabBindingChange): void {
    if (change.current === undefined) {
      boundTabs.delete(change.tabId);
    } else {
      boundTabs.add(change.tabId);
    }
    switch (change.kind) {
      case 'recorded':
        if (
          change.previous !== undefined &&
          change.previous.sessionId !== change.current?.sessionId
        ) {
          agent.disarm(change.tabId, 'displaced');
        }
        // An `agent.ready` that reached the service before the binding existed
        // was attributed to no session; re-relay it so the readiness gate sees
        // the tab's current document.
        agent.reannounce(change.tabId);
        return;
      case 'updated':
        return;
      case 'removed': {
        const reason = disarmReasonFor(change);
        if (reason !== undefined) {
          agent.disarm(change.tabId, reason);
        }
        return;
      }
    }
  }

  /**
   * The URL of a committed navigation this `tabs.onUpdated` event reports, or
   * `undefined` when it reports none.
   *
   * `chrome.webNavigation` would name commits directly, but the manifest's
   * permission set is exactly `storage`, `alarms` and `tabs`, so the commit is
   * derived from `changeInfo`: a changed `url` (a cross-document commit, or a
   * same-document one through the history API) that differs from the last URL
   * seen, or a new `loading` cycle without a URL change — a reload, which
   * commits a new document at the same URL. A repeated event of the same load
   * is de-duplicated against the remembered URL and status.
   */
  function committedNavigationUrl(
    tabId: TabId,
    changeInfo: WorkerTabChange,
    tab: WorkerTab,
  ): string | undefined {
    const previous = navigationMemo.get(tabId);
    navigationMemo.set(tabId, {
      url: changeInfo.url ?? tab.url ?? previous?.url,
      status: changeInfo.status ?? previous?.status,
    });
    if (changeInfo.url !== undefined) {
      return changeInfo.url === previous?.url ? undefined : changeInfo.url;
    }
    if (changeInfo.status === 'loading' && previous?.status !== 'loading') {
      return tab.url ?? previous?.url;
    }
    return undefined;
  }

  /**
   * Report a bound tab's committed navigation: the registry sends
   * `tab.navigated` and keeps or drops the binding by origin, and the agent
   * controller re-arms the new document (same origin) or clears the
   * configuration (different origin). Unbound tabs are not reported, to keep
   * the service free of every other tab's browsing.
   */
  async function handleTabUpdated(
    tabId: TabId,
    changeInfo: WorkerTabChange,
    tab: WorkerTab,
  ): Promise<void> {
    const url = committedNavigationUrl(tabId, changeInfo, tab);
    if (url === undefined) {
      return;
    }
    await ready;
    if ((await registry.getBinding(tabId)) === undefined) {
      return;
    }
    const redacted = redactNavigationUrl(url);
    const reported =
      redacted === undefined
        ? undefined
        : urlFallbacks(redacted).find(
            (candidate) => parseTabNavigatedPayload({ tabId, url: candidate }).ok,
          );
    if (reported === undefined) {
      log.debug('A navigation of a bound tab has no URL the service accepts.', { tabId });
      return;
    }
    const decision = await registry.handleNavigated({ tabId, url: reported });
    const outcome = agent.handleNavigationDecision(decision);
    log.info('Committed navigation of a bound tab.', {
      tabId,
      decision: decision.kind,
      agent: outcome.kind,
    });
  }

  /** The service asked for a target: let the DevTools page offer its selection too. */
  async function forwardTargetRequest(payload: MessagePayload<'target.request'>): Promise<void> {
    const tabId = await registry.getTabForSession(payload.sessionId);
    if (tabId === undefined) {
      return;
    }
    const delivered = hub.sendToDevtools(tabId, {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'downstream',
      type: 'target.request',
      payload,
    });
    log.debug('target.request forwarded to DevTools.', { tabId, delivered });
  }

  // -------------------------------------------------------------------------
  // Socket subscriptions. Every type in RELAYED_MESSAGE_TYPES is already fanned
  // out to the panels by `ws-bridge.ts`; these only apply each frame to the
  // worker's own state, so none is relayed a second time.
  // -------------------------------------------------------------------------

  teardown.push(
    wsBridge.subscribe('agent.config', (message) => {
      background(
        agent.applyConfig(message.payload).then((outcome) => {
          log.debug('agent.config applied.', {
            sessionId: message.payload.sessionId,
            outcome: outcome.kind,
          });
        }),
        'agent.config',
      );
    }),
    wsBridge.subscribe('session.bound', (message) => {
      // The authoritative binding write, the announced replacement included.
      background(
        registry.applyBound(message.payload).then((applied) => {
          log.debug('session.bound applied.', {
            sessionId: message.payload.sessionId,
            outcome: applied.ok ? applied.value.kind : undefined,
            errorCode: errorCode(applied),
          });
        }),
        'session.bound',
      );
    }),
    wsBridge.subscribe('capture.started', (message) => {
      // Stored on the bound tab, so a reload mid-capture continues the same capture.
      background(registry.handleCaptureStarted(message.payload), 'capture.started');
    }),
    wsBridge.subscribe('capture.stopped', (message) => {
      background(registry.handleCaptureStopped(message.payload), 'capture.stopped');
    }),
    wsBridge.subscribe('session.updated', (message) => {
      // An ended session unbinds its tab; the binding change disarms the agent.
      background(registry.handleSessionUpdated(message.payload), 'session.updated');
    }),
    wsBridge.subscribe('cleanup.completed', (message) => {
      background(registry.handleSessionEnded(message.payload.sessionId), 'cleanup.completed');
    }),
    wsBridge.subscribe('session.created', () => {
      background(rebindAnnouncedTabs('session-created'), 'rebind after session.created');
    }),
    wsBridge.subscribe('target.request', (message) => {
      // The panel enters picker mode from the relayed frame itself.
      background(forwardTargetRequest(message.payload), 'target.request');
    }),
    registry.onChange(handleBindingChange),
    store.onStateChange((state) => {
      // `paired` connects, `not-paired` closes the socket and disarms the
      // keepalive; either way the bridge publishes a fresh status snapshot.
      wsBridge.handlePairingState(state);
    }),
  );

  // -------------------------------------------------------------------------
  // Chrome listeners — all registered synchronously, during this call, which
  // the module makes during its own first evaluation.
  // -------------------------------------------------------------------------

  /** Add a listener, and record how `dispose` removes it. */
  function listen<Listener>(event: WorkerEvent<Listener>, listener: Listener): void {
    event.addListener(listener);
    teardown.push(() => {
      event.removeListener(listener);
    });
  }

  /** Start (or keep) the socket once the cold-start work has settled. */
  function ensureConnected(trigger: string): void {
    background(
      ready.then(() => wsBridge.connect()),
      `connect on ${trigger}`,
    );
  }

  // Installed, updated or a profile started: start the socket when a
  // credential exists. The keepalive alarm is created by `wsBridge.connect()`
  // and nowhere else, only when there is a socket to keep alive, and
  // `alarms.create` replaces an alarm of the same name, so this is idempotent.
  listen(runtime.onInstalled, (details) => {
    log.info('Extension installed or updated.', { reason: details.reason });
    ensureConnected('installed');
  });
  listen(runtime.onStartup, () => {
    log.info('Browser profile started.');
    ensureConnected('startup');
  });

  // A panel, a DevTools page or a content bridge: the hub classifies and
  // validates the port; panels are associated with their tab on their first
  // `session.snapshot` request, DevTools pages by their `devtools.hello`.
  listen(runtime.onConnect, (port) => {
    hub.handleConnect(port);
  });

  listen(tabs.onUpdated, (tabId, changeInfo, tab) => {
    background(handleTabUpdated(tabId, changeInfo, tab), 'tab update');
  });

  listen(tabs.onRemoved, (tabId) => {
    navigationMemo.delete(tabId);
    announcedTabs.delete(tabId);
    agent.clear(tabId);
    background(
      registry.unbind(tabId, 'tab-closed').then((removed) => {
        if (removed !== undefined) {
          log.info('A bound tab closed.', { tabId, sessionId: removed.sessionId });
        }
      }),
      'tab removal',
    );
  });

  // The keepalive tick; every other alarm belongs to no module here.
  listen(alarms.onAlarm, (alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM_NAME) {
      return;
    }
    background(
      ready.then(() => wsBridge.handleKeepaliveAlarm(alarm)),
      'keepalive',
    );
  });

  // Best effort only: Manifest V3 does not guarantee this event, and nothing
  // here depends on it — every state that matters is in storage or is rebuilt
  // by the announcements that follow a revival.
  if (runtime.onSuspend !== undefined) {
    listen(runtime.onSuspend, () => {
      log.info('Worker suspending.', {
        connections: hub.listConnections().length,
        status: wsBridge.snapshot().status,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Cold start — after every listener exists
  // -------------------------------------------------------------------------

  /** Hydrate the bindings, read the credential and, with one, open the socket. */
  async function start(): Promise<void> {
    const bindings = await registry.reload();
    for (const binding of bindings) {
      boundTabs.add(binding.tabId);
    }
    await wsBridge.connect();
    log.info('Worker started.', {
      bindings: bindings.length,
      status: wsBridge.snapshot().status,
    });
  }

  const ready: Promise<void> = start().then(undefined, (cause: unknown) => {
    log.error('Worker start-up failed.', { error: errorName(cause) });
  });

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const release of teardown.splice(0).reverse()) {
      try {
        release();
      } catch (cause) {
        log.warn('Releasing a listener failed.', { error: errorName(cause) });
      }
    }
    agent.dispose();
    hub.disposeAll();
    store.dispose();
    background(wsBridge.close(), 'close');
    log.info('Worker disposed.');
  }

  return Object.freeze({
    ready,
    httpClient,
    store,
    hub,
    registry,
    agent,
    wsBridge,
    requestConsentedReload: (tabId: TabId) => agent.requestConsentedReload(tabId),
    dispose,
  });
}

/*
 * ===========================================================================
 * Section E — the bootstrap Chrome runs
 * ===========================================================================
 */

/**
 * The platform's one-shot timers with the numeric handles `WorkerTimerApi`
 * requires. `self` is resolved at call time, so importing this module where no
 * worker global exists (a unit test) is harmless.
 */
const platformTimers: WorkerTimerApi = {
  setTimeout: (handler, ms) => self.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    self.clearTimeout(handle);
  },
};

/**
 * The real Chrome environment, or `undefined` when this module is evaluated
 * anywhere but an extension service worker — so importing it in a test
 * attaches no listener and opens no socket.
 */
function chromeEnvironment(): WorkerEnvironment | undefined {
  if (typeof chrome === 'undefined' || typeof WebSocket === 'undefined') {
    return undefined;
  }
  const namespace: Partial<typeof chrome> = chrome;
  const { runtime, tabs, alarms, storage } = namespace;
  if (
    runtime?.id === undefined ||
    tabs === undefined ||
    alarms === undefined ||
    storage?.local === undefined ||
    storage.session === undefined
  ) {
    return undefined;
  }
  return {
    runtime,
    tabs,
    alarms,
    storage,
    webSocketConstructor: WebSocket,
    timers: platformTimers,
  };
}

/** Create the worker when running as the extension's service worker. */
function bootstrap(): DebugGeneratorWorker | undefined {
  const environment = chromeEnvironment();
  return environment === undefined ? undefined : createWorker(environment);
}

/**
 * The extension's worker, composed synchronously while Chrome evaluates this
 * module — which is what puts every listener in place before the event that
 * woke the worker is dispatched. `undefined` outside an extension service
 * worker.
 */
export const serviceWorker: DebugGeneratorWorker | undefined = bootstrap();
