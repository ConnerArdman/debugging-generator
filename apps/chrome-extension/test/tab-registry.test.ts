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
 *   A navigation to a URL the service cannot accept is handed over as the tab
 *   id alone and unbinds a bound tab with `session.unbind` only — never a
 *   `tab.navigated`, so the URL never leaves the worker.
 * - **Unbinding.** DevTools closing, the tab closing and the session ending
 *   all send `session.unbind` and clear the record.
 * - **Unbind tombstones.** Every unbind is written ahead to its own storage key
 *   before the frame is reported, survives a worker restart, and is re-sent
 *   by `flushPendingUnbinds` until the service acknowledges it, a bind of the
 *   tab the service *confirms* supersedes it, it exhausts its delivery count
 *   (one count per connection), or — once delivered — its age limit.
 *   `requestBind` sends the owed unbind ahead of the bind and holds the
 *   tombstone back from this generation's flushes, never retiring it; a bind
 *   lost, refused or rejected leaves it owed. A tombstone key that cannot be
 *   read is retried and merged, never overwritten; a failed tombstone write is
 *   retried until it lands. Malformed stored tombstones are dropped, never
 *   cast.
 * - **Persistence through worker suspension.** A Manifest V3 service worker is
 *   evicted after about thirty seconds idle, so the bindings live in
 *   `chrome.storage.session`. The restart cases discard the registry, build a
 *   fresh one over the *same* storage record and prove the bindings — capture
 *   ids included — come back. Without that, suspension silently drops the
 *   session.
 * - **Worker wiring.** The last cases compose the real `createWorker` over
 *   in-memory fakes and prove `service-worker.ts` drives those paths: a bound
 *   tab committing any document off the app — including one whose URL has no
 *   reportable form — is unbound, and the tombstones an earlier worker left are
 *   re-sent as soon as the socket opens.
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

import type { WebSocketConstructorLike, WebSocketLike, WsEventMapLike } from '@debuggen/protocol';
import { noopLogger } from '@debuggen/shared';

import { DEVTOOLS_TOKEN_STORAGE_KEY, STORED_CREDENTIAL_VERSION } from '../src/background/auth';
import { workerError } from '../src/background/messages';
import type {
  PortPushSink,
  ProtocolSend,
  TabBindingRecord,
  TabBindingSnapshot,
  WorkerTimerApi,
} from '../src/background/messages';
import { createWorker } from '../src/background/service-worker';
import type {
  DebugGeneratorWorker,
  WorkerEnvironment,
  WorkerEvent,
  WorkerTab,
  WorkerTabChange,
} from '../src/background/service-worker';
import {
  BINDING_STORAGE_KEY,
  MAX_STORED_TAB_BINDINGS,
  MAX_STORED_UNBIND_TOMBSTONES,
  MAX_UNBIND_TOMBSTONE_DELIVERIES,
  TAB_UNBIND_CAUSES,
  UNBIND_TOMBSTONE_STORAGE_KEY,
  UNBIND_TOMBSTONE_TTL_MS,
  createTabRegistry,
} from '../src/background/tab-registry';
import type {
  NavigationDecision,
  TabBindingChange,
  TabRegistry,
  TabRegistryDeps,
  TabRegistryStorageArea,
  TabUnbindCause,
  TabUnbindTombstone,
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

/** The transport's answer when it refused a frame (the socket is closed). */
function refusedSend(): SendResult {
  return {
    ok: false,
    error: workerError('TRANSPORT_DISCONNECTED', 'The test transport is closed.'),
  };
}

/** The instant the clock reports on its `reading`-th call (1-based). */
function clockReading(reading: number): number {
  return CLOCK_START_MS + reading * CLOCK_STEP_MS;
}

/*
 * The protocol's bounds on the fields a stored binding and tombstone carry: a
 * URL of at most 2,048 characters and an id of at most 64 — the limits of the
 * `@debuggen/protocol` binding and capture payload schemas the registry
 * validates hydrated entries with. Restated here only to build values on
 * either side of them.
 */
const PROTOCOL_MAX_URL_LENGTH = 2_048;
const PROTOCOL_MAX_ID_LENGTH = 64;

/** A URL on {@link ORIGIN_A}, under {@link PATH_SEGMENT}, exactly `length` characters long. */
function urlOfLength(length: number): string {
  const prefix = `${ORIGIN_A}${PATH_SEGMENT}`;
  return `${prefix}${'x'.repeat(length - prefix.length)}`;
}

/** A synthetic id starting with `prefix`, exactly `length` characters long. */
function idOfLength(prefix: string, length: number): string {
  return `${prefix}${'x'.repeat(length - prefix.length)}`;
}

/** The tab id the bulk fixtures that fill the registry to its limits count up from. */
const BULK_TAB_BASE = 10_000;

/** The session id of the `index`-th (1-based) bulk fixture. */
function bulkSessionId(index: number): string {
  return `session-test-bulk-${String(index)}`;
}

/**
 * The `index`-th (1-based) bulk binding: its own tab and session, bound at the
 * clock's `boundAtReading`-th reading (by default its index, so a higher
 * index is a more recent binding).
 */
function bulkRecord(index: number, boundAtReading = index): TabBindingRecord {
  return {
    tabId: BULK_TAB_BASE + index,
    sessionId: bulkSessionId(index),
    url: URL_A_OVERVIEW,
    origin: ORIGIN_A,
    boundAt: clockReading(boundAtReading),
  };
}

/**
 * The `index`-th (1-based) bulk tombstone: the unbind of its own tab, decided
 * at the clock's `createdAtReading`-th reading (by default its index) and
 * handed to an open socket `deliveries` times (by default none — still owed).
 */
function bulkTombstone(
  index: number,
  createdAtReading = index,
  deliveries = 0,
): TabUnbindTombstone {
  return {
    tabId: BULK_TAB_BASE + index,
    sessionId: bulkSessionId(index),
    cause: 'tab-closed',
    createdAt: clockReading(createdAtReading),
    deliveries,
  };
}

/** The tab ids of `entries`, in their order. */
function tabIdsOf(entries: readonly { readonly tabId: TabId }[]): TabId[] {
  return entries.map((entry) => entry.tabId);
}

/** `count` items built by `build` from the 1-based indexes `1..count`. */
function buildMany<T>(count: number, build: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, offset) => build(offset + 1));
}

