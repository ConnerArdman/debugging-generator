/**
 * The DevTools panel's only connection to the extension's service worker.
 *
 * ## What this module is
 *
 * The "Debug Generator" panel talks to exactly one peer — the Manifest V3
 * service worker — over exactly one channel, a `chrome.runtime` port named
 * {@link PORT_PANEL}. This module is the panel's **only** call site of
 * `chrome.runtime.connect`, and so the single place where that port is
 * created, held, torn down and reconnected; the single place where a panel →
 * worker request is correlated with its response; and the single route by
 * which worker-relayed protocol frames reach `./session-store.ts`. It is the
 * **only writer of protocol-derived store state**: `applyRelayedMessage`,
 * `applySessionSnapshot`, `setConnectionStatus`, `setBindingState` and the
 * binding-loss `resetPanelStore` are called from here and nowhere else.
 *
 * It also holds the one piece of worker state that is not session state: the
 * worker's **reload offer** ({@link PanelReloadState}) — whether the one-click
 * reload of the inspected page is offered because its agent cannot observe it.
 * The worker decides it (it performs the reload and holds the agent's
 * readiness) and pushes it; this module stores the latest `reload` push or
 * snapshot answer, returns it to `not-needed` when the binding is lost, the
 * port is lost (a new port re-hydrates it) or the connection is torn down, and
 * serves it through
 * {@link usePanelReloadState} / {@link getPanelReloadState}.
 *
 * `../data-provider.ts` and `../actions.ts` inject {@link panelRequest} (or
 * {@link getPanelConnection}) and **must never acquire a port of their own**;
 * `../App.tsx` owns only the lifetime, through {@link startPanelConnection} and
 * the returned handle's `stop()`, reads the pill through
 * {@link usePanelConnection}, and reads the reload offer through
 * {@link usePanelReloadState}.
 *
 * ## Lifecycle
 *
 * - {@link startPanelConnection} is reference-counted. React 19 StrictMode
 *   mounts, unmounts and re-mounts an effect synchronously; the last `stop()`
 *   therefore schedules the teardown for the end of the current microtask
 *   checkpoint, and a `start()` in between cancels it. The double invoke leaves
 *   one port, one pair of port listeners and one hydration request.
 * - A disconnected port — the normal consequence of the worker suspending after
 *   about 30 seconds idle (AAP §0.1.1) — is reopened with jittered exponential
 *   backoff ({@link PANEL_PORT_RECONNECT_INITIAL_MS} doubling by
 *   {@link PANEL_PORT_RECONNECT_FACTOR} up to {@link PANEL_PORT_RECONNECT_MAX_MS}).
 *   Opening the port is itself what wakes the worker, so the first retry is
 *   fast; the backoff only grows while ports keep closing before the worker
 *   says anything.
 * - Every new port starts with the hydration handshake: a `session.snapshot`
 *   port request whose answer is applied with `applySessionSnapshot`, which
 *   keeps the developer's live tail, selection and open drawer.
 *
 * ## The bind handshake
 *
 * The panel never sends the protocol's `session.bind`: the worker does, from
 * its tab registry, when the DevTools page announces the inspected tab. The
 * panel's part is the `session.snapshot` request, whose declared payload is an
 * optional `inspectedTabId` and an optional `sessionId`. When this document
 * runs inside DevTools (a numeric `chrome.devtools.inspectedWindow.tabId`, read
 * defensively) the request always names that tab: it is this port's identity,
 * and the worker associates the port with exactly that tab and never moves it
 * afterwards — so a restarted worker facing several reconnecting DevTools
 * windows never has to guess which one this panel belongs to. When the store
 * also holds a `bound` binding **of that inspected tab**, the request names
 * that session too, as information only: the worker never lets it choose or
 * assign a tab. Outside DevTools — `tests/browser/panel-render.spec.ts` opens
 * the panel page directly as an extension page — binding is skipped entirely:
 * the request names neither a tab nor a session, nothing throws, and the port
 * keeps working.
 *
 * Inside DevTools the panel also refuses to present a `bound` binding that
 * names a tab other than the one it inspects, from a snapshot answer or a
 * binding push: it records `unbound` instead (and keeps none of that
 * snapshot's session, analysis or panel), so it neither shows another tab's
 * session as its own nor names it in its next handshake.
 *
 * ## Status, and what is never inferred
 *
 * The pill's vocabulary is imported. A port disconnect maps to `reconnecting`
 * and to nothing else, however long reconnection takes: `not-paired` and
 * `service-not-running` come only from the worker — in its snapshot answer or
 * its `connection` push — because the worker alone holds the pairing
 * credential (AAP §0.5.6) and probes the service's health route (AAP §0.5.5).
 * A suspended worker cannot push anything, so reading service death into
 * silence would show the developer a false failure. `connected` likewise comes
 * only from the worker, never from a local `connect()` that may be refused.
 *
 * ## What this module deliberately does not do
 *
 * - No `WebSocket`, no `fetch`, no `HttpClient`, no `ReconnectingWsClient`: the
 *   worker owns the socket and every HTTP call, including the panel-data route.
 * - No schema of its own, and no admission by framing alone (CWE-20): every
 *   inbound frame goes through `../../shared/messages`' single admission
 *   point, `classifyPanelPortFrame`, which parses a response with its kind's
 *   own schema and a relayed push with the protocol's discriminated union, and
 *   only the **parsed** value it returns settles a request or reaches the
 *   store. A malformed answer rejects the request it names at once (reason
 *   `malformed`) instead of waiting for the timeout; a malformed push is never
 *   applied, and is reported through the store's non-blocking `lastError`.
 *   Nothing here repairs, re-validates or casts a frame's content.
 * - No credential access: the devtools credential lives in
 *   `chrome.storage.local`, owned by the worker, and is never read here.
 * - No status or label authoring and no "Tab left ‹origin›" wording: the store
 *   holds imported vocabulary values, and components render the labels.
 * - No import from `../../background/**`: the worker's contract reaches this
 *   file only through `../../shared/messages`.
 * - No import-time side effects: nothing connects, listens or schedules a timer
 *   until {@link startPanelConnection} is called.
 *
 * Errors raised here carry no request payload, no response body, no token and
 * no URL query value (AAP §0.5.2): they name the request kind and a reason.
 *
 * @example Owning the lifetime from the panel's root component (`../App.tsx`):
 * ```tsx
 * useEffect(() => {
 *   const connection = startPanelConnection();
 *   return () => connection.stop();
 * }, []);
 * ```
 *
 * @example A typed request through the module-stable function (what
 * `../data-provider.ts` and `../actions.ts` inject):
 * ```ts
 * const { captureId } = await panelRequest('capture.start', { sessionId }, { signal });
 * ```
 *
 * @module apps/chrome-extension/src/panel/state/connection
 */

import type { ErrorPayload } from '@debuggen/protocol';
import { DEBUGGEN_ERROR_CODES, DebuggenError, assertNever, noopLogger } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, SessionId } from '@debuggen/shared';
import { useSyncExternalStore } from 'react';

import {
  EXTENSION_CHANNEL,
  PANEL_RELOAD_NOT_NEEDED,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
  classifyPanelPortFrame,
  newPortRequestId,
  portErrorOwningSessionId,
} from '../../shared/messages';
import type {
  PanelBindingState,
  PanelConnectionStatus,
  PanelReloadState,
  PanelSessionSnapshot,
  PortErrorPayload,
  PortPush,
  PortPushKind,
  PortRequestFrame,
  PortRequestId,
  PortRequestKind,
  PortRequestPayloads,
  PortResponse,
  PortResponseCorrelation,
  PortResponsePayloads,
} from '../../shared/messages';

import {
  applyRelayedMessage,
  applySessionSnapshot,
  getPanelSnapshot,
  resetPanelStore,
  setBindingState,
  setConnectionStatus,
  setLastError,
  setPickerActive,
  usePanelStoreSelector,
} from './session-store';
import type { PanelConnectionSlice, PanelSnapshot } from './session-store';

/*
 * ===========================================================================
 * Section A — tuning constants
 * ===========================================================================
 */

/**
 * The delay before the first reconnect attempt after the port closes, in
 * milliseconds.
 *
 * Short on purpose: a closed port is almost always a suspended worker, and
 * opening a new port is what wakes it, so the panel should be back within a
 * fraction of a second.
 */
export const PANEL_PORT_RECONNECT_INITIAL_MS = 250;

/** The factor each consecutive failed attempt multiplies the delay by. */
export const PANEL_PORT_RECONNECT_FACTOR = 2;

