/**
 * Unit spec for `../src/background/tab-registry.ts` — the service worker's
 * tab ↔ session registry, persisted in `chrome.storage.session`.
 *
 * The registry encodes the binding rules of AAP §0.2.3 ("Tab/session
 * binding"), and this spec proves each of them from the registry's public
 * surface:
 *
 * - **The service decides; the worker records.** `requestBind` only *asks*
 *   (it sends `session.bind` and records nothing); a binding exists once
 *   `applyBound` records the service's authoritative `session.bound`.
 * - **One session per tab, one bound tab per session.** A second bind
 *   replaces the first, and the replacement is *announced* — to the displaced
 *   tab's panel through the `PortPushSink` and to every `onChange` listener —
 *   never applied silently.
 * - **Navigation.** Every committed navigation is reported as `tab.navigated`;
 *   a same-origin one keeps the binding and its running capture and answers
 *   "re-arm", a cross-origin one sends `session.unbind`, drops the record and
 *   pushes the "Tab left ‹origin›" state, whose text is `formatTabLeftMessage`.
 * - **Unbinding.** DevTools closing, the tab closing and the session ending
 *   all send `session.unbind` and clear the record.
 * - **Persistence through worker suspension.** A Manifest V3 service worker is
 *   evicted after about thirty seconds idle, so the bindings live in
 *   `chrome.storage.session`. The restart cases discard the registry, build a
 *   fresh one over the *same* storage record and prove the bindings — capture
 *   ids included — come back. Without that, suspension silently drops the
 *   session.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project. The registry is built for injection
 * (`TabRegistryDeps`) and has no import-time side effect, so nothing is
 * mocked at module level and no `chrome` global is stubbed: every dependency
 * is a local fake handed to `createTabRegistry`. The storage fake is a real
 * backing store — a plain record that JSON-round-trips every value, as the
 * browser's storage does — so its contents outlive the registry instance that
 * wrote them. The transport and the panel sink are `vi.fn()` recorders, the
 * logger records without printing, and the clock is a deterministic counter.
 * A fresh harness is built before every case, so no state leaks between cases.
 *
 * Every origin, path, tab id, session id and capture id below is invented for
 * this spec (AAP §0.5.4): nothing names an application route or component.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { workerError } from '../src/background/messages';
import type {
  PortPushSink,
  ProtocolSend,
  TabBindingRecord,
  TabBindingSnapshot,
} from '../src/background/messages';
import {
  BINDING_STORAGE_KEY,
  TAB_UNBIND_CAUSES,
  createTabRegistry,
} from '../src/background/tab-registry';
import type {
  NavigationDecision,
  TabBindingChange,
  TabRegistry,
  TabRegistryDeps,
  TabRegistryStorageArea,
  TabUnbindCause,
} from '../src/background/tab-registry';
import {
  EXTENSION_CHANNEL,
  PORT_PROTOCOL_VERSION,
  formatTabLeftMessage,
  isPanelBindingState,
} from '../src/shared/messages';
import type { PanelBindingState, PortBindingPush } from '../src/shared/messages';

/*
 * ===========================================================================
 * Types derived from the unit's own contracts — nothing is re-declared
 * ===========================================================================
 */

/** A Chrome tab id, as a binding record types it. */
type TabId = TabBindingRecord['tabId'];

/** The service's `session.bound` payload, as `applyBound` accepts it. */
type SessionBoundPayload = Parameters<TabRegistry['applyBound']>[0];

/** The `capture.started` payload, as `handleCaptureStarted` accepts it. */
type CaptureStartedPayload = Parameters<TabRegistry['handleCaptureStarted']>[0];

/** The protocol's binding-reason vocabulary, as a change reports it. */
type BindingReason = TabBindingChange['reason'];

/** The logger contract the registry is handed. */
type Logger = NonNullable<TabRegistryDeps['logger']>;

/** One structured-fields bag a log call carries. */
type LogFields = Parameters<Logger['info']>[1];

/** One levelled logging method's level. */
type LogLevel = Exclude<Logger['level'], 'silent'>;

/** The epoch-millisecond clock the registry stamps `boundAt` with. */
type Clock = NonNullable<TabRegistryDeps['now']>;

/** What the transport answers for one frame. */
type SendResult = ReturnType<ProtocolSend>;

/*
 * ===========================================================================
 * Fixture values — neutral, and obviously synthetic
 * ===========================================================================
 */

/** The origin of an invented local dev server the tabs are bound on. */
const ORIGIN_A = 'http://localhost:4400';

/** A different origin that differs from {@link ORIGIN_A} by its port alone. */
const ORIGIN_B = 'http://localhost:4401';

/** A path segment every fixture URL shares, used to prove URLs stay out of logs. */
const PATH_SEGMENT = '/workspace/';

const URL_A_OVERVIEW = `${ORIGIN_A}${PATH_SEGMENT}overview`;
const URL_A_SETTINGS = `${ORIGIN_A}${PATH_SEGMENT}settings`;
const URL_B_LANDING = `${ORIGIN_B}${PATH_SEGMENT}landing`;

const TAB_ONE = 101;
const TAB_TWO = 202;
const TAB_UNKNOWN = 909;

const SESSION_ALPHA = 'session-test-alpha';
const SESSION_BETA = 'session-test-beta';
const SESSION_UNKNOWN = 'session-test-unknown';

const CAPTURE_ONE = 'capture-test-0001';
const CAPTURE_TWO = 'capture-test-0002';

