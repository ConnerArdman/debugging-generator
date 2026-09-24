/**
 * The service worker's memory of which inspected tab belongs to which
 * debugging session — the tab ↔ session registry of AAP §0.7.1 Group 4,
 * persisted in `chrome.storage.session`.
 *
 * ## The worker mirrors; the service decides
 *
 * AAP §0.2.3 makes the **local service** the authority on bindings: the
 * DevTools panel announces its inspected tab with `session.bind`, the service
 * matches the tab's origin against a session's dev-server origin (or checks
 * the origin of the session the panel named) and answers `session.bound`. This
 * module therefore does exactly two things with a binding:
 *
 * - it **requests** one ({@link TabRegistry.requestBind}), which records
 *   nothing, and
 * - it **records** what the service confirmed ({@link TabRegistry.applyBound}),
 *   which is the only path that creates a {@link TabBindingRecord}.
 *
 * A tab whose origin "looks right" is never bound locally: that would let a tab
 * claim a session the service never approved.
 *
 * ## The rules it keeps (AAP §0.2.3, §0.4.2, §0.5.5)
 *
 * 1. One tab binds to at most one session, and one session accepts one bound
 *    tab at a time. Recording a binding removes any other record for the same
 *    session and replaces any record for the same tab; a tab displaced that way
 *    is told through its panel, so it never keeps claiming "Connected".
 * 2. Every committed navigation of a tab is reported as `tab.navigated`. A
 *    same-origin navigation keeps the binding (and the capture running on it)
 *    and returns a decision telling `agent-control.ts` to re-arm the page agent;
 *    a cross-origin navigation sends `session.unbind`, drops the record and
 *    pushes the "Tab left ‹origin›" state to the panel.
 * 3. DevTools closing, the tab closing and the session ending all send
 *    `session.unbind`.
 *
 * ## Why `chrome.storage.session`
 *
 * A Manifest V3 service worker is evicted after roughly thirty seconds idle and
 * re-evaluated from scratch on the next event, so a binding held only in memory
 * would vanish mid-session. `chrome.storage.session` survives that eviction and
 * is cleared when the browser session ends — exactly the lifetime a binding
 * has: tab ids are only meaningful within one browser session, and a binding
 * that outlived it would route telemetry to whatever tab reused the id.
 * `chrome.storage.local` is wrong for the same reason — it persists across
 * browser restarts, so a stale binding would outlive the tabs it names.
 *
 * The in-memory map is a **cache** of that storage, never the source of truth.
 * After a revival it is empty, so every read path hydrates from storage first
 * ({@link TabRegistry.reload}), and every mutation is written through to
 * storage before it is announced to a panel or a listener. What is read back is
 * untrusted JSON from an earlier worker generation, and each entry is validated
 * field by field before it is relied on; a malformed entry is dropped, never
 * cast.
 *
 * ## Invariants
 *
 * - **No import-time side effect.** Every top-level statement is a declaration;
 *   all state lives in the {@link createTabRegistry} closure, and no `chrome.*`
 *   listener is registered here — `service-worker.ts` owns
 *   `chrome.tabs.onUpdated`/`onRemoved` and feeds this module.
 * - **No transport.** Frames leave through the injected {@link ProtocolSend};
 *   panel state leaves through the injected {@link PortPushSink}. No socket, no
 *   `fetch`, no `chrome.tabs`, no `chrome.alarms`, nothing read from a page.
 * - **Serialized.** Every operation — reads included — runs on one promise
 *   chain, so two rapid navigations cannot interleave into a lost update and
 *   outbound frames leave in the order the calls were made.
 * - **No authored wording.** The "Tab left ‹origin›" notice is
 *   `formatTabLeftMessage` from `../shared/messages`; every binding reason is a
 *   member of the protocol's `BINDING_REASONS` vocabulary.
 * - **Privacy.** Log lines carry the tab id, session id, origin and decision
 *   only — never a URL (its path and query stay out of every log), never a
 *   token, never page content. URLs handed to this module are expected to be
 *   query-redacted by their producer (AAP §0.5.2); the module stores and sends
 *   them as given and never inspects them beyond their origin.
 *
 * Governed by AAP §0.2.3 ("Tab/session binding"), §0.4.2 (the `session.bind`,
 * `session.bound`, `tab.navigated` and `session.unbind` rows), §0.5.5
 * ("Application reloads mid-session"), §0.7.1 Group 4 and §0.8.1 slice 4.
 *
 * @module apps/chrome-extension/src/background/tab-registry
 */

import type {
  BindingReason,
  CaptureStartedPayload,
  CaptureStoppedPayload,
  MessagePayload,
  MessageType,
  SendOutcome,
  SessionBindPayload,
  SessionBoundPayload,
  SessionStatus,
  SessionUnbindPayload,
  SessionUpdatedPayload,
  TabNavigatedPayload,
} from '@debuggen/protocol';
import { parseSessionBindPayload, parseSessionBoundPayload } from '@debuggen/protocol';
import type { CaptureId, LogFields, Logger, Result, SessionId } from '@debuggen/shared';
import { assertNever, DebuggenError, err, noopLogger, nowEpochMs, ok } from '@debuggen/shared';

import type { PanelBindingState, PortBindingPush } from '../shared/messages';
import { EXTENSION_CHANNEL, formatTabLeftMessage, PORT_PROTOCOL_VERSION } from '../shared/messages';

import type { PortPushSink, ProtocolSend, TabBindingRecord, TabBindingSnapshot } from './messages';
import { workerError } from './messages';

/*
 * ===========================================================================
 * Section A — derived primitives and vocabulary
 * ===========================================================================
 */

/** A Chrome tab id, exactly as the protocol's binding payloads type it. */
type TabId = SessionBindPayload['tabId'];

/** A wall-clock instant in epoch milliseconds, as {@link nowEpochMs} returns it. */
type EpochMs = ReturnType<typeof nowEpochMs>;

/*
 * The binding reasons this module branches on or announces. Each is a member
 * of the protocol's closed `BINDING_REASONS` vocabulary — `satisfies` makes a
 * reason the vocabulary does not contain a compile error here — and every
 * `switch` over a `BindingReason` below ends in `assertNever`, so a reason
 * added upstream stops this module compiling until it is handled.
 */
const REASON_BOUND = 'bound' satisfies BindingReason;
const REASON_REPLACED = 'replaced' satisfies BindingReason;
const REASON_NAVIGATED = 'navigated' satisfies BindingReason;
const REASON_ORIGIN_CHANGED = 'origin-changed' satisfies BindingReason;
const REASON_UNBOUND = 'unbound' satisfies BindingReason;

/**
 * The session status that means "this session is over" — a member of the
 * protocol's `SESSION_STATUSES`, checked by `satisfies`. The registry reacts to
 * it arriving on `session.updated`; it never derives it.
 */
