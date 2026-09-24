/**
 * Unit spec for `../src/background/agent-control.ts` — the arming controller
 * for the dormant MAIN-world telemetry agent, and the only module in the
 * extension allowed to reload a developer's tab.
 *
 * Three product guarantees run through that module, and this spec holds them:
 *
 * - **Configuration reaches only the bound tab.** An `agent.config` is routed
 *   through the session's binding to exactly one tab's bridge; a second tab —
 *   of the same app, bound to nothing or to another session — receives
 *   nothing, a tab the binding moved away from is returned to dormant, and a
 *   document of another origin is never handed the session's ids.
 * - **A reload re-arms without losing the capture.** The statically declared
 *   agent runs afresh at `document_start` on every load; its `agent.ready` is
 *   relayed upward with the `tabId` filled in (the page has no socket, AAP
 *   §0.4.2) and answered with the tab's desired configuration — the **same**
 *   `captureId` (AAP §0.5.5, "Page reloaded during capture").
 * - **A reload happens only with explicit developer consent.** A late fiber
 *   hook (`installedBeforeReact === false`) is surfaced as an offer, never
 *   acted on; only `requestConsentedReload` calls the injected `reload`, and
 *   its wait for the new document's `agent.ready` is bounded by
 *   `PENDING_READY_TIMEOUT_MS`.
 *
 * The real exports are the authority. Where they refine the brief, the spec
 * follows them: `applyConfig` resolves the bound tab through the injected
 * `resolveBinding` lookup and answers a typed `ApplyConfigOutcome`; the
 * developer-facing reload prompt is the *service's* readiness progress, so the
 * worker surfaces the offer as the relayed `agent.ready` (carrying
 * `installedBeforeReact: false`), the `reloadOffered` flag and the
 * `agent-ready` change notification, while the `PortPushSink` refreshes the
 * bound tab's binding line after a re-arm; `disarm` answers a `DisarmOutcome`.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). Every dependency of
 * `createAgentControl` is a recording fake built fresh in `beforeEach` and
 * local to this file — no helper module, no `vi.mock`: the module has no
 * import-time side effect and is fully injectable. The only global stub is a
 * `chrome` object whose `scripting` and `tabs.reload` members must record zero
 * calls. Vitest's fake timers drive the bounded wait, so no case depends on a
 * wall clock; nothing opens a socket or touches the network. Tab ids, origins,
 * session and capture ids are neutral synthetic values (AAP §0.5.4).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { AgentConfigPayload, AgentHookConfig, SendOutcome } from '@debuggen/protocol';
import { err, ok } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import { createAgentControl, PENDING_READY_TIMEOUT_MS } from '../src/background/agent-control';
import type {
  AgentBindingLookup,
  AgentBindingTarget,
  AgentControl,
  AgentControlChange,
  AgentControlListener,
  AgentNavigationDecision,
  AgentTabsApi,
  ReloadOutcome,
} from '../src/background/agent-control';
import { workerError } from '../src/background/messages';
import type {
  AgentReadinessState,
  BridgeSend,
  PortPushSink,
  ProtocolSend,
  WorkerTimerApi,
} from '../src/background/messages';
import { EXTENSION_CHANNEL, PORT_PROTOCOL_VERSION } from '../src/shared/messages';
import type {
  BridgeDownstreamMessage,
  PageAgentReadyPayload,
  PortBindingPush,
} from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/** A Chrome tab id, as the readiness memo types it. */
type TabId = AgentReadinessState['tabId'];

/** A session id, as the configuration payload types it. */
type SessionId = AgentConfigPayload['sessionId'];

/** A capture id, as the configuration payload types it. */
type CaptureId = AgentConfigPayload['captureId'];

/** The tab the session is bound to. */
const BOUND_TAB: TabId = 101;

/** A second tab of the same app, bound to nothing (or to another session). */
const OTHER_TAB: TabId = 202;

/** The origin of the binding. */
const BOUND_ORIGIN = 'http://127.0.0.1:4100';

/** Another local app's origin. */
const FOREIGN_ORIGIN = 'http://localhost:4200';

/** The path of the bound document; logs must never carry it. */
const PAGE_PATH = '/workspace/overview';

/** The bound document's (already query-redacted) URL. */
const PAGE_URL = `${BOUND_ORIGIN}${PAGE_PATH}`;

/** A document of another origin. */
const FOREIGN_URL = `${FOREIGN_ORIGIN}/elsewhere`;

const SESSION_A: SessionId = 'session-test-a';
const SESSION_B: SessionId = 'session-test-b';
const CAPTURE_1: CaptureId = 'capture-test-1';
const CAPTURE_2: CaptureId = 'capture-test-2';

/** The injected clock's reading, so `receivedAt` is asserted exactly. */
const NOW_MS = 1_700_000_000_000;

/** A complete hook set with every flag at one value. */
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

/** An armed configuration: several hooks on, a couple off. */
function armedConfig(
  sessionId: SessionId = SESSION_A,
  captureId: CaptureId = CAPTURE_1,
): AgentConfigPayload {
  return { sessionId, captureId, hooks: { ...hookSet(true), state: false, componentTree: false } };
}

/** The service's own dormancy frame for a capture. */
function dormantConfig(
  sessionId: SessionId = SESSION_A,
  captureId: CaptureId = CAPTURE_1,
): AgentConfigPayload {
  return { sessionId, captureId, hooks: hookSet(false) };
}

/** A page agent's `agent.ready` for the bound origin, hook in place before React. */
function readyPayload(overrides: Partial<PageAgentReadyPayload> = {}): PageAgentReadyPayload {
  return {
    documentId: 'doc-test-1',
    producerId: 'producer-test-1',
    url: PAGE_URL,
    installedBeforeReact: true,
    reactDetected: true,
    ...overrides,
  };
}

/** The exact worker → bridge frame a configuration travels in. */
function configFrame(config: AgentConfigPayload): BridgeDownstreamMessage {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'downstream',
    type: 'agent.config',
    payload: config,
  };
}

/** The exact binding refresh pushed to a re-armed bound tab's panels. */
function boundPush(tabId: TabId, sessionId: SessionId, url: string): PortBindingPush {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'binding',
    state: { kind: 'bound', sessionId, tabId, url },
  };
}

/*
 * ===========================================================================
 * Harness — one recording fake per `AgentControlDeps` member
 * ===========================================================================
 */

