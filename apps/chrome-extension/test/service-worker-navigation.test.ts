/**
 * Unit spec for `../src/background/service-worker.ts` — how the worker turns
 * `chrome.tabs.onUpdated` events into committed navigations.
 *
 * Every committed navigation of a bound tab becomes one `tab.navigated`, and
 * during a capture the service turns a same-origin one into one "Page reloaded
 * during capture" progress row and panel notice (AAP §0.5.5). So the worker
 * must report each committed load exactly once. `tabs.onUpdated` is the only
 * signal it has (the manifest holds `tabs`, not `webNavigation`), and Chrome
 * reports a URL-changing load either as one `{ status: 'loading', url }` event
 * or split in two: `{ status: 'loading' }` when the load starts — `tab.url`
 * still the old committed URL, `tab.pendingUrl` the destination — then
 * `{ url }` at commit. The split order must yield one report, with the
 * committed URL, and never one carrying the stale old URL.
 *
 * Two layers are held:
 *
 * - **The decision.** `nextCommittedNavigation` is pure, so every event order
 *   is replayed against it directly: split and combined loads, same-URL
 *   reloads, aborted and redirected navigations, history-API changes, a
 *   reload after one, repeated events, and a revived worker with no memo.
 * - **The wiring.** The real `createWorker` is driven with recording fakes of
 *   every Chrome surface it is handed, over a `chrome.storage.session` that
 *   already holds a binding. What the worker does with a committed navigation
 *   of a bound tab is observed at the tab registry, which reports it as
 *   `tab.navigated` and announces the binding change: one announced change
 *   and one "Committed navigation" log line per `registry.handleNavigated`.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). Importing the module evaluates its
 * bootstrap, which composes a worker only inside an extension service worker;
 * no `chrome` global exists here, so the import is inert — the first case
 * proves it. No credential is stored, so the worker never opens a socket (the
 * socket constructor records zero constructions) and no timer ever fires.
 * Every origin, path, tab, session and capture id is invented for this spec
 * (AAP §0.5.4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WebSocketConstructorLike, WebSocketLike } from '@debuggen/protocol';
import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import type {
  TabBindingRecord,
  WorkerAlarmSchedule,
  WorkerTimerApi,
} from '../src/background/messages';
import {
  createWorker,
  nextCommittedNavigation,
  serviceWorker,
} from '../src/background/service-worker';
import type {
  DebugGeneratorWorker,
  NavigationMemo,
  WorkerEnvironment,
  WorkerEvent,
  WorkerTab,
  WorkerTabChange,
} from '../src/background/service-worker';
import { BINDING_STORAGE_KEY } from '../src/background/tab-registry';
import type { NavigationDecisionKind, TabBindingChange } from '../src/background/tab-registry';

/*
 * ===========================================================================
 * Fixture values — neutral, and obviously synthetic
 * ===========================================================================
 */

/** A Chrome tab id, as a binding record types it. */
type TabId = TabBindingRecord['tabId'];

/** The origin of an invented local dev server the tab is bound on. */
const ORIGIN = 'http://localhost:4400';

/** A second origin, differing from {@link ORIGIN} by its port alone. */
const OTHER_ORIGIN = 'http://localhost:4401';

const URL_OVERVIEW = `${ORIGIN}/workspace/overview`;
const URL_SETTINGS = `${ORIGIN}/workspace/settings`;
const URL_ARCHIVE = `${ORIGIN}/workspace/archive`;
const URL_ELSEWHERE = `${OTHER_ORIGIN}/workspace/landing`;

const TAB_BOUND: TabId = 101;
const TAB_UNBOUND: TabId = 202;

const SESSION = 'session-test-alpha';
const CAPTURE = 'capture-test-0001';

/** When the stored binding was recorded (2026-01-01T00:00:00Z). */
const BOUND_AT_MS = 1_767_225_600_000;

/** The extension id the fake runtime reports. */
const EXTENSION_ID = 'extension-test-id';

/** The message of the worker's log line for each navigation it hands the registry. */
const COMMITTED_NAVIGATION_LOG = 'Committed navigation of a bound tab.';