const SESSION_STATUS_ENDED = 'ended' satisfies SessionStatus;

/**
 * The key under which the whole binding map is stored in
 * `chrome.storage.session`.
 *
 * Declared once, here, because this module is the single owner of that
 * storage entry: nothing else in the extension reads or writes it. The value
 * stored under it is a {@link TabBindingSnapshot}.
 */
export const BINDING_STORAGE_KEY = 'debuggen.tabBindings';

/**
 * Why the worker itself ends a binding — the three causes of `session.unbind`
 * the worker observes (AAP §0.2.3): the DevTools window inspecting the tab
 * closed (the panel or devtools port disconnected, reported by `ports.ts`), the
 * tab closed (`chrome.tabs.onRemoved`, fed by `service-worker.ts`), or the
 * session ended (relayed `session.updated` / `cleanup.completed`).
 *
 * A worker-internal vocabulary: it is logged and reported on
 * {@link TabBindingChange.cause}, and never sent — the wire payload of
 * `session.unbind` is the tab id alone, because the service does not need to
 * know which of the three it was.
 */
export const TAB_UNBIND_CAUSES = Object.freeze([
  'devtools-closed',
  'tab-closed',
  'session-ended',
] as const);

/** One of {@link TAB_UNBIND_CAUSES}. */
export type TabUnbindCause = (typeof TAB_UNBIND_CAUSES)[number];

/** The cause {@link TabRegistry.handleSessionEnded} unbinds under. */
const CAUSE_SESSION_ENDED = 'session-ended' satisfies TabUnbindCause;

/**
 * The cause whose unbind is reported even when no record exists: a panel that
 * was open on the tab may have asked for a binding the service confirmed but
 * whose `session.bound` has not reached this worker yet, and `session.unbind`
 * is idempotent at the service, so reporting it costs nothing and closes that
 * race.
 */
const CAUSE_DEVTOOLS_CLOSED = 'devtools-closed' satisfies TabUnbindCause;

/*
 * ===========================================================================
 * Section B — the injection surface
 * ===========================================================================
 */

/**
 * The part of a `chrome.storage` area the registry uses: promise-returning
 * `get`, `set` and `remove` of one key.
 *
 * `chrome.storage.session` satisfies it — {@link ChromeSessionStorageSatisfiesTabRegistryStorage}
 * proves that at compile time — so `service-worker.ts` passes the real area,
 * and a unit test passes a small fake over a plain object. The values are typed
 * `unknown` on the way out on purpose: whatever `get` returns is re-validated
 * before it is trusted.
 */
export interface TabRegistryStorageArea {
  /** Read one key; resolves to an object holding it when it is set. */
  get(keys: string): Promise<Record<string, unknown>>;
  /** Write every key of `items`. */
  set(items: Record<string, unknown>): Promise<void>;
  /** Delete one key. */
  remove(keys: string): Promise<void>;
}

/**
 * Fails to compile unless its argument is exactly `true` — the same private
 * helper `./messages` declares for its own drift assertion.
 */
type AssertTrue<Assertion extends true> = Assertion;

/**
 * Compile-time proof that the real `chrome.storage.session` area is assignable
 * to {@link TabRegistryStorageArea}: if `@types/chrome` ever changes `get`,
 * `set` or `remove` incompatibly, the argument becomes `false` and `tsc -b`
 * fails here (TS2344) rather than at the wiring in `service-worker.ts`.
 * Type-level only — it emits nothing, and it is exported solely so
 * `noUnusedLocals` accepts it.
 */
export type ChromeSessionStorageSatisfiesTabRegistryStorage = AssertTrue<
  typeof chrome.storage.session extends TabRegistryStorageArea ? true : false
>;

/** What {@link createTabRegistry} is built from. */
export interface TabRegistryDeps {
  /**
   * Where bindings persist: `chrome.storage.session` in the worker, a fake in a
   * test. See the module overview for why it is the session area.
   */
  readonly storage: TabRegistryStorageArea;
  /**
   * Send one protocol frame to the service — `session.bind`, `tab.navigated`
   * and `session.unbind` are the three this module sends. The socket belongs to
   * `ws-bridge.ts`; this module never touches it.
   */
  readonly send: ProtocolSend;
  /**
   * Push one binding state to the panels of one tab. A tab with no panel is a
   * normal condition, so nothing is expected back.
   */
  readonly notify: PortPushSink;
  /** Where diagnostics go; defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
  /** The epoch-millisecond clock stamping `boundAt`; defaults to `nowEpochMs`. */
  readonly now?: (() => EpochMs) | undefined;
}

/**
 * What {@link TabRegistry.requestBind} asks the service for — the fields of a
 * `session.bind` payload, with `sessionId` omitted (or `undefined`) meaning
 * "bind me to whichever session owns this origin".
 */
export interface TabBindRequest {
  /** The inspected tab, from `chrome.devtools.inspectedWindow.tabId`. */
  readonly tabId: TabId;
  /** The tab's current document URL, query-redacted by its producer. */
  readonly url: string;
  /** That URL's serialized origin. */
  readonly origin: string;
  /** The session asked for, when the panel asks for one in particular. */
  readonly sessionId?: SessionId | undefined;
}

/**
 * A committed navigation, as `service-worker.ts` observed it on
 * `chrome.tabs.onUpdated` — the `tab.navigated` payload's own shape.
 */
export type TabNavigation = TabNavigatedPayload;

/*
 * ===========================================================================
 * Section C — what the registry answers
 * ===========================================================================
 */

/**
 * The verdict on one committed navigation, returned by
 * {@link TabRegistry.handleNavigated} and consumed by `agent-control.ts`
 * (through `service-worker.ts`), which acts on it: this module decides, it does
 * not re-arm or disarm anything itself.
 *
 * Discriminated on `kind`, so a consumer's `switch` narrows exhaustively:
 *
 * - `kept-same-origin` — the tab stayed on its bound origin (a reload, or an
 *   in-app navigation). The binding is kept with its new `url`, and the page
 *   agent must be **re-armed** in the new document with the same
 *   configuration. `captureId` is the capture that was running, preserved so
 *   the same capture continues across the reload (AAP §0.5.5).
 * - `unbound-cross-origin` — the tab left its bound origin (or navigated to a
 *   document with no usable origin, such as `about:blank` or a `chrome://`
 *   page). `session.unbind` was sent, the record was dropped, and the panel was
 *   told the tab left. The page agent must be returned to **dormant**, and
 *   `captureId` is the capture that was running when the tab left, if any.
 *   `notice` is the panel's sentence for this state, from
 *   `formatTabLeftMessage`, for a caller that surfaces it elsewhere (a status
 *   hint, an event-log entry).
 * - `not-bound` — the tab holds no binding; the navigation was reported and
 *   nothing else happened. An unbound tab navigating is not an event.
 *
 * `reported` says whether the `tab.navigated` frame was handed to the transport
 * (sent, or queued while the socket reconnects).
 */