/** A frame a bridge actually took (the fake bridge was attached). */
interface DeliveredFrame {
  readonly tabId: TabId;
  readonly message: BridgeDownstreamMessage;
}

/** One record the injected logger received, bindings merged in. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** Everything a case drives or inspects. */
interface Harness {
  readonly control: AgentControl;
  /** Tabs whose bridge port is attached; the fake `BridgeSend` answers from it. */
  readonly attached: Set<TabId>;
  /** The binding each session holds, as the injected lookup answers it. */
  readonly bindings: Map<SessionId, AgentBindingTarget>;
  /** Every frame a bridge took, in order. */
  readonly delivered: DeliveredFrame[];
  readonly sendToBridge: Mock<BridgeSend>;
  readonly send: Mock<ProtocolSend>;
  readonly resolveBinding: Mock<AgentBindingLookup>;
  /** The injected `chrome.tabs`-shaped reload — zero calls unless consent was given. */
  readonly reload: Mock<AgentTabsApi['reload']>;
  readonly setTimer: Mock<WorkerTimerApi['setTimeout']>;
  readonly clearTimer: Mock<WorkerTimerApi['clearTimeout']>;
  readonly pushStatus: Mock<PortPushSink>;
  readonly onChange: Mock<AgentControlListener>;
  readonly logs: LogEntry[];
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

/** Build a controller over fresh fakes. Fake timers must already be installed. */
function createHarness(): Harness {
  const attached = new Set<TabId>();
  const bindings = new Map<SessionId, AgentBindingTarget>();
  const delivered: DeliveredFrame[] = [];
  const logs: LogEntry[] = [];

  const sendToBridge = vi.fn<BridgeSend>((tabId, message) => {
    if (!attached.has(tabId)) {
      return false;
    }
    delivered.push({ tabId, message });
    return true;
  });
  const send = vi.fn<ProtocolSend>(() => ok<SendOutcome>('sent'));
  const resolveBinding = vi.fn<AgentBindingLookup>((sessionId) => bindings.get(sessionId));
  const reload = vi.fn<AgentTabsApi['reload']>(() => Promise.resolve());

  // Opaque numeric handles over Vitest's faked `setTimeout`, as `TimerApi` requires.
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
  const pushStatus = vi.fn<PortPushSink>();
  const onChange = vi.fn<AgentControlListener>();

  const control = createAgentControl({
    sendToBridge,
    send,
    resolveBinding,
    tabs: { reload },
    timers: { setTimeout: setTimer, clearTimeout: clearTimer },
    now: () => NOW_MS,
    pushStatus,
    onChange,
    logger: createRecordingLogger(logs),
  });

  return {
    control,
    attached,
    bindings,
    delivered,
    sendToBridge,
    send,
    resolveBinding,
    reload,
    setTimer,
    clearTimer,
    pushStatus,
    onChange,
    logs,
  };
}

/*
 * ===========================================================================
 * Query helpers over the recorded fakes
 * ===========================================================================
 */

/** Record the binding the injected lookup answers for a session. */
function bind(h: Harness, sessionId: SessionId, tabId: TabId, origin = BOUND_ORIGIN): void {
  h.bindings.set(sessionId, { tabId, origin });
}

/** Every configuration a tab's bridge actually took, in order. */
function configsTo(h: Harness, tabId: TabId): AgentConfigPayload[] {
  return h.delivered
    .filter((frame) => frame.tabId === tabId)
    .flatMap(({ message }) => (message.type === 'agent.config' ? [message.payload] : []));
}

/** How many times anything was offered to a tab's bridge, taken or not. */
function bridgeAttemptsFor(h: Harness, tabId: TabId): number {
  return h.sendToBridge.mock.calls.filter(([target]) => target === tabId).length;
}

/** Every `agent.ready` payload relayed to the service, in order. */
function relayedReadies(h: Harness): unknown[] {
  return h.send.mock.calls.filter(([type]) => type === 'agent.ready').map(([, payload]) => payload);
}

/** Every change notification of one kind, in order. */
function changesOfKind<Kind extends AgentControlChange['kind']>(
  h: Harness,
  kind: Kind,
): Extract<AgentControlChange, { readonly kind: Kind }>[] {
  return h.onChange.mock.calls
    .map(([change]) => change)
    .filter((change): change is Extract<AgentControlChange, { readonly kind: Kind }> => {
      return change.kind === kind;
    });
}

/** The first log record with a given message; fails the case when there is none. */
function logEntry(h: Harness, message: string): LogEntry {
  const entry = h.logs.find((candidate) => candidate.message === message);
  if (entry === undefined) {
    expect.unreachable(`expected a log record "${message}"`);
  }
  return entry;
}

/** The messages the injected logger recorded at one level. */
function logMessages(h: Harness, level: LogLevel): string[] {
  return h.logs.filter((entry) => entry.level === level).map((entry) => entry.message);
}

/**
 * Observe a promise without awaiting it: the returned reader answers the
 * settled value, or `undefined` while it is still pending.
 */
function watch<T>(promise: Promise<T>): () => T | undefined {
  let value: T | undefined;
  void promise.then((settled) => {
    value = settled;
  });
  return () => value;
}

/** Let every queued microtask run without firing any timer that is due later. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Assert that `sent` is the dormant form of `source`: the same session and
 * capture, and exactly `source`'s own hook keys, each `false`. The expectation
 * is derived from the input's keys — never written out — so it proves the
 * mechanical derivation rather than agreement with a copied list.
 */
function expectDormantFormOf(
  sent: AgentConfigPayload | undefined,
  source: AgentConfigPayload,
): asserts sent is AgentConfigPayload {
  if (sent === undefined) {
    expect.unreachable('expected a dormant configuration frame; none was delivered');
  }
  const expectedHooks = Object.fromEntries(Object.keys(source.hooks).map((key) => [key, false]));
  expect(sent).toEqual({
    sessionId: source.sessionId,
    captureId: source.captureId,
    hooks: expectedHooks,
  });
  expect(Object.keys(sent.hooks).toSorted()).toEqual(Object.keys(source.hooks).toSorted());
  expect(Object.values(sent.hooks).every((enabled) => !enabled)).toBe(true);
}

/*
 * ===========================================================================
 * The spec
 * ===========================================================================
 */

describe('createAgentControl', () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    h = createHarness();
  });

  afterEach(() => {
    h.control.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is pure construction: nothing is sent, scheduled, reloaded or reported before a call', () => {
    expect(h.sendToBridge).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.resolveBinding).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.setTimer).not.toHaveBeenCalled();
    expect(h.pushStatus).not.toHaveBeenCalled();
    expect(h.onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.control.getReadiness(BOUND_TAB)).toBeUndefined();
    expect(h.control.getDesiredConfig(BOUND_TAB)).toBeUndefined();
    expect(h.control.isReloadPending(BOUND_TAB)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Configuration reaches only the bound tab
  // -------------------------------------------------------------------------

  describe('configuration reaches only the bound tab', () => {
    it('forwards agent.config to the bound tab and to no other tab — not even one of the same app', async () => {
      h.attached.add(BOUND_TAB);
      h.attached.add(OTHER_TAB);
      // The second tab is a live, same-origin page whose agent has reported in:
      // exactly the tab a broadcast would leak the session to.
      h.control.handleAgentReady(
        OTHER_TAB,
        readyPayload({ documentId: 'doc-other-1', producerId: 'producer-other-1' }),
      );
      bind(h, SESSION_A, BOUND_TAB);
      const config = armedConfig();

      const outcome = await h.control.applyConfig(config);

      expect(h.resolveBinding).toHaveBeenCalledTimes(1);
      expect(h.resolveBinding).toHaveBeenCalledWith(SESSION_A);
      expect(outcome).toEqual({
        kind: 'routed',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
        captureId: CAPTURE_1,
        dormant: false,
        delivery: 'delivered',
      });
      expect(h.delivered).toEqual([{ tabId: BOUND_TAB, message: configFrame(config) }]);
      expect(bridgeAttemptsFor(h, OTHER_TAB)).toBe(0);
      expect(h.control.getDesiredConfig(BOUND_TAB)).toEqual(config);
      expect(h.control.getDesiredConfig(OTHER_TAB)).toBeUndefined();
      expect(changesOfKind(h, 'config-routed')).toEqual([
        {
          kind: 'config-routed',
          tabId: BOUND_TAB,
          sessionId: SESSION_A,
          captureId: CAPTURE_1,
          dormant: false,
          delivery: 'delivered',
        },
      ]);
    });

    it('keeps two sessions on two tabs apart, across their reloads too', async () => {
      h.attached.add(BOUND_TAB);
      h.attached.add(OTHER_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      bind(h, SESSION_B, OTHER_TAB);
      const configA = armedConfig(SESSION_A, CAPTURE_1);
      const configB = armedConfig(SESSION_B, CAPTURE_2);

      await h.control.applyConfig(configA);
      await h.control.applyConfig(configB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-a-2' }));
      h.control.handleAgentReady(OTHER_TAB, readyPayload({ documentId: 'doc-b-2' }));

      expect(configsTo(h, BOUND_TAB)).toEqual([configA, configA]);
      expect(configsTo(h, OTHER_TAB)).toEqual([configB, configB]);
      expect(h.pushStatus.mock.calls).toEqual([
        [BOUND_TAB, boundPush(BOUND_TAB, SESSION_A, PAGE_URL)],
        [OTHER_TAB, boundPush(OTHER_TAB, SESSION_B, PAGE_URL)],
      ]);
    });

    it('returns a tab the binding moved away from to dormant and arms only the new tab', async () => {
      h.attached.add(BOUND_TAB);
      h.attached.add(OTHER_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      const config = armedConfig();
      await h.control.applyConfig(config);

      bind(h, SESSION_A, OTHER_TAB);
      const outcome = await h.control.applyConfig(config);

      expect(outcome).toMatchObject({ kind: 'routed', tabId: OTHER_TAB, delivery: 'delivered' });
      expect(configsTo(h, OTHER_TAB)).toEqual([config]);
      const toFormer = configsTo(h, BOUND_TAB);
      expect(toFormer).toHaveLength(2);
      expect(toFormer[0]).toEqual(config);
      expectDormantFormOf(toFormer[1], config);
      expect(changesOfKind(h, 'disarmed')).toEqual([
        {
          kind: 'disarmed',
          tabId: BOUND_TAB,
          sessionId: SESSION_A,
          captureId: CAPTURE_1,
          reason: 'displaced',
          delivery: 'delivered',
        },
      ]);

      // The displaced tab's next document is re-armed dormant, never armed.
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-test-2' }));
      expectDormantFormOf(configsTo(h, BOUND_TAB).at(-1), config);
    });

    it('arms no tab when the session holds no binding', async () => {
      h.attached.add(BOUND_TAB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload());

      const outcome = await h.control.applyConfig(armedConfig());

      expect(outcome).toEqual({
        kind: 'not-bound',
        sessionId: SESSION_A,
        captureId: CAPTURE_1,
        reason: 'no-binding',
      });
      expect(h.sendToBridge).not.toHaveBeenCalled();
      expect(h.control.getDesiredConfig(BOUND_TAB)).toBeUndefined();
    });

    it('treats a failed binding lookup as no binding and arms nothing', async () => {
      h.attached.add(BOUND_TAB);
      h.resolveBinding.mockRejectedValueOnce(new Error('session storage unavailable'));

      const outcome = await h.control.applyConfig(armedConfig());

      expect(outcome).toEqual({
        kind: 'not-bound',
        sessionId: SESSION_A,
        captureId: CAPTURE_1,
        reason: 'lookup-failed',
      });
      expect(h.sendToBridge).not.toHaveBeenCalled();
      const failure = logEntry(h, 'binding lookup failed');
      expect(failure.level).toBe('warn');
      expect(failure.fields).toMatchObject({ code: 'TAB_NOT_BOUND', sessionId: SESSION_A });
    });

    it('disarms the tab still armed for a session whose binding is gone, and never hands it the new capture', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      const config = armedConfig(SESSION_A, CAPTURE_1);
      await h.control.applyConfig(config);
      h.bindings.clear();

      const outcome = await h.control.applyConfig(armedConfig(SESSION_A, CAPTURE_2));

      expect(outcome).toMatchObject({ kind: 'not-bound', reason: 'no-binding' });
      const frames = configsTo(h, BOUND_TAB);
      expect(frames).toHaveLength(2);
      expectDormantFormOf(frames[1], config);
      expect(frames.some((frame) => frame.captureId === CAPTURE_2)).toBe(false);
    });

    it('withholds the configuration from a document of another origin until a bound-origin document reports', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-foreign', url: FOREIGN_URL }),
      );
      const config = armedConfig();

      const outcome = await h.control.applyConfig(config);

      expect(outcome).toMatchObject({
        kind: 'routed',
        tabId: BOUND_TAB,
        delivery: 'pending-navigation',
      });
      expect(bridgeAttemptsFor(h, BOUND_TAB)).toBe(0);

      const ready = h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-bound' }),
      );

      expect(ready).toMatchObject({ kind: 'recorded', config: 'delivered' });
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);
    });
  });

  // -------------------------------------------------------------------------
  // Deferral while no bridge is attached
  // -------------------------------------------------------------------------

  describe('deferral while no bridge is attached', () => {
    it('holds — never drops — the configuration, then delivers it on the tab’s next agent.ready', async () => {
      bind(h, SESSION_A, BOUND_TAB);
      const config = armedConfig();

      const outcome = await h.control.applyConfig(config);

      expect(outcome).toMatchObject({
        kind: 'routed',
        tabId: BOUND_TAB,
        delivery: 'pending-bridge',
      });
      expect(h.delivered).toEqual([]);
      expect(h.control.getDesiredConfig(BOUND_TAB)).toEqual(config);

      // Held indefinitely: no timer discards it.
      await vi.advanceTimersByTimeAsync(PENDING_READY_TIMEOUT_MS * 3);
      expect(h.delivered).toEqual([]);
      expect(h.control.getDesiredConfig(BOUND_TAB)).toEqual(config);

      // The page finishes loading: its bridge attaches and its agent reports in.
      h.attached.add(BOUND_TAB);
      const ready = h.control.handleAgentReady(BOUND_TAB, readyPayload());

      expect(ready).toMatchObject({ kind: 'recorded', tabId: BOUND_TAB, config: 'delivered' });
      expect(h.delivered).toEqual([{ tabId: BOUND_TAB, message: configFrame(config) }]);
      expect(bridgeAttemptsFor(h, OTHER_TAB)).toBe(0);
    });

    it('treats a bridge send that throws as not attached and keeps the configuration pending', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      h.sendToBridge.mockImplementationOnce(() => {
        throw new Error('Attempting to use a disconnected port object');
      });
      const config = armedConfig();

      const outcome = await h.control.applyConfig(config);

      expect(outcome).toMatchObject({ kind: 'routed', delivery: 'pending-bridge' });
      expect(logMessages(h, 'warn')).toContain('bridge send threw');
      expect(h.delivered).toEqual([]);

      h.control.handleAgentReady(BOUND_TAB, readyPayload());
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);
    });
  });

  // -------------------------------------------------------------------------
  // Readiness, relay and re-arming after a reload
  // -------------------------------------------------------------------------

  describe('re-arming after a same-origin reload continues the same capture', () => {
    it('re-sends the configuration with the same captureId to every fresh document of the tab', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-load-0' }));
      const config = armedConfig(SESSION_A, CAPTURE_1);
      await h.control.applyConfig(config);
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);

      // "Page reloaded during capture", three times over: the statically
      // declared agent runs afresh at document_start and reports in each time.
      for (const documentId of ['doc-load-1', 'doc-load-2', 'doc-load-3']) {
        const outcome = h.control.handleAgentReady(
          BOUND_TAB,
          readyPayload({ documentId, producerId: `producer-${documentId}` }),
        );
        expect(outcome).toMatchObject({ kind: 'recorded', tabId: BOUND_TAB, config: 'delivered' });
        expect(h.control.getReadiness(BOUND_TAB)?.documentId).toBe(documentId);
      }

      const frames = configsTo(h, BOUND_TAB);
      expect(frames).toHaveLength(4);
      expect(frames.every((frame) => frame.captureId === CAPTURE_1)).toBe(true);
      expect(frames.every((frame) => frame.sessionId === SESSION_A)).toBe(true);
      expect(new Set(frames.map((frame) => JSON.stringify(frame))).size).toBe(1);
      expect(bridgeAttemptsFor(h, OTHER_TAB)).toBe(0);

      // Each re-armed document refreshes the binding line of this tab's panels only.
      expect(h.pushStatus).toHaveBeenCalledTimes(3);
      expect(h.pushStatus.mock.calls.every(([tabId]) => tabId === BOUND_TAB)).toBe(true);
      expect(h.pushStatus).toHaveBeenLastCalledWith(
        BOUND_TAB,
        boundPush(BOUND_TAB, SESSION_A, PAGE_URL),
      );
    });

    it.each([
      { installedBeforeReact: true, reactDetected: true },
      { installedBeforeReact: false, reactDetected: true },
      { installedBeforeReact: true, reactDetected: false },
    ])(
      'relays agent.ready upward with the tabId filled in and memoises the readiness (%o)',
      (flags) => {
        const payload = readyPayload(flags);

        const outcome = h.control.handleAgentReady(BOUND_TAB, payload);

        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.send).toHaveBeenCalledWith('agent.ready', {
          tabId: BOUND_TAB,
          documentId: payload.documentId,
          producerId: payload.producerId,
          url: payload.url,
          installedBeforeReact: flags.installedBeforeReact,
          reactDetected: flags.reactDetected,
        });
        const readiness: AgentReadinessState = {
          tabId: BOUND_TAB,
          documentId: payload.documentId,
          producerId: payload.producerId,
          installedBeforeReact: flags.installedBeforeReact,
          reactDetected: flags.reactDetected,
          receivedAt: NOW_MS,
        };
        expect(outcome).toEqual({
          kind: 'recorded',
          tabId: BOUND_TAB,
          readiness,
          relayed: true,
          reloadOffered: !flags.installedBeforeReact,
          config: 'none',
        });
        expect(h.control.getReadiness(BOUND_TAB)).toEqual(readiness);
        expect(h.control.getReadiness(OTHER_TAB)).toBeUndefined();
        // Nothing to re-arm yet, so no bridge is offered anything.
        expect(h.sendToBridge).not.toHaveBeenCalled();
      },
    );

    it('relays only the protocol’s own fields, whatever else the page put on its report', () => {
      const payload: PageAgentReadyPayload = Object.assign(readyPayload(), {
        pageTitle: 'Overview',
      });

      h.control.handleAgentReady(BOUND_TAB, payload);

      expect(relayedReadies(h)).toEqual([
        {
          tabId: BOUND_TAB,
          documentId: 'doc-test-1',
          producerId: 'producer-test-1',
          url: PAGE_URL,
          installedBeforeReact: true,
          reactDetected: true,
        },
      ]);
    });

    it('still records and re-arms when the socket client refuses the relay, and can re-announce later', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      const config = armedConfig();
      await h.control.applyConfig(config);
      h.send.mockReturnValueOnce(
        err(workerError('TRANSPORT_DISCONNECTED', 'The service socket is closed.')),
      );

      const outcome = h.control.handleAgentReady(BOUND_TAB, readyPayload());

      expect(outcome).toMatchObject({ kind: 'recorded', relayed: false, config: 'delivered' });
      expect(h.control.getReadiness(BOUND_TAB)).toBeDefined();
      expect(configsTo(h, BOUND_TAB)).toEqual([config, config]);
      const refused = logEntry(h, 'agent.ready not relayed');
      expect(refused.level).toBe('warn');
      expect(refused.fields).toMatchObject({ tabId: BOUND_TAB, code: 'TRANSPORT_DISCONNECTED' });

      expect(h.control.reannounce(BOUND_TAB)).toBe(true);
      expect(relayedReadies(h)).toHaveLength(2);
      expect(relayedReadies(h).at(-1)).toMatchObject({
        tabId: BOUND_TAB,
        documentId: 'doc-test-1',
      });
      expect(h.control.reannounce(OTHER_TAB)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Navigation verdicts from tab-registry.ts
  // -------------------------------------------------------------------------

  describe('navigation verdicts', () => {
    /** Bind, attach and arm the bound tab over a same-origin document. */
    async function armBoundTab(): Promise<AgentConfigPayload> {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload());
      const config = armedConfig();
      await h.control.applyConfig(config);
      return config;
    }

    const keptSameOrigin: AgentNavigationDecision = {
      kind: 'kept-same-origin',
      tabId: BOUND_TAB,
      sessionId: SESSION_A,
      captureId: CAPTURE_1,
    };

    it('kept-same-origin re-arms the tab with the same capture', async () => {
      const config = await armBoundTab();

      const outcome = h.control.handleNavigationDecision(keptSameOrigin);

      expect(outcome).toEqual({ kind: 're-armed', tabId: BOUND_TAB, delivery: 'delivered' });
      expect(configsTo(h, BOUND_TAB)).toEqual([config, config]);
      expect(configsTo(h, BOUND_TAB).at(-1)?.captureId).toBe(CAPTURE_1);
    });

    it('kept-same-origin before the new document’s bridge attaches holds the configuration for its agent.ready', async () => {
      const config = await armBoundTab();
      h.attached.delete(BOUND_TAB);

      expect(h.control.handleNavigationDecision(keptSameOrigin)).toEqual({
        kind: 're-armed',
        tabId: BOUND_TAB,
        delivery: 'pending-bridge',
      });
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);

      h.attached.add(BOUND_TAB);
      const ready = h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-test-2' }),
      );

      expect(ready).toMatchObject({ kind: 'recorded', config: 'delivered' });
      expect(configsTo(h, BOUND_TAB).map((frame) => frame.captureId)).toEqual([
        CAPTURE_1,
        CAPTURE_1,
      ]);
    });

    it('unbound-cross-origin does not re-arm and clears the tab’s state', async () => {
      const config = await armBoundTab();

      const outcome = h.control.handleNavigationDecision({
        kind: 'unbound-cross-origin',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
      });

      expect(outcome).toEqual({ kind: 'cleared', tabId: BOUND_TAB });
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);
      expect(h.control.getDesiredConfig(BOUND_TAB)).toBeUndefined();
      expect(h.control.getReadiness(BOUND_TAB)).toBeUndefined();
      expect(changesOfKind(h, 'cleared')).toEqual([{ kind: 'cleared', tabId: BOUND_TAB }]);

      // The other app's agent reports in: relayed for the service to judge,
      // but never handed the session's configuration.
      const ready = h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-foreign', url: FOREIGN_URL }),
      );

      expect(ready).toMatchObject({ kind: 'recorded', config: 'none' });
      expect(relayedReadies(h).at(-1)).toMatchObject({ tabId: BOUND_TAB, url: FOREIGN_URL });
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);
      expect(h.control.disarm(BOUND_TAB)).toEqual({ kind: 'not-armed', tabId: BOUND_TAB });
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);
    });

    it('kept-same-origin under another session drops the stale configuration instead of re-arming', async () => {
      const config = await armBoundTab();

      const outcome = h.control.handleNavigationDecision({
        kind: 'kept-same-origin',
        tabId: BOUND_TAB,
        sessionId: SESSION_B,
      });

      expect(outcome).toEqual({ kind: 'no-config', tabId: BOUND_TAB });
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);
      expect(h.control.getDesiredConfig(BOUND_TAB)).toBeUndefined();
    });

    it('not-bound drops the configuration but keeps the document’s readiness', async () => {
      const config = await armBoundTab();

      expect(h.control.handleNavigationDecision({ kind: 'not-bound', tabId: BOUND_TAB })).toEqual({
        kind: 'cleared',
        tabId: BOUND_TAB,
      });
      expect(h.control.getDesiredConfig(BOUND_TAB)).toBeUndefined();
      expect(h.control.getReadiness(BOUND_TAB)).toMatchObject({ documentId: 'doc-test-1' });

      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-test-2' }));
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);
    });

    it('ignores a verdict for a tab it holds nothing for', () => {
      expect(
        h.control.handleNavigationDecision({ kind: 'unbound-cross-origin', tabId: OTHER_TAB }),
      ).toEqual({ kind: 'ignored', tabId: OTHER_TAB });
      expect(h.control.handleNavigationDecision({ kind: 'not-bound', tabId: OTHER_TAB })).toEqual({
        kind: 'ignored',
        tabId: OTHER_TAB,
      });
      expect(
        h.control.handleNavigationDecision({
          kind: 'kept-same-origin',
          tabId: OTHER_TAB,
          sessionId: SESSION_A,
        }),
      ).toEqual({ kind: 'no-config', tabId: OTHER_TAB });
      expect(h.sendToBridge).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // The consented reload
  // -------------------------------------------------------------------------

  describe('the consented reload', () => {
    /** The document the late-hook report describes. */
    const LATE_DOCUMENT = 'doc-late-hook';

    /**
     * Arm the bound tab, then have its agent report that the fiber hook arrived
     * after React — a page that was open before the extension was installed.
     */
    async function armWithLateHook(): Promise<AgentConfigPayload> {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      const config = armedConfig();
      await h.control.applyConfig(config);
      h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: LATE_DOCUMENT, installedBeforeReact: false }),
      );
      return config;
    }

    it('never reloads on its own when the hook arrived after React — an unconsented reload would destroy the developer’s page state', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      await h.control.applyConfig(armedConfig());

      const outcome = h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: LATE_DOCUMENT, installedBeforeReact: false }),
      );

      // The offer is surfaced for the developer to accept …
      expect(outcome).toMatchObject({ kind: 'recorded', tabId: BOUND_TAB, reloadOffered: true });
      expect(changesOfKind(h, 'agent-ready')).toMatchObject([
        {
          kind: 'agent-ready',
          tabId: BOUND_TAB,
          readiness: { documentId: LATE_DOCUMENT, installedBeforeReact: false },
          reloadOffered: true,
        },
      ]);
      // … to the service, whose readiness progress asks for the one-click reload …
      expect(relayedReadies(h)).toMatchObject([{ tabId: BOUND_TAB, installedBeforeReact: false }]);
      // … and to the bound tab's panels, whose binding line is refreshed.
      expect(h.pushStatus).toHaveBeenCalledWith(
        BOUND_TAB,
        boundPush(BOUND_TAB, SESSION_A, PAGE_URL),
      );

      // Nothing acts on it: not the report, not the passage of time.
      await vi.advanceTimersByTimeAsync(PENDING_READY_TIMEOUT_MS * 5);
      expect(h.reload).not.toHaveBeenCalled();
      expect(h.setTimer).not.toHaveBeenCalled();
      expect(h.control.isReloadPending(BOUND_TAB)).toBe(false);
      expect(changesOfKind(h, 'reload-started')).toEqual([]);
    });

    it('with consent, reloads exactly that tab once and resolves only when the new document’s agent.ready arrives', async () => {
      await armWithLateHook();
      const framesBefore = configsTo(h, BOUND_TAB).length;

      const pending = h.control.requestConsentedReload(BOUND_TAB);

      expect(h.reload).toHaveBeenCalledTimes(1);
      expect(h.reload).toHaveBeenCalledWith(BOUND_TAB);
      expect(h.setTimer).toHaveBeenCalledTimes(1);
      expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), PENDING_READY_TIMEOUT_MS);
      expect(h.control.isReloadPending(BOUND_TAB)).toBe(true);
      expect(changesOfKind(h, 'reload-started')).toEqual([
        { kind: 'reload-started', tabId: BOUND_TAB, previousDocumentId: LATE_DOCUMENT },
      ]);

      // Chrome has started the reload, but the outcome waits on the agent.
      const current = watch(pending);
      await settle();
      expect(current()).toBeUndefined();

      const ready = h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-reloaded', producerId: 'producer-reloaded' }),
      );

      expect(ready).toMatchObject({ kind: 'recorded', config: 'delivered', reloadOffered: false });
      const expected: ReloadOutcome = {
        kind: 'ready',
        tabId: BOUND_TAB,
        readiness: {
          tabId: BOUND_TAB,
          documentId: 'doc-reloaded',
          producerId: 'producer-reloaded',
          installedBeforeReact: true,
          reactDetected: true,
          receivedAt: NOW_MS,
        },
      };
      await expect(pending).resolves.toEqual(expected);
      expect(changesOfKind(h, 'reload-settled')).toEqual([
        { kind: 'reload-settled', tabId: BOUND_TAB, outcome: expected },
      ]);

      // The reloaded document is re-armed under the same capture.
      const frames = configsTo(h, BOUND_TAB);
      expect(frames).toHaveLength(framesBefore + 1);
      expect(frames.at(-1)?.captureId).toBe(CAPTURE_1);

      // The bounded wait is over and cleaned up; Chrome was asked exactly once.
      expect(h.control.isReloadPending(BOUND_TAB)).toBe(false);
      expect(h.clearTimer).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.reload).toHaveBeenCalledTimes(1);
    });

    it('ignores a late re-announcement from the replaced document while it waits', async () => {
      await armWithLateHook();
      const pending = h.control.requestConsentedReload(BOUND_TAB);
      const current = watch(pending);

      const stale = h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: LATE_DOCUMENT, installedBeforeReact: false }),
      );

      expect(stale).toEqual({ kind: 'stale', tabId: BOUND_TAB, documentId: LATE_DOCUMENT });
      expect(relayedReadies(h)).toHaveLength(1);
      await settle();
      expect(current()).toBeUndefined();
      expect(h.control.isReloadPending(BOUND_TAB)).toBe(true);
      expect(h.control.getReadiness(BOUND_TAB)).toBeUndefined();
    });

    it('resolves as a timeout once PENDING_READY_TIMEOUT_MS passes without agent.ready — it never hangs', async () => {
      await armWithLateHook();
      const pending = h.control.requestConsentedReload(BOUND_TAB);
      const current = watch(pending);

      await vi.advanceTimersByTimeAsync(PENDING_READY_TIMEOUT_MS - 1);
      expect(current()).toBeUndefined();
      expect(h.control.isReloadPending(BOUND_TAB)).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      const timedOut: ReloadOutcome = {
        kind: 'timeout',
        tabId: BOUND_TAB,
        timeoutMs: PENDING_READY_TIMEOUT_MS,
      };
      expect(current()).toEqual(timedOut);
      expect(h.control.isReloadPending(BOUND_TAB)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.reload).toHaveBeenCalledTimes(1);

      // A report that arrives after the deadline re-arms normally; the outcome stands.
      const late = h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-slow-reload' }),
      );
      expect(late).toMatchObject({ kind: 'recorded', config: 'delivered' });
      await expect(pending).resolves.toEqual(timedOut);
    });

    it('refuses, reloading nothing, when no report says the hook arrived after React', async () => {
      await expect(h.control.requestConsentedReload(BOUND_TAB)).resolves.toEqual({
        kind: 'not-consented',
        tabId: BOUND_TAB,
        reason: 'no-agent-report',
      });

      h.control.handleAgentReady(BOUND_TAB, readyPayload({ installedBeforeReact: true }));

      await expect(h.control.requestConsentedReload(BOUND_TAB)).resolves.toEqual({
        kind: 'not-consented',
        tabId: BOUND_TAB,
        reason: 'hook-installed-before-react',
      });
      expect(h.reload).not.toHaveBeenCalled();
      expect(h.setTimer).not.toHaveBeenCalled();
      expect(h.control.isReloadPending(BOUND_TAB)).toBe(false);
    });

    it('shares one reload between repeated requests while it is in flight', async () => {
      await armWithLateHook();

      const first = h.control.requestConsentedReload(BOUND_TAB);
      const second = h.control.requestConsentedReload(BOUND_TAB);

      expect(second).toBe(first);
      expect(h.reload).toHaveBeenCalledTimes(1);
      expect(h.setTimer).toHaveBeenCalledTimes(1);

      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-reloaded' }));
      await expect(second).resolves.toMatchObject({ kind: 'ready', tabId: BOUND_TAB });
    });

    const refusals: [label: string, refuse: AgentTabsApi['reload']][] = [
      ['rejects', () => Promise.reject(new Error('No tab with id: 101.'))],
      [
        'throws',
        () => {
          throw new Error('No tab with id: 101.');
        },
      ],
    ];

    it.each(refusals)(
      'settles as no-tab when Chrome %s the reload, restoring the offer',
      async (_label, refuse) => {
        await armWithLateHook();
        h.reload.mockImplementationOnce(refuse);

        await expect(h.control.requestConsentedReload(BOUND_TAB)).resolves.toEqual({
          kind: 'no-tab',
          tabId: BOUND_TAB,
          reason: 'reload-failed',
        });
        expect(h.control.isReloadPending(BOUND_TAB)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.control.getReadiness(BOUND_TAB)).toMatchObject({
          documentId: LATE_DOCUMENT,
          installedBeforeReact: false,
        });

        // The document was never replaced, so the developer may try again.
        const retry = h.control.requestConsentedReload(BOUND_TAB);
        expect(h.reload).toHaveBeenCalledTimes(2);
        h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-reloaded' }));
        await expect(retry).resolves.toMatchObject({ kind: 'ready', tabId: BOUND_TAB });
      },
    );

    it('settles as no-tab when the tab is cleared, or leaves the bound origin, mid-wait', async () => {
      await armWithLateHook();
      const cleared = h.control.requestConsentedReload(BOUND_TAB);
      h.control.clear(BOUND_TAB);
      await expect(cleared).resolves.toEqual({
        kind: 'no-tab',
        tabId: BOUND_TAB,
        reason: 'cleared',
      });
      expect(vi.getTimerCount()).toBe(0);

      await armWithLateHook();
      const navigated = h.control.requestConsentedReload(BOUND_TAB);
      h.control.handleNavigationDecision({
        kind: 'unbound-cross-origin',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
      });
      await expect(navigated).resolves.toEqual({
        kind: 'no-tab',
        tabId: BOUND_TAB,
        reason: 'cleared',
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(h.reload).toHaveBeenCalledTimes(2);
    });

    it('reloads through no path but requestConsentedReload — applyConfig, handleAgentReady and handleNavigationDecision all leave the tab alone', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      const lateHook = { installedBeforeReact: false } as const;

      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-1', ...lateHook }));
      await h.control.applyConfig(armedConfig(SESSION_A, CAPTURE_1));
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-2', ...lateHook }));
      h.control.handleNavigationDecision({
        kind: 'kept-same-origin',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
        captureId: CAPTURE_1,
      });
      h.control.reannounce(BOUND_TAB);
      h.control.disarm(BOUND_TAB);
      await h.control.applyConfig(armedConfig(SESSION_A, CAPTURE_2));
      h.control.handleNavigationDecision({ kind: 'not-bound', tabId: BOUND_TAB });
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-3', ...lateHook }));
      h.control.handleNavigationDecision({
        kind: 'unbound-cross-origin',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
      });
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-4', ...lateHook }));
      await h.control.applyConfig(dormantConfig(SESSION_A, CAPTURE_2));
      h.control.clear(BOUND_TAB);
      h.control.dispose();
      await vi.advanceTimersByTimeAsync(PENDING_READY_TIMEOUT_MS * 3);

      expect(h.reload).not.toHaveBeenCalled();
      expect(h.setTimer).not.toHaveBeenCalled();
      expect(changesOfKind(h, 'reload-started')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Returning the agent to dormant
  // -------------------------------------------------------------------------

  describe('clearing hooks returns the agent to dormant', () => {
    it('disarm sends every hook key of the last received configuration, each false — derived, not listed', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      // A hook key this file does not know — as if one had been added upstream —
      // so only a derivation from the configuration's own keys can pass.
      const hooks: AgentHookConfig = Object.assign(
        { ...armedConfig().hooks },
        { upstreamAddedHook: true },
      );
      const received: AgentConfigPayload = { sessionId: SESSION_A, captureId: CAPTURE_1, hooks };
      await h.control.applyConfig(received);

      const outcome = h.control.disarm(BOUND_TAB);

      expect(outcome).toEqual({
        kind: 'disarmed',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
        captureId: CAPTURE_1,
        delivery: 'delivered',
      });
      const frames = configsTo(h, BOUND_TAB);
      expect(frames).toHaveLength(2);
      const sent = frames[1];
      expectDormantFormOf(sent, received);
      expect(Object.keys(sent.hooks)).toContain('upstreamAddedHook');
      // The received configuration itself is left untouched.
      expect(Object.values(received.hooks)).toContain(true);
      expect(changesOfKind(h, 'disarmed')).toEqual([
        {
          kind: 'disarmed',
          tabId: BOUND_TAB,
          sessionId: SESSION_A,
          captureId: CAPTURE_1,
          reason: 'requested',
          delivery: 'delivered',
        },
      ]);

      // Dormant is now the desired state: a reload re-arms it dormant.
      expect(h.control.getDesiredConfig(BOUND_TAB)).toEqual(sent);
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-test-2' }));
      expect(configsTo(h, BOUND_TAB).at(-1)).toEqual(sent);
    });

    it('holds a disarm for a tab whose bridge is gone and delivers it when the page returns', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      const config = armedConfig();
      await h.control.applyConfig(config);
      h.attached.delete(BOUND_TAB);

      expect(h.control.disarm(BOUND_TAB, 'session-ended')).toMatchObject({
        kind: 'disarmed',
        delivery: 'pending-bridge',
      });
      expect(configsTo(h, BOUND_TAB)).toEqual([config]);

      h.attached.add(BOUND_TAB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload());
      expectDormantFormOf(configsTo(h, BOUND_TAB).at(-1), config);
    });

    it('leaves a tab that never received a configuration alone', () => {
      h.attached.add(BOUND_TAB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload());

      expect(h.control.disarm(BOUND_TAB)).toEqual({ kind: 'not-armed', tabId: BOUND_TAB });
      expect(h.control.disarm(OTHER_TAB)).toEqual({ kind: 'not-armed', tabId: OTHER_TAB });
      expect(h.sendToBridge).not.toHaveBeenCalled();
      expect(changesOfKind(h, 'disarmed')).toEqual([]);
    });

    it('forwards the service’s own all-false agent.config as it arrives, even after the binding is gone', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      await h.control.applyConfig(armedConfig());
      h.bindings.clear();
      const dormant = dormantConfig();

      const outcome = await h.control.applyConfig(dormant);

      expect(outcome).toEqual({
        kind: 'routed',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
        captureId: CAPTURE_1,
        dormant: true,
        delivery: 'delivered',
      });
      expect(configsTo(h, BOUND_TAB).at(-1)).toEqual(dormant);
      expect(bridgeAttemptsFor(h, OTHER_TAB)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Clearing a tab
  // -------------------------------------------------------------------------

  describe('clear', () => {
    it('drops the stored readiness and the pending configuration', async () => {
      bind(h, SESSION_A, BOUND_TAB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload());
      // No bridge attached: the configuration is pending when the tab is cleared.
      await h.control.applyConfig(armedConfig());
      expect(h.control.getDesiredConfig(BOUND_TAB)).toBeDefined();

      h.control.clear(BOUND_TAB);

      expect(h.control.getReadiness(BOUND_TAB)).toBeUndefined();
      expect(h.control.getDesiredConfig(BOUND_TAB)).toBeUndefined();
      expect(h.control.isReloadPending(BOUND_TAB)).toBe(false);
      expect(h.control.reannounce(BOUND_TAB)).toBe(false);
      expect(changesOfKind(h, 'cleared')).toEqual([{ kind: 'cleared', tabId: BOUND_TAB }]);

      // The pending configuration is gone for good: a returning page gets nothing.
      h.attached.add(BOUND_TAB);
      const ready = h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-test-2' }),
      );
      expect(ready).toMatchObject({ kind: 'recorded', config: 'none' });
      expect(h.delivered).toEqual([]);
      expect(h.control.disarm(BOUND_TAB)).toEqual({ kind: 'not-armed', tabId: BOUND_TAB });
    });

    it('discards a configuration whose binding lookup was still in flight when the tab was cleared', async () => {
      h.attached.add(BOUND_TAB);
      let answer: (target: AgentBindingTarget | undefined) => void = () => undefined;
      h.resolveBinding.mockImplementationOnce(
        () =>
          new Promise<AgentBindingTarget | undefined>((resolve) => {
            answer = resolve;
          }),
      );

      const applying = h.control.applyConfig(armedConfig());
      await settle();
      h.control.clear(BOUND_TAB);
      answer({ tabId: BOUND_TAB, origin: BOUND_ORIGIN });

      await expect(applying).resolves.toEqual({
        kind: 'discarded',
        sessionId: SESSION_A,
        captureId: CAPTURE_1,
        reason: 'tab-cleared',
      });
      expect(h.sendToBridge).not.toHaveBeenCalled();
      expect(h.control.getDesiredConfig(BOUND_TAB)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // No dynamic injection, and no page data in logs
  // -------------------------------------------------------------------------

  describe('no dynamic injection', () => {
    it('never touches chrome.scripting or the global chrome.tabs.reload across a full lifecycle', async () => {
      const scripting = {
        executeScript: vi.fn(),
        registerContentScripts: vi.fn(),
        updateContentScripts: vi.fn(),
        unregisterContentScripts: vi.fn(),
        getRegisteredContentScripts: vi.fn(),
        insertCSS: vi.fn(),
      };
      const globalReload = vi.fn();
      vi.stubGlobal('chrome', { scripting, tabs: { reload: globalReload } });

      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      await h.control.applyConfig(armedConfig());
      h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-late', installedBeforeReact: false }),
      );
      const reloading = h.control.requestConsentedReload(BOUND_TAB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-reloaded' }));
      await expect(reloading).resolves.toMatchObject({ kind: 'ready' });
      h.control.handleNavigationDecision({
        kind: 'kept-same-origin',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
      });
      h.control.disarm(BOUND_TAB, 'session-ended');
      h.control.clear(BOUND_TAB);
      h.control.dispose();

      for (const [name, method] of Object.entries(scripting)) {
        expect(method, `chrome.scripting.${name}`).not.toHaveBeenCalled();
      }
      expect(globalReload).not.toHaveBeenCalled();
      // The one reload went through the injected, consented path.
      expect(h.reload).toHaveBeenCalledTimes(1);
      expect(h.reload).toHaveBeenCalledWith(BOUND_TAB);
    });

    it('contains no chrome.scripting call and no dynamic content-script registration in its code', () => {
      // Resolved with `node:path`, not the global `URL`: under happy-dom that
      // global is the DOM implementation, which does not keep `file:` bases.
      const testDir = dirname(fileURLToPath(import.meta.url));
      const source = readFileSync(resolve(testDir, '../src/background/agent-control.ts'), 'utf8');
      // Comments may describe the design; only code is inspected.
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

      expect(code).not.toMatch(/chrome\s*\.\s*scripting/);
      expect(code).not.toMatch(/registerContentScripts|executeScript|insertCSS/);
      expect(code).not.toMatch(/chrome\s*\.\s*tabs\s*\.\s*reload\s*\(/);
      expect(code).toContain('createAgentControl');
    });

    it('logs tab, session, capture and document ids — never the page URL', async () => {
      h.attached.add(BOUND_TAB);
      bind(h, SESSION_A, BOUND_TAB);
      await h.control.applyConfig(armedConfig());
      h.control.handleAgentReady(
        BOUND_TAB,
        readyPayload({ documentId: 'doc-late', installedBeforeReact: false }),
      );
      const reloading = h.control.requestConsentedReload(BOUND_TAB);
      h.control.handleAgentReady(BOUND_TAB, readyPayload({ documentId: 'doc-reloaded' }));
      await reloading;
      h.control.handleNavigationDecision({
        kind: 'unbound-cross-origin',
        tabId: BOUND_TAB,
        sessionId: SESSION_A,
      });

      expect(h.logs.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(h.logs);
      expect(serialized).not.toContain(PAGE_PATH);
      expect(serialized).not.toContain(PAGE_URL);
      expect(h.logs.every((entry) => entry.fields.module === 'agent-control')).toBe(true);
    });
  });
});