/** The clock's epoch origin (2026-01-01T00:00:00Z) and its step per reading. */
const CLOCK_START_MS = 1_767_225_600_000;
const CLOCK_STEP_MS = 1_000;

/** The transport's answer when it put a frame on the open socket. */
const SENT: SendResult = { ok: true, value: 'sent' };

/** The transport's answer when it queued a frame while reconnecting. */
const QUEUED: SendResult = { ok: true, value: 'queued' };

/** The instant the clock reports on its `reading`-th call (1-based). */
function clockReading(reading: number): number {
  return CLOCK_START_MS + reading * CLOCK_STEP_MS;
}

/*
 * ===========================================================================
 * Fakes — every member of `TabRegistryDeps`, kept local to this file
 * ===========================================================================
 */

/** A JSON round trip: what `chrome.storage` does to every value it keeps. */
function jsonClone(value: unknown): unknown {
  const text = JSON.stringify(value) as string | undefined;
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/**
 * A `chrome.storage.session`-shaped area over a plain backing record.
 *
 * Not a no-op: `set` and `remove` mutate {@link items}, and `get` reads it
 * back, so a second registry built over the same instance sees exactly what
 * the first one wrote — the simulated worker restart depends on that. Values
 * are JSON-cloned on the way in and out, so the registry can never share an
 * object with storage by reference. Failures are injectable per direction.
 */
class FakeSessionStorageArea implements TabRegistryStorageArea {
  /** The backing record: what survives a worker generation. */
  readonly items: Record<string, unknown> = {};
  /** How many times `get` was called. */
  reads = 0;
  /** How many times `set` or `remove` was called. */
  writes = 0;
  /** When set, every `get` rejects with it. */
  readFailure: Error | undefined = undefined;
  /** When set, every `set` and `remove` rejects with it. */
  writeFailure: Error | undefined = undefined;

  get(keys: string): Promise<Record<string, unknown>> {
    this.reads += 1;
    if (this.readFailure !== undefined) {
      return Promise.reject(this.readFailure);
    }
    return Promise.resolve(
      Object.hasOwn(this.items, keys) ? { [keys]: jsonClone(this.items[keys]) } : {},
    );
  }

  set(items: Record<string, unknown>): Promise<void> {
    this.writes += 1;
    if (this.writeFailure !== undefined) {
      return Promise.reject(this.writeFailure);
    }
    for (const [key, value] of Object.entries(items)) {
      this.items[key] = jsonClone(value);
    }
    return Promise.resolve();
  }

  remove(keys: string): Promise<void> {
    this.writes += 1;
    if (this.writeFailure !== undefined) {
      return Promise.reject(this.writeFailure);
    }
    delete this.items[keys];
    return Promise.resolve();
  }

  /** Whatever is stored under the registry's key, if anything. */
  stored(): unknown {
    return this.items[BINDING_STORAGE_KEY];
  }
}

/** One recorded log call. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A silent logger that remembers its calls, for the privacy assertion. */
interface RecordingLogger extends Logger {
  readonly entries: LogEntry[];
}

function createRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  const levelled =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields });
    };
  const logger: RecordingLogger = {
    level: 'silent',
    entries,
    trace: levelled('trace'),
    debug: levelled('debug'),
    info: levelled('info'),
    warn: levelled('warn'),
    error: levelled('error'),
    fatal: levelled('fatal'),
    child: () => logger,
  };
  return logger;
}

/** A deterministic, strictly increasing clock: reading `n` is {@link clockReading}(n). */
function createClock(): Mock<Clock> {
  let readings = 0;
  return vi.fn<Clock>(() => {
    readings += 1;
    return clockReading(readings);
  });
}

/*
 * ===========================================================================
 * Harness — one worker generation
 * ===========================================================================
 */

/** One worker generation: a registry and the fakes it was built from. */
interface Harness {
  readonly storage: FakeSessionStorageArea;
  readonly send: Mock<ProtocolSend>;
  readonly notify: Mock<PortPushSink>;
  readonly logger: RecordingLogger;
  readonly now: Mock<Clock>;
  /** Every change the registry announced to its `onChange` listeners. */
  readonly changes: TabBindingChange[];
  readonly registry: TabRegistry;
}

/**
 * Build one worker generation over `storage` — a fresh area by default, or
 * the area an earlier generation wrote to when simulating a worker restart.
 * Transport, panel sink, logger and clock are always new, as they are after a
 * real eviction.
 */
function createHarness(storage: FakeSessionStorageArea = new FakeSessionStorageArea()): Harness {
  const send = vi.fn<ProtocolSend>(() => SENT);
  const notify = vi.fn<PortPushSink>();
  const logger = createRecordingLogger();
  const now = createClock();
  const registry = createTabRegistry({ storage, send, notify, logger, now });
  const changes: TabBindingChange[] = [];
  registry.onChange((change) => {
    changes.push(change);
  });
  return { storage, send, notify, logger, now, changes, registry };
}

/**
 * Simulate the Manifest V3 worker being evicted and revived: the previous
 * registry (and its in-memory cache) is dropped, and a fresh one is built
 * over the same storage record.
 */
function restartWorker(previous: Harness): Harness {
  return createHarness(previous.storage);
}

/** Forget what the fakes observed so far, keeping their implementations. */
function resetObservations(harness: Harness): void {
  harness.send.mockClear();
  harness.notify.mockClear();
  harness.changes.length = 0;
}