export type NavigationDecision =
  | {
      readonly kind: 'kept-same-origin';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId: CaptureId | undefined;
      readonly url: string;
      readonly origin: string;
      readonly reported: boolean;
    }
  | {
      readonly kind: 'unbound-cross-origin';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId: CaptureId | undefined;
      /** The origin the tab left — the one its binding was for. */
      readonly previousOrigin: string;
      /** The new document's origin, or `undefined` when it has none (opaque or unparseable). */
      readonly origin: string | undefined;
      /** `formatTabLeftMessage(previousOrigin)`. */
      readonly notice: string;
      readonly reported: boolean;
    }
  | {
      readonly kind: 'not-bound';
      readonly tabId: TabId;
      readonly reported: boolean;
    };

/** One of the {@link NavigationDecision} kinds. */
export type NavigationDecisionKind = NavigationDecision['kind'];

/**
 * What one {@link TabRegistry.applyBound} did with the service's announcement.
 *
 * - `recorded` — a binding was established (or replaced the tab's binding to
 *   another session). `previous` is the tab's earlier record, if it had one;
 *   `displaced` lists the records of *other* tabs removed because the session
 *   may hold only one tab, each of whose panels was told.
 * - `updated` — an existing binding of this tab to this session was refreshed:
 *   a re-announcement after a reconnect, or a kept same-origin navigation.
 * - `removed` — the announcement dropped this tab's binding (`replaced`,
 *   `origin-changed` or `unbound`); `removed` is the record that was dropped.
 * - `ignored` — the announcement was about a binding this worker does not hold
 *   (a late frame about an older binding, or a drop already applied). A late
 *   frame must never undo the current binding, so it changes nothing.
 */
export type ApplyBoundOutcome =
  | {
      readonly kind: 'recorded';
      readonly record: TabBindingRecord;
      readonly previous: TabBindingRecord | undefined;
      readonly displaced: readonly TabBindingRecord[];
      readonly reason: BindingReason;
    }
  | {
      readonly kind: 'updated';
      readonly record: TabBindingRecord;
      readonly reason: BindingReason;
    }
  | {
      readonly kind: 'removed';
      readonly removed: TabBindingRecord;
      readonly reason: BindingReason;
    }
  | {
      readonly kind: 'ignored';
      readonly reason: BindingReason;
    };

/**
 * One change to one tab's binding, delivered to every {@link TabRegistry.onChange}
 * listener after the change was written through and pushed to the tab's panel.
 *
 * `service-worker.ts` uses it to refresh the `WorkerStatusSnapshot` it pushes to
 * panels. `state` is the {@link PanelBindingState} that was pushed; `reason` is
 * the protocol reason the change corresponds to (the service's own, when the
 * change came from `session.bound`); `cause` is set when the worker itself
 * unbound the tab.
 */
export interface TabBindingChange {
  /** `recorded` (a new binding), `updated` (url or capture changed) or `removed`. */
  readonly kind: 'recorded' | 'updated' | 'removed';
  /** The tab whose binding changed. */
  readonly tabId: TabId;
  /** The record before the change, if there was one. */
  readonly previous: TabBindingRecord | undefined;
  /** The record after the change, if there is one. */
  readonly current: TabBindingRecord | undefined;
  /** What the tab's panel was told. */
  readonly state: PanelBindingState;
  /** The binding reason the change corresponds to. */
  readonly reason: BindingReason;
  /** Why the worker unbound the tab, when it did. */
  readonly cause: TabUnbindCause | undefined;
}

/** A {@link TabRegistry.onChange} subscriber. */
export type TabBindingListener = (change: TabBindingChange) => void;

/**
 * The registry. Every member is a function-valued property rather than a
 * method, so `service-worker.ts` can hand one on as a plain callback
 * (`listBindings: registry.listBindings`) without binding it. Every
 * asynchronous member runs on the registry's single operation queue, in call
 * order, and none rejects for an expected condition.
 */
export interface TabRegistry {
  /**
   * Re-read the bindings from storage, replacing the in-memory cache.
   *
   * `service-worker.ts` calls it on a cold start; every other read path
   * hydrates on its own when the cache is cold, so calling it is never
   * required for correctness. Malformed entries are dropped (and the cleaned
   * map written back).
   *
   * @returns Every valid binding, ordered by tab id.
   */
  readonly reload: () => Promise<readonly TabBindingRecord[]>;

  /**
   * Ask the service to bind a tab: send `session.bind`. Records nothing — the
   * binding exists once the service answers and {@link applyBound} records it.
   *
   * @returns The transport's outcome: `ok('sent')`, or `ok('queued')` while
   * the socket reconnects (a success, AAP §0.5.5); an `err` when the request is
   * not a valid `session.bind` payload (`PROTOCOL_INVALID_MESSAGE`, nothing
   * sent) or the transport refused it.
   */
  readonly requestBind: (request: TabBindRequest) => Promise<Result<SendOutcome, DebuggenError>>;

  /**
   * Record the service's `session.bound` announcement — the authoritative
   * write. Enforces one tab per session and one session per tab, writes
   * through, pushes the new state to the affected tabs' panels and notifies
   * listeners.
   *
   * @returns What was done, or an `err` (`PROTOCOL_INVALID_MESSAGE`) when the
   * payload is not a valid `session.bound`, or names a document without an
   * HTTP(S) origin, in which case nothing changes.
   */
  readonly applyBound: (
    payload: SessionBoundPayload,
  ) => Promise<Result<ApplyBoundOutcome, DebuggenError>>;

  /**
   * Handle one committed navigation: always report `tab.navigated`, then keep
   * the binding (same origin) or drop it (different origin). See
   * {@link NavigationDecision}.
   */
  readonly handleNavigated: (navigation: TabNavigation) => Promise<NavigationDecision>;

  /**
   * End a tab's binding because DevTools closed, the tab closed or the session
   * ended: send `session.unbind`, drop the record, write through, push the
   * `unbound` state and notify.
   *
   * `session.unbind` is sent whenever the tab held a record, and additionally
   * for `'devtools-closed'` even without one (see the module notes on that
   * cause); for a tab this worker knows nothing about, closing it sends nothing.
   *
   * @returns The record that was removed, or `undefined` when there was none.
   */
  readonly unbind: (tabId: TabId, cause: TabUnbindCause) => Promise<TabBindingRecord | undefined>;

  /**
   * Unbind whichever tab holds a session that has ended.
   *
   * @returns The record that was removed, or `undefined` when no tab held it.
   */
  readonly handleSessionEnded: (sessionId: SessionId) => Promise<TabBindingRecord | undefined>;