/** The stored form of `records`: a snapshot keyed by decimal tab id, as the registry writes it. */
function snapshotOf(records: readonly TabBindingRecord[]): TabBindingSnapshot {
  return Object.fromEntries(records.map((record) => [String(record.tabId), record]));
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
  /** Per-key read failures: a `get` of a key listed here rejects with its error. */
  readonly keyReadFailures = new Map<string, Error>();
  /** Per-key write failures: a `set` or `remove` touching a key listed here rejects. */
  readonly keyWriteFailures = new Map<string, Error>();

  get(keys: string): Promise<Record<string, unknown>> {
    this.reads += 1;
    const failure = this.readFailure ?? this.keyReadFailures.get(keys);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    return Promise.resolve(
      Object.hasOwn(this.items, keys) ? { [keys]: jsonClone(this.items[keys]) } : {},
    );
  }

  set(items: Record<string, unknown>): Promise<void> {
    this.writes += 1;
    const failure =
      this.writeFailure ??
      Object.keys(items)
        .map((key) => this.keyWriteFailures.get(key))
        .find((error) => error !== undefined);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    for (const [key, value] of Object.entries(items)) {
      this.items[key] = jsonClone(value);
    }
    return Promise.resolve();
  }

  remove(keys: string): Promise<void> {
    this.writes += 1;
    const failure = this.writeFailure ?? this.keyWriteFailures.get(keys);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    delete this.items[keys];
    return Promise.resolve();
  }

  /** Whatever is stored under the registry's key, if anything. */
  stored(): unknown {
    return this.items[BINDING_STORAGE_KEY];
  }

  /** Whatever is stored under the registry's unbind tombstone key, if anything. */
  storedTombstones(): unknown {
    return this.items[UNBIND_TOMBSTONE_STORAGE_KEY];
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

/**
 * A deterministic, strictly increasing clock: its reading `n` is
 * {@link clockReading}(`readingsBefore + n`). A restarted worker whose clock
 * must keep running past the earlier generation's — as the wall clock does —
 * is built with `readingsBefore` set past the readings that generation took.
 */
function createClock(readingsBefore = 0): Mock<Clock> {
  let readings = readingsBefore;
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
 * real eviction; `clockReadingsBefore` starts the clock past that many
 * readings (see {@link createClock}).
 */
function createHarness(
  storage: FakeSessionStorageArea = new FakeSessionStorageArea(),
  clockReadingsBefore = 0,
): Harness {
  const send = vi.fn<ProtocolSend>(() => SENT);
  const notify = vi.fn<PortPushSink>();
  const logger = createRecordingLogger();
  const now = createClock(clockReadingsBefore);
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
 * over the same storage record. `clockReadingsBefore` keeps the new clock
 * running past the old one's readings, for a case that orders decisions of
 * the two generations by time.
 */
function restartWorker(previous: Harness, clockReadingsBefore = 0): Harness {
  return createHarness(previous.storage, clockReadingsBefore);
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

/** The `tabId` a frame's payload carries, if it carries a numeric one. */
function payloadTabId(payload: unknown): TabId | undefined {
  if (typeof payload !== 'object' || payload === null || !('tabId' in payload)) {
    return undefined;
  }
  const { tabId } = payload;
  return typeof tabId === 'number' ? tabId : undefined;
}

/**
 * The local service's side of the bindings, as far as the registry can
 * observe it: the bindings the service holds for this worker's tabs, which it
 * keeps across a dropped socket and a worker restart alike (AAP §0.5.5), and
 * which it never lists back to the worker.
 *
 * {@link attach} makes it the harness's transport. While `connected`, each
 * frame is applied as the service applies it — a `session.unbind` ends the
 * tab's binding and, only when one was held, is answered with a `session.bound`
 * of reason `unbound`, applied through the registry's own `applyBound` — and
 * answered `sent`. While not connected every frame is `queued` and never
 * reaches it, as a frame handed to a reconnecting socket that the worker's
 * eviction then discards. Seeded directly with the bindings an earlier worker
 * generation had confirmed.
 */
class FakeBindingService {
  /** The bindings the service holds, by tab. */
  readonly bindings = new Map<TabId, { readonly sessionId: string; readonly url: string }>();
  /** Whether the worker's socket is open. */
  connected = true;
  /** The answers sent back, until {@link settle} waits for them. */
  private readonly answers: Promise<unknown>[] = [];

  /** Hold a binding of each record, as if an earlier generation had it confirmed. */
  seed(records: readonly TabBindingRecord[]): void {
    for (const record of records) {
      this.bindings.set(record.tabId, { sessionId: record.sessionId, url: record.url });
    }
  }

  /** Become `harness`'s transport, answering through its registry. */
  attach(harness: Harness): void {
    harness.send.mockImplementation((type, payload) => {
      if (!this.connected) {
        return QUEUED;
      }
      const tabId = payloadTabId(payload);
      const held = tabId === undefined ? undefined : this.bindings.get(tabId);
      if (type === 'session.unbind' && tabId !== undefined && held !== undefined) {
        this.bindings.delete(tabId);
        this.answers.push(
          harness.registry.applyBound(bound(tabId, held.sessionId, held.url, 'unbound')),
        );
      }
      return SENT;
    });
  }

  /** Wait until every answer sent so far has been applied by the registry. */
  async settle(): Promise<void> {
    await Promise.all(this.answers.splice(0));
  }

  /** The tabs the service still holds a binding for, ordered by id. */
  boundTabs(): TabId[] {
    return [...this.bindings.keys()].sort((left, right) => left - right);
  }
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

  it('refuses a capture id longer than the protocol admits, so storage never holds one hydration would drop', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    const tooLong = idOfLength('capture-test-', PROTOCOL_MAX_ID_LENGTH + 1);
    const atBound = idOfLength('capture-test-', PROTOCOL_MAX_ID_LENGTH);
    resetObservations(h);

    expect(await h.registry.setCaptureId(TAB_ONE, tooLong)).toBe(false);
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(record);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: record });
    expect(h.changes).toStrictEqual([]);

    // Exactly at the bound it is stored, and a restarted worker hydrates it.
    expect(await h.registry.setCaptureId(TAB_ONE, atBound)).toBe(true);
    const capturing: TabBindingRecord = { ...record, captureId: atBound };
    const revived = restartWorker(h);
    expect(await revived.registry.reload()).toStrictEqual([capturing]);
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
    // One hydration reads the new generation's caches — the binding key and the
    // unbind tombstone key, once each; later reads are served from memory.
    expect(revived.storage.reads).toBe(readsBeforeRestart + 2);
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
      // A same-origin URL one character past the protocol's bound.
      '505': {
        ...valid,
        tabId: 505,
        sessionId: 'session-test-long-url',
        url: urlOfLength(PROTOCOL_MAX_URL_LENGTH + 1),
      },
      // A same-origin URL of 50,000 characters.
      '606': {
        ...valid,
        tabId: 606,
        sessionId: 'session-test-huge-url',
        url: urlOfLength(50_000),
      },
      // A session id one character past the protocol's bound.
      '707': {
        ...valid,
        tabId: 707,
        sessionId: idOfLength('session-test-', PROTOCOL_MAX_ID_LENGTH + 1),
      },
      // A capture id one character past the protocol's bound.
      '808': {
        ...valid,
        tabId: 808,
        sessionId: 'session-test-long-capture',
        captureId: idOfLength('capture-test-', PROTOCOL_MAX_ID_LENGTH + 1),
      },
    };

    const reloaded = await h.registry.reload();

    expect(reloaded).toStrictEqual([valid]);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: valid });
    expect(h.logger.entries).toContainEqual({
      level: 'warn',
      message: 'Dropped malformed or excess tab bindings read back from session storage',
      fields: { dropped: 8, overLimit: 0, kept: 1, limit: MAX_STORED_TAB_BINDINGS },
    });
    // The refused URLs stay out of the log, like every other URL.
    for (const entry of h.logger.entries) {
      expect(JSON.stringify(entry)).not.toContain(PATH_SEGMENT);
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it('keeps a stored entry exactly at the protocol bounds: a 2048-character URL and 64-character ids', async () => {
    const atBounds: TabBindingRecord = {
      tabId: TAB_ONE,
      sessionId: idOfLength('session-test-', PROTOCOL_MAX_ID_LENGTH),
      url: urlOfLength(PROTOCOL_MAX_URL_LENGTH),
      origin: ORIGIN_A,
      boundAt: clockReading(1),
      captureId: idOfLength('capture-test-', PROTOCOL_MAX_ID_LENGTH),
    };
    h.storage.items[BINDING_STORAGE_KEY] = { [String(TAB_ONE)]: atBounds };

    expect(await h.registry.reload()).toStrictEqual([atBounds]);

    // Nothing was dropped, so nothing was rewritten.
    expect(h.storage.writes).toBe(0);
    expect(h.storage.stored()).toStrictEqual({ [String(TAB_ONE)]: atBounds });
    expect(await h.registry.getTabForSession(atBounds.sessionId)).toBe(TAB_ONE);
  });

  it(`keeps the newest ${String(MAX_STORED_TAB_BINDINGS)} stored bindings and ends the rest through owed unbinds, clearing them at the service and telling their panels`, async () => {
    const excess = 2;
    // Tabs 2 and 3 were bound at the same instant, straddling the cut: the tie
    // keeps the higher tab id, the rule a session named twice is resolved by.
    const records = buildMany(MAX_STORED_TAB_BINDINGS + excess, (index) =>
      bulkRecord(index, index === 3 ? 2 : index),
    );
    const pruned = records.slice(0, excess);
    const newest = records.slice(excess);
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(records);
    // The service still holds every one of them: it keeps bindings across a
    // dropped socket, and nothing but an unbind ends one.
    const service = new FakeBindingService();
    service.seed(records);
    service.attach(h);

    expect(await h.registry.reload()).toStrictEqual(newest);
    await service.settle();

    expect(h.storage.stored()).toStrictEqual(snapshotOf(newest));
    expect(await h.registry.getBinding(BULK_TAB_BASE + 1)).toBeUndefined();
    expect(await h.registry.getBinding(BULK_TAB_BASE + 2)).toBeUndefined();
    expect(await h.registry.getTabForSession(bulkSessionId(3))).toBe(BULK_TAB_BASE + 3);
    // Each pruned binding was unbound at the service, and nothing else was.
    expect(sentFrames(h)).toStrictEqual(
      pruned.map((record) => ({ type: 'session.unbind', payload: { tabId: record.tabId } })),
    );
    expect(service.boundTabs()).toStrictEqual(tabIdsOf(newest));
    // Its panel is told, and every listener hears of it.
    expect(bindingPushes(h)).toStrictEqual(
      pruned.map((record) => ({ tabId: record.tabId, state: { kind: 'unbound' } })),
    );
    expect(h.changes).toStrictEqual(
      pruned.map((record) => ({
        kind: 'removed',
        tabId: record.tabId,
        previous: record,
        current: undefined,
        state: { kind: 'unbound' },
        reason: 'unbound',
        cause: undefined,
      })),
    );
    expect(await h.registry.getPanelBindingState(BULK_TAB_BASE + 1)).toStrictEqual({
      kind: 'unbound',
    });
    // The service's answers acknowledged the owed unbinds, so none is left.
    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    expect(h.logger.entries).toContainEqual({
      level: 'warn',
      message: 'Dropped malformed or excess tab bindings read back from session storage',
      fields: {
        dropped: excess,
        overLimit: excess,
        kept: MAX_STORED_TAB_BINDINGS,
        limit: MAX_STORED_TAB_BINDINGS,
      },
    });
    expect(h.logger.entries).toContainEqual({
      level: 'warn',
      message: 'Ended stored tab bindings beyond the binding limit through owed unbinds',
      fields: {
        ended: excess,
        tombstoned: excess,
        handed: excess,
        heldBack: 0,
        limit: MAX_STORED_TAB_BINDINGS,
      },
    });

    // The rewritten storage is exactly what the next generation keeps: it
    // hydrates all of it and has nothing to rewrite or send.
    const writesBefore = h.storage.writes;
    const revived = restartWorker(h);
    expect(await revived.registry.reload()).toStrictEqual(newest);
    expect(revived.storage.writes).toBe(writesBefore);
    expect(revived.send).not.toHaveBeenCalled();
  });

  it('a stored binding beyond the limit ended while the socket is down stays owed across a restart, and the reconnect clears it at the service', async () => {
    const records = buildMany(MAX_STORED_TAB_BINDINGS + 1, (index) => bulkRecord(index));
    const [oldest] = records;
    const orphan = required(oldest, 'the least recently bound fixture');
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(records);
    const service = new FakeBindingService();
    service.seed(records);
    service.attach(h);
    service.connected = false;

    await h.registry.reload();

    // The unbind could only be queued, so it is written ahead as owed…
    expect(h.storage.storedTombstones()).toStrictEqual([
      {
        tabId: orphan.tabId,
        sessionId: orphan.sessionId,
        cause: 'binding-limit',
        createdAt: clockReading(1),
        deliveries: 0,
      },
    ]);
    // …the panel already shows the tab unbound, while the service still holds it.
    expect(bindingPushes(h)).toStrictEqual([{ tabId: orphan.tabId, state: { kind: 'unbound' } }]);
    expect(service.boundTabs()).toContain(orphan.tabId);

    // The worker is evicted with the socket still down; its successor connects.
    const revived = restartWorker(h, 1);
    service.attach(revived);
    service.connected = true;
    expect(await revived.registry.flushPendingUnbinds()).toBe(1);
    await service.settle();

    expect(service.boundTabs()).toStrictEqual(tabIdsOf(records.slice(1)));
    expect(Object.hasOwn(revived.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    expect(await revived.registry.listBindings()).toStrictEqual(records.slice(1));
  });

  it(`ends at most ${String(MAX_STORED_UNBIND_TOMBSTONES)} stored bindings beyond the limit in one hydration, dropping any older ones as corruption`, async () => {
    const records = buildMany(MAX_STORED_TAB_BINDINGS + MAX_STORED_UNBIND_TOMBSTONES + 1, (index) =>
      bulkRecord(index),
    );
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(records);

    expect(await h.registry.reload()).toStrictEqual(records.slice(-MAX_STORED_TAB_BINDINGS));

    // The most recently bound of the pruned ones are unbound; the oldest is dropped.
    const unbound = records.slice(1, MAX_STORED_UNBIND_TOMBSTONES + 1);
    expect(sentFrames(h)).toStrictEqual(
      unbound.map((record) => ({ type: 'session.unbind', payload: { tabId: record.tabId } })),
    );
    expect(h.storage.storedTombstones()).toHaveLength(MAX_STORED_UNBIND_TOMBSTONES);
    expect(h.logger.entries).toContainEqual({
      level: 'error',
      message:
        'Dropped stored tab bindings beyond what one hydration ends: storage held more than the registry writes',
      fields: { dropped: 1, limit: MAX_STORED_UNBIND_TOMBSTONES },
    });
  });

  it('holds back the owed unbind of a stored binding beyond the limit whose tab has a bind in flight, and lets its confirmation supersede it', async () => {
    const records = buildMany(MAX_STORED_TAB_BINDINGS + 1, (index) => bulkRecord(index));
    const inFlight = required(records[0], 'the least recently bound fixture');
    unwrap(
      await h.registry.requestBind({
        tabId: inFlight.tabId,
        url: inFlight.url,
        origin: inFlight.origin,
      }),
    );
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(records);
    resetObservations(h);

    await h.registry.reload();

    // Sent now, the unbind would follow the bind in flight and end it.
    expect(h.send).not.toHaveBeenCalled();
    expect(h.storage.storedTombstones()).toMatchObject([
      { tabId: inFlight.tabId, cause: 'binding-limit', deliveries: 0 },
    ]);
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();

    // The confirmation supersedes the tombstone. The map is still full from
    // storage the registry did not write, so the least recently bound kept
    // binding is ended for it, through the ordinary unbind.
    await confirmBinding(h, inFlight.tabId, SESSION_ALPHA, inFlight.url);
    const lru = required(records[1], 'the least recently bound kept fixture');
    expect(sentFrames(h)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: lru.tabId } },
    ]);
    expect(h.storage.storedTombstones()).toMatchObject([
      { tabId: lru.tabId, cause: 'binding-limit', deliveries: 1 },
    ]);
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBe(inFlight.tabId);
    expect(await h.registry.listBindings()).toHaveLength(MAX_STORED_TAB_BINDINGS);
  });

  it('restores one tab per session when storage names a session twice, without unbinding the stale duplicate', async () => {
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
    // The service holds the session on one tab only, so the duplicate names no
    // binding it can still hold, and `session.unbind { tabId }` for it could
    // end an unrelated, newer binding of that tab.
    expect(h.send).not.toHaveBeenCalled();
    expect(h.changes).toStrictEqual([]);
    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
  });

  it('starts empty when storage cannot be read, and rebuilds from the next confirmation', async () => {
    h.storage.readFailure = new Error('session storage unavailable');

    expect(await h.registry.reload()).toStrictEqual([]);

    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    expect(await h.registry.getBinding(TAB_ONE)).toStrictEqual(record);
  });

  it(`a confirmed bind of a new tab at ${String(MAX_STORED_TAB_BINDINGS)} bindings unbinds the least recently bound tab, never dropping it silently`, async () => {
    const held = buildMany(MAX_STORED_TAB_BINDINGS, (index) => bulkRecord(index));
    const [oldest] = held;
    const least = required(oldest, 'the least recently bound fixture');
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(held);
    const revived = restartWorker(h, MAX_STORED_TAB_BINDINGS);

    const outcome = unwrap(
      await revived.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    const record: TabBindingRecord = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      boundAt: clockReading(MAX_STORED_TAB_BINDINGS + 1),
    };
    expect(outcome).toStrictEqual({
      kind: 'recorded',
      record,
      previous: undefined,
      displaced: [],
      reason: 'bound',
    });
    // The ordinary unbind: the service is told, under a write-ahead tombstone…
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: least.tabId } },
    ]);
    expect(revived.storage.storedTombstones()).toStrictEqual([
      {
        tabId: least.tabId,
        sessionId: least.sessionId,
        cause: 'binding-limit',
        createdAt: clockReading(MAX_STORED_TAB_BINDINGS + 2),
        deliveries: 1,
      },
    ]);
    // …the panel is shown unbound and every listener hears of it.
    expect(bindingPushes(revived)).toStrictEqual([
      {
        tabId: TAB_ONE,
        state: { kind: 'bound', sessionId: SESSION_ALPHA, tabId: TAB_ONE, url: URL_A_OVERVIEW },
      },
      { tabId: least.tabId, state: { kind: 'unbound' } },
    ]);
    expect(revived.changes).toStrictEqual([
      {
        kind: 'recorded',
        tabId: TAB_ONE,
        previous: undefined,
        current: record,
        state: { kind: 'bound', sessionId: SESSION_ALPHA, tabId: TAB_ONE, url: URL_A_OVERVIEW },
        reason: 'bound',
        cause: undefined,
      },
      {
        kind: 'removed',
        tabId: least.tabId,
        previous: least,
        current: undefined,
        state: { kind: 'unbound' },
        reason: 'unbound',
        cause: undefined,
      },
    ]);
    // Storage holds exactly the limit, the new binding in and the oldest out.
    expect(revived.storage.stored()).toStrictEqual(snapshotOf([...held.slice(1), record]));
    expect(await revived.registry.getBinding(least.tabId)).toBeUndefined();
    expect(await revived.registry.getPanelBindingState(least.tabId)).toStrictEqual({
      kind: 'unbound',
    });

    // A re-confirmation of a tab already held makes no room, so it ends nothing.
    resetObservations(revived);
    const second = required(held[1], 'the second bulk fixture');
    await confirmBinding(revived, second.tabId, second.sessionId, second.url);
    expect(revived.send).not.toHaveBeenCalled();
    expect(await revived.registry.listBindings()).toHaveLength(MAX_STORED_TAB_BINDINGS);

    // The service's answer to that unbind acknowledges the tombstone, as for any other.
    await revived.registry.applyBound(bound(least.tabId, least.sessionId, least.url, 'unbound'));
    expect(Object.hasOwn(revived.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
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

describe('capacity — bounded by the obligations it tracks, never by forgetting one', () => {
  /** A request to bind `tabId` on the fixture origin. */
  function bindRequest(tabId: TabId): { tabId: TabId; url: string; origin: string } {
    return { tabId, url: URL_A_OVERVIEW, origin: ORIGIN_A };
  }

  /** An owed unbind of `tabId`, which holds no record. */
  function owedTombstone(tabId: TabId): TabUnbindTombstone {
    return {
      tabId,
      sessionId: SESSION_BETA,
      cause: 'tab-closed',
      createdAt: clockReading(1),
      deliveries: 0,
    };
  }

  it('always has room in the tombstone list for every unbind a slot can owe', () => {
    expect(MAX_STORED_UNBIND_TOMBSTONES).toBeGreaterThanOrEqual(MAX_STORED_TAB_BINDINGS);
  });

  it('a bind in flight holds its slot: a new tab is refused meanwhile, and the confirmation is recorded without ending a binding', async () => {
    const held = buildMany(MAX_STORED_TAB_BINDINGS - 1, (index) => bulkRecord(index));
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(held);
    const revived = restartWorker(h, MAX_STORED_TAB_BINDINGS);

    expect(unwrap(await revived.registry.requestBind(bindRequest(TAB_ONE)))).toBe('sent');
    const refused = await revived.registry.requestBind(bindRequest(TAB_TWO));
    expect(refused).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    // A tab already holding a slot is never refused.
    expect(unwrap(await revived.registry.requestBind(bindRequest(TAB_ONE)))).toBe('sent');
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.bind', payload: bindRequest(TAB_ONE) },
      { type: 'session.bind', payload: bindRequest(TAB_ONE) },
    ]);
    expect(revived.logger.entries).toContainEqual({
      level: 'warn',
      message: 'Refused to request a binding: every slot is held',
      fields: { tabId: TAB_TWO, slots: MAX_STORED_TAB_BINDINGS, limit: MAX_STORED_TAB_BINDINGS },
    });

    resetObservations(revived);
    const outcome = unwrap(
      await revived.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    expect(outcome.kind).toBe('recorded');
    expect(revived.send).not.toHaveBeenCalled();
    expect(revived.changes).toMatchObject([{ kind: 'recorded', tabId: TAB_ONE }]);
    expect(await revived.registry.listBindings()).toHaveLength(MAX_STORED_TAB_BINDINGS);
    expect(Object.hasOwn(revived.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
  });

  it('DevTools closing on a tab with a bind in flight writes its owed unbind into that slot', async () => {
    const held = buildMany(MAX_STORED_TAB_BINDINGS - 1, (index) => bulkRecord(index));
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(held);
    const revived = restartWorker(h, MAX_STORED_TAB_BINDINGS);
    revived.send.mockReturnValue(QUEUED);
    unwrap(await revived.registry.requestBind(bindRequest(TAB_ONE)));

    await revived.registry.unbind(TAB_ONE, 'devtools-closed');

    expect(revived.storage.storedTombstones()).toStrictEqual([
      {
        tabId: TAB_ONE,
        cause: 'devtools-closed',
        createdAt: clockReading(MAX_STORED_TAB_BINDINGS + 1),
        deliveries: 0,
      },
    ]);
    // The slot moved from the bind to the owed unbind: still every slot held.
    const refused = await revived.registry.requestBind(bindRequest(TAB_TWO));
    expect(refused).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
  });

  it('a confirmation holding no slot at the limit delivers an owed unbind to make room, ending no binding', async () => {
    const held = buildMany(MAX_STORED_TAB_BINDINGS - 1, (index) => bulkRecord(index));
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(held);
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = [owedTombstone(TAB_TWO)];
    const revived = restartWorker(h, MAX_STORED_TAB_BINDINGS);

    const outcome = unwrap(
      await revived.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    expect(outcome.kind).toBe('recorded');
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_TWO } },
    ]);
    expect(revived.storage.storedTombstones()).toStrictEqual([
      { ...owedTombstone(TAB_TWO), deliveries: 1 },
    ]);
    expect(revived.changes).toMatchObject([{ kind: 'recorded', tabId: TAB_ONE }]);
    expect(await revived.registry.listBindings()).toHaveLength(MAX_STORED_TAB_BINDINGS);
  });

  it('declines such a confirmation when the socket takes no frame, ending nothing, and records it once the socket is back', async () => {
    const held = buildMany(MAX_STORED_TAB_BINDINGS - 1, (index) => bulkRecord(index));
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(held);
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = [owedTombstone(TAB_TWO)];
    const revived = restartWorker(h, MAX_STORED_TAB_BINDINGS);
    revived.send.mockImplementation(refusedSend);

    const outcome = unwrap(
      await revived.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    expect(outcome).toStrictEqual({ kind: 'ignored', reason: 'bound' });
    expect(await revived.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(await revived.registry.listBindings()).toStrictEqual(held);
    expect(revived.changes).toStrictEqual([]);
    expect(revived.notify).not.toHaveBeenCalled();
    expect(revived.storage.storedTombstones()).toStrictEqual([owedTombstone(TAB_TWO)]);
    expect(revived.logger.entries).toContainEqual({
      level: 'error',
      message:
        'Declined to record a confirmed binding: every slot is held and the socket took no frame to free one',
      fields: {
        tabId: TAB_ONE,
        sessionId: SESSION_ALPHA,
        slots: MAX_STORED_TAB_BINDINGS,
        limit: MAX_STORED_TAB_BINDINGS,
        displacedTabs: [],
        limitEndedTabs: [],
      },
    });

    // The socket opens: the flush delivers the owed unbind, freeing its slot,
    // and the DevTools page's rebind is confirmed and recorded.
    revived.send.mockImplementation(() => SENT);
    expect(await revived.registry.flushPendingUnbinds()).toBe(1);
    expect(unwrap(await revived.registry.requestBind(bindRequest(TAB_ONE)))).toBe('sent');
    await confirmBinding(revived, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    expect(await revived.registry.getTabForSession(SESSION_ALPHA)).toBe(TAB_ONE);
  });

  it('with the map full and the socket taking no frame, the binding ended for room stays owed and the confirmation is declined', async () => {
    const held = buildMany(MAX_STORED_TAB_BINDINGS, (index) => bulkRecord(index));
    const least = required(held[0], 'the least recently bound fixture');
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(held);
    const revived = restartWorker(h, MAX_STORED_TAB_BINDINGS);
    revived.send.mockImplementation(refusedSend);

    const outcome = unwrap(
      await revived.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW)),
    );

    expect(outcome).toStrictEqual({ kind: 'ignored', reason: 'bound' });
    expect(await revived.registry.getBinding(TAB_ONE)).toBeUndefined();
    // The ended binding is told to its panel and kept owed, never forgotten.
    expect(bindingPushes(revived)).toStrictEqual([
      { tabId: least.tabId, state: { kind: 'unbound' } },
    ]);
    expect(revived.changes).toMatchObject([
      { kind: 'removed', tabId: least.tabId, reason: 'unbound', cause: undefined },
    ]);
    expect(revived.storage.storedTombstones()).toStrictEqual([
      {
        tabId: least.tabId,
        sessionId: least.sessionId,
        cause: 'binding-limit',
        createdAt: clockReading(MAX_STORED_TAB_BINDINGS + 2),
        deliveries: 0,
      },
    ]);
    expect(revived.storage.stored()).toStrictEqual(snapshotOf(held.slice(1)));
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

  it('handles a navigation to a URL longer than the protocol admits as unreportable, never recording it', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    resetObservations(h);
    // Same origin, but past the bound: it can be neither reported nor stored.
    const oversized = urlOfLength(PROTOCOL_MAX_URL_LENGTH + 1);

    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: oversized });

    expect(decision).toStrictEqual({
      kind: 'unbound-cross-origin',
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      captureId: undefined,
      previousOrigin: ORIGIN_A,
      origin: undefined,
      notice: formatTabLeftMessage(ORIGIN_A),
      reported: false,
    });
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(Object.hasOwn(h.storage.items, BINDING_STORAGE_KEY)).toBe(false);
    for (const entry of h.logger.entries) {
      expect(JSON.stringify(entry)).not.toContain(PATH_SEGMENT);
    }

    // An unbound tab navigating there is not an event: nothing is sent.
    resetObservations(h);
    expect(await h.registry.handleNavigated({ tabId: TAB_TWO, url: oversized })).toStrictEqual({
      kind: 'not-bound',
      tabId: TAB_TWO,
      reported: false,
    });
    expect(h.send).not.toHaveBeenCalled();
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

describe('unbind tombstones — an unbind outlives the worker that decided it', () => {
  /** Make the transport answer `outcome` for every frame of one type, SENT otherwise. */
  function answerFor(harness: Harness, type: string, outcome: () => SendResult): void {
    harness.send.mockImplementation((sentType) => (sentType === type ? outcome() : SENT));
  }

  it('a cross-origin navigation queued while reconnecting leaves a tombstone a restarted worker flushes', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);

    const decision = await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });

    expect(decision).toMatchObject({ kind: 'unbound-cross-origin', reported: true });
    const pending: TabUnbindTombstone = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      cause: 'navigated-away',
      createdAt: clockReading(2),
      deliveries: 0,
    };
    // Queued is not a delivery: the frame only sits in the socket client's memory.
    expect(h.storage.storedTombstones()).toStrictEqual([pending]);
    expect(Object.hasOwn(h.storage.items, BINDING_STORAGE_KEY)).toBe(false);

    // The worker is evicted, taking the socket client's queue with it.
    const revived = restartWorker(h);
    const resent = await revived.registry.flushPendingUnbinds();

    expect(resent).toBe(1);
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
    ]);
    expect(revived.storage.storedTombstones()).toStrictEqual([{ ...pending, deliveries: 1 }]);
    expect(await revived.registry.listBindings()).toStrictEqual([]);
    expect(revived.notify).not.toHaveBeenCalled();
    expect(revived.changes).toStrictEqual([]);
  });

  it('writes the tombstone before the unbind frame is reported and before the record is dropped', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    const atReport: { tombstones: unknown; bindings: unknown }[] = [];
    h.send.mockImplementation((type) => {
      if (type === 'session.unbind') {
        atReport.push({
          tombstones: jsonClone(h.storage.storedTombstones()),
          bindings: jsonClone(h.storage.stored()),
        });
      }
      return SENT;
    });

    await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });

    expect(atReport).toStrictEqual([
      {
        tombstones: [
          {
            tabId: TAB_ONE,
            sessionId: SESSION_ALPHA,
            cause: 'navigated-away',
            createdAt: clockReading(2),
            deliveries: 0,
          },
        ],
        bindings: { [String(TAB_ONE)]: record },
      },
    ]);
    // Handed to an open socket, the frame counts one delivery.
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE, deliveries: 1 }]);
  });

  it.each([...TAB_UNBIND_CAUSES])(
    'the %s unbind persists a tombstone naming the session',
    async (cause) => {
      await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
      h.send.mockReturnValue(QUEUED);

      await h.registry.unbind(TAB_ONE, cause);

      const expected: TabUnbindTombstone[] = [
        {
          tabId: TAB_ONE,
          sessionId: SESSION_ALPHA,
          cause,
          createdAt: clockReading(2),
          deliveries: 0,
        },
      ];
      expect(h.storage.storedTombstones()).toStrictEqual(expected);
    },
  );

  it('an ended session persists a session-ended tombstone for the tab that held it', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);

    await h.registry.handleSessionEnded(SESSION_ALPHA);

    expect(h.storage.storedTombstones()).toStrictEqual([
      {
        tabId: TAB_ONE,
        sessionId: SESSION_ALPHA,
        cause: 'session-ended',
        createdAt: clockReading(2),
        deliveries: 0,
      },
    ]);
  });

  it('DevTools closing on a tab with no record persists a tombstone naming no session', async () => {
    await h.registry.unbind(TAB_UNKNOWN, 'devtools-closed');

    expect(h.storage.storedTombstones()).toStrictEqual([
      { tabId: TAB_UNKNOWN, cause: 'devtools-closed', createdAt: clockReading(1), deliveries: 1 },
    ]);
  });

  it('closing a tab this worker never bound stores no tombstone', async () => {
    await h.registry.unbind(TAB_UNKNOWN, 'tab-closed');

    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a refused unbind keeps the tombstone as it was, and a later flush delivers it', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    answerFor(h, 'session.unbind', refusedSend);

    await h.registry.unbind(TAB_ONE, 'tab-closed');

    const pending: TabUnbindTombstone = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      cause: 'tab-closed',
      createdAt: clockReading(2),
      deliveries: 0,
    };
    expect(h.storage.storedTombstones()).toStrictEqual([pending]);

    // Still refused: nothing handed over, nothing counted.
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    expect(h.storage.storedTombstones()).toStrictEqual([pending]);

    h.send.mockImplementation(() => SENT);
    resetObservations(h);
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(h.storage.storedTombstones()).toStrictEqual([{ ...pending, deliveries: 1 }]);
  });

  it.each(['unbound', 'origin-changed', 'replaced'] as const)(
    "the service's %s announcement acknowledges the tombstone although no record is held",
    async (reason) => {
      await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
      await h.registry.unbind(TAB_ONE, 'devtools-closed');
      expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE }]);
      resetObservations(h);

      const outcome = unwrap(
        await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW, reason)),
      );

      // The outcome stays 'ignored' — there is no record to drop — but the intent is settled.
      expect(outcome).toStrictEqual({ kind: 'ignored', reason });
      expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
      expect(h.notify).not.toHaveBeenCalled();
      expect(h.changes).toStrictEqual([]);
      expect(await h.registry.flushPendingUnbinds()).toBe(0);
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it('an acknowledgement for another session of the tab keeps the tombstone', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.unbind(TAB_ONE, 'tab-closed');

    await h.registry.applyBound(bound(TAB_ONE, SESSION_BETA, URL_A_OVERVIEW, 'unbound'));

    expect(h.storage.storedTombstones()).toMatchObject([
      { tabId: TAB_ONE, sessionId: SESSION_ALPHA },
    ]);
  });

  it('a tombstone naming no session is acknowledged by a drop for any session of the tab', async () => {
    await h.registry.unbind(TAB_UNKNOWN, 'devtools-closed');

    await h.registry.applyBound(bound(TAB_UNKNOWN, SESSION_BETA, URL_A_OVERVIEW, 'unbound'));

    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
  });

  /**
   * Bind `TAB_ONE` to `SESSION_ALPHA`, then navigate it off the origin while
   * the socket reconnects, so its unbind is only queued: the tombstone it
   * leaves (created at the clock's second reading) has no delivery yet.
   */
  async function leaveWhileReconnecting(harness: Harness): Promise<TabUnbindTombstone> {
    await confirmBinding(harness, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    harness.send.mockReturnValue(QUEUED);
    await harness.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });
    const pending: TabUnbindTombstone = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      cause: 'navigated-away',
      createdAt: clockReading(2),
      deliveries: 0,
    };
    expect(harness.storage.storedTombstones()).toStrictEqual([pending]);
    return pending;
  }

  /** The panel asks to bind `TAB_ONE` again, on its original origin. */
  function rebindTabOne(harness: Harness): ReturnType<TabRegistry['requestBind']> {
    return harness.registry.requestBind({ tabId: TAB_ONE, url: URL_A_OVERVIEW, origin: ORIGIN_A });
  }

  it('requestBind of a tab holding a tombstone sends session.unbind, then session.bind, and keeps the tombstone', async () => {
    const pending = await leaveWhileReconnecting(h);
    resetObservations(h);
    const atBind: unknown[] = [];
    h.send.mockImplementation((type) => {
      if (type === 'session.bind') {
        atBind.push(jsonClone(h.storage.storedTombstones()));
      }
      return SENT;
    });

    const result = await rebindTabOne(h);

    expect(unwrap(result)).toBe('sent');
    // The owed unbind leaves first, so the FIFO transport delivers it ahead of the bind.
    expect(sentFrames(h)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
      { type: 'session.bind', payload: { tabId: TAB_ONE, url: URL_A_OVERVIEW, origin: ORIGIN_A } },
    ]);
    // Asking supersedes nothing: the tombstone is stored when the bind leaves and after,
    // with the unbind's hand-off to the open socket counted.
    const delivered: TabUnbindTombstone = { ...pending, deliveries: 1 };
    expect(atBind).toStrictEqual([[delivered]]);
    expect(h.storage.storedTombstones()).toStrictEqual([delivered]);
    expect(await h.registry.listBindings()).toStrictEqual([]);
  });

  it('the binding the service then confirms for the tab retires the tombstone', async () => {
    await leaveWhileReconnecting(h);
    h.send.mockReturnValue(SENT);
    await rebindTabOne(h);
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE }]);

    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);

    expect(record).toMatchObject({ tabId: TAB_ONE, sessionId: SESSION_ALPHA });
    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    // Neither this generation nor the next has anything left to end the new binding with.
    resetObservations(h);
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    const revived = restartWorker(h);
    expect(await revived.registry.flushPendingUnbinds()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(revived.send).not.toHaveBeenCalled();
  });

  it('a flush in the same generation after that requestBind sends nothing for the tab, and still sends the rest', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    h.send.mockReturnValue(QUEUED);
    await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });
    await h.registry.unbind(TAB_TWO, 'tab-closed');
    await rebindTabOne(h);
    resetObservations(h);
    h.send.mockReturnValue(SENT);

    expect(await h.registry.flushPendingUnbinds()).toBe(1);

    // Flushed now, TAB_ONE's unbind would follow its pending bind and end it.
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_TWO } }]);
    // Held back, not retired.
    expect(h.storage.storedTombstones()).toMatchObject([
      { tabId: TAB_ONE, deliveries: 0 },
      { tabId: TAB_TWO, deliveries: 1 },
    ]);
  });

  it("a queued bind lost with the worker: the next generation's flush re-sends the unbind", async () => {
    const pending = await leaveWhileReconnecting(h);

    // Unbind and bind both wait in the socket client's queue …
    expect(unwrap(await rebindTabOne(h))).toBe('queued');
    expect(await h.registry.flushPendingUnbinds()).toBe(0);

    // … which the eviction discards, together with the mark that held the tombstone back.
    const revived = restartWorker(h);
    expect(await revived.registry.flushPendingUnbinds()).toBe(1);

    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
    ]);
    expect(revived.storage.storedTombstones()).toStrictEqual([{ ...pending, deliveries: 1 }]);
  });

  it('a bind the transport refuses leaves the tombstone flushable in the same generation', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_ONE, 'devtools-closed');
    answerFor(h, 'session.bind', refusedSend);
    resetObservations(h);

    const result = await rebindTabOne(h);

    expect(result).toMatchObject({ ok: false, error: { code: 'TRANSPORT_DISCONNECTED' } });
    expect(sentFrames(h).map((frame) => frame.type)).toStrictEqual([
      'session.unbind',
      'session.bind',
    ]);
    expect(h.storage.storedTombstones()).toMatchObject([
      { tabId: TAB_ONE, cause: 'devtools-closed', deliveries: 1 },
    ]);

    // No bind is pending, so nothing holds the tombstone back.
    h.send.mockImplementation(() => SENT);
    resetObservations(h);
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE, deliveries: 2 }]);
  });

  it('a refused owed unbind withholds the bind, which would otherwise leave unordered', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_ONE, 'tab-closed');
    const pending = h.storage.storedTombstones();
    h.send.mockImplementation(refusedSend);
    resetObservations(h);

    const result = await rebindTabOne(h);

    expect(result).toMatchObject({ ok: false, error: { code: 'TRANSPORT_DISCONNECTED' } });
    expect(sentFrames(h).map((frame) => frame.type)).toStrictEqual(['session.unbind']);
    expect(h.storage.storedTombstones()).toStrictEqual(pending);

    h.send.mockImplementation(() => SENT);
    resetObservations(h);
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
  });

  it('a bind the service rejects — no session.bound arrives — keeps the tombstone owed', async () => {
    await leaveWhileReconnecting(h);
    h.send.mockReturnValue(SENT);
    expect(unwrap(await rebindTabOne(h))).toBe('sent');

    // The service's refusal is an `error` frame the registry never sees: nothing is recorded.
    expect(await h.registry.listBindings()).toStrictEqual([]);
    expect(h.storage.storedTombstones()).toMatchObject([
      { tabId: TAB_ONE, sessionId: SESSION_ALPHA, deliveries: 1 },
    ]);

    // On the next connection the flush still holds it back, and the panel's next
    // request sends the unbind ahead of that bind as well — one count for the new epoch.
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    resetObservations(h);
    await rebindTabOne(h);
    expect(sentFrames(h).map((frame) => frame.type)).toStrictEqual([
      'session.unbind',
      'session.bind',
    ]);
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE, deliveries: 2 }]);
  });

  it('counts one delivery per epoch, however often requestBind re-sends the unbind on one connection', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_ONE, 'devtools-closed');
    h.send.mockReturnValue(SENT);
    resetObservations(h);

    for (let attempt = 0; attempt <= MAX_UNBIND_TOMBSTONE_DELIVERIES; attempt += 1) {
      await rebindTabOne(h);
    }

    const unbinds = sentFrames(h).filter((frame) => frame.type === 'session.unbind');
    expect(unbinds).toHaveLength(MAX_UNBIND_TOMBSTONE_DELIVERIES + 1);
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE, deliveries: 1 }]);
  });

  it('closing a tab while its bind is pending over a tombstone sends the unbind now, flushable', async () => {
    await leaveWhileReconnecting(h);
    await rebindTabOne(h);
    h.send.mockReturnValue(SENT);
    resetObservations(h);

    const removed = await h.registry.unbind(TAB_ONE, 'tab-closed');

    expect(removed).toBeUndefined();
    // Sent after the pending bind, it ends that bind if the service applies it.
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(h.storage.storedTombstones()).toStrictEqual([
      { tabId: TAB_ONE, cause: 'tab-closed', createdAt: clockReading(3), deliveries: 1 },
    ]);
    resetObservations(h);
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
  });

  it('an invalid bind request leaves the tombstone untouched', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.unbind(TAB_ONE, 'tab-closed');
    const pending = h.storage.storedTombstones();
    const writes = h.storage.writes;

    await h.registry.requestBind({ tabId: TAB_ONE, url: URL_A_OVERVIEW, origin: `${ORIGIN_A}/` });

    expect(h.storage.storedTombstones()).toStrictEqual(pending);
    expect(h.storage.writes).toBe(writes);
  });

  it('a binding the service records for the tab supersedes its tombstone', async () => {
    await h.registry.unbind(TAB_ONE, 'devtools-closed');
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE }]);

    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);

    expect(record).toMatchObject({ tabId: TAB_ONE, sessionId: SESSION_ALPHA });
    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    resetObservations(h);
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it(`retires an unacknowledged tombstone after ${String(MAX_UNBIND_TOMBSTONE_DELIVERIES)} sent deliveries`, async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    // The unbind itself is the first delivery to the open socket.
    await h.registry.unbind(TAB_ONE, 'tab-closed');
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE, deliveries: 1 }]);

    for (let delivered = 2; delivered <= MAX_UNBIND_TOMBSTONE_DELIVERIES; delivered += 1) {
      expect(await h.registry.flushPendingUnbinds()).toBe(1);
    }

    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    resetObservations(h);
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not count frames queued while reconnecting as deliveries', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_ONE, 'tab-closed');

    for (let flush = 0; flush <= MAX_UNBIND_TOMBSTONE_DELIVERIES; flush += 1) {
      expect(await h.registry.flushPendingUnbinds()).toBe(1);
    }

    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE, deliveries: 0 }]);
  });

  it('a never-delivered tombstone older than the TTL is still flushed', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_ONE, 'tab-closed');
    const createdAt = clockReading(2);
    resetObservations(h);

    // Only ever queued, it has told the service nothing: age alone never retires it.
    h.now.mockReturnValueOnce(createdAt + 2 * UNBIND_TOMBSTONE_TTL_MS);
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(h.storage.storedTombstones()).toMatchObject([
      { tabId: TAB_ONE, createdAt, deliveries: 0 },
    ]);

    // It survives a restart just as long, and its first open socket delivers it.
    const revived = restartWorker(h);
    revived.now.mockReturnValueOnce(createdAt + 2 * UNBIND_TOMBSTONE_TTL_MS);
    expect(await revived.registry.flushPendingUnbinds()).toBe(1);
    expect(revived.storage.storedTombstones()).toMatchObject([
      { tabId: TAB_ONE, createdAt, deliveries: 1 },
    ]);
  });

  it('a delivered tombstone older than the TTL is retired', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    // Handed to the open socket, the unbind itself is the first delivery.
    await h.registry.unbind(TAB_ONE, 'tab-closed');
    const createdAt = clockReading(2);
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE, deliveries: 1 }]);
    resetObservations(h);

    h.now.mockReturnValueOnce(createdAt + UNBIND_TOMBSTONE_TTL_MS - 1);
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(h.storage.storedTombstones()).toMatchObject([
      { tabId: TAB_ONE, createdAt, deliveries: 2 },
    ]);

    resetObservations(h);
    h.now.mockReturnValueOnce(createdAt + UNBIND_TOMBSTONE_TTL_MS);
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
  });

  it('flushes pending unbinds oldest first', async () => {
    await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_TWO, 'tab-closed');
    await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });
    resetObservations(h);

    expect(await h.registry.flushPendingUnbinds()).toBe(2);

    expect(sentFrames(h)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_TWO } },
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
    ]);
  });

  it('with nothing pending, a flush sends nothing and writes nothing', async () => {
    expect(await h.registry.flushPendingUnbinds()).toBe(0);

    expect(h.send).not.toHaveBeenCalled();
    expect(h.storage.writes).toBe(0);
    expect(h.now).not.toHaveBeenCalled();
  });

  it('a newer unbind of the same tab replaces its tombstone', async () => {
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_ONE, 'devtools-closed');
    await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    await h.registry.unbind(TAB_ONE, 'devtools-closed');

    expect(h.storage.storedTombstones()).toStrictEqual([
      { tabId: TAB_ONE, cause: 'devtools-closed', createdAt: clockReading(3), deliveries: 0 },
    ]);
  });

  it('drops malformed stored tombstones on reload and writes the cleaned list back', async () => {
    const valid: TabUnbindTombstone = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      cause: 'navigated-away',
      createdAt: clockReading(4),
      deliveries: 1,
    };
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = [
      valid,
      // Not a tab id.
      { ...valid, tabId: -1 },
      // A cause outside the vocabulary.
      { ...valid, tabId: TAB_TWO, cause: 'navigated' },
      // An empty session id.
      { ...valid, tabId: TAB_TWO, sessionId: '' },
      // A session id one character past the protocol's bound.
      {
        ...valid,
        tabId: TAB_TWO,
        sessionId: idOfLength('session-test-', PROTOCOL_MAX_ID_LENGTH + 1),
      },
      // A fractional delivery count.
      { ...valid, tabId: TAB_TWO, deliveries: 1.5 },
      // No creation stamp.
      { tabId: TAB_TWO, cause: 'tab-closed', deliveries: 0 },
      // Not a record at all.
      'not-a-tombstone',
      // A second, older tombstone for the same tab.
      { ...valid, createdAt: clockReading(1) },
    ];

    expect(await h.registry.reload()).toStrictEqual([]);

    expect(h.storage.storedTombstones()).toStrictEqual([valid]);
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
  });

  it('keeps a stored tombstone whose session id is exactly at the protocol bound', async () => {
    const atBound: TabUnbindTombstone = {
      tabId: TAB_ONE,
      sessionId: idOfLength('session-test-', PROTOCOL_MAX_ID_LENGTH),
      cause: 'tab-closed',
      createdAt: clockReading(1),
      deliveries: 0,
    };
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = [atBound];

    await h.registry.reload();

    expect(h.storage.writes).toBe(0);
    expect(h.storage.storedTombstones()).toStrictEqual([atBound]);
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
  });

  it(`hydrates only the newest ${String(MAX_STORED_UNBIND_TOMBSTONES)} tombstones and rewrites storage without the rest`, async () => {
    const excess = 2;
    // Tabs 2 and 3 were unbound at the same instant, straddling the cut: the
    // tie keeps the higher tab id, the tail of the flush order.
    const tombstones = buildMany(MAX_STORED_UNBIND_TOMBSTONES + excess, (index) =>
      bulkTombstone(index, index === 3 ? 2 : index),
    );
    const newest = tombstones.slice(excess);
    // Stored newest first: what is kept follows `createdAt`, not the position.
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = [...tombstones].reverse();

    await h.registry.reload();

    expect(h.storage.storedTombstones()).toStrictEqual(newest);
    expect(h.logger.entries).toContainEqual({
      level: 'warn',
      message: 'Dropped malformed or excess unbind tombstones read back from session storage',
      fields: {
        dropped: excess,
        overLimit: excess,
        kept: MAX_STORED_UNBIND_TOMBSTONES,
        limit: MAX_STORED_UNBIND_TOMBSTONES,
      },
    });

    // Only the kept tombstones are ever re-sent, oldest first.
    expect(await h.registry.flushPendingUnbinds()).toBe(MAX_STORED_UNBIND_TOMBSTONES);
    expect(sentFrames(h)).toStrictEqual(
      newest.map((tombstone) => ({
        type: 'session.unbind',
        payload: { tabId: tombstone.tabId },
      })),
    );
    // More owed unbinds than the registry ever writes can only be corruption.
    expect(h.logger.entries).toContainEqual({
      level: 'error',
      message:
        'Dropped undelivered unbind tombstones read back from session storage: it held more owed unbinds than the registry writes',
      fields: { owed: excess, limit: MAX_STORED_UNBIND_TOMBSTONES },
    });
  });

  it(`hydration keeps every undelivered tombstone before a delivered one, however new the delivered one is`, async () => {
    const excess = 2;
    // The two newest were already delivered; every older one is still owed.
    const tombstones = buildMany(MAX_STORED_UNBIND_TOMBSTONES + excess, (index) =>
      bulkTombstone(index, index, index > MAX_STORED_UNBIND_TOMBSTONES ? 1 : 0),
    );
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = tombstones;

    await h.registry.reload();

    expect(h.storage.storedTombstones()).toStrictEqual(
      tombstones.slice(0, MAX_STORED_UNBIND_TOMBSTONES),
    );
    expect(h.logger.entries.filter((entry) => entry.level === 'error')).toStrictEqual([]);
  });

  it(`writing a tombstone beyond ${String(MAX_STORED_UNBIND_TOMBSTONES)} evicts the oldest delivered one, never an undelivered one`, async () => {
    // The oldest is still owed; the second oldest was delivered once.
    const stored = buildMany(MAX_STORED_UNBIND_TOMBSTONES, (index) =>
      bulkTombstone(index, index, index === 2 ? 1 : 0),
    );
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = stored;
    const revived = restartWorker(h, MAX_STORED_UNBIND_TOMBSTONES);

    await revived.registry.unbind(TAB_UNKNOWN, 'devtools-closed');

    const written: TabUnbindTombstone = {
      tabId: TAB_UNKNOWN,
      cause: 'devtools-closed',
      createdAt: clockReading(MAX_STORED_UNBIND_TOMBSTONES + 1),
      deliveries: 1,
    };
    const [oldest] = stored;
    expect(revived.storage.storedTombstones()).toStrictEqual([
      required(oldest, 'the oldest stored tombstone'),
      ...stored.slice(2),
      written,
    ]);
    expect(revived.logger.entries).toContainEqual({
      level: 'warn',
      message: 'Evicted the oldest delivered unbind tombstones to stay within the stored limit',
      fields: {
        evicted: 1,
        owed: 0,
        pending: MAX_STORED_UNBIND_TOMBSTONES,
        limit: MAX_STORED_UNBIND_TOMBSTONES,
      },
    });

    // The owed unbind is still re-sent; only the delivered one's retransmission is gone.
    resetObservations(revived);
    expect(await revived.registry.flushPendingUnbinds()).toBe(MAX_STORED_UNBIND_TOMBSTONES);
    const flushedTabs = sentFrames(revived).map((frame) => frame.payload);
    expect(flushedTabs).toContainEqual({ tabId: BULK_TAB_BASE + 1 });
    expect(flushedTabs).not.toContainEqual({ tabId: BULK_TAB_BASE + 2 });
    expect(flushedTabs).toContainEqual({ tabId: TAB_UNKNOWN });
  });

  it(`never evicts an owed unbind: ${String(MAX_STORED_TAB_BINDINGS)} bindings ended during an outage all reach the service on reconnect, and a further DevTools close is sent without a tombstone`, async () => {
    const held = buildMany(MAX_STORED_TAB_BINDINGS, (index) => bulkRecord(index));
    h.storage.items[BINDING_STORAGE_KEY] = snapshotOf(held);
    const service = new FakeBindingService();
    service.seed(held);
    const revived = restartWorker(h, MAX_STORED_TAB_BINDINGS);
    service.attach(revived);
    service.connected = false;

    // Every bound tab closes while the socket is down: each unbind is owed.
    for (const record of held) {
      await revived.registry.unbind(record.tabId, 'tab-closed');
    }
    const owed = h.storage.storedTombstones();
    expect(owed).toHaveLength(MAX_STORED_UNBIND_TOMBSTONES);
    expect(owed).toMatchObject(held.map((record) => ({ tabId: record.tabId, deliveries: 0 })));
    expect(bindingPushes(revived)).toStrictEqual(
      held.map((record) => ({ tabId: record.tabId, state: { kind: 'unbound' } })),
    );

    // Every slot is owed now. DevTools closing on a tab holding none is a race
    // closer only, so it is handed over without a tombstone and nothing is
    // evicted for it…
    resetObservations(revived);
    await revived.registry.unbind(TAB_UNKNOWN, 'devtools-closed');
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_UNKNOWN } },
    ]);
    expect(h.storage.storedTombstones()).toStrictEqual(owed);
    expect(revived.logger.entries).toContainEqual({
      level: 'warn',
      message: 'Unbind sent without a tombstone: every slot is held and the tab holds none',
      fields: {
        tabId: TAB_UNKNOWN,
        cause: 'devtools-closed',
        slots: MAX_STORED_TAB_BINDINGS,
        limit: MAX_STORED_TAB_BINDINGS,
      },
    });
    // …and a bind of a new tab is refused before anything is sent.
    resetObservations(revived);
    const refused = await revived.registry.requestBind({
      tabId: TAB_ONE,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect(revived.send).not.toHaveBeenCalled();

    // The worker is evicted during the outage; its successor connects and
    // flushes, and every binding the service held is cleared.
    const next = restartWorker(revived, 3 * MAX_STORED_TAB_BINDINGS);
    service.attach(next);
    service.connected = true;
    expect(await next.registry.flushPendingUnbinds()).toBe(MAX_STORED_TAB_BINDINGS);
    await service.settle();
    expect(service.boundTabs()).toStrictEqual([]);
    expect(Object.hasOwn(next.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);

    // With the obligations settled, binding a tab is possible again.
    expect(
      unwrap(
        await next.registry.requestBind({ tabId: TAB_ONE, url: URL_A_OVERVIEW, origin: ORIGIN_A }),
      ),
    ).toBe('sent');
  });

  it('the tombstone being written is never the one evicted, even when the clock places it first', async () => {
    // Every stored tombstone was delivered once, and decided after the clock's
    // reading this worker takes.
    const stored = buildMany(MAX_STORED_UNBIND_TOMBSTONES, (index) =>
      bulkTombstone(index, MAX_STORED_UNBIND_TOMBSTONES + index, 1),
    );
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = stored;
    h.send.mockReturnValue(QUEUED);

    await h.registry.unbind(TAB_UNKNOWN, 'devtools-closed');

    const written: TabUnbindTombstone = {
      tabId: TAB_UNKNOWN,
      cause: 'devtools-closed',
      createdAt: clockReading(1),
      deliveries: 0,
    };
    expect(h.storage.storedTombstones()).toStrictEqual([written, ...stored.slice(1)]);
  });

  it('drops a stored tombstone value that is not a list', async () => {
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = { [String(TAB_ONE)]: 'not-a-list' };

    await h.registry.reload();

    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    expect(await h.registry.flushPendingUnbinds()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('hydration lets the later decision win when a crash left a tab with a record and a tombstone', async () => {
    const endedByTombstone: TabBindingRecord = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      url: URL_A_OVERVIEW,
      origin: ORIGIN_A,
      boundAt: clockReading(1),
    };
    const newerThanItsTombstone: TabBindingRecord = {
      tabId: TAB_TWO,
      sessionId: SESSION_BETA,
      url: URL_A_SETTINGS,
      origin: ORIGIN_A,
      boundAt: clockReading(5),
    };
    const unbindAfterBind: TabUnbindTombstone = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      cause: 'navigated-away',
      createdAt: clockReading(2),
      deliveries: 0,
    };
    h.storage.items[BINDING_STORAGE_KEY] = {
      [String(TAB_ONE)]: endedByTombstone,
      [String(TAB_TWO)]: newerThanItsTombstone,
    };
    h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = [
      unbindAfterBind,
      {
        tabId: TAB_TWO,
        sessionId: SESSION_BETA,
        cause: 'tab-closed',
        createdAt: clockReading(3),
        deliveries: 0,
      },
    ];

    expect(await h.registry.reload()).toStrictEqual([newerThanItsTombstone]);

    expect(h.storage.stored()).toStrictEqual({ [String(TAB_TWO)]: newerThanItsTombstone });
    expect(h.storage.storedTombstones()).toStrictEqual([unbindAfterBind]);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.changes).toStrictEqual([]);
  });

  /** What the registry logs, code alone, each time the tombstone key cannot be read. */
  const TOMBSTONE_READ_FAILED =
    'Unbind tombstones could not be read from session storage; the read is retried on the next operation';

  /** What the registry logs, code alone, each time the tombstone list cannot be written. */
  const TOMBSTONE_WRITE_FAILED =
    'Unbind tombstones could not be written to session storage; kept in memory and retried on the next operation';

  /** Make every read of the tombstone key reject, as an unavailable storage area does. */
  function failTombstoneReads(storage: FakeSessionStorageArea): void {
    storage.keyReadFailures.set(
      UNBIND_TOMBSTONE_STORAGE_KEY,
      new Error('session storage unavailable'),
    );
  }

  /** Make every write of the tombstone key reject, as a full storage area does. */
  function failTombstoneWrites(storage: FakeSessionStorageArea): void {
    storage.keyWriteFailures.set(
      UNBIND_TOMBSTONE_STORAGE_KEY,
      new Error('session storage quota exceeded'),
    );
  }

  it('a transient tombstone read failure is retried on the next operation; the stored tombstone is neither lost nor clobbered', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_TWO, 'tab-closed');
    const stored: TabUnbindTombstone = {
      tabId: TAB_TWO,
      sessionId: SESSION_BETA,
      cause: 'tab-closed',
      createdAt: clockReading(3),
      deliveries: 0,
    };
    expect(h.storage.storedTombstones()).toStrictEqual([stored]);

    // The next generation's clock runs on past this one's three readings.
    const revived = restartWorker(h, 3);
    failTombstoneReads(revived.storage);
    revived.send.mockReturnValue(QUEUED);
    expect(await revived.registry.reload()).toStrictEqual([record]);
    expect(revived.logger.entries).toContainEqual({
      level: 'error',
      message: TOMBSTONE_READ_FAILED,
      fields: { code: 'STORE_ERROR', inMemory: 0 },
    });

    // Decided while the key is unreadable: the unbind still leaves and the record
    // still goes, but nothing is written over the stored list this worker has not read.
    await revived.registry.unbind(TAB_ONE, 'tab-closed');
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
    ]);
    expect(await revived.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(revived.storage.storedTombstones()).toStrictEqual([stored]);

    // Storage recovers: the very next operation reads the key, merges it under the
    // newer in-memory intent and writes both through.
    revived.storage.keyReadFailures.clear();
    expect(await revived.registry.listBindings()).toStrictEqual([]);
    const decidedMeanwhile: TabUnbindTombstone = {
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      cause: 'tab-closed',
      createdAt: clockReading(4),
      deliveries: 0,
    };
    expect(revived.storage.storedTombstones()).toStrictEqual([stored, decidedMeanwhile]);

    resetObservations(revived);
    revived.send.mockReturnValue(SENT);
    expect(await revived.registry.flushPendingUnbinds()).toBe(2);
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_TWO } },
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
    ]);
  });

  it('a binding the service confirms while the key is unreadable outranks the stored tombstone read later', async () => {
    await leaveWhileReconnecting(h);
    const revived = restartWorker(h, 2);
    failTombstoneReads(revived.storage);
    expect(await revived.registry.reload()).toStrictEqual([]);

    // The tombstone is unknown, so the bind leaves alone — and the service confirms it.
    expect(unwrap(await rebindTabOne(revived))).toBe('sent');
    expect(sentFrames(revived).map((frame) => frame.type)).toStrictEqual(['session.bind']);
    const record = await confirmBinding(revived, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);

    revived.storage.keyReadFailures.clear();
    resetObservations(revived);
    expect(await revived.registry.flushPendingUnbinds()).toBe(0);

    // The confirmed bind is the newer decision: the stale intent is neither sent nor kept.
    expect(revived.send).not.toHaveBeenCalled();
    expect(Object.hasOwn(revived.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    expect(await revived.registry.getBinding(TAB_ONE)).toStrictEqual(record);
  });

  it('a bind requested while the key is unreadable holds back the stored tombstone read later', async () => {
    const pending = await leaveWhileReconnecting(h);
    const revived = restartWorker(h, 2);
    failTombstoneReads(revived.storage);
    await revived.registry.reload();
    expect(unwrap(await rebindTabOne(revived))).toBe('sent');

    // Readable again before any answer to that bind: the stored tombstone is merged,
    // but flushed now it would follow the pending bind and end it.
    revived.storage.keyReadFailures.clear();
    resetObservations(revived);
    expect(await revived.registry.flushPendingUnbinds()).toBe(0);
    expect(revived.send).not.toHaveBeenCalled();
    expect(revived.storage.storedTombstones()).toStrictEqual([pending]);

    // The panel's next request sends the owed unbind ahead of its bind.
    await rebindTabOne(revived);
    expect(sentFrames(revived).map((frame) => frame.type)).toStrictEqual([
      'session.unbind',
      'session.bind',
    ]);
  });

  it.each([
    [
      'navigated-away',
      {
        kind: 'tab-left',
        origin: ORIGIN_A,
        sessionId: SESSION_ALPHA,
        reason: 'origin-changed',
      } satisfies PanelBindingState,
      'origin-changed',
      undefined,
    ],
    ['tab-closed', { kind: 'unbound' } satisfies PanelBindingState, 'unbound', 'tab-closed'],
    // Not one of the worker's three unbind causes: announced without a cause.
    ['binding-limit', { kind: 'unbound' } satisfies PanelBindingState, 'unbound', undefined],
  ] as const)(
    'a %s tombstone read back late ends the record it outranks, and announces it',
    async (cause, state, reason, changeCause) => {
      const record: TabBindingRecord = {
        tabId: TAB_ONE,
        sessionId: SESSION_ALPHA,
        url: URL_A_OVERVIEW,
        origin: ORIGIN_A,
        boundAt: clockReading(1),
      };
      const tombstone: TabUnbindTombstone = {
        tabId: TAB_ONE,
        sessionId: SESSION_ALPHA,
        cause,
        createdAt: clockReading(2),
        deliveries: 0,
      };
      h.storage.items[BINDING_STORAGE_KEY] = { [String(TAB_ONE)]: record };
      h.storage.items[UNBIND_TOMBSTONE_STORAGE_KEY] = [tombstone];
      failTombstoneReads(h.storage);

      // A worker died between writing the tombstone and dropping the record; with the
      // tombstone unreadable, the record is all this generation can see.
      expect(await h.registry.reload()).toStrictEqual([record]);
      expect(await h.registry.getPanelBindingState(TAB_ONE)).toMatchObject({ kind: 'bound' });

      h.storage.keyReadFailures.clear();

      // The later decision wins, and the panel that was shown "bound" is told.
      expect(await h.registry.getPanelBindingState(TAB_ONE)).toStrictEqual(state);
      expect(Object.hasOwn(h.storage.items, BINDING_STORAGE_KEY)).toBe(false);
      expect(h.notify.mock.calls).toStrictEqual([[TAB_ONE, bindingPushFrame(state)]]);
      expect(h.changes).toStrictEqual([
        {
          kind: 'removed',
          tabId: TAB_ONE,
          previous: record,
          current: undefined,
          state,
          reason,
          cause: changeCause,
        },
      ]);
      expect(h.storage.storedTombstones()).toStrictEqual([tombstone]);
      expect(await h.registry.flushPendingUnbinds()).toBe(1);
      expect(sentFrames(h)).toStrictEqual([
        { type: 'session.unbind', payload: { tabId: TAB_ONE } },
      ]);
    },
  );

  it('a transient tombstone write failure is persisted by the next operation; the unbind is sent and the record dropped meanwhile', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    failTombstoneWrites(h.storage);
    h.send.mockReturnValue(QUEUED);
    resetObservations(h);

    const removed = await h.registry.unbind(TAB_ONE, 'tab-closed');

    // The tab did close: the unbind leaves and the record goes, so nothing routes to it.
    expect(removed).toMatchObject({ tabId: TAB_ONE, sessionId: SESSION_ALPHA });
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(Object.hasOwn(h.storage.items, BINDING_STORAGE_KEY)).toBe(false);
    expect(h.storage.storedTombstones()).toBeUndefined();

    // Still failing, the next operation's retry fails too — one line per failure, the
    // code alone — and the intent stays in memory.
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(h.storage.storedTombstones()).toBeUndefined();
    const writeFailures = h.logger.entries.filter(
      (entry) => entry.message === TOMBSTONE_WRITE_FAILED,
    );
    expect(writeFailures).toStrictEqual([
      { level: 'error', message: TOMBSTONE_WRITE_FAILED, fields: { code: 'STORE_ERROR' } },
      { level: 'error', message: TOMBSTONE_WRITE_FAILED, fields: { code: 'STORE_ERROR' } },
    ]);

    // Storage recovers: the next operation — here the flush — writes it through first.
    h.storage.keyWriteFailures.clear();
    expect(await h.registry.flushPendingUnbinds()).toBe(1);
    expect(h.storage.storedTombstones()).toStrictEqual([
      {
        tabId: TAB_ONE,
        sessionId: SESSION_ALPHA,
        cause: 'tab-closed',
        createdAt: clockReading(2),
        deliveries: 0,
      },
    ]);

    // Durable now, the intent outlives the worker.
    const revived = restartWorker(h);
    expect(await revived.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
    ]);
  });

  it('a retirement whose write failed is written by the next operation, whatever it is', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.unbind(TAB_ONE, 'devtools-closed');
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE }]);
    failTombstoneWrites(h.storage);

    await h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW, 'unbound'));
    expect(h.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE }]);

    h.storage.keyWriteFailures.clear();
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
  });

  it('a flush never rejects, even when the transport throws or a log sink fails', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);
    await h.registry.unbind(TAB_ONE, 'tab-closed');

    const throwing = createHarness(h.storage);
    throwing.send.mockImplementation(() => {
      throw new Error('transport exploded');
    });
    expect(await throwing.registry.flushPendingUnbinds()).toBe(0);
    expect(throwing.storage.storedTombstones()).toMatchObject([{ tabId: TAB_ONE, deliveries: 0 }]);

    const failingLogger = createRecordingLogger();
    const faulty = createTabRegistry({
      storage: h.storage,
      send: vi.fn<ProtocolSend>(() => SENT),
      notify: vi.fn<PortPushSink>(),
      logger: {
        ...failingLogger,
        info: () => {
          throw new Error('log sink failed');
        },
        child: () => ({
          ...failingLogger,
          info: () => {
            throw new Error('log sink failed');
          },
        }),
      },
      now: createClock(),
    });
    await expect(faulty.flushPendingUnbinds()).resolves.toBe(0);
    expect(failingLogger.entries).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'Pending unbinds could not be flushed' }),
    );
  });
});