/** A tab whose page at {@link URL_OVERVIEW} has finished loading. */
const LOADED: NavigationMemo = Object.freeze({ url: URL_OVERVIEW, status: 'complete' });

/*
 * ===========================================================================
 * Chrome's events, as `tabs.onUpdated` delivers them
 * ===========================================================================
 */

/** One `tabs.onUpdated` event: its change info and the tab it reports. */
interface TabEvent {
  readonly change: WorkerTabChange;
  readonly tab: WorkerTab;
}

/**
 * A load starting while `committed` is still the tab's URL: bound for
 * `pending` when one is given (Chrome also names the same URL on a reload),
 * with no pending URL otherwise.
 */
function loadingStarted(committed: string, pending?: string): TabEvent {
  return {
    change: { status: 'loading' },
    tab: pending === undefined ? { url: committed } : { url: committed, pendingUrl: pending },
  };
}

/** A load's commit reported alone: the URL changed, the status did not. */
function urlCommitted(url: string): TabEvent {
  return { change: { url }, tab: { url } };
}

/** A load reported as one event: it entered `loading` and committed `url`. */
function loadingCommitted(url: string): TabEvent {
  return { change: { status: 'loading', url }, tab: { url } };
}

/** A load finishing on `url`. */
function loadCompleted(url: string): TabEvent {
  return { change: { status: 'complete' }, tab: { url } };
}

/** What a replayed sequence of events reported, and the memo it left. */
interface Replay {
  readonly reported: readonly string[];
  readonly memo: NavigationMemo | undefined;
}

/** Feed `events` through {@link nextCommittedNavigation}, threading the memo. */
function replay(events: readonly TabEvent[], initial: NavigationMemo | undefined = LOADED): Replay {
  let memo = initial;
  const reported: string[] = [];
  for (const { change, tab } of events) {
    const step = nextCommittedNavigation(memo, change, tab);
    memo = step.memo;
    if (step.url !== undefined) {
      reported.push(step.url);
    }
  }
  return { reported, memo };
}

/*
 * ===========================================================================
 * Fakes — every Chrome surface `createWorker` is handed
 * ===========================================================================
 */

/** A Chrome event whose listeners the spec can invoke. */
interface FakeEvent<Args extends unknown[]> extends WorkerEvent<(...args: Args) => void> {
  /** Deliver one event to every listener, synchronously, as Chrome dispatches. */
  emit(...args: Args): void;
}

function createEvent<Args extends unknown[]>(): FakeEvent<Args> {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    emit: (...args) => {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
  };
}

/** A JSON round trip: what `chrome.storage` does to every value it keeps. */
function jsonClone(value: unknown): unknown {
  const text = JSON.stringify(value) as string | undefined;
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/** A `chrome.storage` area over a plain backing record, JSON-cloning in and out. */
class FakeStorageArea {
  readonly items: Record<string, unknown>;

  constructor(initial: Record<string, unknown> = {}) {
    this.items = jsonClone(initial) as Record<string, unknown>;
  }

  get(keys: string): Promise<Record<string, unknown>> {
    return Promise.resolve(
      Object.hasOwn(this.items, keys) ? { [keys]: jsonClone(this.items[keys]) } : {},
    );
  }

  set(items: Readonly<Record<string, unknown>>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.items[key] = jsonClone(value);
    }
    return Promise.resolve();
  }

  remove(keys: string): Promise<void> {
    delete this.items[keys];
    return Promise.resolve();
  }
}

/** One recorded log call. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A silent logger that remembers every call, its children's included. */
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

/** `WebSocket.CLOSED`: the state of a socket that is never opened. */
const SOCKET_CLOSED_STATE = 3;

/**
 * A socket constructor that records every construction and every call on the
 * socket it builds. With no credential stored the worker must never construct
 * one, so both lists stay empty.
 */