  /**
   * React to a relayed `session.updated`: when the record's status is the
   * ended status, unbind the tab that held the session. Any other status is
   * the service's state machine at work and changes nothing here.
   *
   * @returns The record that was removed, if any.
   */
  readonly handleSessionUpdated: (
    payload: SessionUpdatedPayload,
  ) => Promise<TabBindingRecord | undefined>;

  /**
   * Remember the capture running on a bound tab, so a mid-capture reload
   * continues the same capture.
   *
   * @returns `true` when the tab is bound and the id was stored; `false` when
   * the tab is not bound or the id is empty.
   */
  readonly setCaptureId: (tabId: TabId, captureId: CaptureId) => Promise<boolean>;

  /**
   * Forget the capture on a bound tab. When `captureId` is given, only that
   * capture is cleared — a late `capture.stopped` for an earlier capture must
   * not clear a newer one.
   *
   * @returns `true` when a stored capture id was cleared.
   */
  readonly clearCaptureId: (tabId: TabId, captureId?: CaptureId) => Promise<boolean>;

  /**
   * Apply a relayed `capture.started`: store its `captureId` on the tab bound
   * to its session.
   *
   * @returns The tab that was updated, or `undefined` when no tab holds the session.
   */
  readonly handleCaptureStarted: (payload: CaptureStartedPayload) => Promise<TabId | undefined>;

  /**
   * Apply a relayed `capture.stopped`: clear that capture from the tab bound to
   * its session, if it is still the stored one.
   *
   * @returns The tab that was updated, or `undefined` when nothing was cleared.
   */
  readonly handleCaptureStopped: (payload: CaptureStoppedPayload) => Promise<TabId | undefined>;

  /** The binding of one tab, or `undefined`. Hydrates when the cache is cold. */
  readonly getBinding: (tabId: TabId) => Promise<TabBindingRecord | undefined>;

  /** The tab bound to one session, or `undefined`. Hydrates when the cache is cold. */
  readonly getTabForSession: (sessionId: SessionId) => Promise<TabId | undefined>;

  /** Every binding, ordered by tab id. Hydrates when the cache is cold. */
  readonly listBindings: () => Promise<readonly TabBindingRecord[]>;

  /**
   * The {@link PanelBindingState} a panel inspecting this tab should render:
   * `bound` for a recorded binding, `tab-left` after the tab navigated off its
   * bound origin (until it binds again, is unbound or closes), and `unbound`
   * otherwise. What `session.snapshot` answers a freshly opened panel with.
   *
   * The `tab-left` memory is held in the worker's memory only; after an
   * eviction a reopened panel sees `unbound`, which is also true.
   */
  readonly getPanelBindingState: (tabId: TabId) => Promise<PanelBindingState>;

  /**
   * Subscribe to binding changes.
   *
   * @returns A function that removes the subscription; calling it twice is
   * harmless.
   */
  readonly onChange: (listener: TabBindingListener) => () => void;
}

/*
 * ===========================================================================
 * Section D — pure helpers
 *
 * Total functions: each returns a value for every input and none throws. The
 * guards narrow through `typeof` and plain property reads, so nothing read
 * back from storage is ever cast into a record.
 * ===========================================================================
 */

/** A plain object — not `null`, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string with at least one character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A Chrome tab id: a non-negative safe integer. `-1` is
 * `chrome.tabs.TAB_ID_NONE`, never a tab — the protocol's rule too.
 */
function isTabId(value: unknown): value is TabId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A plausible epoch-millisecond stamp: a finite, non-negative number. */
function isEpochMs(value: unknown): value is EpochMs {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The serialized origin of an HTTP or HTTPS URL, or `undefined` when the URL
 * does not parse or has no such origin (`about:blank`, `chrome://…`, an
 * extension page, `file://…`).
 *
 * Origins are always compared through this — the platform `URL` parser's own
 * serialization — and never by a string prefix, which would equate
 * `http://127.0.0.1:3000` with `http://127.0.0.1:30001`.
 */
function httpOriginOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/** Every field of a {@link TabBindingRecord}, with `captureId` spelled out. */
interface TabBindingFields {
  readonly tabId: TabId;
  readonly sessionId: SessionId;
  readonly url: string;
  readonly origin: string;
  readonly boundAt: EpochMs;
  readonly captureId: CaptureId | undefined;
}

/**
 * Build a frozen record. `captureId` is omitted rather than stored as
 * `undefined`, so the JSON written to storage has no empty keys.
 */
function makeRecord(fields: TabBindingFields): TabBindingRecord {
  const base = {
    tabId: fields.tabId,
    sessionId: fields.sessionId,
    url: fields.url,
    origin: fields.origin,
    boundAt: fields.boundAt,
  };
  return Object.freeze(
    fields.captureId === undefined ? base : { ...base, captureId: fields.captureId },
  );
}

/** A record's fields, for building an amended copy of it. */
function fieldsOf(record: TabBindingRecord): TabBindingFields {
  return {
    tabId: record.tabId,
    sessionId: record.sessionId,
    url: record.url,
    origin: record.origin,
    boundAt: record.boundAt,
    captureId: record.captureId,
  };
}

/** Records ordered by tab id, as a frozen array — the order every list is in. */
function sortRecords(records: Iterable<TabBindingRecord>): readonly TabBindingRecord[] {
  return Object.freeze([...records].sort((left, right) => left.tabId - right.tabId));
}

/**
 * Validate one stored entry and rebuild it as a fresh record, or answer
 * `undefined` for anything malformed.
 *
 * An entry is valid when its key is its own tab id rendered in decimal, its
 * session id and URL are non-empty strings, its origin is exactly the URL's
 * HTTP(S) origin, its `boundAt` is a plausible stamp, and its `captureId` is
 * absent or a non-empty string. Unknown keys on the stored object are not
 * carried over — the record is rebuilt from the validated fields alone.
 */
function readStoredRecord(key: string, value: unknown): TabBindingRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { tabId, sessionId, url, origin, boundAt, captureId } = value;
  if (!isTabId(tabId) || String(tabId) !== key) {
    return undefined;
  }
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(url) || !isEpochMs(boundAt)) {
    return undefined;
  }
  const derivedOrigin = httpOriginOf(url);
  if (derivedOrigin === undefined || origin !== derivedOrigin) {
    return undefined;
  }
  if (captureId !== undefined && !isNonEmptyString(captureId)) {
    return undefined;
  }
  return makeRecord({ tabId, sessionId, url, origin: derivedOrigin, boundAt, captureId });
}

/** The outcome of reading a stored snapshot back. */
interface ParsedSnapshot {
  /** Every valid record, one per tab and one per session, ordered by tab id. */
  readonly records: readonly TabBindingRecord[];
  /** How many stored entries were refused (or `1` when the whole value was malformed). */
  readonly dropped: number;
}