describe('handleUnreportableNavigation — a navigation the service cannot be told about', () => {
  it('unbinds a bound tab with session.unbind alone, pushes tab-left and answers the decision', async () => {
    const record = await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await h.registry.setCaptureId(TAB_ONE, CAPTURE_ONE);
    resetObservations(h);

    const decision = await h.registry.handleUnreportableNavigation(TAB_ONE);

    const expected: NavigationDecision = {
      kind: 'unbound-cross-origin',
      tabId: TAB_ONE,
      sessionId: SESSION_ALPHA,
      captureId: CAPTURE_ONE,
      previousOrigin: ORIGIN_A,
      origin: undefined,
      notice: formatTabLeftMessage(ORIGIN_A),
      reported: false,
    };
    expect(decision).toStrictEqual(expected);

    // No tab.navigated: the URL never leaves the worker. Only the sanitized unbind does.
    expect(sentFrames(h)).toStrictEqual([{ type: 'session.unbind', payload: { tabId: TAB_ONE } }]);
    expect(await h.registry.getBinding(TAB_ONE)).toBeUndefined();
    expect(await h.registry.getTabForSession(SESSION_ALPHA)).toBeUndefined();
    expect(Object.hasOwn(h.storage.items, BINDING_STORAGE_KEY)).toBe(false);

    const left: PanelBindingState = {
      kind: 'tab-left',
      origin: ORIGIN_A,
      sessionId: SESSION_ALPHA,
      reason: 'origin-changed',
    };
    expect(h.notify.mock.calls).toStrictEqual([[TAB_ONE, bindingPushFrame(left)]]);
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
    expect(h.storage.storedTombstones()).toStrictEqual([
      {
        tabId: TAB_ONE,
        sessionId: SESSION_ALPHA,
        cause: 'navigated-away',
        createdAt: clockReading(2),
        deliveries: 1,
      },
    ]);
  });

  it('leaves a tombstone a restarted worker flushes when the unbind was only queued', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    h.send.mockReturnValue(QUEUED);

    await h.registry.handleUnreportableNavigation(TAB_ONE);

    const revived = restartWorker(h);
    expect(await revived.registry.flushPendingUnbinds()).toBe(1);
    expect(sentFrames(revived)).toStrictEqual([
      { type: 'session.unbind', payload: { tabId: TAB_ONE } },
    ]);
  });

  it('on a tab with no binding sends, stores and announces nothing', async () => {
    await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    resetObservations(h);
    const writes = h.storage.writes;

    const decision = await h.registry.handleUnreportableNavigation(TAB_UNKNOWN);

    expect(decision).toStrictEqual({ kind: 'not-bound', tabId: TAB_UNKNOWN, reported: false });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.changes).toStrictEqual([]);
    expect(h.storage.writes).toBe(writes);
    expect(Object.hasOwn(h.storage.items, UNBIND_TOMBSTONE_STORAGE_KEY)).toBe(false);
    expect(await h.registry.getPanelBindingState(TAB_UNKNOWN)).toStrictEqual({ kind: 'unbound' });
  });

  it('refuses an invalid tab id without touching storage', async () => {
    const decision = await h.registry.handleUnreportableNavigation(-1);

    expect(decision).toStrictEqual({ kind: 'not-bound', tabId: -1, reported: false });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.storage.reads).toBe(0);
    expect(h.storage.writes).toBe(0);
  });

  it('runs on the operation queue, after a binding still being recorded', async () => {
    const binding = h.registry.applyBound(bound(TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW));
    const leaving = h.registry.handleUnreportableNavigation(TAB_ONE);

    const [bindResult, decision] = await Promise.all([binding, leaving]);

    expect(unwrap(bindResult).kind).toBe('recorded');
    expect(decision).toMatchObject({ kind: 'unbound-cross-origin', sessionId: SESSION_ALPHA });
    expect(await h.registry.listBindings()).toStrictEqual([]);
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

  it('never writes a document URL into a log line on the tombstone paths', async () => {
    await confirmBinding(h, TAB_ONE, SESSION_ALPHA, URL_A_OVERVIEW);
    await confirmBinding(h, TAB_TWO, SESSION_BETA, URL_A_SETTINGS);
    h.send.mockReturnValue(QUEUED);
    await h.registry.handleNavigated({ tabId: TAB_ONE, url: URL_B_LANDING });
    await h.registry.handleUnreportableNavigation(TAB_TWO);
    await h.registry.flushPendingUnbinds();
    await h.registry.requestBind({ tabId: TAB_ONE, url: URL_A_OVERVIEW, origin: ORIGIN_A });
    await h.registry.applyBound(bound(TAB_TWO, SESSION_BETA, URL_A_SETTINGS, 'unbound'));
    const revived = restartWorker(h);
    await revived.registry.flushPendingUnbinds();

    const entries = [...h.logger.entries, ...revived.logger.entries];
    expect(entries.some((entry) => entry.message === 'Pending unbinds flushed')).toBe(true);
    for (const entry of entries) {
      expect(JSON.stringify(entry)).not.toContain(PATH_SEGMENT);
    }
  });
});