function createSocketRecorder(): {
  readonly ctor: WebSocketConstructorLike;
  readonly calls: string[];
} {
  const calls: string[] = [];
  class RecordingSocket implements WebSocketLike {
    readonly readyState = SOCKET_CLOSED_STATE;

    constructor(url: string) {
      calls.push(`construct ${url}`);
    }

    addEventListener(type: string): void {
      calls.push(`addEventListener ${type}`);
    }

    removeEventListener(type: string): void {
      calls.push(`removeEventListener ${type}`);
    }

    send(): void {
      calls.push('send');
    }

    close(): void {
      calls.push('close');
    }
  }
  return { ctor: RecordingSocket, calls };
}

/*
 * ===========================================================================
 * Harness — one composed worker over a stored binding
 * ===========================================================================
 */

/** One composed worker and what the spec observes of it. */
interface Harness {
  readonly worker: DebugGeneratorWorker;
  /** `chrome.tabs.onUpdated`, for dispatching tab events. */
  readonly onUpdated: FakeEvent<[TabId, WorkerTabChange, WorkerTab]>;
  /** Every binding change the registry announced after start-up, in order. */
  readonly changes: TabBindingChange[];
  readonly logger: RecordingLogger;
  /** Every construction of, and call on, a socket. */
  readonly socketCalls: readonly string[];
}

/** Workers composed by the current case, disposed after it. */
const workers: DebugGeneratorWorker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

/**
 * Compose a worker over a `chrome.storage.session` that already holds
 * `binding` — what a revived worker finds — and wait for its cold start.
 */
async function startWorker(binding: TabBindingRecord): Promise<Harness> {
  const onUpdated = createEvent<[TabId, WorkerTabChange, WorkerTab]>();
  const logger = createRecordingLogger();
  const sockets = createSocketRecorder();
  // No case depends on a timer firing, so none ever does: a scheduled handler
  // is held until it is cancelled or the case ends.
  const scheduledTimers = new Map<number, () => void>();
  let nextTimer = 0;
  const timers: WorkerTimerApi = {
    setTimeout: (handler) => {
      nextTimer += 1;
      scheduledTimers.set(nextTimer, handler);
      return nextTimer;
    },
    clearTimeout: (handle) => {
      scheduledTimers.delete(handle);
    },
  };
  const env: WorkerEnvironment = {
    runtime: {
      id: EXTENSION_ID,
      onConnect: createEvent<[chrome.runtime.Port]>(),
      onInstalled: createEvent<[{ readonly reason: string }]>(),
      onStartup: createEvent<[]>(),
    },
    tabs: {
      reload: vi.fn<(tabId: TabId) => Promise<void>>(() => Promise.resolve()),
      get: vi.fn<(tabId: TabId) => Promise<WorkerTab>>(() => Promise.resolve({})),
      onUpdated,
      onRemoved: createEvent<[TabId]>(),
    },
    alarms: {
      create: vi.fn<(name: string, schedule: WorkerAlarmSchedule) => Promise<void>>(() =>
        Promise.resolve(),
      ),
      clear: vi.fn<(name: string) => Promise<boolean>>(() => Promise.resolve(false)),
      onAlarm: createEvent<[{ readonly name: string }]>(),
    },
    storage: {
      local: new FakeStorageArea(),
      session: new FakeStorageArea({
        [BINDING_STORAGE_KEY]: { [String(binding.tabId)]: binding },
      }),
    },
    webSocketConstructor: sockets.ctor,
    timers,
    logger,
    random: () => 0.5,
  };
  const worker = createWorker(env);
  workers.push(worker);
  await worker.ready;
  const changes: TabBindingChange[] = [];
  worker.registry.onChange((change) => {
    changes.push(change);
  });
  return { worker, onUpdated, changes, logger, socketCalls: sockets.calls };
}

/**
 * Let every promise chain the dispatched events started run to completion.
 * The fakes answer with already-settled promises and no timer fires, so the
 * work is microtasks only and one macrotask turn drains it; three leave margin.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** Dispatch `events` for `tabId`, then wait for the worker to finish with them. */
async function dispatch(
  harness: Harness,
  tabId: TabId,
  events: readonly TabEvent[],
): Promise<void> {
  for (const { change, tab } of events) {
    harness.onUpdated.emit(tabId, change, tab);
  }
  await settle();
}