/**
 * Read a stored {@link TabBindingSnapshot} back into validated records.
 *
 * Absent storage is an empty registry. A value that is not an object is
 * dropped whole. Each entry is validated by {@link readStoredRecord}; when two
 * valid entries name the same session — which the registry never writes, so it
 * can only be corruption — the one bound most recently is kept (ties broken by
 * the higher tab id, so the answer is deterministic) and the other dropped,
 * restoring the one-tab-per-session invariant.
 */
function parseSnapshot(raw: unknown): ParsedSnapshot {
  if (raw === undefined) {
    return { records: Object.freeze([]), dropped: 0 };
  }
  if (!isRecord(raw)) {
    return { records: Object.freeze([]), dropped: 1 };
  }
  const bySession = new Map<SessionId, TabBindingRecord>();
  let dropped = 0;
  for (const [key, value] of Object.entries(raw)) {
    const record = readStoredRecord(key, value);
    if (record === undefined) {
      dropped += 1;
      continue;
    }
    const rival = bySession.get(record.sessionId);
    if (rival === undefined) {
      bySession.set(record.sessionId, record);
      continue;
    }
    dropped += 1;
    const newer =
      record.boundAt > rival.boundAt ||
      (record.boundAt === rival.boundAt && record.tabId > rival.tabId);
    if (newer) {
      bySession.set(record.sessionId, record);
    }
  }
  return { records: sortRecords(bySession.values()), dropped };
}

/** The JSON map form of a set of records, keyed by decimal tab id. */
function toSnapshot(records: Iterable<TabBindingRecord>): TabBindingSnapshot {
  const snapshot: Record<string, TabBindingRecord> = {};
  for (const record of sortRecords(records)) {
    snapshot[String(record.tabId)] = record;
  }
  return snapshot;
}

/** The panel state for a recorded binding. */
function boundState(record: TabBindingRecord): PanelBindingState {
  return Object.freeze({
    kind: 'bound',
    sessionId: record.sessionId,
    tabId: record.tabId,
    url: record.url,
  });
}

/** The panel state for a tab no session holds. */
const UNBOUND_STATE: PanelBindingState = Object.freeze({ kind: 'unbound' });

/**
 * The panel state for a tab that left its bound origin. `origin` is the origin
 * it **left**; the panel renders `formatTabLeftMessage(origin)` from it.
 */
function tabLeftState(
  origin: string,
  sessionId: SessionId,
  reason: BindingReason,
): PanelBindingState {
  return Object.freeze({ kind: 'tab-left', origin, sessionId, reason });
}

/** A `binding` push frame carrying one state, on the extension channel. */
function bindingPush(state: PanelBindingState): PortBindingPush {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'binding',
    state,
  };
}
/*
 * ===========================================================================
 * Section E — the registry
 * ===========================================================================
 */

/**
 * Build a tab registry over the given storage area, transport and panel sink.
 *
 * Construction performs no I/O: the cache hydrates from storage on the first
 * operation (or on an explicit {@link TabRegistry.reload}), so building the
 * registry synchronously at the top of `service-worker.ts` costs nothing.
 *
 * @example
 * ```ts
 * const registry = createTabRegistry({
 *   storage: chrome.storage.session,
 *   send: (type, payload) => wsBridge.send(type, payload),
 *   notify: hub.pushToPanels,
 *   logger,
 * });
 * const decision = await registry.handleNavigated({ tabId, url });
 * agent.handleNavigationDecision(decision);
 * ```
 */
