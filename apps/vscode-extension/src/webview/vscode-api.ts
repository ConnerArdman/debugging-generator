/**
 * The webview's only channel to the outside: a bridge over `acquireVsCodeApi()` to the extension
 * host. It opens no WebSocket, calls no `fetch` and imports no extension API — the host owns every
 * connection to the local service. Every inbound frame is checked with `isHostToWebviewMessage`
 * before anything sees it, every outbound frame is typed by `WebviewToHostMessage`, and the only
 * thing persisted is presentational UI state: never a question, telemetry, a token or a code.
 */

import { isHostToWebviewMessage } from '../webview-messages';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../webview-messages';

// ---------------------------------------------------------------------------
// The VS Code webview API
// ---------------------------------------------------------------------------

/**
 * The object `acquireVsCodeApi()` returns, reduced to the three members this module uses.
 *
 * Declared here because this program sets `types: []` and `@types/vscode-webview` is not a
 * dependency. The global is reached by narrowing `globalThis` (see {@link WebviewGlobalScope})
 * rather than through `declare global`: `../webview-messages` is compiled by the host project as
 * well, and an ambient global declared from here would be a cross-project side effect.
 */
interface VsCodeWebviewApi {
  /** Posts a structured-clonable value to the host's `onDidReceiveMessage`. */
  postMessage(message: unknown): void;
  /** The value last passed to `setState` in this webview, surviving reloads while retained. */
  getState(): unknown;
  /** Replaces the persisted webview state and returns it. */
  setState<T>(state: T): T;
}

/** The global scope as VS Code's webview preload script leaves it. */
interface WebviewGlobalScope {
  readonly acquireVsCodeApi?: () => unknown;
}

/**
 * Whether `acquireVsCodeApi()` has been attempted in this document.
 *
 * VS Code hands the API out exactly once per document and throws on a second call, and React 19
 * StrictMode runs effects twice in development, so acquisition happens lazily on first use and its
 * outcome — including "unavailable" — is memoised here for the lifetime of the document.
 */
let acquisitionAttempted = false;

/** The memoised API; `undefined` before the first attempt and whenever it is unavailable. */
let memoisedApi: VsCodeWebviewApi | undefined;

/** The webview API, acquired at most once per document. */
function getVsCodeApi(): VsCodeWebviewApi | undefined {
  if (!acquisitionAttempted) {
    acquisitionAttempted = true;
    memoisedApi = acquireVsCodeApiOnce();
  }
  return memoisedApi;
}

/** Calls the global `acquireVsCodeApi()` if it exists and returns what it handed out. */
function acquireVsCodeApiOnce(): VsCodeWebviewApi | undefined {
  const scope = globalThis as WebviewGlobalScope;
  if (typeof scope.acquireVsCodeApi !== 'function') {
    // Not a VS Code webview: a unit test, a plain browser tab or a stale cached page.
    return undefined;
  }
  try {
    const api = scope.acquireVsCodeApi();
    return isVsCodeWebviewApi(api) ? api : undefined;
  } catch {
    // VS Code throws when the API was already acquired in this document by another script. The
    // channel is then unusable from here, which is exactly what "unavailable" reports.
    return undefined;
  }
}

/** Whether `value` exposes the three functions {@link VsCodeWebviewApi} declares. */
function isVsCodeWebviewApi(value: unknown): value is VsCodeWebviewApi {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly [K in keyof VsCodeWebviewApi]?: unknown };
  return (
    typeof candidate.postMessage === 'function' &&
    typeof candidate.getState === 'function' &&
    typeof candidate.setState === 'function'
  );
}

// ---------------------------------------------------------------------------
// Inbound: host → webview
// ---------------------------------------------------------------------------

/** Receives every validated host-to-webview message, in arrival order. */
export type HostMessageHandler = (message: HostToWebviewMessage) => void;

/**
 * How many validated messages are held while nothing is subscribed. The host pushes whole
 * snapshots, so the newest `state` always supersedes an older one and dropping the oldest entry
 * when the buffer is full never loses the current state.
 */
const MAX_BUFFERED_HOST_MESSAGES = 16;

/**
 * One registration. Held as an object rather than as the bare handler so that the same function
 * subscribed twice is two independent registrations, and each unsubscribe removes exactly its own.
 */
interface Subscription {
  readonly handler: HostMessageHandler;
}

/** The live registrations; a `Set` because StrictMode briefly overlaps effect lifetimes. */
const subscriptions = new Set<Subscription>();

/** Validated messages that arrived while {@link subscriptions} was empty, oldest first. */
const bufferedMessages: HostToWebviewMessage[] = [];