/** The decision of every navigation the worker handed the registry, in order. */
function committedNavigations(harness: Harness): (NavigationDecisionKind | undefined)[] {
  return harness.logger.entries
    .filter((entry) => entry.message === COMMITTED_NAVIGATION_LOG)
    .map((entry) => {
      const decision = entry.fields?.['decision'];
      return typeof decision === 'string' ? (decision as NavigationDecisionKind) : undefined;
    });
}

/** The URL of every same-origin navigation the registry recorded, in order. */
function navigatedUrls(harness: Harness): string[] {
  return harness.changes
    .filter((change) => change.reason === 'navigated')
    .map((change) => change.current?.url ?? '');
}

/** The binding the spec starts from: {@link TAB_BOUND} on {@link URL_OVERVIEW}, capturing. */
const CAPTURING_BINDING: TabBindingRecord = Object.freeze({
  tabId: TAB_BOUND,
  sessionId: SESSION,
  url: URL_OVERVIEW,
  origin: ORIGIN,
  boundAt: BOUND_AT_MS,
  captureId: CAPTURE,
});

/*
 * ===========================================================================
 * Module evaluation
 * ===========================================================================
 */

describe('service-worker module evaluation', () => {
  it('composes no worker where no chrome global exists', () => {
    expect('chrome' in globalThis).toBe(false);
    expect(serviceWorker).toBeUndefined();
  });
});

/*
 * ===========================================================================
 * The decision
 * ===========================================================================
 */