/**
 * The longest reconnect delay, in milliseconds. Low, because the port is local
 * and cheap: a panel whose worker stays unreachable retries at this cadence,
 * which keeps the recovery prompt without flooding the extension.
 */
export const PANEL_PORT_RECONNECT_MAX_MS = 3_000;

/**
 * The fraction of each reconnect delay that jitter may remove: a delay lies in
 * `[ceiling × (1 − jitter), ceiling]`, so panels of several DevTools windows do
 * not retry in lockstep after a worker restart, and the cap is never exceeded.
 */
export const PANEL_PORT_RECONNECT_JITTER = 0.2;

/**
 * How long a panel request waits for its response before it is rejected, in
 * milliseconds, unless the caller passes its own `timeoutMs`.
 *
 * Deliberately longer than the worker's own port-request timeout (twenty-five
 * seconds, which in turn outlasts the twenty seconds a consented page reload
 * waits for the new document's agent, so that wait is answered with its own
 * specific failure): a handler that hangs is answered by the worker with a
 * typed failure, which carries more information than a local timeout, so this
 * one only fires when the worker went silent without closing the port.
 */
export const PANEL_PORT_REQUEST_TIMEOUT_MS = 30_000;

/** The largest delay a platform timer accepts without firing immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Caps the backoff exponent so the ceiling can never overflow to `Infinity`. */
const MAX_BACKOFF_EXPONENT = 16;

/**
 * The only status this module writes on its own observation: the port is not
 * exchanging frames. A member of the imported `PANEL_CONNECTION_STATUSES`, as
 * `satisfies` proves; every other status arrives from the worker.
 */
const PORT_DOWN_STATUS = 'reconnecting' satisfies PanelConnectionStatus;

/*
 * ===========================================================================
 * Section B — failure vocabulary
 * ===========================================================================
 */

/**
 * Why a panel request was rejected, as recorded in the rejection's
 * `details.reason` — so a consumer can tell a retryable transport loss from a
 * refusal without parsing a message.
 *
 * - `disconnected` — the port closed (typically a suspended worker) before the
 *   response arrived; the panel reconnects on its own.
 * - `stopped` — the panel's connection was torn down.
 * - `timeout` — no response within the request's timeout.
 * - `aborted` — the caller's `AbortSignal` fired.
 * - `unavailable` — the document has no extension runtime to connect with.
 * - `mismatched` — the worker answered with a response of another kind.
 * - `malformed` — the worker answered with a frame that names this request
 *   but failed its kind's schema (`classifyPanelPortFrame`'s
 *   `malformed-response`). Nothing from the frame is kept — not its payload,
 *   not its error text — and the request is rejected at once with code
 *   `PROTOCOL_INVALID_MESSAGE` rather than left to time out. Not retryable
 *   in place: the same worker build answers the same way.
 * - `refused` — the worker answered with a typed failure; the rejection keeps
 *   that failure's code and message, and — for a `capture.start` refused
 *   because another session holds the project's capture — that session's id
 *   ({@link panelRequestOwningSessionId}).
 */
export const PANEL_REQUEST_FAILURE_REASONS = [
  'disconnected',
  'stopped',
  'timeout',
  'aborted',
  'unavailable',
  'mismatched',
  'malformed',
  'refused',
] as const;

/** One of {@link PANEL_REQUEST_FAILURE_REASONS}. */
export type PanelRequestFailureReason = (typeof PANEL_REQUEST_FAILURE_REASONS)[number];

/*
 * ===========================================================================
 * Section C — the injection surface
 * ===========================================================================
 */

/**
 * The listener-registration half of a `chrome.events.Event`.
 *
 * @typeParam Listener The callback signature the event dispatches to.
 */
export interface PanelPortEventLike<Listener> {
  /** Register `listener`. */
  addListener(listener: Listener): void;
  /** Unregister a listener previously passed to {@link addListener}. */
  removeListener(listener: Listener): void;
}

/** The members of a `chrome.runtime.Port` this module uses. */
export interface PanelPortLike {
  /** Send one frame to the worker; throws when the port is already dead. */
  postMessage(message: unknown): void;
  /** Close the port; the worker's `onDisconnect` fires, this side's does not. */
  disconnect(): void;
  /** Frames the worker posts on this port. */
  readonly onMessage: PanelPortEventLike<(message: unknown) => void>;
  /** Fired once, when the worker closes the port or goes away. */
  readonly onDisconnect: PanelPortEventLike<(port: unknown) => void>;
}

/** The members of `chrome.runtime` this module uses. */
export interface PanelRuntimeLike {
  /** Set while an `onDisconnect` listener runs if the port closed on an error. */
  readonly lastError?: { readonly message?: string | undefined } | undefined;
  /** Open a long-lived port to the extension's service worker. */
  connect(connectInfo: { name: string }): PanelPortLike;
}

/**
 * Fails to compile unless its argument is exactly `true` — the drift-assertion
 * idiom the extension's other modules use.
 */
type AssertTrue<Assertion extends true> = Assertion;

/**
 * Compile-time proof that the real `chrome.runtime` namespace satisfies
 * {@link PanelRuntimeLike}, so the default wiring needs no cast and an
 * incompatible `@types/chrome` change fails `tsc -b` here. Type-level only.
 */
export type ChromeRuntimeSatisfiesPanelRuntime = AssertTrue<
  typeof chrome.runtime extends PanelRuntimeLike ? true : false
>;