/*
 * ===========================================================================
 * The composed worker — `createWorker` wiring of the registry's unbind paths
 *
 * The registry decides; `service-worker.ts` must call it. These cases compose
 * the real worker over in-memory fakes — `chrome.storage` areas backed by
 * {@link FakeSessionStorageArea}, events that record their listeners, timers
 * that never fire and a socket the case accepts by hand — and read what
 * reached the socket:
 *
 * - a bound tab that commits a document off the app (`about:blank`, a
 *   `chrome://` page, a `file:` document, or a URL with no reportable form at
 *   all) is unbound, shows "Tab left ‹origin›", and leaves a tombstone;
 * - the tombstones an earlier worker generation left are re-sent as soon as
 *   the socket opens, before anything else of the tab is said.
 * ===========================================================================
 */

/** The WHATWG `WebSocket.readyState` values the fake socket moves through. */
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

/** A syntactically valid devtools credential, invented for this spec. */
const WORKER_TOKEN = 'test-devtools-credential';

/** The extension id the composed worker's port hub validates senders against. */
const WORKER_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** A socket the case opens by hand; it records every text frame written to it. */
interface HandSocket extends WebSocketLike {
  /** Every text frame written, in order. */
  readonly sent: readonly string[];
  /** The service accepted the connection: `readyState` OPEN, then `open`. */
  accept(): void;
}