describe('nextCommittedNavigation', () => {
  it('reports a load Chrome splits into loading and url events once, with the committed URL', () => {
    const result = replay([
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      urlCommitted(URL_SETTINGS),
      loadCompleted(URL_SETTINGS),
    ]);

    expect(result.reported).toEqual([URL_SETTINGS]);
    expect(result.memo).toEqual({ url: URL_SETTINGS, status: 'complete' });
  });

  it('reports nothing for the loading entry of a load bound for another URL, keeping the committed URL', () => {
    const { change, tab } = loadingStarted(URL_OVERVIEW, URL_SETTINGS);

    const step = nextCommittedNavigation(LOADED, change, tab);

    expect(step.url).toBeUndefined();
    expect(step.memo).toEqual({ url: URL_OVERVIEW, status: 'loading' });
  });

  it('reports a load whose url arrives with its loading entry once', () => {
    const result = replay([loadingCommitted(URL_SETTINGS), loadCompleted(URL_SETTINGS)]);

    expect(result.reported).toEqual([URL_SETTINGS]);
    expect(result.memo).toEqual({ url: URL_SETTINGS, status: 'complete' });
  });

  it.each([
    ['names the same URL', URL_OVERVIEW],
    ['is absent', undefined],
  ])(
    'reports a same-URL reload whose pending URL %s once, with the committed URL',
    (_, pending) => {
      const result = replay([loadingStarted(URL_OVERVIEW, pending), loadCompleted(URL_OVERVIEW)]);

      expect(result.reported).toEqual([URL_OVERVIEW]);
      expect(result.memo).toEqual({ url: URL_OVERVIEW, status: 'complete' });
    },
  );

  it('reports nothing for a pending navigation that never commits, and still reports a later reload', () => {
    const aborted = replay([
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      loadCompleted(URL_OVERVIEW),
    ]);

    expect(aborted.reported).toEqual([]);
    expect(aborted.memo).toEqual({ url: URL_OVERVIEW, status: 'complete' });

    const reloaded = replay(
      [loadingStarted(URL_OVERVIEW), loadCompleted(URL_OVERVIEW)],
      aborted.memo,
    );

    expect(reloaded.reported).toEqual([URL_OVERVIEW]);
  });

  it('reports a history-API URL change once', () => {
    const result = replay([urlCommitted(URL_SETTINGS)]);

    expect(result.reported).toEqual([URL_SETTINGS]);
    expect(result.memo).toEqual({ url: URL_SETTINGS, status: 'complete' });
  });

  it.each([
    ['names the same URL', URL_SETTINGS],
    ['is absent', undefined],
  ])('reports a reload after a history-API URL change whose pending URL %s', (_, pending) => {
    const result = replay([
      urlCommitted(URL_SETTINGS),
      loadingStarted(URL_SETTINGS, pending),
      loadCompleted(URL_SETTINGS),
    ]);

    expect(result.reported).toEqual([URL_SETTINGS, URL_SETTINGS]);
  });

  it('adds no report for repeated events of one split load', () => {
    const result = replay([
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      urlCommitted(URL_SETTINGS),
      urlCommitted(URL_SETTINGS),
      loadCompleted(URL_SETTINGS),
      loadCompleted(URL_SETTINGS),
    ]);

    expect(result.reported).toEqual([URL_SETTINGS]);
  });

  it('adds no report for repeated events of one reload or one combined load', () => {
    expect(
      replay([
        loadingStarted(URL_OVERVIEW),
        loadingStarted(URL_OVERVIEW, URL_OVERVIEW),
        loadCompleted(URL_OVERVIEW),
        loadCompleted(URL_OVERVIEW),
      ]).reported,
    ).toEqual([URL_OVERVIEW]);

    expect(
      replay([
        loadingCommitted(URL_SETTINGS),
        loadingCommitted(URL_SETTINGS),
        loadCompleted(URL_SETTINGS),
      ]).reported,
    ).toEqual([URL_SETTINGS]);
  });

  it('reports a redirected load once, with the URL it committed', () => {
    const result = replay([
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      urlCommitted(URL_ARCHIVE),
      loadCompleted(URL_ARCHIVE),
    ]);

    expect(result.reported).toEqual([URL_ARCHIVE]);
  });

  it('reports each of several consecutive loads once, whatever order Chrome reports each in', () => {
    const result = replay([
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      urlCommitted(URL_SETTINGS),
      loadCompleted(URL_SETTINGS),
      loadingCommitted(URL_ARCHIVE),
      loadCompleted(URL_ARCHIVE),
      loadingStarted(URL_ARCHIVE, URL_ARCHIVE),
      loadCompleted(URL_ARCHIVE),
    ]);

    expect(result.reported).toEqual([URL_SETTINGS, URL_ARCHIVE, URL_ARCHIVE]);
  });

  it('answers the same for a tab it holds no memo of, as after a worker revival', () => {
    expect(
      replay([loadingStarted(URL_OVERVIEW, URL_SETTINGS), urlCommitted(URL_SETTINGS)], undefined)
        .reported,
    ).toEqual([URL_SETTINGS]);

    expect(replay([loadingStarted(URL_OVERVIEW)], undefined).reported).toEqual([URL_OVERVIEW]);
  });

  it('falls back to the remembered URL when the event carries no committed URL', () => {
    expect(nextCommittedNavigation(LOADED, { status: 'loading' }, {}).url).toBe(URL_OVERVIEW);
    expect(
      nextCommittedNavigation(LOADED, { status: 'loading' }, { pendingUrl: URL_SETTINGS }).url,
    ).toBeUndefined();
    expect(
      nextCommittedNavigation(LOADED, { status: 'loading' }, { pendingUrl: URL_OVERVIEW }).url,
    ).toBe(URL_OVERVIEW);
  });

  it('reports nothing, and keeps the memo, for an event that neither changes the URL nor starts a load', () => {
    const titleOnly = nextCommittedNavigation(LOADED, {}, { url: URL_OVERVIEW });
    const completed = nextCommittedNavigation(
      LOADED,
      { status: 'complete' },
      { url: URL_OVERVIEW },
    );

    expect(titleOnly).toEqual({ memo: LOADED, url: undefined });
    expect(completed).toEqual({ memo: LOADED, url: undefined });
  });
});

/*
 * ===========================================================================
 * The wiring — createWorker driven through chrome.tabs.onUpdated
 * ===========================================================================
 */