/** Everything the connection needs from its environment, injectable for tests. */
export interface PanelConnectionDeps {
  /**
   * `chrome.runtime`, or a fake with the same members. Defaults to the real
   * `chrome.runtime`, resolved when the connection starts; when none exists,
   * requests are rejected as `unavailable` and nothing is retried.
   */
  readonly runtime?: PanelRuntimeLike | undefined;
  /**
   * Reads the `chrome.devtools`-shaped object whose `inspectedWindow.tabId`
   * says whether this document runs inside DevTools. Called once per start,
   * inside `try`/`catch`; its result is read structurally. Defaults to reading
   * the real `chrome.devtools`.
   */
  readonly readDevtools?: (() => unknown) | undefined;
  /**
   * Schedules a timer. Defaults to `globalThis.setTimeout`, looked up at call
   * time so fake timers installed later apply.
   */
  readonly setTimeout?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  /** Cancels a handle returned by {@link setTimeout}. Defaults to `globalThis.clearTimeout`. */
  readonly clearTimeout?: ((handle: unknown) => void) | undefined;
  /** Jitter source in `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
  /**
   * Where diagnostics go. Defaults to the silent `noopLogger`; nothing logged
   * here carries a payload, a token or a URL.
   */
  readonly logger?: Logger | undefined;
  /** The default per-request timeout. Defaults to {@link PANEL_PORT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number | undefined;
}

/*
 * ===========================================================================
 * Section D — the public surface
 * ===========================================================================
 */

/** Per-request options of {@link panelRequest}. */
export interface PanelRequestOptions {
  /**
   * Cancels the request. An already-aborted signal rejects without sending; an
   * abort in flight rejects at once and drops the response when it arrives.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * How long to wait for the response, in milliseconds. Non-finite or
   * non-positive values fall back to the connection's default
   * ({@link PANEL_PORT_REQUEST_TIMEOUT_MS} unless configured).
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * The typed panel → worker request function: send one request of `kind`, and
 * resolve with that kind's success payload or reject with a `DebuggenError`.
 *
 * Module-stable: it resolves the live port at call time and never closes over
 * one, so a provider or action object built once at mount keeps working across
 * every suspension-driven reconnect. While no port is open — between reconnect
 * attempts, or before the connection starts — the request waits, bounded by its
 * timeout, and is sent as soon as a port opens.
 */
export type PanelRequestFunction = <Kind extends PortRequestKind>(
  kind: Kind,
  payload: PortRequestPayloads[Kind],
  options?: PanelRequestOptions,
) => Promise<PortResponsePayloads[Kind]>;

/** Why {@link onPortDisconnect} listeners were notified. */
export type PanelPortDisconnectReason = Extract<
  PanelRequestFailureReason,
  'disconnected' | 'stopped'
>;

/** What an {@link onPortDisconnect} listener receives. */
export interface PanelPortDisconnectEvent {
  /** `disconnected` for a closed port (reconnection follows), `stopped` for teardown. */
  readonly reason: PanelPortDisconnectReason;
  /**
   * A typed error describing the loss. Every request pending at that moment was
   * rejected with an error of the same code and reason, naming its own kind.
   */
  readonly error: DebuggenError;
}

/** A callback registered with {@link onPortDisconnect}. */
export type PanelPortDisconnectListener = (event: PanelPortDisconnectEvent) => void;

/**
 * The module-stable connection facade {@link getPanelConnection} returns. Every
 * member resolves the live state at call time, so the object is safe to build
 * a `useMemo` value from once.
 */
export interface PanelConnection {
  /** The typed request function; the same function as {@link panelRequest}. */
  readonly request: PanelRequestFunction;
  /**
   * Register a listener for port loss and teardown; answers its unsubscribe.
   * The same function as the module export {@link onPortDisconnect}.
   */
  readonly onPortDisconnect: (listener: PanelPortDisconnectListener) => () => void;
  /**
   * Re-run the hydration handshake on the live port. A no-op while no port is
   * open (the next port hydrates anyway) or while a handshake is in flight.
   */
  readonly resync: () => void;
  /**
   * The inspected tab's id when this document runs inside DevTools, or
   * `undefined` outside DevTools and while the connection is not running.
   */
  readonly getInspectedTabId: () => number | undefined;
  /** Whether a started connection is live (not torn down). */
  readonly isRunning: () => boolean;
}

/**
 * What {@link startPanelConnection} answers: the facade plus the release of
 * this one start.
 */
export interface PanelConnectionHandle extends PanelConnection {
  /**
   * Release the reference this start took. Idempotent per handle: a second call
   * does nothing. The connection is torn down once the last reference is
   * released and no start follows before the current microtask checkpoint.
   */
  readonly stop: () => void;
}

/*
 * ===========================================================================
 * Section E — pure helpers
 * ===========================================================================
 */

/**
 * The delay before reconnect attempt `attempt` (0-based): exponential from
 * {@link PANEL_PORT_RECONNECT_INITIAL_MS} by {@link PANEL_PORT_RECONNECT_FACTOR},
 * capped at {@link PANEL_PORT_RECONNECT_MAX_MS}, minus up to
 * {@link PANEL_PORT_RECONNECT_JITTER} of itself. Pure.
 *
 * @param attempt Consecutive attempts whose port closed before the worker said
 * anything; non-finite or negative values count as 0.
 * @param random A source of values in `[0, 1)`; out-of-range draws are clamped.
 * @returns A whole number of milliseconds in
 * `[PANEL_PORT_RECONNECT_INITIAL_MS × (1 − jitter), PANEL_PORT_RECONNECT_MAX_MS]`.
 */
export function computePanelPortReconnectDelay(
  attempt: number,
  random: () => number = () => Math.random(),
): number {
  const exponent =
    Number.isFinite(attempt) && attempt > 0
      ? Math.min(Math.floor(attempt), MAX_BACKOFF_EXPONENT)
      : 0;
  const ceiling = Math.min(
    PANEL_PORT_RECONNECT_MAX_MS,
    PANEL_PORT_RECONNECT_INITIAL_MS * PANEL_PORT_RECONNECT_FACTOR ** exponent,
  );
  const draw = random();
  const unit = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0;
  return Math.round(ceiling * (1 - PANEL_PORT_RECONNECT_JITTER * unit));
}

/** Whether a value is a non-null, non-array object whose members can be read. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The inspected tab's id, read defensively from a `chrome.devtools`-shaped
 * value: `undefined` unless `inspectedWindow.tabId` is a non-negative integer.
 * Never throws — a throwing accessor or getter reads as "not in DevTools".
 *
 * @param readDevtools Answers the `chrome.devtools`-shaped value, or anything.
 * @returns The inspected tab id, or `undefined` outside DevTools.
 */
export function readInspectedTabId(readDevtools: () => unknown): number | undefined {
  try {
    const devtools = readDevtools();
    if (!isRecord(devtools)) {
      return undefined;
    }
    const inspectedWindow = devtools.inspectedWindow;
    if (!isRecord(inspectedWindow)) {
      return undefined;
    }
    const tabId = inspectedWindow.tabId;
    return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0 ? tabId : undefined;
  } catch {
    // A DevTools API that throws on access is as absent as one that is missing.
    return undefined;
  }
}

/**
 * The reason recorded on a rejection this module produced, or `undefined` for
 * any other value.
 *
 * @param error A value a {@link panelRequest} promise rejected with, or anything.
 * @returns One of {@link PANEL_REQUEST_FAILURE_REASONS}, or `undefined`.
 */
export function panelRequestFailureReason(error: unknown): PanelRequestFailureReason | undefined {
  if (!DebuggenError.is(error) || !isRecord(error.details)) {
    return undefined;
  }
  const reason = error.details.reason;
  return PANEL_REQUEST_FAILURE_REASONS.find((candidate) => candidate === reason);
}

/**
 * The session that holds the project's capture, as named by a `refused`
 * rejection of `capture.start` (AAP §0.4.2: the service "answers
 * `409 { owningSessionId }`"), or `undefined` for any other value — another
 * reason, another failure, or a refusal that names no owner.
 *
 * Read from the rejection's `details`, where {@link panelRequest} put the
 * owner the parsed failure carried, and string-checked again here because a
 * caller may pass any value.
 *
 * @param error A value a {@link panelRequest} promise rejected with, or anything.
 * @returns The owning session's id, or `undefined`.
 *
 * @example
 * ```ts
 * try {
 *   await panelRequest('capture.start', { sessionId });
 * } catch (cause) {
 *   const owner = panelRequestOwningSessionId(cause); // e.g. the other session's id
 * }
 * ```
 */
export function panelRequestOwningSessionId(error: unknown): SessionId | undefined {
  if (panelRequestFailureReason(error) !== 'refused' || !DebuggenError.is(error)) {
    return undefined;
  }
  const owner = error.details?.owningSessionId;
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}

/** Whether a string is one of the closed `DEBUGGEN_ERROR_CODES`. */
function isKnownErrorCode(code: string): code is DebuggenErrorCode {
  return DEBUGGEN_ERROR_CODES.some((candidate) => candidate === code);
}

/** A usable timer delay: `candidate` when finite and positive, otherwise `fallback`. */
function usableDelay(candidate: number | undefined, fallback: number): number {
  const delay =
    candidate !== undefined && Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
  return Math.min(Math.ceil(delay), MAX_TIMER_DELAY_MS);
}

/** The default timer, resolved at call time so fake timers installed later apply. */
function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

/**
 * The default cancellation. Browser timer handles are numbers; any other handle
 * is left to fire, which is harmless because every timer callback here checks
 * that it is still current before acting.
 */
function defaultClearTimeout(handle: unknown): void {
  if (typeof handle === 'number') {
    globalThis.clearTimeout(handle);
  }
}

/** The default jitter source. */
function defaultRandom(): number {
  return Math.random();
}

/** The real `chrome.devtools`, or `undefined` outside an extension document. */
function defaultReadDevtools(): unknown {
  return typeof chrome === 'undefined' ? undefined : chrome.devtools;
}

/**
 * The real `chrome.runtime` when it can open ports, or `undefined` — in a
 * document with no extension API, or once the extension context is gone.
 */
function defaultRuntime(): PanelRuntimeLike | undefined {
  try {
    if (typeof chrome === 'undefined') {
      return undefined;
    }
    const candidate: unknown = chrome.runtime;
    return isRecord(candidate) && typeof candidate.connect === 'function'
      ? chrome.runtime
      : undefined;
  } catch {
    // Reading `chrome.runtime` from an invalidated context throws; treat as absent.
    return undefined;
  }
}

/*
 * ===========================================================================
 * Section F — typed rejections
 * ===========================================================================
 */

/** The rejection for a request that could not complete on the panel's side. */
function transportError(
  kind: PortRequestKind,
  reason: Exclude<PanelRequestFailureReason, 'refused' | 'mismatched' | 'malformed'>,
  options: { readonly timeoutMs?: number; readonly cause?: unknown } = {},
): DebuggenError {
  const details = {
    kind,
    reason,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const cause = options.cause === undefined ? {} : { cause: options.cause };
  switch (reason) {
    case 'disconnected':
      return new DebuggenError(
        'TRANSPORT_DISCONNECTED',
        `The connection to the extension's service worker closed before the ${kind} request was answered.`,
        { hint: 'The panel reconnects on its own; retry in a moment.', details, ...cause },
      );
    case 'stopped':
      return new DebuggenError(
        'TRANSPORT_DISCONNECTED',
        `The panel's connection closed before the ${kind} request was answered.`,
        { hint: 'Reopen the Debug Generator panel and retry.', details, ...cause },
      );
    case 'timeout':
      return new DebuggenError(
        'TRANSPORT_DISCONNECTED',
        `The extension's service worker did not answer the ${kind} request within ${String(options.timeoutMs ?? 0)} ms.`,
        {
          hint: 'Retry in a moment; if it keeps failing, reload the extension.',
          details,
          ...cause,
        },
      );
    case 'aborted':
      return new DebuggenError(
        'TRANSPORT_DISCONNECTED',
        `The ${kind} request was cancelled before the extension's service worker answered.`,
        { details, ...cause },
      );
    case 'unavailable':
      return new DebuggenError(
        'TRANSPORT_DISCONNECTED',
        `This page has no extension runtime, so the ${kind} request cannot reach the service worker.`,
        { hint: 'Open the Debug Generator panel from Chrome DevTools.', details, ...cause },
      );
    default:
      return assertNever(reason, 'Unhandled panel request failure reason');
  }
}

/** The rejection for a response whose kind differs from the request's. */
function mismatchError(kind: PortRequestKind, answeredKind: PortRequestKind): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    `The extension's service worker answered the ${kind} request with a ${answeredKind} response.`,
    { details: { kind, answeredKind, reason: 'mismatched' satisfies PanelRequestFailureReason } },
  );
}

/**
 * The rejection for an answer that names this request but failed its kind's
 * schema. Nothing from the frame is kept — neither its payload nor any error
 * text it carried — so the rejection names only the request's kind and the
 * kind the frame claimed (AAP §0.5.2). The hint is the recovery that applies:
 * an unreadable answer means the panel and the worker disagree about the
 * contract, which a reload of the extension and its panel resolves.
 */
function malformedResponseError(
  kind: PortRequestKind,
  answeredKind: PortRequestKind,
): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    `The extension's service worker answered the ${kind} request with a response this panel could not read.`,
    {
      hint: 'Reload the Debug Generator extension, then reopen its DevTools panel.',
      details: { kind, answeredKind, reason: 'malformed' satisfies PanelRequestFailureReason },
    },
  );
}