/** The single `message` listener: drops anything outside the contract, routes the rest. */
function receiveFromHost(event: MessageEvent<unknown>): void {
  const data = event.data;
  // The schema predicate is the guard. A webview has no stable origin to compare against, and a
  // frame outside the contract is dropped without being logged or stored.
  if (!isHostToWebviewMessage(data)) {
    return;
  }
  routeHostMessage(data);
}

/** Buffers `message` when nothing is subscribed, otherwise delivers it to every subscriber. */
function routeHostMessage(message: HostToWebviewMessage): void {
  if (subscriptions.size === 0) {
    if (bufferedMessages.length >= MAX_BUFFERED_HOST_MESSAGES) {
      bufferedMessages.shift();
    }
    bufferedMessages.push(message);
    return;
  }
  // Iterate a snapshot: a handler that subscribes during delivery waits for the next message, and
  // one that unsubscribes (itself or another) is skipped from that moment on.
  for (const subscription of [...subscriptions]) {
    if (subscriptions.has(subscription)) {
      deliver(subscription.handler, message);
    }
  }
}

/**
 * Hands the buffered messages, in arrival order, to a subscriber that has just registered.
 *
 * The buffer is emptied before the first delivery, so a handler that subscribes again from inside
 * a flushed message finds nothing left to replay and no message is delivered twice. The
 * subscription cannot end mid-flush: its unsubscribe function is returned only after this runs.
 */
function flushBufferTo(subscription: Subscription): void {
  if (bufferedMessages.length === 0) {
    return;
  }
  const pending = bufferedMessages.splice(0, bufferedMessages.length);
  for (const message of pending) {
    deliver(subscription.handler, message);
  }
}

/** Calls one handler, isolating the channel from whatever it throws. */
function deliver(handler: HostMessageHandler, message: HostToWebviewMessage): void {
  try {
    handler(message);
  } catch (error: unknown) {
    rethrowAsynchronously(error);
  }
}

/**
 * Re-raises a subscriber's error on a fresh task, so it surfaces in the webview developer tools as
 * an uncaught error without interrupting delivery to the remaining subscribers.
 */
function rethrowAsynchronously(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}

/*
 * The listener is installed at module evaluation, not in a React effect, because of the handshake:
 *
 *   main.tsx posts `ready` → the host answers with a full `state` snapshot → this listener buffers
 *   it (nothing has subscribed yet) → App.tsx subscribes in an effect → subscribeToHost flushes the
 *   buffered `state` → the first render after mount shows the real session.
 *
 * Were the listener installed in App's effect, the reply could arrive first and the view would stay
 * empty. Under StrictMode's subscribe → unsubscribe → subscribe sequence this module still has
 * exactly one `message` listener, the buffered snapshot is delivered once (to the first
 * subscription), and later messages reach the one subscription that remains. The `typeof window`
 * guard keeps importing this module harmless outside a document.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('message', receiveFromHost);
}

/**
 * Registers `handler` for every validated host-to-webview message.
 *
 * Messages that arrived before any subscriber existed — typically the host's answer to `ready` —
 * are delivered to `handler` synchronously, in arrival order, before this function returns, and
 * the buffer is then empty. Returns a function that removes exactly this registration; calling it
 * more than once is harmless. A handler that throws does not affect the other subscribers: its
 * error is re-raised asynchronously.
 *
 * @example
 * ```tsx
 * useEffect(
 *   () =>
 *     subscribeToHost((message) => {
 *       if (message.type === 'state') setState(message.state);
 *     }),
 *   [],
 * );
 * ```
 */
export function subscribeToHost(handler: HostMessageHandler): () => void {
  const subscription: Subscription = { handler };
  subscriptions.add(subscription);
  flushBufferTo(subscription);
  return () => {
    subscriptions.delete(subscription);
  };
}

// ---------------------------------------------------------------------------
// Outbound: webview → host
// ---------------------------------------------------------------------------

/**
 * Whether this document can talk to the extension host at all. Acquires the API on first call, so
 * `main.tsx` or `App.tsx` can decide once to render a degraded surface instead of discovering the
 * missing channel on every click.
 */
export function isVsCodeApiAvailable(): boolean {
  return getVsCodeApi() !== undefined;
}

/**
 * Posts one message of the host contract. Returns `true` when it was handed to VS Code and `false`
 * when there is no host channel or the message could not be posted.
 *
 * Never throws: it is called from click handlers and form submits, where an exception would become
 * an unhandled error in the webview. The return value is the signal.
 */
export function postToHost(message: WebviewToHostMessage): boolean {
  const api = getVsCodeApi();
  if (api === undefined) {
    return false;
  }
  try {
    api.postMessage(message);
    return true;
  } catch {
    // `postMessage` structured-clones its argument and throws a `DataCloneError` for a value that
    // cannot be cloned; that failure is reported through the return value like any other.
    return false;
  }
}