/** A recording socket constructor and every socket it built. */
function handSocketFactory(): {
  readonly ctor: WebSocketConstructorLike;
  readonly sockets: HandSocket[];
} {
  const sockets: HandSocket[] = [];
  class RecordingSocket implements HandSocket {
    readyState: number = SOCKET_CONNECTING;
    readonly sent: string[] = [];
    private readonly openListeners = new Set<(event: WsEventMapLike['open']) => void>();

    constructor() {
      sockets.push(this);
    }

    addEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      if (type === 'open') {
        this.openListeners.add(listener as (event: WsEventMapLike['open']) => void);
      }
    }

    removeEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      if (type === 'open') {
        this.openListeners.delete(listener as (event: WsEventMapLike['open']) => void);
      }
    }

    send(data: string): void {
      if (this.readyState !== SOCKET_OPEN) {
        throw new Error('the hand socket is not open');
      }
      this.sent.push(data);
    }

    close(): void {
      this.readyState = SOCKET_CONNECTING;
    }

    accept(): void {
      this.readyState = SOCKET_OPEN;
      for (const listener of [...this.openListeners]) {
        listener({ type: 'open' });
      }
    }
  }
  return { ctor: RecordingSocket, sockets };
}

/** A `WorkerEvent` that records its listeners, so a case can fire them. */
interface FiringEvent<Listener> extends WorkerEvent<Listener> {
  readonly listeners: Set<Listener>;
}