/**
 * The store's non-blocking failure record for a push that failed its parse and
 * was dropped: a dropped update is invisible otherwise, and a panel that shows
 * stale state as if it were current misleads (AAP §0.5.5). Frozen and shared,
 * so a burst of unreadable pushes writes one record — the store ignores an
 * identical `setLastError` — rather than one per frame.
 */
const MALFORMED_PUSH_ERROR: ErrorPayload = Object.freeze({
  code: 'PROTOCOL_INVALID_MESSAGE',
  message:
    "The panel ignored an update from the extension's service worker that it could not read, so what it shows may be out of date.",
});

/**
 * The rejection for a typed failure the worker answered with: its code (when it
 * is a member of the closed vocabulary) and message are kept, its `ref`
 * travels in `details` so the store can be given the original payload, and the
 * owning session of a capture-ownership conflict — the one detail the port's
 * failure payload admits — travels in `details.owningSessionId`, where
 * {@link panelRequestOwningSessionId} reads it.
 */
function refusedError(kind: PortRequestKind, error: PortErrorPayload): DebuggenError {
  const code: DebuggenErrorCode = isKnownErrorCode(error.code)
    ? error.code
    : 'PROTOCOL_INVALID_MESSAGE';
  const owningSessionId = portErrorOwningSessionId(error);
  return new DebuggenError(code, error.message, {
    details: {
      kind,
      reason: 'refused' satisfies PanelRequestFailureReason,
      ...(error.ref === undefined ? {} : { ref: error.ref }),
      ...(owningSessionId === undefined ? {} : { owningSessionId }),
    },
  });
}

/**
 * The protocol error payload a `refused` rejection was built from, rebuilt for
 * the store's `setLastError`; `undefined` for any other rejection.
 */
function refusedPayload(error: unknown): ErrorPayload | undefined {
  if (panelRequestFailureReason(error) !== 'refused' || !DebuggenError.is(error)) {
    return undefined;
  }
  const ref = error.details?.ref;
  return {
    code: error.code,
    message: error.message,
    ...(typeof ref === 'string' && ref.length > 0 ? { ref } : {}),
  };
}

/**
 * The error {@link onPortDisconnect} listeners receive: the loss itself, with
 * the same code and reason as the per-request rejections it caused.
 */
function connectionLossError(reason: PanelPortDisconnectReason): DebuggenError {
  return reason === 'disconnected'
    ? new DebuggenError(
        'TRANSPORT_DISCONNECTED',
        "The connection to the extension's service worker closed.",
        { hint: 'The panel reconnects on its own.', details: { reason } },
      )
    : new DebuggenError('TRANSPORT_DISCONNECTED', "The panel's connection was closed.", {
        details: { reason },
      });
}

/** A value's error name for a log field — never its message or contents. */
function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/*
 * ===========================================================================
 * Section G — module state
 *
 * Allocated empty at import and touched only by calls: nothing here connects,
 * listens or schedules until `startPanelConnection` runs.
 * ===========================================================================
 */

/** A request between {@link panelRequest} and its settlement. */
interface PendingRequest {
  /** The request's kind, for the rejection wording. */
  readonly kind: PortRequestKind;
  /** The frame to post. */
  readonly frame: PortRequestFrame<PortRequestKind>;
  /** The port the frame was posted on; `undefined` while it waits for one. */
  port: PanelPortLike | undefined;
  /** Settle with the worker's response. */
  readonly settle: (response: PortResponse) => void;
  /** Reject with a typed error; a no-op once settled. */
  readonly fail: (error: DebuggenError) => void;
}

/** A scheduled reconnect; identity tells a stale timer callback from a live one. */
interface ReconnectTimer {
  handle: unknown;
}

/** One started connection: its environment, its reference count and its port. */
interface Controller {
  readonly runtime: PanelRuntimeLike | undefined;
  readonly inspectedTabId: number | undefined;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly random: () => number;
  readonly logger: Logger;
  readonly requestTimeoutMs: number;
  /** Starts not yet released. */
  references: number;
  /** The last reference was released and a teardown microtask is queued. */
  teardownScheduled: boolean;
  /** Torn down; nothing may reopen it. */
  stopped: boolean;
  /** The live port, if one is open. */
  port: PanelPortLike | undefined;
  /** Removes the live port's two listeners. */
  detachPort: (() => void) | undefined;
  /** A hydration handshake is in flight on the live port. */
  hydrating: boolean;
  /** Consecutive ports that closed before the worker said anything. */
  attempt: number;
  /** The pending reconnect, if one is scheduled. */
  reconnectTimer: ReconnectTimer | undefined;
}

/** Every request not yet settled, keyed by its correlation id. */
const pendingRequests = new Map<PortRequestId, PendingRequest>();

/** Consumer listeners; module-stable, so they outlive any one port or start. */
const disconnectListeners = new Set<PanelPortDisconnectListener>();

/** The started connection, or `undefined` while none is running. */
let current: Controller | undefined;

/**
 * The worker's latest reload offer for the inspected tab. Held here rather
 * than in `./session-store.ts` because it is not derived from any protocol
 * frame: it is port state the worker composes and pushes, like the connection
 * lifecycle this module already owns. Replaced only when its content changes,
 * so its identity is a stable `useSyncExternalStore` snapshot.
 */
let reloadState: PanelReloadState = PANEL_RELOAD_NOT_NEEDED;

/** The {@link usePanelReloadState} subscribers, notified when {@link reloadState} changes. */
const reloadListeners = new Set<() => void>();

/*
 * ===========================================================================
 * Section H — the request broker
 * ===========================================================================
 */

/**
 * One reader per request kind: the kind's success payload out of a parsed
 * response, or `undefined` when the response is of another kind or a failure.
 *
 * A mapped type over `PortRequestKind`, so indexing it with a request's
 * generic `Kind` yields exactly that kind's reader — which is what lets
 * {@link dispatchRequest} resolve `PortResponsePayloads[Kind]` without a type
 * assertion — and a kind added to the contract without a reader here fails to
 * compile. `undefined` is never a success payload (every one is an object), so
 * it can only mean "not this kind's success".
 */
type SuccessPayloadReaders = {
  readonly [Kind in PortRequestKind]: (
    response: PortResponse,
  ) => PortResponsePayloads[Kind] | undefined;
};

/**
 * The readers. Each narrows the `PortResponse` union on its own `kind` literal
 * and then on `ok`, so the payload it returns is typed by the discriminants
 * `classifyPanelPortFrame` parsed, never asserted.
 */