// ---------------------------------------------------------------------------
// UI-only persistence
// ---------------------------------------------------------------------------

/** The version stamped into every persisted {@link WebviewUiState}. */
export const UI_STATE_VERSION = 1;

/** The collapsible sections of the view whose open/closed state is remembered. */
export const WEBVIEW_UI_SECTIONS = [
  'progress',
  'relevantFiles',
  'modifications',
  'analysis',
] as const;

/** One of {@link WEBVIEW_UI_SECTIONS}. */
export type WebviewUiSection = (typeof WEBVIEW_UI_SECTIONS)[number];

/**
 * The presentational state VS Code keeps for this webview across reloads.
 *
 * PRIVACY RULE — confront it before adding a field: this shape holds purely presentational flags
 * and opaque record ids. It must never hold question text, a follow-up draft, an analysis,
 * telemetry, a token, a pairing code, a file path or file contents (AAP §0.5.2, §0.5.6). Session
 * data lives in the host and is re-sent as a snapshot after every reload; nothing here is needed to
 * restore it. {@link writeUiState} persists only the fields declared below, whatever it is given.
 */
export interface WebviewUiState {
  /** Always {@link UI_STATE_VERSION} once persisted; state of any other version is discarded. */
  readonly version: number;
  /** Ids of the `ModificationRecord` rows the developer expanded. */
  readonly expandedModificationIds: readonly string[];
  /** Id of the `ModificationRecord` whose diff is open, when one is. */
  readonly openDiffModificationId?: string;
  /** The sections the developer collapsed; every other section is open. */
  readonly collapsedSections: readonly WebviewUiSection[];
}

/** The field names of {@link WebviewUiState}, the only keys a persisted state may carry. */
const UI_STATE_KEYS: ReadonlySet<string> = new Set<keyof WebviewUiState>([
  'version',
  'expandedModificationIds',
  'openDiffModificationId',
  'collapsedSections',
]);

/**
 * The persisted UI state, or `undefined` when there is none, there is no host channel, or what VS
 * Code returned is not exactly a current-version {@link WebviewUiState}. Persisted state survives
 * reloads and extension updates and can be stale or hand-edited, so its shape is never trusted.
 */
export function readUiState(): WebviewUiState | undefined {
  const api = getVsCodeApi();
  if (api === undefined) {
    return undefined;
  }
  return parseUiState(api.getState());
}

/**
 * Persists `next`, stamped with {@link UI_STATE_VERSION}. Only the declared presentational fields
 * are copied, so a caller cannot persist anything else by passing a wider object. A no-op when
 * there is no host channel.
 */
export function writeUiState(next: WebviewUiState): void {
  const api = getVsCodeApi();
  if (api === undefined) {
    return;
  }
  api.setState(
    createUiState(
      next.expandedModificationIds.filter(isString),
      typeof next.openDiffModificationId === 'string' ? next.openDiffModificationId : undefined,
      next.collapsedSections.filter(isWebviewUiSection),
    ),
  );
}

/** Validates a persisted value field by field; anything unexpected yields `undefined`. */
function parseUiState(value: unknown): WebviewUiState | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!UI_STATE_KEYS.has(key)) {
      return undefined;
    }
  }
  const { version, expandedModificationIds, openDiffModificationId, collapsedSections } = value;
  if (version !== UI_STATE_VERSION) {
    return undefined;
  }
  if (!Array.isArray(expandedModificationIds) || !expandedModificationIds.every(isString)) {
    return undefined;
  }
  if (openDiffModificationId !== undefined && typeof openDiffModificationId !== 'string') {
    return undefined;
  }
  if (!Array.isArray(collapsedSections) || !collapsedSections.every(isWebviewUiSection)) {
    return undefined;
  }
  return createUiState(expandedModificationIds, openDiffModificationId, collapsedSections);
}

/** Builds a fresh, current-version state from already-validated field values. */
function createUiState(
  expandedModificationIds: readonly string[],
  openDiffModificationId: string | undefined,
  collapsedSections: readonly WebviewUiSection[],
): WebviewUiState {
  const state: WebviewUiState = {
    version: UI_STATE_VERSION,
    expandedModificationIds: [...expandedModificationIds],
    collapsedSections: [...collapsedSections],
  };
  return openDiffModificationId === undefined ? state : { ...state, openDiffModificationId };
}

/** Whether `value` is a non-array object created by an object literal or `JSON.parse`. */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isWebviewUiSection(value: unknown): value is WebviewUiSection {
  return typeof value === 'string' && (WEBVIEW_UI_SECTIONS as readonly string[]).includes(value);
}