function firingEvent<Listener>(): FiringEvent<Listener> {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener(listener: Listener): void {
      listeners.add(listener);
    },
    removeListener(listener: Listener): void {
      listeners.delete(listener);
    },
  };
}

/** Timers that never fire: nothing in these cases waits on a backoff or a deadline. */
const DORMANT_TIMERS: WorkerTimerApi = {
  setTimeout: (): number => 0,
  clearTimeout: (): void => undefined,
};

/** One composed worker and the fakes a case drives it through. */
interface WorkerHarness {
  readonly worker: DebugGeneratorWorker;
  readonly session: FakeSessionStorageArea;
  readonly sockets: readonly HandSocket[];
  readonly onUpdated: FiringEvent<(tabId: TabId, change: WorkerTabChange, tab: WorkerTab) => void>;
}

/** Every worker a case composed, disposed after it. */
const composedWorkers: DebugGeneratorWorker[] = [];

/**
 * Compose a paired worker whose session storage holds `bindings` (and
 * `tombstones`, when given), and wait for its cold start — after which its
 * socket exists but has not opened.
 */
async function composeWorker(
  bindings: readonly TabBindingRecord[],
  tombstones?: readonly TabUnbindTombstone[],
): Promise<WorkerHarness> {
  const session = new FakeSessionStorageArea();
  const snapshot: TabBindingSnapshot = Object.fromEntries(
    bindings.map((binding) => [String(binding.tabId), binding]),
  );
  if (bindings.length > 0) {
    await session.set({ [BINDING_STORAGE_KEY]: snapshot });
  }
  if (tombstones !== undefined) {
    await session.set({ [UNBIND_TOMBSTONE_STORAGE_KEY]: tombstones });
  }
  const local = new FakeSessionStorageArea();
  await local.set({
    [DEVTOOLS_TOKEN_STORAGE_KEY]: { version: STORED_CREDENTIAL_VERSION, token: WORKER_TOKEN },
  });
  const { ctor, sockets } = handSocketFactory();
  const onUpdated = firingEvent<(tabId: TabId, change: WorkerTabChange, tab: WorkerTab) => void>();
  const environment: WorkerEnvironment = {
    runtime: {
      id: WORKER_EXTENSION_ID,
      onConnect: firingEvent(),
      onInstalled: firingEvent(),
      onStartup: firingEvent(),
    },
    tabs: {
      reload: (): Promise<void> => Promise.resolve(),
      get: (): Promise<WorkerTab> => Promise.resolve({}),
      onUpdated,
      onRemoved: firingEvent(),
    },
    alarms: {
      create: (): Promise<void> => Promise.resolve(),
      clear: (): Promise<boolean> => Promise.resolve(false),
      onAlarm: firingEvent(),
    },
    storage: { local, session },
    webSocketConstructor: ctor,
    timers: DORMANT_TIMERS,
    logger: noopLogger,
  };
  const worker = createWorker(environment);
  composedWorkers.push(worker);
  await worker.ready;
  return { worker, session, sockets, onUpdated };
}