const SUCCESS_PAYLOAD_READERS: SuccessPayloadReaders = Object.freeze({
  'panelData.query': (response: PortResponse) =>
    response.kind === 'panelData.query' && response.ok ? response.payload : undefined,
  'source.open': (response: PortResponse) =>
    response.kind === 'source.open' && response.ok ? response.payload : undefined,
  'capture.start': (response: PortResponse) =>
    response.kind === 'capture.start' && response.ok ? response.payload : undefined,
  'capture.stop': (response: PortResponse) =>
    response.kind === 'capture.stop' && response.ok ? response.payload : undefined,
  'target.pick': (response: PortResponse) =>
    response.kind === 'target.pick' && response.ok ? response.payload : undefined,
  'target.selected': (response: PortResponse) =>
    response.kind === 'target.selected' && response.ok ? response.payload : undefined,
  'pair.complete': (response: PortResponse) =>
    response.kind === 'pair.complete' && response.ok ? response.payload : undefined,
  'session.snapshot': (response: PortResponse) =>
    response.kind === 'session.snapshot' && response.ok ? response.payload : undefined,
  'page.reload': (response: PortResponse) =>
    response.kind === 'page.reload' && response.ok ? response.payload : undefined,
});

/**
 * Send one request through `live`'s port, or hold it until a port opens.
 *
 * Every path ends in exactly one settlement: the matching response, a typed
 * rejection (abort, timeout, port loss, teardown, no runtime, a mismatched or
 * malformed answer), never a promise left pending. The request's timer and
 * abort listener are removed on every path.
 */
function dispatchRequest<Kind extends PortRequestKind>(
  live: Controller | undefined,
  kind: Kind,
  payload: PortRequestPayloads[Kind],
  options: PanelRequestOptions,
): Promise<PortResponsePayloads[Kind]> {
  return new Promise<PortResponsePayloads[Kind]>((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted === true) {
      const reason: unknown = signal.reason;
      reject(transportError(kind, 'aborted', { cause: reason }));
      return;
    }
    if (live !== undefined && live.runtime === undefined) {
      reject(transportError(kind, 'unavailable'));
      return;
    }

    const setTimer = live?.setTimer ?? defaultSetTimeout;
    const clearTimer = live?.clearTimer ?? defaultClearTimeout;
    const timeoutMs = usableDelay(
      options.timeoutMs,
      live?.requestTimeoutMs ?? PANEL_PORT_REQUEST_TIMEOUT_MS,
    );
    const requestId = newPortRequestId();
    let settled = false;
    // A holder rather than a `const` handle: a timer implementation that fires
    // synchronously would otherwise reach `finish` before the handle exists.
    const timeout: { handle: unknown } = { handle: undefined };

    const onAbort = (): void => {
      const reason: unknown = signal?.reason;
      fail(transportError(kind, 'aborted', { cause: reason }));
    };
    const finish = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      pendingRequests.delete(requestId);
      clearTimer(timeout.handle);
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const fail = (error: DebuggenError): void => {
      if (finish()) {
        reject(error);
      }
    };

    const frame: PortRequestFrame<Kind> = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'request',
      requestId,
      kind,
      payload,
    };
    const entry: PendingRequest = {
      kind,
      frame,
      port: undefined,
      settle: (response) => {
        if (!finish()) {
          return;
        }
        if (response.kind !== kind) {
          reject(mismatchError(kind, response.kind));
          return;
        }
        if (!response.ok) {
          reject(refusedError(kind, response.error));
          return;
        }
        // The one admission of the port's payload into the typed result, and
        // no assertion: `classifyPanelPortFrame` parsed this response with the
        // schema of its own `kind`, just proven equal to this request's, and
        // the kind's reader narrows the union on that discriminant. It answers
        // `undefined` only for another kind or a failure — both settled above —
        // so that branch rejects rather than ever resolving with nothing.
        const payload = SUCCESS_PAYLOAD_READERS[kind](response);
        if (payload === undefined) {
          reject(malformedResponseError(kind, response.kind));
          return;
        }
        resolve(payload);
      },
      fail,
    };

    pendingRequests.set(requestId, entry);
    timeout.handle = setTimer(() => {
      fail(transportError(kind, 'timeout', { timeoutMs }));
    }, timeoutMs);
    if (settled) {
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const port = live?.port;
    if (live !== undefined && port !== undefined) {
      postRequest(live, entry, port);
    } else {
      (live?.logger ?? noopLogger).debug('Holding a panel request until the port opens.', {
        kind,
      });
    }
  });
}

/** Post a request on `port`; a port that refuses the post is treated as closed. */
function postRequest(live: Controller, entry: PendingRequest, port: PanelPortLike): void {
  entry.port = port;
  try {
    port.postMessage(entry.frame);
  } catch (cause) {
    live.logger.debug('Posting on the panel port failed; treating the port as closed.', {
      kind: entry.kind,
      error: errorName(cause),
    });
    handlePortLoss(live, port);
  }
}

/** Post every request still waiting for a port, oldest first. */
function flushWaitingRequests(live: Controller, port: PanelPortLike): void {
  for (const entry of [...pendingRequests.values()]) {
    if (live.port !== port) {
      return;
    }
    if (entry.port === undefined) {
      postRequest(live, entry, port);
    }
  }
}

/** Reject every pending request `shouldReject` selects, each with its own kind's error. */
function rejectRequests(
  reason: Exclude<PanelRequestFailureReason, 'refused' | 'mismatched' | 'malformed'>,
  shouldReject: (entry: PendingRequest) => boolean,
): void {
  for (const entry of [...pendingRequests.values()]) {
    if (shouldReject(entry)) {
      entry.fail(transportError(entry.kind, reason));
    }
  }
}

/** Settle the request a response answers; a response nobody awaits is dropped. */
function settleResponse(live: Controller, port: PanelPortLike, response: PortResponse): void {
  const entry = pendingRequests.get(response.requestId);
  if (entry === undefined || entry.port !== port) {
    live.logger.debug('Dropped a panel port response with no pending request.', {
      kind: response.kind,
    });
    return;
  }
  entry.settle(response);
}

/**
 * Reject, at once, the request a malformed answer names — when that request is
 * pending on this port — with a `malformed` rejection, instead of leaving it
 * to its timeout. Nothing from the frame is kept. An answer whose correlation
 * is unreadable, or that names a request nobody on this port awaits, is only
 * logged, by its claimed kind when it has one.
 *
 * @param correlation The request the frame claims to answer, when readable.
 */
function rejectMalformedResponse(
  live: Controller,
  port: PanelPortLike,
  correlation: PortResponseCorrelation | undefined,
): void {
  if (correlation === undefined) {
    live.logger.warn('Dropped a malformed panel port response that names no request.');
    return;
  }
  const entry = pendingRequests.get(correlation.requestId);
  if (entry === undefined || entry.port !== port) {
    live.logger.warn('Dropped a malformed panel port response with no pending request.', {
      kind: correlation.kind,
    });
    return;
  }
  live.logger.warn('Rejected a panel request answered with a malformed response.', {
    kind: correlation.kind,
  });
  entry.fail(malformedResponseError(entry.kind, correlation.kind));
}

/** Tell every consumer listener about a port loss or teardown; a throwing listener is logged. */
function notifyDisconnect(logger: Logger, event: PanelPortDisconnectEvent): void {
  for (const listener of [...disconnectListeners]) {
    try {
      listener(event);
    } catch (cause) {
      logger.error('A panel port disconnect listener threw.', {
        reason: event.reason,
        error: errorName(cause),
      });
    }
  }
}

/*
 * ===========================================================================
 * Section I — store writes
 *
 * The only protocol-derived writes into `./session-store.ts`. Each is guarded
 * so a reducer failure is logged instead of escaping into Chrome's event
 * dispatch, and none composes wording: the store holds imported vocabulary,
 * and the one failure record written here is Section F's.
 * ===========================================================================
 */

/** The inspected tab's binding as the store holds it now. */
function currentBinding(): PanelBindingState {
  return getPanelSnapshot().connection.binding;
}

/** The binding recorded in place of one that names another tab. */
const UNBOUND_BINDING: PanelBindingState = Object.freeze({ kind: 'unbound' });

/**
 * `binding`, or `unbound` when it is a `bound` state for a tab other than the
 * one this document inspects inside DevTools. The worker answers and pushes
 * the binding of the tab it associated this port with; if that tab is not the
 * inspected one, the association is wrong, and presenting (or later claiming)
 * its session would show this DevTools window another tab's session. Outside
 * DevTools there is no inspected tab to compare with, and the binding is kept.
 */
function inspectedTabBinding(live: Controller, binding: PanelBindingState): PanelBindingState {
  const inspectedTabId = live.inspectedTabId;
  if (
    inspectedTabId === undefined ||
    binding.kind !== 'bound' ||
    binding.tabId === inspectedTabId
  ) {
    return binding;
  }
  live.logger.warn('Ignored a binding for a tab this panel does not inspect.', {
    tabId: binding.tabId,
    inspectedTabId,
  });
  return UNBOUND_BINDING;
}