describe('createWorker: one tab.navigated per committed load of a bound tab', () => {
  it('hands the registry one navigation, with the committed URL, for a split same-origin load during a capture', async () => {
    const harness = await startWorker(CAPTURING_BINDING);

    await dispatch(harness, TAB_BOUND, [
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      urlCommitted(URL_SETTINGS),
      loadCompleted(URL_SETTINGS),
    ]);

    expect(committedNavigations(harness)).toEqual(['kept-same-origin']);
    expect(navigatedUrls(harness)).toEqual([URL_SETTINGS]);
    const binding = await harness.worker.registry.getBinding(TAB_BOUND);
    expect(binding?.url).toBe(URL_SETTINGS);
    expect(binding?.captureId).toBe(CAPTURE);
    expect(harness.socketCalls).toEqual([]);
  });

  it('hands the registry one navigation for a reload during a capture', async () => {
    const harness = await startWorker(CAPTURING_BINDING);

    await dispatch(harness, TAB_BOUND, [
      loadingStarted(URL_OVERVIEW, URL_OVERVIEW),
      loadCompleted(URL_OVERVIEW),
    ]);

    expect(committedNavigations(harness)).toEqual(['kept-same-origin']);
    expect(navigatedUrls(harness)).toEqual([URL_OVERVIEW]);
    expect((await harness.worker.registry.getBinding(TAB_BOUND))?.captureId).toBe(CAPTURE);
  });

  it('hands the registry nothing for a pending navigation that never commits', async () => {
    const harness = await startWorker(CAPTURING_BINDING);

    await dispatch(harness, TAB_BOUND, [
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      loadCompleted(URL_OVERVIEW),
    ]);

    expect(committedNavigations(harness)).toEqual([]);
    expect(harness.changes).toEqual([]);
    expect((await harness.worker.registry.getBinding(TAB_BOUND))?.url).toBe(URL_OVERVIEW);
  });

  it('hands the registry both a history-API change and the reload after it', async () => {
    const harness = await startWorker(CAPTURING_BINDING);

    await dispatch(harness, TAB_BOUND, [
      urlCommitted(URL_SETTINGS),
      loadingStarted(URL_SETTINGS, URL_SETTINGS),
      loadCompleted(URL_SETTINGS),
    ]);

    expect(committedNavigations(harness)).toEqual(['kept-same-origin', 'kept-same-origin']);
    expect(navigatedUrls(harness)).toEqual([URL_SETTINGS, URL_SETTINGS]);
  });

  it('adds no navigation for repeated events of one load', async () => {
    const harness = await startWorker(CAPTURING_BINDING);

    await dispatch(harness, TAB_BOUND, [
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      urlCommitted(URL_SETTINGS),
      urlCommitted(URL_SETTINGS),
      loadCompleted(URL_SETTINGS),
    ]);

    expect(committedNavigations(harness)).toEqual(['kept-same-origin']);
    expect(navigatedUrls(harness)).toEqual([URL_SETTINGS]);
  });

  it('unbinds once, without first re-arming at the stale URL, for a split load to another origin', async () => {
    const harness = await startWorker(CAPTURING_BINDING);

    await dispatch(harness, TAB_BOUND, [
      loadingStarted(URL_OVERVIEW, URL_ELSEWHERE),
      urlCommitted(URL_ELSEWHERE),
      loadCompleted(URL_ELSEWHERE),
    ]);

    expect(committedNavigations(harness)).toEqual(['unbound-cross-origin']);
    expect(navigatedUrls(harness)).toEqual([]);
    expect(harness.changes.map((change) => [change.kind, change.reason])).toEqual([
      ['removed', 'origin-changed'],
    ]);
    expect(await harness.worker.registry.getBinding(TAB_BOUND)).toBeUndefined();
  });

  it('hands the registry nothing for a tab that is not bound', async () => {
    const harness = await startWorker(CAPTURING_BINDING);

    await dispatch(harness, TAB_UNBOUND, [
      loadingStarted(URL_OVERVIEW, URL_SETTINGS),
      urlCommitted(URL_SETTINGS),
      loadCompleted(URL_SETTINGS),
      loadingStarted(URL_SETTINGS),
    ]);

    expect(committedNavigations(harness)).toEqual([]);
    expect(harness.changes).toEqual([]);
  });
});