export function createTabRegistry(deps: TabRegistryDeps): TabRegistry {
  const { storage, send, notify } = deps;
  const logger = (deps.logger ?? noopLogger).child({ component: 'tab-registry' });
  const now = deps.now ?? nowEpochMs;

  /** The cache of the stored bindings, keyed by tab id. */
  const cache = new Map<TabId, TabBindingRecord>();
  /** Whether `cache` reflects storage for this worker generation. */
  let hydrated = false;
  /**
   * The `tab-left` state of tabs that navigated off their bound origin, kept
   * so a panel reopened on such a tab is told the tab left rather than merely
   * that it is unbound. Memory only (see `getPanelBindingState`).
   */
  const departures = new Map<TabId, PanelBindingState>();
  /** Change subscribers. */
  const listeners = new Set<TabBindingListener>();
  /** The tail of the operation queue; always settles, never rejects. */
  let tail: Promise<void> = Promise.resolve();

  /**
   * Run one operation after every operation queued before it.
   *
   * This is the serialization every read-modify-write depends on: a
   * navigation handled while a `session.bound` is being written waits for the
   * write, so neither can overwrite the other with a stale map. The chain
   * itself swallows an operation's failure (its own caller observes it), so
   * one faulty operation cannot stall every later one.
   */
  function exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = tail.then(operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Replace the cache with what storage holds, dropping malformed entries and
   * writing the cleaned map back when any were dropped.
   *
   * A storage read that fails leaves the registry empty for this worker
   * generation (logged): the bindings then rebuild from what the service
   * confirms next, starting with the panel's next `session.bind`. The
   * alternative, retrying the read on every operation, would let a late
   * successful read overwrite bindings the service confirmed in between.
   */
  async function hydrate(): Promise<void> {
    let raw: unknown;
    try {
      const items: unknown = await storage.get(BINDING_STORAGE_KEY);
      raw = isRecord(items) ? items[BINDING_STORAGE_KEY] : undefined;
    } catch (cause) {
      cache.clear();
      hydrated = true;
      logger.error('Tab bindings could not be read from session storage; starting empty', {
        code: DebuggenError.from(cause, 'STORE_ERROR').code,
      });
      return;
    }
    const parsed = parseSnapshot(raw);
    cache.clear();
    for (const record of parsed.records) {
      cache.set(record.tabId, record);
    }
    hydrated = true;
    if (parsed.dropped > 0) {
      logger.warn('Dropped malformed tab bindings read back from session storage', {
        dropped: parsed.dropped,
        kept: parsed.records.length,
      });
      await persist();
    } else {
      logger.debug('Tab bindings hydrated from session storage', { bindings: cache.size });
    }
  }

  /** Hydrate once per worker generation, before the first use of the cache. */
  async function ensureHydrated(): Promise<void> {
    if (!hydrated) {
      await hydrate();
    }
  }

  /**
   * Write the whole cache through to storage — or remove the key when no
   * binding remains, so an idle browser session holds no entry at all.
   *
   * A failed write is logged and answered `false`; the cache keeps the change,
   * because the cache holds what the service confirmed and the next successful
   * write stores the whole map again.
   */
  async function persist(): Promise<boolean> {
    try {
      if (cache.size === 0) {
        await storage.remove(BINDING_STORAGE_KEY);
      } else {
        await storage.set({ [BINDING_STORAGE_KEY]: toSnapshot(cache.values()) });
      }
      return true;
    } catch (cause) {
      logger.error('Tab bindings could not be written to session storage; kept in memory', {
        code: DebuggenError.from(cause, 'STORE_ERROR').code,
        bindings: cache.size,
      });
      return false;
    }
  }

  /**
   * Send one protocol frame and log the outcome by message type and code only.
   *
   * `ProtocolSend` does not throw for an expected condition; a throw from a
   * faulty transport is still converted into an `err`, so a registry
   * operation never rejects halfway through its bookkeeping.
   */
  function report<K extends MessageType>(
    type: K,
    payload: MessagePayload<K>,
    fields: LogFields,
  ): Result<SendOutcome, DebuggenError> {
    let outcome: Result<SendOutcome, DebuggenError>;
    try {
      outcome = send(type, payload);
    } catch (cause) {
      outcome = err(DebuggenError.from(cause, 'TRANSPORT_DISCONNECTED'));
    }
    if (outcome.ok) {
      logger.debug('Binding frame handed to the transport', {
        type,
        outcome: outcome.value,
        ...fields,
      });
    } else {
      logger.warn('Binding frame not sent', { type, code: outcome.error.code, ...fields });
    }
    return outcome;
  }

  /**
   * Announce one change that has already been written through: push its state
   * to the tab's panels (unless `push` is `false` — a capture change leaves the
   * panel's binding state as it was) and notify every listener. A sink or a
   * listener that throws is logged and does not stop the others.
   */
  function announce(change: TabBindingChange, push = true): void {
    if (push) {
      try {
        notify(change.tabId, bindingPush(change.state));
      } catch (cause) {
        logger.warn('Binding state could not be pushed to the panel', {
          tabId: change.tabId,
          code: DebuggenError.from(cause, 'INTERNAL').code,
        });
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (cause) {
        logger.error('A tab binding listener threw', {
          tabId: change.tabId,
          code: DebuggenError.from(cause, 'INTERNAL').code,
        });
      }
    }
  }

  /** The record holding a session, if any tab holds it. */
  function findBySession(sessionId: SessionId): TabBindingRecord | undefined {
    for (const record of cache.values()) {
      if (record.sessionId === sessionId) {
        return record;
      }
    }
    return undefined;
  }

  /*
   * ---- session.bound: the authoritative writes ----
   */

  /**
   * Record an established binding (`reason` absent or `bound`).
   *
   * The tab's previous record, if it named another session, is replaced; any
   * other tab holding the same session is displaced and its panel told it is
   * unbound, so a panel whose binding was taken never keeps claiming
   * "Connected". A re-announcement of the binding the tab already holds (after
   * a socket reconnect) keeps its `boundAt` and its running capture.
   */
  async function establish(
    bound: SessionBoundPayload,
    reason: BindingReason,
  ): Promise<Result<ApplyBoundOutcome, DebuggenError>> {
    const origin = httpOriginOf(bound.url);
    if (origin === undefined) {
      logger.warn('Refused a session.bound for a document without an HTTP(S) origin', {
        tabId: bound.tabId,
        sessionId: bound.sessionId,
      });
      return err(
        workerError(
          'PROTOCOL_INVALID_MESSAGE',
          'A session.bound announcement named a document without an HTTP or HTTPS origin, so no binding was recorded.',
        ),
      );
    }

    const previous = cache.get(bound.tabId);
    const sameBinding = previous !== undefined && previous.sessionId === bound.sessionId;
    const record = makeRecord({
      tabId: bound.tabId,
      sessionId: bound.sessionId,
      url: bound.url,
      origin,
      boundAt: sameBinding ? previous.boundAt : now(),
      captureId: sameBinding ? previous.captureId : undefined,
    });

    const displaced = [...cache.values()].filter(
      (other) => other.tabId !== bound.tabId && other.sessionId === bound.sessionId,
    );
    for (const other of displaced) {
      cache.delete(other.tabId);
      departures.delete(other.tabId);
    }
    cache.set(record.tabId, record);
    departures.delete(record.tabId);
    await persist();

    announce({
      kind: sameBinding ? 'updated' : 'recorded',
      tabId: record.tabId,
      previous,
      current: record,
      state: boundState(record),
      reason,
      cause: undefined,
    });
    for (const other of displaced) {
      announce({
        kind: 'removed',
        tabId: other.tabId,
        previous: other,
        current: undefined,
        state: UNBOUND_STATE,
        reason: REASON_REPLACED,
        cause: undefined,
      });
    }

    logger.info(sameBinding ? 'Tab binding re-confirmed' : 'Tab bound to session', {
      tabId: record.tabId,
      sessionId: record.sessionId,
      origin,
      replacedSession: previous !== undefined && !sameBinding ? previous.sessionId : undefined,
      displacedTabs: displaced.map((other) => other.tabId),
    });

    if (sameBinding) {
      return ok({ kind: 'updated', record, reason });
    }
    return ok({
      kind: 'recorded',
      record,
      previous,
      displaced: sortRecords(displaced),
      reason,
    });
  }

  /**
   * Apply the service's `navigated` announcement: the binding was kept across
   * a same-origin navigation, so the record takes the new document's URL.
   *
   * Only a record for the same tab **and** session is refreshed. A `navigated`
   * frame for a binding this worker no longer holds — one it already dropped
   * on a later cross-origin navigation, say — is late and is ignored, so it
   * cannot resurrect a binding.
   */
  async function refreshNavigated(
    bound: SessionBoundPayload,
    reason: BindingReason,
  ): Promise<ApplyBoundOutcome> {
    const current = cache.get(bound.tabId);
    const origin = httpOriginOf(bound.url);
    if (current === undefined || current.sessionId !== bound.sessionId || origin === undefined) {
      logger.debug('Ignored a navigated announcement for a binding this worker does not hold', {
        tabId: bound.tabId,
        sessionId: bound.sessionId,
      });
      return { kind: 'ignored', reason };
    }
    // The service compared the origin and kept the binding; it is the
    // authority, so its URL (and that URL's origin) is what is recorded.
    const record = makeRecord({ ...fieldsOf(current), url: bound.url, origin });
    cache.set(record.tabId, record);
    await persist();
    announce({
      kind: 'updated',
      tabId: record.tabId,
      previous: current,
      current: record,
      state: boundState(record),
      reason,
      cause: undefined,
    });
    return { kind: 'updated', record, reason };
  }

  /**
   * Apply an announcement that ends a binding: `replaced` (another bind took
   * it), `origin-changed` (the tab left the session's origin) or `unbound`
   * (DevTools closed, the tab closed or the session ended).
   *
   * Only a record naming the same tab **and** session is dropped: a frame
   * about an earlier binding of the tab — the displaced half of a replacement
   * that has already been recorded, for instance — must not undo the current
   * one. A tab that left its origin is shown `tab-left` with the origin it
   * left; the other two drops show `unbound`. (The service's own reason also
   * reaches the panel on the relayed `session.bound` frame itself.)
   */
  async function dropAnnounced(
    bound: SessionBoundPayload,
    reason: typeof REASON_REPLACED | typeof REASON_ORIGIN_CHANGED | typeof REASON_UNBOUND,
  ): Promise<ApplyBoundOutcome> {
    const current = cache.get(bound.tabId);
    if (current === undefined || current.sessionId !== bound.sessionId) {
      logger.debug('Ignored a binding drop for a binding this worker does not hold', {
        tabId: bound.tabId,
        sessionId: bound.sessionId,
        reason,
      });
      return { kind: 'ignored', reason };
    }
    cache.delete(current.tabId);
    const state =
      reason === REASON_ORIGIN_CHANGED
        ? tabLeftState(current.origin, current.sessionId, reason)
        : UNBOUND_STATE;
    if (state.kind === 'tab-left') {
      departures.set(current.tabId, state);
    } else {
      departures.delete(current.tabId);
    }
    await persist();
    announce({
      kind: 'removed',
      tabId: current.tabId,
      previous: current,
      current: undefined,
      state,
      reason,
      cause: undefined,
    });
    logger.info('Tab binding dropped by the service', {
      tabId: current.tabId,
      sessionId: current.sessionId,
      origin: current.origin,
      reason,
    });
    return { kind: 'removed', removed: current, reason };
  }

  /** Dispatch a validated `session.bound` on its reason. */
  async function applyValidatedBound(
    bound: SessionBoundPayload,
  ): Promise<Result<ApplyBoundOutcome, DebuggenError>> {
    await ensureHydrated();
    // An absent reason is an establishment (see `sessionBoundPayloadSchema`).
    const reason: BindingReason = bound.reason ?? REASON_BOUND;
    switch (reason) {
      case REASON_BOUND:
        return establish(bound, reason);
      case REASON_NAVIGATED:
        return ok(await refreshNavigated(bound, reason));
      case REASON_REPLACED:
      case REASON_ORIGIN_CHANGED:
      case REASON_UNBOUND:
        return ok(await dropAnnounced(bound, reason));
      default:
        return assertNever(reason, 'Unhandled binding reason');
    }
  }

  /*
   * ---- navigation ----
   */

  /**
   * Report one committed navigation and decide what it means for the tab's
   * binding. See {@link NavigationDecision} for the three outcomes.
   *
   * The comparison is between the new document's origin and the origin the
   * binding was recorded for, both serialized by the platform `URL` parser. A
   * URL that does not parse, or has no HTTP(S) origin, can never equal a bound
   * origin, so it is a cross-origin navigation: the tab has left the app.
   */
  async function navigate(navigation: TabNavigation): Promise<NavigationDecision> {
    const { tabId, url } = navigation;
    if (!isTabId(tabId)) {
      logger.warn('Ignored a navigation report for an invalid tab id');
      return { kind: 'not-bound', tabId, reported: false };
    }

    const navigated: TabNavigatedPayload = { tabId, url };
    const reported = report('tab.navigated', navigated, { tabId }).ok;

    await ensureHydrated();
    const current = cache.get(tabId);
    if (current === undefined) {
      return { kind: 'not-bound', tabId, reported };
    }

    const origin = httpOriginOf(url);
    if (origin !== undefined && origin === current.origin) {
      const record = makeRecord({ ...fieldsOf(current), url });
      cache.set(tabId, record);
      await persist();
      announce({
        kind: 'updated',
        tabId,
        previous: current,
        current: record,
        state: boundState(record),
        reason: REASON_NAVIGATED,
        cause: undefined,
      });
      logger.info('Bound tab navigated within its origin; binding kept', {
        tabId,
        sessionId: current.sessionId,
        origin,
        decision: 'kept-same-origin',
        capture: current.captureId !== undefined,
      });
      return {
        kind: 'kept-same-origin',
        tabId,
        sessionId: current.sessionId,
        captureId: current.captureId,
        url,
        origin,
        reported,
      };
    }

    const unbindPayload: SessionUnbindPayload = { tabId };
    report('session.unbind', unbindPayload, { tabId, sessionId: current.sessionId });
    cache.delete(tabId);
    const state = tabLeftState(current.origin, current.sessionId, REASON_ORIGIN_CHANGED);
    departures.set(tabId, state);
    await persist();
    announce({
      kind: 'removed',
      tabId,
      previous: current,
      current: undefined,
      state,
      reason: REASON_ORIGIN_CHANGED,
      cause: undefined,
    });
    logger.info('Bound tab left its origin; binding dropped', {
      tabId,
      sessionId: current.sessionId,
      origin: current.origin,
      newOrigin: origin,
      decision: 'unbound-cross-origin',
    });
    return {
      kind: 'unbound-cross-origin',
      tabId,
      sessionId: current.sessionId,
      captureId: current.captureId,
      previousOrigin: current.origin,
      origin,
      notice: formatTabLeftMessage(current.origin),
      reported,
    };
  }

  /*
   * ---- unbinding and session end ----
   */

  /**
   * End a tab's binding on the worker's own observation. Runs inside the
   * queue; the public `unbind` and `handleSessionEnded` both call it there,
   * never through `exclusive` again (which would wait on itself).
   */
  async function unbindLocked(
    tabId: TabId,
    cause: TabUnbindCause,
  ): Promise<TabBindingRecord | undefined> {
    await ensureHydrated();
    const current = cache.get(tabId);
    departures.delete(tabId);

    if (current === undefined && cause !== CAUSE_DEVTOOLS_CLOSED) {
      logger.debug('Unbind for a tab with no binding; nothing to report', { tabId, cause });
      return undefined;
    }

    const payload: SessionUnbindPayload = { tabId };
    report('session.unbind', payload, { tabId, cause });
    if (current === undefined) {
      return undefined;
    }

    cache.delete(tabId);
    await persist();
    announce({
      kind: 'removed',
      tabId,
      previous: current,
      current: undefined,
      state: UNBOUND_STATE,
      reason: REASON_UNBOUND,
      cause,
    });
    logger.info('Tab unbound', { tabId, sessionId: current.sessionId, cause });
    return current;
  }

  /** Unbind the tab holding an ended session, and forget its departures. */
  async function endSessionLocked(sessionId: SessionId): Promise<TabBindingRecord | undefined> {
    if (!isNonEmptyString(sessionId)) {
      return undefined;
    }
    await ensureHydrated();
    for (const [tabId, state] of [...departures]) {
      if (state.kind === 'tab-left' && state.sessionId === sessionId) {
        departures.delete(tabId);
      }
    }
    const holder = findBySession(sessionId);
    if (holder === undefined) {
      logger.debug('Session ended with no bound tab', { sessionId });
      return undefined;
    }
    return unbindLocked(holder.tabId, CAUSE_SESSION_ENDED);
  }

  /*
   * ---- capture bookkeeping ----
   */

  /** Store a capture id on a bound tab. Runs inside the queue. */
  async function setCaptureLocked(tabId: TabId, captureId: CaptureId): Promise<boolean> {
    if (!isTabId(tabId) || !isNonEmptyString(captureId)) {
      return false;
    }
    await ensureHydrated();
    const current = cache.get(tabId);
    if (current === undefined) {
      logger.debug('Capture id not stored: the tab is not bound', { tabId });
      return false;
    }
    if (current.captureId === captureId) {
      return true;
    }
    const record = makeRecord({ ...fieldsOf(current), captureId });
    cache.set(tabId, record);
    await persist();
    announce(
      {
        kind: 'updated',
        tabId,
        previous: current,
        current: record,
        state: boundState(record),
        reason: REASON_BOUND,
        cause: undefined,
      },
      false,
    );
    logger.debug('Capture id stored on the bound tab', {
      tabId,
      sessionId: record.sessionId,
      captureId,
    });
    return true;
  }

  /** Clear a bound tab's capture id (only `captureId`, when given). Runs inside the queue. */
  async function clearCaptureLocked(tabId: TabId, captureId?: CaptureId): Promise<boolean> {
    if (!isTabId(tabId)) {
      return false;
    }
    await ensureHydrated();
    const current = cache.get(tabId);
    if (current?.captureId === undefined) {
      return false;
    }
    if (captureId !== undefined && current.captureId !== captureId) {
      logger.debug('Capture id kept: a different capture is stored on the tab', { tabId });
      return false;
    }
    const record = makeRecord({ ...fieldsOf(current), captureId: undefined });
    cache.set(tabId, record);
    await persist();
    announce(
      {
        kind: 'updated',
        tabId,
        previous: current,
        current: record,
        state: boundState(record),
        reason: REASON_BOUND,
        cause: undefined,
      },
      false,
    );
    logger.debug('Capture id cleared from the bound tab', {
      tabId,
      sessionId: record.sessionId,
      captureId: current.captureId,
    });
    return true;
  }

  /*
   * ---- the public surface: every member runs on the queue ----
   */

  const reload = (): Promise<readonly TabBindingRecord[]> =>
    exclusive(async () => {
      await hydrate();
      return sortRecords(cache.values());
    });

  const requestBind = (request: TabBindRequest): Promise<Result<SendOutcome, DebuggenError>> =>
    exclusive(() => {
      const { tabId, url, origin, sessionId } = request;
      const candidate: SessionBindPayload =
        sessionId === undefined ? { tabId, url, origin } : { tabId, url, origin, sessionId };
      const parsed = parseSessionBindPayload(candidate);
      if (!parsed.ok) {
        logger.warn('Refused to request a binding: not a valid session.bind payload', {
          tabId: isTabId(tabId) ? tabId : undefined,
          code: parsed.error.code,
        });
        return err(parsed.error);
      }
      return report('session.bind', parsed.value, {
        tabId: parsed.value.tabId,
        origin: parsed.value.origin,
        sessionId: parsed.value.sessionId,
      });
    });

  const applyBound = (
    payload: SessionBoundPayload,
  ): Promise<Result<ApplyBoundOutcome, DebuggenError>> =>
    exclusive(() => {
      const parsed = parseSessionBoundPayload(payload);
      if (!parsed.ok) {
        logger.warn('Ignored an invalid session.bound payload', { code: parsed.error.code });
        return err(parsed.error);
      }
      return applyValidatedBound(parsed.value);
    });

  const handleNavigated = (navigation: TabNavigation): Promise<NavigationDecision> =>
    exclusive(() => navigate(navigation));

  const unbind = (tabId: TabId, cause: TabUnbindCause): Promise<TabBindingRecord | undefined> =>
    exclusive(() => {
      if (!isTabId(tabId)) {
        logger.warn('Ignored an unbind for an invalid tab id', { cause });
        return undefined;
      }
      return unbindLocked(tabId, cause);
    });

  const handleSessionEnded = (sessionId: SessionId): Promise<TabBindingRecord | undefined> =>
    exclusive(() => endSessionLocked(sessionId));

  const handleSessionUpdated = (
    payload: SessionUpdatedPayload,
  ): Promise<TabBindingRecord | undefined> =>
    exclusive(() => {
      const session = payload.session;
      return session.status === SESSION_STATUS_ENDED ? endSessionLocked(session.id) : undefined;
    });

  const setCaptureId = (tabId: TabId, captureId: CaptureId): Promise<boolean> =>
    exclusive(() => setCaptureLocked(tabId, captureId));

  const clearCaptureId = (tabId: TabId, captureId?: CaptureId): Promise<boolean> =>
    exclusive(() => clearCaptureLocked(tabId, captureId));

  const handleCaptureStarted = (payload: CaptureStartedPayload): Promise<TabId | undefined> =>
    exclusive(async () => {
      await ensureHydrated();
      const holder = findBySession(payload.sessionId);
      if (holder === undefined) {
        logger.debug('capture.started for a session no tab holds', {
          sessionId: payload.sessionId,
        });
        return undefined;
      }
      return (await setCaptureLocked(holder.tabId, payload.captureId)) ? holder.tabId : undefined;
    });

  const handleCaptureStopped = (payload: CaptureStoppedPayload): Promise<TabId | undefined> =>
    exclusive(async () => {
      await ensureHydrated();
      const holder = findBySession(payload.sessionId);
      if (holder === undefined) {
        return undefined;
      }
      return (await clearCaptureLocked(holder.tabId, payload.captureId)) ? holder.tabId : undefined;
    });

  const getBinding = (tabId: TabId): Promise<TabBindingRecord | undefined> =>
    exclusive(async () => {
      await ensureHydrated();
      return cache.get(tabId);
    });

  const getTabForSession = (sessionId: SessionId): Promise<TabId | undefined> =>
    exclusive(async () => {
      await ensureHydrated();
      return findBySession(sessionId)?.tabId;
    });

  const listBindings = (): Promise<readonly TabBindingRecord[]> =>
    exclusive(async () => {
      await ensureHydrated();
      return sortRecords(cache.values());
    });

  const getPanelBindingState = (tabId: TabId): Promise<PanelBindingState> =>
    exclusive(async () => {
      await ensureHydrated();
      const record = cache.get(tabId);
      if (record !== undefined) {
        return boundState(record);
      }
      return departures.get(tabId) ?? UNBOUND_STATE;
    });

  const onChange = (listener: TabBindingListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return Object.freeze({
    reload,
    requestBind,
    applyBound,
    handleNavigated,
    unbind,
    handleSessionEnded,
    handleSessionUpdated,
    setCaptureId,
    clearCaptureId,
    handleCaptureStarted,
    handleCaptureStopped,
    getBinding,
    getTabForSession,
    listBindings,
    getPanelBindingState,
    onChange,
  });
}