/** Open the worker's socket and wait until its `client.hello` has been written. */
async function openSocket(harness: WorkerHarness): Promise<HandSocket> {
  const socket = required(harness.sockets.at(-1), 'the worker socket');
  socket.accept();
  await vi.waitFor(() => {
    expect(socketFrames(socket).length).toBeGreaterThan(0);
  });
  return socket;
}

/** Every frame written to a socket, decoded to its type and payload. */
function socketFrames(socket: HandSocket): SentFrame[] {
  return socket.sent.map((text) => {
    const frame = JSON.parse(text) as { readonly type: string; readonly payload: unknown };
    return { type: frame.type, payload: frame.payload };
  });
}

/** The frames of one type written to a socket, by payload. */
function framesOfType(socket: HandSocket, type: string): unknown[] {
  return socketFrames(socket)
    .filter((frame) => frame.type === type)
    .map((frame) => frame.payload);
}

/** Fire `chrome.tabs.onUpdated` for a committed navigation of `tabId` to `url`. */
function commitNavigation(harness: WorkerHarness, tabId: TabId, url: string): void {
  for (const listener of [...harness.onUpdated.listeners]) {
    listener(tabId, { url, status: 'loading' }, { url });
  }
}

/** A binding as the registry writes it to `chrome.storage.session`. */
function storedBinding(tabId: TabId, sessionId: string): TabBindingRecord {
  return { tabId, sessionId, url: URL_A_OVERVIEW, origin: ORIGIN_A, boundAt: CLOCK_START_MS };
}