/** Whether two reload offers say the same thing: the same kind, and the same reason. */
function sameReloadState(left: PanelReloadState, right: PanelReloadState): boolean {
  if (left.kind === 'offered' || right.kind === 'offered') {
    return left.kind === 'offered' && right.kind === 'offered' && left.reason === right.reason;
  }
  return left.kind === right.kind;
}

/**
 * Replace the reload offer and notify {@link usePanelReloadState}'s
 * subscribers — only when its content changed, so an unchanged push re-renders
 * nothing and the snapshot identity stays stable. `not-needed` is always
 * stored as the shared frozen {@link PANEL_RELOAD_NOT_NEEDED}.
 */
function setReloadState(next: PanelReloadState): void {
  if (sameReloadState(reloadState, next)) {
    return;
  }
  reloadState = next.kind === 'not-needed' ? PANEL_RELOAD_NOT_NEEDED : next;
  for (const listener of [...reloadListeners]) {
    listener();
  }
}

/**
 * Discard everything scoped to the session the panel showed: the store's
 * session-scoped slices (`resetPanelStore()` keeps the connection slice, so the
 * pill and a "Tab left ‹origin›" binding survive) and the reload offer, which
 * was about that session's tab.
 */
function resetSessionScope(): void {
  resetPanelStore();
  setReloadState(PANEL_RELOAD_NOT_NEEDED);
}

/**
 * Reset the session scope when the binding just moved to a non-bound kind from
 * a different kind — the tab was unbound (a session end included, since ending
 * a session unbinds its tab), left its session's origin, or had its binding
 * taken. A binding to another session needs no call: the store resets on a
 * change of session identity itself, and the worker pushes the new tab state's
 * reload offer.
 */
function resetIfBindingLost(before: PanelBindingState): void {
  const after = currentBinding();
  if (after.kind !== 'bound' && after.kind !== before.kind) {
    resetSessionScope();
  }
}

/**
 * Apply one push. Branches on the push's frame kind only — a relayed protocol
 * frame goes to `applyRelayedMessage` untouched, whatever its type — and a
 * binding push naming another tab than the inspected one is recorded as
 * `unbound` ({@link inspectedTabBinding}).
 */
function applyPush(live: Controller, push: PortPush): void {
  switch (push.kind) {
    case 'protocol': {
      const before = currentBinding();
      applyRelayedMessage(push);
      resetIfBindingLost(before);
      return;
    }
    case 'connection':
      // The worker composed this status with `panelConnectionStatus()` from its
      // socket state, credential presence and health probe; it is stored as is.
      setConnectionStatus(push.state);
      return;
    case 'binding': {
      const before = currentBinding();
      setBindingState(inspectedTabBinding(live, push.state));
      resetIfBindingLost(before);
      return;
    }
    case 'reload':
      // The worker decided the offer from the tab's agent readiness; it is
      // stored as is and read by the panel's reload notice.
      setReloadState(push.state);
      return;
    case 'picker':
      // The page's pick ended — the developer clicked an element, pressed
      // Escape in the page, the page was hidden or its document went away —
      // so picker mode ends here too. The store change is what `App.tsx`'s
      // picker-mode listener follows to close the activation on screen; no
      // error is raised, because ending a pick is not a failure.
      setPickerActive(push.state.active);
      return;
    default:
      assertNever(push, 'Unhandled panel port push');
  }
}

/**
 * Apply a `session.snapshot` answer. A snapshot whose binding names another
 * tab than the inspected one is reduced to its connection state and an
 * `unbound` binding ({@link inspectedTabBinding}): none of that tab's
 * session, analysis or panel is kept. When the resulting binding is non-bound
 * and differs from the store's, the previous session's scope is reset first,
 * so its tail and progress cannot linger beside the new state; the snapshot
 * then lands, keeping the live tail, selection and drawer of an unchanged
 * session, and its reload offer replaces the held one — an absent offer reads
 * as `not-needed`, as the contract declares.
 */
function applySnapshot(live: Controller, answer: PanelSessionSnapshot): void {
  const binding = inspectedTabBinding(live, answer.binding);
  const snapshot: PanelSessionSnapshot =
    binding === answer.binding ? answer : { connection: answer.connection, binding };
  if (snapshot.binding.kind !== 'bound' && snapshot.binding.kind !== currentBinding().kind) {
    resetSessionScope();
  }
  applySessionSnapshot(snapshot);
  setReloadState(snapshot.reload ?? PANEL_RELOAD_NOT_NEEDED);
}

/**
 * Record a push that failed its parse: it is never applied, the log names only
 * its push kind (never its content), and the developer sees the store's
 * non-blocking `lastError` instead of a silently stale panel.
 *
 * @param pushKind The frame's push kind, when it is a known one.
 */
function reportMalformedPush(live: Controller, pushKind: PortPushKind | undefined): void {
  live.logger.warn(
    'Dropped a malformed panel port push.',
    pushKind === undefined ? undefined : { pushKind },
  );
  setLastError(MALFORMED_PUSH_ERROR);
}

/** Write the locally observed status; a store failure is logged. */
function writePortDownStatus(logger: Logger): void {
  try {
    setConnectionStatus(PORT_DOWN_STATUS);
  } catch (cause) {
    logger.error('Recording the panel connection status failed.', { error: errorName(cause) });
  }
}

/*
 * ===========================================================================
 * Section J — the hydration handshake
 * ===========================================================================
 */

/**
 * The `session.snapshot` payload. Inside DevTools it always names this
 * document's inspected tab (`inspectedTabId`, from
 * `chrome.devtools.inspectedWindow.tabId`): that is the port's identity, and
 * the worker associates the port with exactly that tab — so a worker revived
 * while several DevTools windows reconnect never has to guess which window
 * this panel belongs to. It also names the bound session when the store holds
 * a `bound` binding of the inspected tab; that claim is informational only
 * (the worker logs and ignores one that has gone stale, and never lets it
 * choose or assign a tab).
 *
 * Outside DevTools binding is skipped entirely — the request names neither a
 * tab nor a session, so the worker never ties a page that inspects nothing to
 * a tab on this document's word. A claim is dropped as soon as the panel can
 * see it is stale: after an `unbound` or `tab-left` binding (a session end, a
 * navigation away, a replacement), after a snapshot answer naming no session,
 * and for a `bound` binding of any tab other than the inspected one. A
 * snapshot answer naming a different session of this tab replaces the claim
 * with that session, which is the tab's current truth.
 *
 * `readInspectedTabId` accepts any non-negative integer; the request guard
 * accepts safe integers only, so an id beyond that range (which no Chrome tab
 * has) is left out rather than turning the whole handshake into a malformed
 * request.
 */
function handshakePayload(live: Controller): PortRequestPayloads['session.snapshot'] {
  const inspectedTabId = live.inspectedTabId;
  if (inspectedTabId === undefined || !Number.isSafeInteger(inspectedTabId)) {
    return {};
  }
  const binding = currentBinding();
  const sessionId: SessionId | undefined =
    binding.kind === 'bound' && binding.tabId === inspectedTabId ? binding.sessionId : undefined;
  return sessionId === undefined ? { inspectedTabId } : { inspectedTabId, sessionId };
}

/**
 * Record why a handshake did not complete. A typed failure the worker answered
 * with — and an answer the panel could not use at all (`malformed` or
 * `mismatched`) — is surfaced through the store's non-blocking `lastError`,
 * because a panel that silently never hydrates would present nothing as if it
 * were fine (AAP §0.5.5); a transport loss is only logged, because the next
 * port hydrates again and the pill already says `reconnecting`.
 */
function reportHydrationFailure(live: Controller, error: unknown): void {
  const payload = refusedPayload(error) ?? unusableAnswerPayload(error);
  if (payload !== undefined) {
    live.logger.warn('The service worker did not answer the panel snapshot usably.', {
      code: payload.code,
      reason: panelRequestFailureReason(error),
    });
    try {
      setLastError(payload);
    } catch (cause) {
      live.logger.error('Recording the snapshot failure failed.', { error: errorName(cause) });
    }
    return;
  }
  const reason = panelRequestFailureReason(error);
  if (reason === undefined) {
    live.logger.error('Applying the panel snapshot failed.', { error: errorName(error) });
    return;
  }
  live.logger.debug('The panel snapshot did not complete.', { reason });
}

/**
 * The store record of a `malformed` or `mismatched` rejection — its code, and
 * its message followed by its recovery hint when it has one — or `undefined`
 * for any other value. Both rejections were built here and carry nothing from
 * the frame, so the record holds no payload content (AAP §0.5.2).
 */