/** One frame handed to the transport. */
interface SentFrame {
  readonly type: string;
  readonly payload: unknown;
}

/** Every frame the registry handed to the transport, in order. */
function sentFrames(harness: Harness): SentFrame[] {
  return harness.send.mock.calls.map(([type, payload]) => ({ type, payload }));
}

/** One binding state pushed to one tab's panels. */
interface PushedBinding {
  readonly tabId: TabId;
  readonly state: PanelBindingState;
}

/** Every binding state pushed through the panel sink, in order. */
function bindingPushes(harness: Harness): PushedBinding[] {
  const pushes: PushedBinding[] = [];
  for (const [tabId, push] of harness.notify.mock.calls) {
    if (push.kind === 'binding') {
      pushes.push({ tabId, state: push.state });
    }
  }
  return pushes;
}

/** The `binding` push frame a panel receives for `state`. */
function bindingPushFrame(state: PanelBindingState): PortBindingPush {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'binding',
    state,
  };
}

/** A `session.bound` payload, with `reason` omitted when not given. */
function bound(
  tabId: TabId,
  sessionId: string,
  url: string,
  reason?: BindingReason,
): SessionBoundPayload {
  return reason === undefined ? { sessionId, tabId, url } : { sessionId, tabId, url, reason };
}

/** The shape of every `Result` the registry answers with. */
type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** The value of an `ok` result; fails the case with the error's code otherwise. */
function unwrap<T>(result: Outcome<T>): T {
  if (!result.ok) {
    throw new Error(`Expected an ok result, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** A value the case requires to be present, narrowed for the compiler. */
function required<T>(value: T | undefined, what: string): T {
  expect(value, what).toBeDefined();
  if (value === undefined) {
    throw new Error(`${what} is undefined`);
  }
  return value;
}

/**
 * Record the service's confirmation of one binding, as the worker does when
 * `session.bound` arrives, and answer the record it wrote.
 */
async function confirmBinding(
  harness: Harness,
  tabId: TabId,
  sessionId: string,
  url: string,
): Promise<TabBindingRecord> {
  const outcome = unwrap(await harness.registry.applyBound(bound(tabId, sessionId, url)));
  if (outcome.kind !== 'recorded' && outcome.kind !== 'updated') {
    throw new Error(`Expected the binding to be recorded, got '${outcome.kind}'`);
  }
  return outcome.record;
}

/*
 * ===========================================================================
 * The spec
 * ===========================================================================
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTabRegistry', () => {
  it('performs no I/O and needs no chrome global to be built', () => {
    expect(Reflect.has(globalThis, 'chrome')).toBe(false);

    const storage = new FakeSessionStorageArea();
    const send = vi.fn<ProtocolSend>(() => SENT);
    const notify = vi.fn<PortPushSink>();
    createTabRegistry({ storage, send, notify });

    expect(storage.reads).toBe(0);
    expect(storage.writes).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('works with the default logger and clock', async () => {
    const storage = new FakeSessionStorageArea();
    const registry = createTabRegistry({
      storage,
      send: vi.fn<ProtocolSend>(() => SENT),
      notify: vi.fn<PortPushSink>(),
    });

    const outcome = unwrap(
      await registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    expect(outcome.kind).toBe('recorded');
    const record = required(await registry.getBinding(TAB_ONE), 'binding');
    expect(Number.isFinite(record.boundAt)).toBe(true);
    expect(record.boundAt).toBeGreaterThan(0);
  });
});

describe('requestBind — the worker asks, the service decides', () => {
  it('sends session.bind with exactly the tab, URL and origin, and records nothing', async () => {
    const result = await h.registry.requestBind({
      tabId: TAB_ONE,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
    });

    expect(unwrap(result)).toBe('sent');
    expect(sentFrames(h)).toStrictEqual([
      { type: 'session.bind', payload: { tabId: TAB_ONE, url: URL_A_OVERVIEW, origin: ORIGIN_A } },
    ]);
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(await h.registry.listBindings()).toStrictEqual([]);
    expect(h.storage.stored()).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.changes).toStrictEqual([]);
  });

  it('includes the session id when the panel names one', async () => {
    await h.registry.requestBind({
      tabId: TAB_ONE,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      sessionId: SESSION_ALPHA,
    });

    expect(sentFrames(h)).toStrictEqual([
      {
        type: 'session.bind',
        payload: {
          tabId: TAB_ONE,
          url: URL_A_OVERVIEW,
          origin: ORIGIN_A,
          sessionId: SESSION_ALPHA,
        },
      },
    ]);
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
  });

  it("passes the transport's queued outcome through as a success", async () => {
    h.send.mockReturnValueOnce(QUEUED);

    const result = await h.registry.requestBind({
      tabId: TAB_ONE,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
    });

    expect(unwrap(result)).toBe('queued');
  });

  it('refuses a request that is not a valid session.bind payload and sends nothing', async () => {
    const trailingSlash = await h.registry.requestBind({
      tabId: TAB_ONE,
      url: URL_A_OVERVIEW,
      origin: `${ORIGIN_A}/`,
    });
    const noTab = await h.registry.requestBind({
      tabId: -1,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
    });

    expect(trailingSlash).toMatchObject({ ok: false, error: { code: 'PROTOCOL_INVALID_MESSAGE' } });
    expect(noTab).toMatchObject({ ok: false, error: { code: 'PROTOCOL_INVALID_MESSAGE' } });
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('applyBound — the authoritative write', () => {
  it('records the binding the service confirmed and pushes the bound state', async () => {
    await h.registry.requestBind({ tabId: TAB_ONE, url: URL_A_OVERVIEW, origin: ORIGIN_A });
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    resetObservations(h);

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    const expected: TabBindingRecord = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      boundAt: clockReading(1),
    };
    expect(outcome).toStrictEqual({
      kind: 'recorded',
      record: expected,
      previous: undefined,
      displaced: [],
      reason: 'bound',
    });
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(expected);
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_ONE);
    expect(await h.registry.listBindings()).toStrictEqual([expected]);

    const boundState: PanelBindingState = {
      kind: 'bound',
      sessionId: SESSION_ALPHA,
      tabId: TAB_ONE,
      url: URL_A_OVERVIEW,
    };
    expect(h.notify.mock.calls).toStrictEqual([[TAB_ONE, bindingPushFrame(boundState)]]);
    expect(h.changes).toStrictEqual([
      {
        kind: 'recorded',
        tabId: TAB_ONE,
        previous: undefined,
        current: expected,
        state: boundState,
        reason: 'bound',
        cause: undefined,
      },
    ]);
    // Recording the service's answer sends nothing back to the service.
    expect(h.send).not.toHaveBeenCalled();
  });

  it('keeps boundAt and the running capture when the service re-announces the same binding', async () => {
    const original = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    expect(await h.registry.setCaptureId(TAB_ONE, CAPTURE_ONE)).toBe(true);

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    const expected: TabBindingRecord = { ...original, captureId: CAPTURE_ONE };
    expect(outcome).toStrictEqual({ kind: 'updated', record: expected, reason: 'bound' });
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(expected);
    expect(h.now).toHaveBeenCalledTimes(1);
  });

  it('refuses an announcement for a document without an HTTP(S) origin', async () => {
    const result = await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, 'chrome://newtab/'));

    expect(result).toMatchObject({ ok: false, error: { code: 'PROTOCOL_INVALID_MESSAGE' } });
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.changes).toStrictEqual([]);
  });

  it('refuses a payload that is not a valid session.bound', async () => {
    const result = await h.registry.applyBound(bound(-1, SESSION_ALPHA, URL_A_OVERVIEW));

    expect(result).toMatchObject({ ok: false, error: { code: 'PROTOCOL_INVALID_MESSAGE' } });
    expect(await h.registry.listBindings()).toStrictEqual([]);
    expect(h.storage.stored()).toBeUndefined();
  });

  it("records the service's URL when it announces a kept same-origin navigation", async () => {
    const original = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    resetObservations(h);

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_SETTINGS, 'navigated')),
    );

    const expected: TabBindingRecord = { ...original, url: URL_A_SETTINGS };
    expect(outcome).toStrictEqual({ kind: 'updated', record: expected, reason: 'navigated' });
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(expected);
    expect(bindingPushes(h)).toStrictEqual([
      {
        tabId: TAB_ONE,
        state: { kind: 'bound', sessionId: SESSION_ALPHA, tabId: TAB_ONE, url: URL_A_SETTINGS },
      },
    ]);
  });
});

describe('one session per tab, one bound tab per session — a replacement is announced', () => {
  it('replaces the binding of a tab the service binds to another session', async () => {
    const alpha = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    resetObservations(h);

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_ONE, SESSION_BETA, URL_A_OVERVIEW)),
    );

    const beta: TabBindingRecord = {
      tabId: TAB_ONE,
      sessionId: SESSION_BETA,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      boundAt: clockReading(2),
    };
    expect(outcome).toStrictEqual({
      kind: 'recorded',
      record: beta,
      previous: alpha,
      displaced: [],
      reason: 'bound',
    });
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(beta);
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
    expect(await h.registry.getTabForSession(SESSION_BETA)).toBe(TAB_ONE);
    expect(await h.registry.listBindings()).toStrictEqual([beta]);

    // Announced: the panel is told its new session, listeners see what it replaced.
    expect(bindingPushes(h)).toStrictEqual([
      {
        tabId: TAB_ONE,
        state: { kind: 'bound', sessionId: SESSION_BETA, tabId: TAB_ONE, url: URL_A_OVERVIEW },
      },
    ]);
    expect(h.changes).toMatchObject([
      { kind: 'recorded', tabId: TAB_ONE, previous: alpha, current: beta, reason: 'bound' },
    ]);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: beta });
  });

  it('displaces the other tab when the service binds the session to a new tab', async () => {
    const first = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    resetObservations(h);

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_TWO, SESSION_ALPHA, URL_A_SETTINGS)),
    );

    const second: TabBindingRecord = {
      tabId: TAB_TWO,
      sessionId: SESSION_ALPHA,
      url: URL_A_SETTINGS,
      origin: ORIGIN_A,
      boundAt: clockReading(2),
    };
    expect(outcome).toStrictEqual({
      kind: 'recorded',
      record: second,
      previous: undefined,
      displaced: [first],
      reason: 'bound',
    });
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(await h.registry.getBinding(TAB_TWO)).toStrictEqual(second);
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_TWO);
    expect(await h.registry.listBindings()).toStrictEqual([second]);

    // The displaced tab's panel is told it is unbound, so it never keeps claiming "Connected".
    expect(bindingPushes(h)).toStrictEqual([
      {
        tabId: TAB_TWO,
        state: { kind: 'bound', sessionId: SESSION_ALPHA, tabId: TAB_TWO, url: URL_A_SETTINGS },
      },
      { tabId: TAB_ONE, state: { kind: 'unbound' } },
    ]);
    expect(h.changes).toStrictEqual([
      {
        kind: 'recorded',
        tabId: TAB_TWO,
        previous: undefined,
        current: second,
        state: { kind: 'bound', sessionId: SESSION_ALPHA, tabId: TAB_TWO, url: URL_A_SETTINGS },
        reason: 'bound',
        cause: undefined,
      },
      {
        kind: 'removed',
        tabId: TAB_ONE,
        previous: first,
        current: undefined,
        state: { kind: 'unbound' },
        reason: 'replaced',
        cause: undefined,
      },
    ]);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_TWO)]: second });
  });

  it('drops the binding when the service announces it was replaced, surfacing the reason', async () => {
    const alpha = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    resetObservations(h);

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW, 'replaced')),
    );

    expect(outcome).toStrictEqual({ kind: 'removed', removed: alpha, reason: 'replaced' });
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
    expect(bindingPushes(h)).toStrictEqual([{ tabId: TAB_ONE, state: { kind: 'unbound' } }]);
    expect(h.changes).toMatchObject([
      { kind: 'removed', tabId: TAB_ONE, previous: alpha, current: undefined, reason: 'replaced' },
    ]);
    expect(h.storage.stored()).toBeUndefined();
  });

  it('ignores a late replacement frame about a binding the tab no longer holds', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    const beta = await confirmBinding(h, TAB_ONE, SESSION_BETA, URL_A_OVERVIEW);
    resetObservations(h);

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW, 'replaced')),
    );

    expect(outcome).toStrictEqual({ kind: 'ignored', reason: 'replaced' });
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(beta);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.changes).toStrictEqual([]);
  });

  it('shows the tab as having left when the service announces an origin change', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    resetObservations(h);

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_B_LANDING, 'origin-changed')),
    );

    const left: PanelBindingState = {
      kind: 'tab-left',
      origin: ORIGIN_A,
      sessionId: SESSION_ALPHA,
      reason: 'origin-changed',
    };
    expect(outcome).toMatchObject({ kind: 'removed', reason: 'origin-changed' });
    expect(bindingPushes(h)).toStrictEqual([{ tabId: TAB_ONE, state: left }]);
    expect(await h.registry.getPanelBindingState(TAB_ONE)).toStrictEqual(left);
  });
});

describe('unbind — DevTools closed, tab closed, session ended', () => {
  it.each([...TAB_UNBIND_CAUSES])(
    'the %s path sends session.unbind, clears the record and pushes the unbound state',
    async (cause) => {
      const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
      resetObservations(h);

      const removed = await h.registry.unbind(TAB_ONE, cause);

      expect(removed).toStrictEqual(record);
      expect(sentFrames(h)).toStrictEqual([
        { type: 'session.unbind', payload: { tabId: TAB_ONE } },
      ]);
      expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
      expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
      expect(await h.registry.listBindings()).toStrictEqual([]);
      expect(await h.registry.getPanelBindingState(TAB_ONE)).toStrictEqual({ kind: 'unbound' });
      expect(h.notify.mock.calls).toStrictEqual([[TAB_ONE, bindingPushFrame({ kind: 'unbound' })]]);
      expect(h.changes).toStrictEqual([
        {
          kind: 'removed',
          tabId: TAB_ONE,
          previous: record,
          current: undefined,
          state: { kind: 'unbound' },
          reason: 'unbound',
          cause,
        },
      ]);
      // The last binding gone, the storage entry is removed rather than left empty.
      expect(Object.hasOwn(h.storage.items, BINDING_STORAGE_KEY)).toBe(false);
    },
  );

  it('the tab-removed path unbinds only the closed tab', async () => {
    const tabClosed: TabUnbindCause = 'tab-closed';
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    const other = await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    resetObservations(h);

    await h.registry.unbind(TAB_ONE, tabClosed);

    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(await h.registry.listBindings()).toStrictEqual([other]);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_TWO)]: other });
  });

  it('closing a tab this worker never bound sends nothing', async () => {
    const removed = await h.registry.unbind(TAB_UNKNOWN, 'tab-closed');

    expect(removed).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.changes).toStrictEqual([]);
  });

  it('closing DevTools still reports session.unbind for a binding not yet confirmed here', async () => {
    const removed = await h.registry.unbind(TAB_UNKNOWN, 'devtools-closed');

    expect(removed).toBeUndefined();
    expect(sentFrames(h)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_UNKNOWN } },
    ]);
    expect(h.changes).toStrictEqual([]);
  });

  it('handleSessionEnded clears the tab holding the ended session and leaves the rest', async () => {
    const alpha = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    const beta = await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    resetObservations(h);

    const removed = await h.registry.handleSessionEnded(SESSION_ALPHA);

    expect(removed).toStrictEqual(alpha);
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
    expect(await h.registry.listBindings()).toStrictEqual([beta]);
    expect(h.changes).toMatchObject([
      { kind: 'removed', tabId: TAB_ONE, reason: 'unbound', cause: 'session-ended' },
    ]);
  });

  it('handleSessionEnded for a session no tab holds changes nothing', async () => {
    const alpha = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    resetObservations(h);

    expect(await h.registry.handleSessionEnded(SESSION_UNKNOWN)).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(await h.registry.listBindings()).toStrictEqual([alpha]);
  });
});

describe('capture id bookkeeping', () => {
  it('setCaptureId and clearCaptureId round-trip on the record', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    resetObservations(h);

    expect(await h.registry.setCaptureId(TAB_ONE, CAPTURE_ONE)).toBe(true);
    const capturing: TabBindingRecord = { ...record, captureId: CAPTURE_ONE };
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(capturing);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: capturing });

    expect(await h.registry.clearCaptureId(TAB_ONE)).toBe(true);
    // Cleared means absent, not an `undefined`-valued key.
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(record);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: record });

    // Capture changes reach listeners, but leave the panel's binding state as it was.
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.changes).toMatchObject([
      { kind: 'updated', tabId: TAB_ONE, previous: record, current: capturing },
      { kind: 'updated', tabId: TAB_ONE, previous: capturing, current: record },
    ]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a late clear for an earlier capture keeps the newer one', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.setCaptureId(TAB_ONE, CAPTURE_TWO);

    expect(await h.registry.clearCaptureId(TAB_ONE, CAPTURE_ONE)).toBe(false);
    expect((await h.registry.getBinding(TAB_ONE))?.captureId).toBe(CAPTURE_TWO);

    expect(await h.registry.clearCaptureId(TAB_ONE, CAPTURE_TWO)).toBe(true);
    expect((await h.registry.getBinding(TAB_ONE))?.captureId).toBeUndefined();
  });

  it('a capture cannot be stored on a tab no session holds', async () => {
    expect(await h.registry.setCaptureId(TAB_UNKNOWN, CAPTURE_ONE)).toBe(false);
    expect(await h.registry.clearCaptureId(TAB_UNKNOWN)).toBe(false);
    expect(await h.registry.listBindings()).toStrictEqual([]);
  });

  it('a relayed capture.started lands on the tab bound to its session', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    const started: CaptureStartedPayload = { sessionId: SESSION_ALPHA, captureId: CAPTURE_ONE };
    const unrelated: CaptureStartedPayload = { sessionId: SESSION_UNKNOWN, captureId: CAPTURE_TWO };

    expect(await h.registry.handleCaptureStarted(started)).toBe(TAB_ONE);
    expect(await h.registry.handleCaptureStarted(unrelated)).toBeUndefined();
    expect((await h.registry.getBinding(TAB_ONE))?.captureId).toBe(CAPTURE_ONE);
  });
});

describe('persistence through chrome.storage.session', () => {
  it('writes the binding under BINDING_STORAGE_KEY as a snapshot keyed by tab id', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);

    const expected: TabBindingSnapshot = { [String(TAB_ONE)]: record };
    expect(Object.keys(h.storage.items)).toStrictEqual([BINDING_STORAGE_KEY]);
    expect(h.storage.stored()).toStrictEqual(expected);
  });

  it('survives a simulated worker restart, capture id included', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    expect(await h.registry.setCaptureId(TAB_ONE, CAPTURE_ONE)).toBe(true);
    const before = await h.registry.listBindings();

    const revived = restartWorker(h);
    const reloaded = await revived.registry.reload();

    const first: TabBindingRecord = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      boundAt: clockReading(1),
      captureId: CAPTURE_ONE,
    };
    const second: TabBindingRecord = {
      tabId: TAB_TWO,
      sessionId: SESSION_BETA,
      url: URL_A_SETTINGS,
      origin: ORIGIN_A,
      boundAt: clockReading(2),
    };
    expect(before).toStrictEqual([first, second]);
    expect(reloaded).toStrictEqual([first, second]);
    expect(await revived.registry.getBinding(TAB_ONE)).toStrictEqual(first);
    expect(await revived.registry.getBinding(TAB_TWO)).toStrictEqual(second);
    expect(await revived.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_ONE);
    expect(await revived.registry.getTabForSession(SESSION_BETA)).toBe(TAB_TWO);
    expect(await revived.registry.listBindings()).toStrictEqual([first, second]);
    expect(await revived.registry.getPanelBindingState(TAB_ONE)).toStrictEqual({
      kind: 'bound',
      sessionId: SESSION_ALPHA,
      tabId: TAB_ONE,
      url: URL_A_OVERVIEW,
    });

    // Reviving is silent: nothing is re-requested, re-announced or re-stamped.
    expect(revived.send).not.toHaveBeenCalled();
    expect(revived.notify).not.toHaveBeenCalled();
    expect(revived.changes).toStrictEqual([]);
    expect(revived.now).not.toHaveBeenCalled();
  });

  it('hydrates from storage on the first read, without an explicit reload', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    const readsBeforeRestart = h.storage.reads;

    const revived = restartWorker(h);

    expect(await revived.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_ONE);
    expect(await revived.registry.getBinding(TAB_ONE)).toStrictEqual(record);
    // One read hydrates the new generation's cache; later reads are served from it.
    expect(revived.storage.reads).toBe(readsBeforeRestart + 1);
  });

  it('continues the same capture when the page reloads after the worker was revived', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.setCaptureId(TAB_ONE, CAPTURE_ONE);

    const revived = restartWorker(h);
    const decision = await revived.registry.handleNavigated({
      tabId: TAB_ONE,
      url: URL_A_OVERVIEW,
    });

    expect(decision).toStrictEqual({
      kind: 'kept-same-origin',
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      captureId: CAPTURE_ONE,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      reported: true,
    });
  });

  it('a binding ended in one worker generation stays ended in the next', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.unbind(TAB_ONE, 'devtools-closed');

    const revived = restartWorker(h);

    expect(await revived.registry.reload()).toStrictEqual([]);
    expect(await revived.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
  });

  it('drops malformed stored entries on reload and writes the cleaned map back', async () => {
    const valid: TabBindingRecord = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      boundAt: clockReading(1),
    };
    h.storage.items[BINDING_STORAGE_KEY] = {
      [String(TAB_ONE)]: valid,
      // Keyed by a tab id other than its own.
      [String(TAB_TWO)]: { ...valid, tabId: TAB_UNKNOWN, sessionId: SESSION_BETA },
      // An origin that is not the URL's own.
      [String(TAB_UNKNOWN)]: { ...valid, tabId: TAB_UNKNOWN, origin: ORIGIN_B },
      // Not a record at all.
      '303': 'not-a-binding',
      // An empty capture id.
      '404': { ...valid, tabId: 404, sessionId: SESSION_UNKNOWN, captureId: '' },
    };

    const reloaded = await h.registry.reload();

    expect(reloaded).toStrictEqual([valid]);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: valid });
  });

  it('restores one tab per session when storage names a session twice', async () => {
    const older: TabBindingRecord = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      boundAt: clockReading(1),
    };
    const newer: TabBindingRecord = { ...older, tabId: TAB_TWO, boundAt: clockReading(5) };
    h.storage.items[BINDING_STORAGE_KEY] = {
      [String(TAB_ONE)]: older,
      [String(TAB_TWO)]: newer,
    };

    expect(await h.registry.reload()).toStrictEqual([newer]);
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_TWO);
  });

  it('starts empty when storage cannot be read, and rebuilds from the next confirmation', async () => {
    h.storage.readFailure = new Error('session storage unavailable');

    expect(await h.registry.reload()).toStrictEqual([]);

    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(record);
  });

  it('keeps a confirmed binding in memory when the storage write fails', async () => {
    h.storage.writeFailure = new Error('session storage quota exceeded');

    const outcome = unwrap(
      await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    expect(outcome.kind).toBe('recorded');
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_ONE);
    expect(h.storage.stored()).toBeUndefined();
    expect(h.changes).toMatchObject([{ kind: 'recorded', tabId: TAB_ONE }]);
  });
});

describe('handleNavigated — keep and re-arm, or unbind', () => {
  it('keeps a same-origin binding, its capture included, and answers kept-same-origin', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.setCaptureId(TAB_ONE, CAPTURE_ONE);
    resetObservations(h);

    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_A_SETTINGS });

    const expected: NavigationDecision = {
      kind: 'kept-same-origin',
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      captureId: CAPTURE_ONE,
      url: URL_A_SETTINGS,
      origin: ORIGIN_A,
      reported: true,
    };
    expect(decision).toStrictEqual(expected);

    // The binding is intact: same session, origin, stamp and capture; only the document moved.
    const kept: TabBindingRecord = { ...record, url: URL_A_SETTINGS, captureId: CAPTURE_ONE };
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(kept);
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_ONE);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: kept });

    expect(sentFrames(h)).toStrictEqual([
      { type: 'tab.navigated', payload: { tabId: TAB_ONE, url: URL_A_SETTINGS } },
    ]);
    expect(bindingPushes(h)).toStrictEqual([
      {
        tabId: TAB_ONE,
        state: { kind: 'bound', sessionId: SESSION_ALPHA, tabId: TAB_ONE, url: URL_A_SETTINGS },
      },
    ]);
    expect(h.changes).toMatchObject([
      { kind: 'updated', tabId: TAB_ONE, current: kept, reason: 'navigated', cause: undefined },
    ]);
  });

  it('treats a reload of the same document as same-origin', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);

    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_A_OVERVIEW });

    expect(decision.kind).toBe('kept-same-origin');
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_ONE);
  });

  it('unbinds a cross-origin navigation, sends session.unbind and pushes the tab-left state', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.setCaptureId(TAB_ONE, CAPTURE_ONE);
    resetObservations(h);

    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });

    const expected: NavigationDecision = {
      kind: 'unbound-cross-origin',
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      captureId: CAPTURE_ONE,
      previousOrigin: ORIGIN_A,
      origin: ORIGIN_B,
      notice: formatTabLeftMessage(ORIGIN_A),
      reported: true,
    };
    expect(decision).toStrictEqual(expected);

    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
    expect(Object.hasOwn(h.storage.items, BINDING_STORAGE_KEY)).toBe(false);
    expect(sentFrames(h)).toStrictEqual([
      { type: 'tab.navigated', payload: { tabId: TAB_ONE, url: URL_B_LANDING } },
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
    ]);

    // The panel is pushed the state it renders as "Tab left ‹origin›" — the origin it left.
    const left: PanelBindingState = {
      kind: 'tab-left',
      origin: ORIGIN_A,
      sessionId: SESSION_ALPHA,
      reason: 'origin-changed',
    };
    expect(h.notify.mock.calls).toStrictEqual([[TAB_ONE, bindingPushFrame(left)]]);
    const pushed = required(bindingPushes(h).at(0), 'the pushed binding state').state;
    expect(isPanelBindingState(pushed)).toBe(true);
    if (pushed.kind !== 'tab-left') {
      throw new Error(`Expected a tab-left state, got '${pushed.kind}'`);
    }
    if (decision.kind !== 'unbound-cross-origin') {
      throw new Error(`Expected an unbound-cross-origin decision, got '${decision.kind}'`);
    }
    // The panel's text and the decision's notice are one sentence, from one formatter.
    expect(formatTabLeftMessage(pushed.origin)).toBe(formatTabLeftMessage(ORIGIN_A));
    expect(formatTabLeftMessage(pushed.origin)).toBe(decision.notice);

    // A panel reopened on the tab is told it left, not merely that it is unbound.
    expect(await h.registry.getPanelBindingState(TAB_ONE)).toStrictEqual(left);
    expect(h.changes).toStrictEqual([
      {
        kind: 'removed',
        tabId: TAB_ONE,
        previous: { ...record, captureId: CAPTURE_ONE },
        current: undefined,
        state: left,
        reason: 'origin-changed',
        cause: undefined,
      },
    ]);
  });

  it('unbinds a navigation to a document with no HTTP(S) origin', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);

    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: 'about:blank' });

    expect(decision).toStrictEqual({
      kind: 'unbound-cross-origin',
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      captureId: undefined,
      previousOrigin: ORIGIN_A,
      origin: undefined,
      notice: formatTabLeftMessage(ORIGIN_A),
      reported: true,
    });
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
  });

  it('reports the navigation of an unbound tab and changes nothing else', async () => {
    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });

    expect(decision).toStrictEqual({ kind: 'not-bound', tabId: TAB_ONE, reported: true });
    expect(sentFrames(h)).toStrictEqual([
      { type: 'tab.navigated', payload: { tabId: TAB_ONE, url: URL_B_LANDING } },
    ]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.changes).toStrictEqual([]);
  });

  it('says so in the decision when the transport refused the tab.navigated frame', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValueOnce({
      ok: false,
      error: workerError('TRANSPORT_DISCONNECTED', 'The test transport is closed.'),
    });

    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_A_SETTINGS });

    expect(decision).toMatchObject({ kind: 'kept-same-origin', reported: false });
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_ONE);
  });

  it('counts a frame queued while reconnecting as reported', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValueOnce(QUEUED);

    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });

    expect(decision).toMatchObject({ kind: 'unbound-cross-origin', reported: true });
  });

  it('serializes operations issued back to back, so none sees a stale binding', async () => {
    const binding = h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW));
    const leaving = h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });
    const rebinding = h.registry.applyBound(bound(TAB_ONE, SESSION_BETA, URL_B_LANDING));

    const [bindResult, decision, rebindResult] = await Promise.all([binding, leaving, rebinding]);

    expect(unwrap(bindResult).kind).toBe('recorded');
    expect(decision).toMatchObject({ kind: 'unbound-cross-origin', sessionId: SESSION_ALPHA });
    expect(unwrap(rebindResult)).toMatchObject({ kind: 'recorded', previous: undefined });
    expect(sentFrames(h).map((frame) => frame.type)).toStrictEqual([
      'tab.navigated',
      'session.unbind',
    ]);
    expect(await h.registry.listBindings()).toMatchObject([
      { tabId: TAB_ONE, sessionId: SESSION_BETA, origin: ORIGIN_B },
    ]);
  });
});

describe('onChange — listeners observe bind, replace and unbind', () => {
  it('fires on each change in order, and stops after unsubscribe', async () => {
    const seen: TabBindingChange[] = [];
    const unsubscribe = h.registry.onChange((change) => {
      seen.push(change);
    });

    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await confirmBinding(h, TAB_TWO, SESSION_ALPHA, URL_A_SETTINGS);
    await h.registry.unbind(TAB_TWO, 'tab-closed');

    expect(
      seen.map(({ kind, tabId, reason, cause }) => ({ kind, tabId, reason, cause })),
    ).toStrictEqual([
      { kind: 'recorded', tabId: TAB_ONE, reason: 'bound', cause: undefined },
      { kind: 'recorded', tabId: TAB_TWO, reason: 'bound', cause: undefined },
      { kind: 'removed', tabId: TAB_ONE, reason: 'replaced', cause: undefined },
      { kind: 'removed', tabId: TAB_TWO, reason: 'unbound', cause: 'tab-closed' },
    ]);

    unsubscribe();
    unsubscribe();
    await confirmBinding(h, TAB_ONE, SESSION_BETA, URL_A_OVERVIEW);

    expect(seen).toHaveLength(4);
    // The harness's own listener is still subscribed and saw the later change.
    expect(h.changes).toHaveLength(5);
  });

  it('a listener that throws does not stop the others or the operation', async () => {
    const after: TabBindingChange[] = [];
    h.registry.onChange(() => {
      throw new Error('listener failure');
    });
    h.registry.onChange((change) => {
      after.push(change);
    });

    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);

    expect(after).toMatchObject([{ kind: 'recorded', current: record }]);
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(record);
  });

  it('a panel sink that throws does not stop listeners or the write-through', async () => {
    h.notify.mockImplementation(() => {
      throw new Error('panel port gone');
    });

    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);

    expect(h.changes).toMatchObject([{ kind: 'recorded', current: record }]);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: record });
  });
});

describe('privacy', () => {
  it('never writes a document URL into a log line', async () => {
    await h.registry.requestBind({ tabId: TAB_ONE, url: URL_A_OVERVIEW, origin: ORIGIN_A });
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_A_SETTINGS });
    await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });
    await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_A_OVERVIEW });

    expect(h.logger.entries.length).toBeGreaterThan(0);
    for (const entry of h.logger.entries) {
      expect(JSON.stringify(entry)).not.toContain(PATH_SEGMENT);
    }
  });
});