describe('createWorker — a bound tab that leaves the app is unbound, however its URL reads', () => {
  afterEach(() => {
    for (const worker of composedWorkers.splice(0)) {
      worker.dispose();
    }
  });

  it.each([
    ['about:blank', 'about:blank'],
    ['a chrome:// page', 'chrome://newtab/'],
    ['a file: document', 'file:///home/dev/notes.html'],
  ])('unbinds on a navigation to %s and shows the tab left', async (_label, url) => {
    const harness = await composeWorker([storedBinding(TAB_ONE, SESSION_ALPHA)]);
    const socket = await openSocket(harness);

    commitNavigation(harness, TAB_ONE, url);

    await vi.waitFor(async () => {
      expect(await harness.worker.registry.getBinding(TAB_ONE)).toBeUndefined();
    });
    expect(framesOfType(socket, 'session.unbind')).toContainEqual({ tabId: TAB_ONE });
    expect(await harness.worker.registry.getPanelBindingState(TAB_ONE)).toStrictEqual({
      kind: 'tab-left',
      origin: ORIGIN_A,
      sessionId: SESSION_ALPHA,
      reason: 'origin-changed',
    });
    // Nothing of the document's path reaches the service.
    expect(socket.sent.join('\n')).not.toContain('/home/dev/');
  });

  it('unbinds with session.unbind alone when the new URL has no form the service accepts', async () => {
    const harness = await composeWorker([storedBinding(TAB_ONE, SESSION_ALPHA)]);
    const socket = await openSocket(harness);

    commitNavigation(harness, TAB_ONE, 'not an absolute url');

    await vi.waitFor(async () => {
      expect(await harness.worker.registry.getBinding(TAB_ONE)).toBeUndefined();
    });
    expect(framesOfType(socket, 'session.unbind')).toStrictEqual([{ tabId: TAB_ONE }]);
    expect(framesOfType(socket, 'tab.navigated')).toStrictEqual([]);
    expect(await harness.worker.registry.getPanelBindingState(TAB_ONE)).toMatchObject({
      kind: 'tab-left',
      origin: ORIGIN_A,
    });
    expect(harness.session.storedTombstones()).toMatchObject([
      { tabId: TAB_ONE, sessionId: SESSION_ALPHA, cause: 'navigated-away' },
    ]);
  });

  it('reports nothing for an unbound tab, whatever its URL', async () => {
    const harness = await composeWorker([storedBinding(TAB_ONE, SESSION_ALPHA)]);
    const socket = await openSocket(harness);
    const before = socket.sent.length;

    commitNavigation(harness, TAB_TWO, 'not an absolute url');
    commitNavigation(harness, TAB_TWO, 'about:blank');

    await Promise.resolve();
    expect(await harness.worker.registry.getBinding(TAB_ONE)).toBeDefined();
    expect(socket.sent.slice(before)).toStrictEqual([]);
  });
});

describe('createWorker — tombstones left by an earlier worker are delivered on connect', () => {
  afterEach(() => {
    for (const worker of composedWorkers.splice(0)) {
      worker.dispose();
    }
  });

  it('re-sends every pending unbind as soon as the socket opens', async () => {
    const pending: TabUnbindTombstone[] = [
      {
        tabId: TAB_ONE,
        sessionId: SESSION_ALPHA,
        cause: 'tab-closed',
        createdAt: Date.now(),
        deliveries: 0,
      },
      { tabId: TAB_TWO, cause: 'devtools-closed', createdAt: Date.now(), deliveries: 0 },
    ];
    const harness = await composeWorker([], pending);
    expect(harness.sockets.length).toBe(1);

    const socket = await openSocket(harness);

    await vi.waitFor(() => {
      expect(framesOfType(socket, 'session.unbind')).toStrictEqual([
        { tabId: TAB_ONE },
        { tabId: TAB_TWO },
      ]);
    });
    expect(socketFrames(socket)[0]?.type).toBe('client.hello');
    // Delivered on an open socket, each is counted against its bound.
    await vi.waitFor(() => {
      expect(harness.session.storedTombstones()).toMatchObject([
        { tabId: TAB_ONE, deliveries: 1 },
        { tabId: TAB_TWO, deliveries: 1 },
      ]);
    });
  });

  it('sends nothing on connect when no unbind is pending', async () => {
    const harness = await composeWorker([]);
    const socket = await openSocket(harness);

    await Promise.resolve();
    expect(framesOfType(socket, 'session.unbind')).toStrictEqual([]);
  });
});