function unusableAnswerPayload(error: unknown): ErrorPayload | undefined {
  const reason = panelRequestFailureReason(error);
  if ((reason !== 'malformed' && reason !== 'mismatched') || !DebuggenError.is(error)) {
    return undefined;
  }
  const hint = error.hint;
  return {
    code: error.code,
    message: hint === undefined || hint === '' ? error.message : `${error.message} ${hint}`,
  };
}

/**
 * Run the handshake on `port`: request the snapshot and apply it if the port is
 * still the live one. At most one handshake per port is in flight. Never
 * rejects — every failure is recorded by {@link reportHydrationFailure}.
 */
async function hydrate(live: Controller, port: PanelPortLike): Promise<void> {
  if (live.hydrating || live.port !== port) {
    return;
  }
  live.hydrating = true;
  try {
    const snapshot = await dispatchRequest(live, 'session.snapshot', handshakePayload(live), {});
    if (live.port === port) {
      applySnapshot(live, snapshot);
    }
  } catch (error) {
    reportHydrationFailure(live, error);
  } finally {
    if (live.port === port) {
      live.hydrating = false;
    }
  }
}

/*
 * ===========================================================================
 * Section K — the port lifecycle
 * ===========================================================================
 */

/** Build a controller from `deps`, resolving every default now. */
function createController(deps: PanelConnectionDeps): Controller {
  return {
    runtime: deps.runtime ?? defaultRuntime(),
    inspectedTabId: readInspectedTabId(deps.readDevtools ?? defaultReadDevtools),
    setTimer: deps.setTimeout ?? defaultSetTimeout,
    clearTimer: deps.clearTimeout ?? defaultClearTimeout,
    random: deps.random ?? defaultRandom,
    logger: deps.logger ?? noopLogger,
    requestTimeoutMs: usableDelay(deps.requestTimeoutMs, PANEL_PORT_REQUEST_TIMEOUT_MS),
    references: 0,
    teardownScheduled: false,
    stopped: false,
    port: undefined,
    detachPort: undefined,
    hydrating: false,
    attempt: 0,
    reconnectTimer: undefined,
  };
}

/** `runtime.connect`, or `undefined` when the platform throws (an invalidated context). */
function connectPort(live: Controller, runtime: PanelRuntimeLike): PanelPortLike | undefined {
  try {
    return runtime.connect({ name: PORT_PANEL });
  } catch (cause) {
    live.logger.warn('Opening the panel port failed; retrying.', {
      attempt: live.attempt,
      error: errorName(cause),
    });
    return undefined;
  }
}

/** Remove a port's two listeners; a platform-torn-down port may refuse removal. */
function detachListeners(
  live: Controller,
  port: PanelPortLike,
  onMessage: (message: unknown) => void,
  onDisconnect: (port: unknown) => void,
): void {
  try {
    port.onMessage.removeListener(onMessage);
  } catch (cause) {
    live.logger.debug('Removing the panel port message listener failed.', {
      error: errorName(cause),
    });
  }
  try {
    port.onDisconnect.removeListener(onDisconnect);
  } catch (cause) {
    live.logger.debug('Removing the panel port disconnect listener failed.', {
      error: errorName(cause),
    });
  }
}

/**
 * Open the port, attach its listeners once, run the handshake and send every
 * waiting request. A no-op once torn down, while a port is open, or without a
 * runtime.
 */
function openPort(live: Controller): void {
  const runtime = live.runtime;
  if (live.stopped || live.port !== undefined || runtime === undefined) {
    return;
  }
  const port = connectPort(live, runtime);
  if (port === undefined) {
    scheduleReconnect(live);
    return;
  }

  const onMessage = (message: unknown): void => {
    handleFrame(live, port, message);
  };
  const onDisconnect = (): void => {
    // Reading `lastError` inside the callback is what keeps Chrome from
    // printing an "Unchecked runtime.lastError" warning for this closure.
    const lastError = runtime.lastError;
    if (lastError !== undefined) {
      live.logger.debug('The panel port closed with a runtime error.', {
        message: lastError.message,
      });
    }
    handlePortLoss(live, port);
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  live.port = port;
  live.detachPort = () => {
    detachListeners(live, port, onMessage, onDisconnect);
  };
  live.logger.debug('Opened the panel port.', {
    attempt: live.attempt,
    inspectingTab: live.inspectedTabId !== undefined,
  });

  void hydrate(live, port);
  flushWaitingRequests(live, port);
}

/**
 * Schedule the next {@link openPort} with jittered exponential backoff. The
 * attempt counter grows with every port that closes before the worker says
 * anything, and is reset by the first frame a port delivers.
 */
function scheduleReconnect(live: Controller): void {
  if (live.stopped || live.reconnectTimer !== undefined) {
    return;
  }
  const delayMs = computePanelPortReconnectDelay(live.attempt, live.random);
  live.attempt += 1;
  const timer: ReconnectTimer = { handle: undefined };
  live.reconnectTimer = timer;
  timer.handle = live.setTimer(() => {
    if (live.reconnectTimer !== timer) {
      return;
    }
    live.reconnectTimer = undefined;
    openPort(live);
  }, delayMs);
  live.logger.debug('Scheduled a panel port reconnect.', { delayMs, attempt: live.attempt });
}

/**
 * The live port closed (or refused a post): detach it, reject every request in
 * flight on it, end picker mode, show `reconnecting`, tell the consumer
 * listeners, and schedule a reconnect. Requests still waiting for a port stay
 * queued for the next one.
 */
function handlePortLoss(live: Controller, port: PanelPortLike): void {
  if (live.port !== port) {
    return;
  }
  live.detachPort?.();
  live.detachPort = undefined;
  live.port = undefined;
  live.hydrating = false;

  rejectRequests('disconnected', (entry) => entry.port === port);
  writePortDownStatus(live.logger);
  // The offer was the worker's word about the tab this port was associated
  // with; a new port starts unassociated, so the offer is withdrawn until that
  // port's snapshot (or a `reload` push to it) states it afresh. A stale
  // "Reload page" can therefore never be activated across a reconnect.
  setReloadState(PANEL_RELOAD_NOT_NEEDED);
  // Picker mode ends with the port. The worker generation that armed any page
  // pick for this panel is gone or has lost this panel, and in both cases the
  // page's pick ends: the page agent ends it when its bridge's worker port
  // closes, and the worker cancels it when a tab loses its last panel. No
  // `picker` push can arrive for that pick on the next port, so a toggle left
  // pressed here would claim a picker mode nothing holds. Local only: the
  // store change closes the activation on screen, and no request is sent.
  setPickerActive(false);
  notifyDisconnect(live.logger, {
    reason: 'disconnected',
    error: connectionLossError('disconnected'),
  });
  live.logger.debug('The panel port closed; reconnecting.', { attempt: live.attempt });
  scheduleReconnect(live);
}

/**
 * Route one frame from the live port through the panel's single admission
 * point, `classifyPanelPortFrame`, and act only on what it parsed:
 *
 * - a parsed response settles its request, and a parsed push is applied to
 *   the store — each as the rebuilt value the classifier returns, never the
 *   raw frame;
 * - a malformed response rejects the request it names at once
 *   ({@link rejectMalformedResponse});
 * - a malformed push is dropped and reported ({@link reportMalformedPush});
 * - anything else — another channel or version, a request echoed back — is
 *   ignored harmlessly.
 *
 * Every frame on this channel, well-formed or not, proves the worker is alive
 * and resets the backoff.
 */
function handleFrame(live: Controller, port: PanelPortLike, message: unknown): void {
  if (live.port !== port) {
    return;
  }
  try {
    const inbound = classifyPanelPortFrame(message);
    switch (inbound.kind) {
      case 'response':
        live.attempt = 0;
        settleResponse(live, port, inbound.response);
        return;
      case 'push':
        live.attempt = 0;
        applyPush(live, inbound.push);
        return;
      case 'malformed-response':
        live.attempt = 0;
        rejectMalformedResponse(live, port, inbound.correlation);
        return;
      case 'malformed-push':
        live.attempt = 0;
        reportMalformedPush(live, inbound.pushKind);
        return;
      case 'unrecognised':
        live.logger.debug('Ignored an unrecognised frame on the panel port.');
        return;
      default:
        assertNever(inbound, 'Unhandled panel port frame classification');
    }
  } catch (cause) {
    live.logger.error('Applying a panel port frame failed.', { error: errorName(cause) });
  }
}

/**
 * Tear the connection down: cancel the reconnect, detach and close the port,
 * reject every pending request (waiting ones included), show `reconnecting`
 * and tell the consumer listeners. No port listener survives it.
 */
function teardown(live: Controller): void {
  if (live.stopped) {
    return;
  }
  live.stopped = true;
  live.teardownScheduled = false;
  if (current === live) {
    current = undefined;
  }

  const timer = live.reconnectTimer;
  live.reconnectTimer = undefined;
  if (timer !== undefined) {
    live.clearTimer(timer.handle);
  }

  const port = live.port;
  live.detachPort?.();
  live.detachPort = undefined;
  live.port = undefined;
  live.hydrating = false;
  if (port !== undefined) {
    try {
      // Closing from this side fires only the worker's `onDisconnect`, which is
      // why every pending request is rejected here rather than by a listener.
      port.disconnect();
    } catch (cause) {
      live.logger.debug('Closing the panel port failed.', { error: errorName(cause) });
    }
  }

  rejectRequests('stopped', () => true);
  writePortDownStatus(live.logger);
  // No worker speaks for this panel any more, so nothing can be offered: a
  // later start hydrates the offer afresh from its snapshot.
  setReloadState(PANEL_RELOAD_NOT_NEEDED);
  notifyDisconnect(live.logger, { reason: 'stopped', error: connectionLossError('stopped') });
  live.logger.debug('Stopped the panel connection.');
}

/**
 * Release one reference. At zero, the teardown is queued for the end of the
 * current microtask checkpoint, so a synchronous re-start — React StrictMode's
 * unmount/remount of an effect — keeps the same port instead of opening a
 * second one.
 */
function release(live: Controller): void {
  if (live.stopped) {
    return;
  }
  live.references = Math.max(0, live.references - 1);
  if (live.references > 0 || live.teardownScheduled) {
    return;
  }
  live.teardownScheduled = true;
  void Promise.resolve().then(() => {
    if (!live.teardownScheduled || live.references > 0) {
      return;
    }
    try {
      teardown(live);
    } catch (cause) {
      live.logger.error('Tearing down the panel connection failed.', { error: errorName(cause) });
    }
  });
}

/*
 * ===========================================================================
 * Section L — the public API
 * ===========================================================================
 */

/**
 * Send one typed request to the service worker — the panel's only request
 * path, and the function `../data-provider.ts` and `../actions.ts` inject.
 *
 * Resolves with the kind's success payload. Rejects, always with a
 * `DebuggenError` whose `details.reason` is one of
 * {@link PANEL_REQUEST_FAILURE_REASONS}: the worker's own typed failure
 * (`refused`, keeping its code and message), a port loss (`disconnected`),
 * teardown (`stopped`), `timeout`, `aborted`, `unavailable`, `mismatched`, or
 * an answer that failed its kind's schema (`malformed`).
 * Never throws synchronously, and never leaves a promise pending: a disconnect
 * rejects what was in flight so `useQuery` renders its error state with a retry
 * instead of a spinner.
 *
 * Module-stable — see {@link PanelRequestFunction}.
 *
 * @param kind The request kind, from `../../shared/messages`' contract.
 * @param payload That kind's request payload.
 * @param options Cancellation and timeout.
 * @returns That kind's success payload.
 */
export function panelRequest<Kind extends PortRequestKind>(
  kind: Kind,
  payload: PortRequestPayloads[Kind],
  options: PanelRequestOptions = {},
): Promise<PortResponsePayloads[Kind]> {
  return dispatchRequest(current, kind, payload, options);
}

/**
 * Register a listener for port loss (`disconnected`, reconnection follows) and
 * teardown (`stopped`). Listeners are module-stable: they survive reconnects
 * and restarts until the returned function unsubscribes them, so a provider
 * built once at mount keeps its registration across React StrictMode's
 * double-invoked effects.
 *
 * @param listener Called after the pending requests were rejected.
 * @returns Unsubscribes `listener`; calling it twice is harmless.
 */
export function onPortDisconnect(listener: PanelPortDisconnectListener): () => void {
  disconnectListeners.add(listener);
  return () => {
    disconnectListeners.delete(listener);
  };
}

/** Re-run the hydration handshake on the live port, if any; see {@link PanelConnection.resync}. */
function resyncPanelConnection(): void {
  const live = current;
  const port = live?.port;
  if (live !== undefined && port !== undefined) {
    void hydrate(live, port);
  }
}

/**
 * The module-stable facade. Built from hoisted function declarations only, so
 * constructing it at import performs no effect.
 */
const PANEL_CONNECTION: PanelConnection = Object.freeze({
  request: panelRequest,
  onPortDisconnect,
  resync: resyncPanelConnection,
  getInspectedTabId: (): number | undefined => current?.inspectedTabId,
  isRunning: (): boolean => current !== undefined && !current.stopped,
});

/**
 * The module-stable connection facade — the same object on every call, whether
 * or not a connection is running. For `../data-provider.ts` and
 * `../actions.ts`, which inject its members and must never open a port of
 * their own: this module is the panel's only `chrome.runtime.connect` call
 * site.
 *
 * @returns The facade.
 */
export function getPanelConnection(): PanelConnection {
  return PANEL_CONNECTION;
}

/**
 * Start (or join) the panel's connection and take one reference to it.
 *
 * The first start resolves its dependencies, reads the inspected tab
 * defensively, opens the port and runs the hydration handshake; a start while a
 * connection is running only takes a reference — and cancels a teardown the
 * last `stop()` queued — so the first start's dependencies hold for the
 * connection's lifetime. With no extension runtime the connection still starts,
 * but every request is rejected as `unavailable` and nothing is retried.
 *
 * @param deps The environment; every member defaults to the real platform.
 * @returns A handle whose `stop()` releases exactly this start's reference.
 */
export function startPanelConnection(deps: PanelConnectionDeps = {}): PanelConnectionHandle {
  let live = current;
  if (live === undefined) {
    live = createController(deps);
    current = live;
    live.references = 1;
    if (live.runtime === undefined) {
      live.logger.warn('No extension runtime is available; the panel cannot reach the worker.');
      rejectRequests('unavailable', (entry) => entry.port === undefined);
    } else {
      openPort(live);
    }
  } else {
    live.references += 1;
    live.teardownScheduled = false;
  }

  const owner = live;
  let released = false;
  return Object.freeze({
    ...PANEL_CONNECTION,
    stop: (): void => {
      if (released) {
        return;
      }
      released = true;
      release(owner);
    },
  });
}

/*
 * ===========================================================================
 * Section M — the status hook
 * ===========================================================================
 */

/** Module-scope selector, so the subscription's selector identity is stable. */
function selectConnection(snapshot: PanelSnapshot): PanelConnectionSlice {
  return snapshot.connection;
}

/**
 * The store's connection slice — the pill's status, the worker's retry delay
 * and service URL, and the inspected tab's binding — for `../App.tsx` to decide
 * between `PairDialog` (`not-paired`), the start command
 * (`service-not-running`) and the panel body, with the wording imported from
 * `../../shared/messages`.
 *
 * A thin selector over `./session-store.ts`: it holds no state of its own.
 *
 * @returns The current connection slice; a new reference only when it changed.
 */
export function usePanelConnection(): PanelConnectionSlice {
  return usePanelStoreSelector(selectConnection);
}

/*
 * ===========================================================================
 * Section N — the reload offer
 * ===========================================================================
 */

/**
 * Register a {@link usePanelReloadState} subscriber. Module-scope, so the
 * subscription's identity is stable and React never re-subscribes.
 */
function subscribePanelReloadState(listener: () => void): () => void {
  reloadListeners.add(listener);
  return () => {
    reloadListeners.delete(listener);
  };
}

/**
 * The worker's current reload offer for the inspected tab, read outside React
 * — `../App.tsx`'s reload command checks it at call time, so a consent is
 * only ever sent while a reload is `offered`.
 *
 * @returns The held offer; the same object until its content changes.
 */
export function getPanelReloadState(): PanelReloadState {
  return reloadState;
}

/**
 * The worker's current reload offer for the inspected tab, for `../App.tsx`
 * to decide whether to show the reload notice and its action.
 *
 * `not-needed` until the worker says otherwise, after a binding loss, after a
 * port loss (until the new port's snapshot) and after teardown; `offered`
 * (with its reason) or `reloading` exactly as the worker's
 * last `reload` push or snapshot answer said.
 *
 * @returns The held offer; a new reference only when its content changed.
 *
 * @example
 * ```tsx
 * const reload = usePanelReloadState();
 * return reload.kind === 'not-needed' ? null : <PageReloadNotice reload={reload} />;
 * ```
 */
export function usePanelReloadState(): PanelReloadState {
  return useSyncExternalStore(subscribePanelReloadState, getPanelReloadState);
}
