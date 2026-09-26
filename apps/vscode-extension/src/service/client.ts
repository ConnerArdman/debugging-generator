/**
 * The extension host's only wire to the local coordination service.
 *
 * Every HTTP request and every WebSocket frame, inbound or outbound, of the
 * VS Code extension passes through the {@link ServiceClient} this module builds:
 * `src/extension.ts` constructs it during `activate` and routes its
 * subscriptions into `ExtensionState`, `src/commands/**` issue operations
 * through it and `src/views/sessions-tree.ts` lists sessions through it. No
 * other module under `src/**` opens a socket or calls `fetch` against the
 * service (AAP §0.4.2: both extensions import `@debuggen/protocol` only, never
 * service internals).
 *
 * ## A façade, not a second SDK
 *
 * The transport is `@debuggen/protocol`'s: `ReconnectingWsClient` owns the
 * `client.hello` handshake, the backoff curve (500 ms → 10 s, factor 2,
 * jitter 0.5), the frame validation and the typed per-type dispatch, and
 * `HttpClient` owns the route table, the bearer header, the body validation and
 * the `Result`-shaped failures (AAP §0.7.1 Group 3: "`ReconnectingWsClient`
 * from protocol with the token from `auth.ts`"). This module adds only what the
 * editor host needs on top of them:
 *
 * - the Node `WebSocket` constructor from `ws` 8.21.3, which the protocol
 *   package deliberately does not depend on;
 * - the `debuggen.serviceUrl` setting and its changes, which rebuild both
 *   transports against the new URL (the socket URL is fixed per client);
 * - the announced project root, whose change reconnects so the new root is
 *   announced by a fresh `client.hello` rather than mutating an open
 *   connection's identity;
 * - the credential rotation policy of AAP §0.5.6, driven by `./auth`;
 * - the sockets kept announcing the project to a session's service across a
 *   URL or root change and a disposal (see below);
 * - fan-out of the connection state and of the unauthorized signal to any
 *   number of listeners, with every listener isolated from the transport;
 * - the deadline of every HTTP call, resolved per call from the caller's own
 *   `timeoutMs`, a per-operation table and a default, so a service that
 *   accepts connections but stalls cannot leave a command pending forever
 *   ({@link DEFAULT_EDITOR_REQUEST_TIMEOUT_MS},
 *   {@link EDITOR_OPERATION_TIMEOUTS_MS});
 * - one named method per HTTP operation the commands and views use, plus a
 *   typed passthrough for the rest — every path comes from the protocol's
 *   route table by operation id, never from a string written here;
 * - {@link readModificationJournal}, the one walk of the paged modification
 *   journal, which every reader of a whole journal uses so none mistakes a
 *   page for the journal;
 * - one typed {@link ServiceClient.send} for the frames the editor itself
 *   writes after the handshake — `source.result`, its answer to a forwarded
 *   `source.open` — delegating to whichever socket client is current.
 *
 * There is exactly one retry loop — the protocol client's reconnect curve.
 * Nothing here wraps a second one around it: the only repeats are single and
 * conditional (a changed credential, a hello not yet admitted), and HTTP
 * failures are returned as typed `Err` values for the caller to render
 * (AAP §0.5.5).
 *
 * ## The credential (AAP §0.5.2, §0.5.6)
 *
 * The editor credential is read lazily, per request and per handshake, from
 * the store in `./auth`: its cached token when one is held, otherwise a fresh
 * read of `$DEBUGGEN_HOME/auth.json`. It travels only in the `Authorization`
 * header (built by `HttpClient`) and in the `client.hello` payload (built by
 * `ReconnectingWsClient`). It is never logged, never placed in a URL, an error,
 * a hint, a detail or a notification, and never written anywhere. Log records
 * built here carry operation ids, message types, close codes, state names,
 * counts and error codes — nothing else.
 *
 * ## Thrown values are classified, never quoted (AAP §0.5.2)
 *
 * Every record lands in the editor's `LogOutputChannel` unredacted, and the
 * text of an exception is exactly where a developer path, a telemetry value, a
 * pasted URL or a credential ends up: a listener's `TypeError` quotes the
 * value it choked on, a socket error quotes the URL it could not open. So a
 * caught value is logged only as its projection — {@link errorClassOf}'s
 * closed class vocabulary, the `DebuggenError` code when it is one (with the
 * class of its `cause`), and a Node error code only when it is one of the
 * finite set of known system and Node codes — never its message, its `name`
 * verbatim, its stack, an unknown `code` or any other property. Each such
 * record carries a correlation `ref` minted by `newMessageId()` beside the
 * callback or frame kind it concerns; where the failure is also returned to a
 * caller (an HTTP call that failed unexpectedly), the returned error names the
 * same reference, so the failure a developer sees can be matched to its log
 * line without either carrying the exception text.
 *
 * Rotation (`debuggen.rotateServiceToken`) deletes every credential, rewrites
 * `auth.json` and closes every socket with 4401. The protocol client treats a
 * 4401 as terminal for the credential it presented; this module then re-reads
 * the file once and, **only if the token actually changed**, replaces the
 * socket client and reconnects with the new credential. An unchanged token is
 * reported through {@link ServiceClient.onUnauthorized} and nothing retries: a
 * refused credential cannot become acceptable by being presented again. An HTTP
 * `UNAUTHORIZED` refusal follows the same rule — one re-read, and one repeat of
 * the refused request only when the token on disk differs from the one that
 * was refused. Each observed refusal causes at most one re-read and at most one
 * reconnect or repeat; there is no loop.
 *
 * ## Announcing sockets outlive a URL switch and a disposal (AAP §0.5.1, §0.5.6)
 *
 * The service authorizes an editor credential only for the project folders
 * its **live** WebSocket connections announced in `client.hello`, reference-
 * counted per connection and withdrawn the moment a connection closes. Closing
 * the only socket to a service therefore withdraws the editor's authority
 * there at once, and a `session.end` that reaches it afterwards is refused
 * `PATH_OUTSIDE_PROJECT` with the session's patches left on disk. Three rules
 * keep the socket a session's end depends on alive:
 *
 * - **Disposal waits for the ends.** VS Code disposes `context.subscriptions`
 *   synchronously right after `deactivate()` returns its promise, while the
 *   end it started is still resolving its credential.
 *   {@link ServiceClient.keepConnectionsFor} registers such an operation;
 *   {@link ServiceClient.dispose} still releases every subscription, listener
 *   and watcher at once, but closes the sockets only once every registered
 *   operation settled — and after {@link CONNECTION_HOLD_TIMEOUT_MS} at the
 *   latest, so a hung operation cannot keep a socket forever.
 * - **The tracked session's service keeps its socket.**
 *   {@link ServiceClientOptions.retainedEndpoint} names the service that owns
 *   the session the editor tracks. When `debuggen.serviceUrl` or the announced
 *   root changes, a socket to that service is kept open — reconnecting and
 *   announcing as before — instead of being closed. A kept socket is closed
 *   once it no longer matches the retained endpoint and no session request
 *   relies on it ({@link ServiceClient.pruneRetainedConnections}), and
 *   switching back to its service makes it current again rather than opening
 *   a second one: there is at most one socket per service and announced root.
 * - **A request to another service travels with an announcement.** A
 *   session-scoped call addressed to a non-current endpoint
 *   ({@link SessionEndpointCallOptions}) waits, bounded by
 *   {@link ENDPOINT_SOCKET_OPEN_TIMEOUT_MS} and by at most half the call's own
 *   `timeoutMs`, for that service's socket to be open, and opens one first
 *   when none exists. The service never acknowledges a hello, so a socket that
 *   opened during the call may not have been admitted yet when the request
 *   arrives. That race is settled deterministically: a `PATH_OUTSIDE_PROJECT`
 *   answer, on a call whose socket opened while it waited, is repeated exactly
 *   once after {@link ANNOUNCEMENT_SETTLE_DELAY_MS}, within the call's budget.
 *   The refusal is decided by the service's admission check before any
 *   handler runs, so the repeat cannot apply an operation twice.
 *
 * ## Failure is a state, never an exception (AAP §0.5.5)
 *
 * Construction performs no I/O and never throws; `connect()` never throws and
 * never blocks activation; every HTTP method resolves to a `Result` and never
 * rejects. "Service not running" is a `closed`/`reconnecting` connection plus
 * an `Err` from {@link ServiceClient.health}; a misconfigured service URL is
 * {@link ServiceClient.configurationError}. A listener that throws is logged
 * and dropped for that one call; the socket survives it.
 *
 * ## Module conventions
 *
 * Authored as ESM with extensionless relative specifiers and bundled to
 * CommonJS by `esbuild.mjs`; no top-level `await`; no DOM types — the
 * transports are typed through the protocol's structural `FetchLike` and
 * `WebSocketConstructorLike`, and Node 24's global `fetch` is the default.
 * This module imports neither `./process` nor `./discovery`: `src/extension.ts`
 * wires the resolved project root in through {@link ServiceClient.setProjectRoot}
 * and hands {@link ServiceClient.health} to the process manager's health-probe
 * port, which keeps `src/service/` acyclic.
 *
 * @packageDocumentation
 */

import { getSystemErrorMap } from 'node:util';

import * as vscode from 'vscode';
import { WebSocket } from 'ws';

import {
  HttpClient,
  MODIFICATIONS_PAGE_MAX_LIMIT,
  ReconnectingWsClient,
  isAuthExemptOperation,
  parseServiceOrigin,
} from '@debuggen/protocol';
import type {
  CaptureStartResponse,
  CaptureStopResponse,
  ClientKind,
  ConnectionState,
  CreateEnvelopeOptions,
  CredentialsRotateResponse,
  DevServerLaunchRequest,
  DevServerLaunchResponse,
  DevServerStopRequest,
  DevServerStopResponse,
  FetchLike,
  HealthResponse,
  HttpCallOptions,
  HttpOperation,
  HttpRequestArgs,
  HttpResponseBody,
  ListPageRequest,
  MessageHandler,
  MessagePayload,
  MessageType,
  ModificationRecord,
  ModificationsResponse,
  PairStartResponse,
  SendOutcome,
  SessionCreateRequest,
  SessionEndResponse,
  SessionListResponse,
  SessionPurgeResponse,
  SessionQuestionRequest,
  SessionRecord,
  TargetRequestResponse,
  TimerApi,
  TokenProvider,
  Unsubscribe,
  WebSocketConstructorLike,
  WsBackoffOptions,
  WsQueueDropDetail,
  WsStateChangeDetail,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, isOk, newMessageId, noopLogger, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import type { EditorCredentialStore } from './auth';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The configuration section every Debug Generator setting is contributed under. */
const CONFIGURATION_SECTION = 'debuggen';

/** The key, inside {@link CONFIGURATION_SECTION}, of the service base URL setting. */
const SERVICE_URL_KEY = 'serviceUrl';

/**
 * The fully qualified setting id `ConfigurationChangeEvent.affectsConfiguration`
 * is asked about. Derived from the two parts above rather than spelled a
 * second time, so the key read and the key watched cannot disagree.
 */
const SERVICE_URL_SETTING_ID = `${CONFIGURATION_SECTION}.${SERVICE_URL_KEY}`;

/**
 * The client kind this process announces in `client.hello`: the editor
 * (AAP §0.5.6, role `vscode`). Typed against the protocol's identity so a value
 * outside `CLIENT_KINDS` is a compile error.
 */
const EDITOR_CLIENT_KIND = 'vscode' satisfies ClientKind;

/**
 * Operations the editor host never performs, even through the generic
 * {@link ServiceClient.request} passthrough.
 *
 * - `pair.complete` redeems a pairing code for a DevTools credential. It is the
 *   Chrome service worker's half of pairing, called from its
 *   `chrome-extension://` origin; the editor only *starts* a pairing
 *   (`pair.start`) and never holds a DevTools credential (AAP §0.5.6).
 * - `telemetry.event` is the Node preload's ingest route, accepted only for a
 *   server-agent credential scoped to one project.
 *
 * Excluded in the type of {@link EditorHttpOperation} and, for untyped callers,
 * at run time by {@link EDITOR_EXCLUDED_OPERATION_SET}.
 */
const EDITOR_EXCLUDED_OPERATIONS = [
  'pair.complete',
  'telemetry.event',
] as const satisfies readonly HttpOperation[];

/** {@link EDITOR_EXCLUDED_OPERATIONS} as a lookup set over the whole operation vocabulary. */
const EDITOR_EXCLUDED_OPERATION_SET: ReadonlySet<HttpOperation> = new Set<HttpOperation>(
  EDITOR_EXCLUDED_OPERATIONS,
);

/**
 * The close reason sent when the client is disposed. It reaches the service's
 * log, so it is a constant sentence carrying nothing but the fact.
 */
const DISPOSED_CLOSE_REASON = 'the editor client was disposed';

/** The close reason sent when a socket client is replaced by a new one. */
const REPLACED_CLOSE_REASON = 'the editor client is reconnecting with a new configuration';

/**
 * The close reason sent when a kept socket is released: the editor no longer
 * tracks a session at that service and no session request relies on it.
 */
const RETAINED_RELEASED_CLOSE_REASON = 'the editor no longer tracks a session at this service';

/**
 * The longest {@link ServiceClient.dispose} keeps the sockets open for the
 * operations registered with {@link ServiceClient.keepConnectionsFor}, in
 * milliseconds, counted from the disposal.
 *
 * Comfortably above the whole shutdown routine's bound — the active end's
 * `DEFAULT_SHUTDOWN_TIMEOUTS.activeEndMs` of 3 s in
 * `src/commands/end-session.ts`, which the creates' wait plus their ends never
 * exceed — and above the 5 s VS Code allows `deactivate()`, so it never cuts an
 * end short; it only stops a hung operation from holding a socket forever. The
 * extension-host suite asserts the relation, since this module cannot import
 * the commands (`src/service/` stays below them).
 */
export const CONNECTION_HOLD_TIMEOUT_MS = 10_000;

/**
 * The longest a session request addressed to a non-current endpoint waits for
 * the socket announcing the project to that service to be open, in
 * milliseconds. A call with a `timeoutMs` waits at most half of it, so the
 * request itself always keeps the rest of the caller's budget. A loopback
 * socket opens in milliseconds; a service that is down never opens one, and
 * the request is then sent anyway for the service's own answer.
 */
export const ENDPOINT_SOCKET_OPEN_TIMEOUT_MS = 3_000;

/**
 * The pause before the one repeat of a request refused `PATH_OUTSIDE_PROJECT`
 * whose announcing socket opened during the call, in milliseconds: time for
 * the service to process a hello it received a moment before the request,
 * which it never acknowledges.
 */
export const ANNOUNCEMENT_SETTLE_DELAY_MS = 150;

/**
 * The generation of a socket client that was never current: one opened for a
 * request to another service. Generations count up from zero, so it never
 * matches the current one.
 */
const NEVER_CURRENT_GENERATION = -1;

/** The refusal of a project-scoped request no live editor socket announced (AAP §0.5.6). */
const NOT_ANNOUNCED_CODE = 'PATH_OUTSIDE_PROJECT' satisfies DebuggenErrorCode;

/** The state-change reason announced when `debuggen.serviceUrl` changed. */
const SERVICE_URL_CHANGED_REASON = 'the service URL setting changed';

/** The state-change reason announced when the announced project root changed. */
const PROJECT_ROOT_CHANGED_REASON = 'the workspace project changed';

/** The state-change reason announced when a rotated credential is presented. */
const CREDENTIAL_ROTATED_REASON = 'the service credential was rotated';

/**
 * The message of a frame refused because the client was disposed. A constant
 * sentence: it names the fact, never the frame.
 */
const SEND_AFTER_DISPOSE_MESSAGE = 'The editor client was disposed, so the frame was not sent';

/** The hint attached to a frame refused after disposal. */
const SEND_AFTER_DISPOSE_HINT =
  'The VS Code window is shutting down or the extension was deactivated; nothing will be sent until it activates again.';

/** The hint attached to a refused call of an operation the editor never performs. */
const EXCLUDED_OPERATION_HINT =
  'Pairing is completed by the Chrome DevTools panel and telemetry is posted by the dev-server preload; the editor starts a pairing with the Pair Chrome command instead.';

/** The unsubscribe handed out after disposal: there is nothing to remove. */
const NOOP_UNSUBSCRIBE: Unsubscribe = () => undefined;

/**
 * The Node `WebSocket` implementation the socket client is constructed with.
 *
 * `ws` 8.21.3's class satisfies the protocol's structural
 * {@link WebSocketConstructorLike} directly — its `(address, protocols?,
 * options?)` overload, its numeric `readyState`, its generic
 * `addEventListener`/`removeEventListener` over `open`/`message`/`close`/`error`,
 * `send(string)` and `close(code?, reason?)` — so the assignment below is the
 * compile-time proof, and no adapter or cast is needed. The protocol package
 * cannot state this proof itself because it deliberately declares no `ws`
 * dependency.
 */
const NODE_WEB_SOCKET: WebSocketConstructorLike = WebSocket;

// ---------------------------------------------------------------------------
// Request deadlines
// ---------------------------------------------------------------------------

/**
 * The deadline, in milliseconds, the editor gives an HTTP call that states
 * none of its own and whose operation has no entry in
 * {@link EDITOR_OPERATION_TIMEOUTS_MS}. `src/extension.ts` passes it as
 * {@link ServiceClientOptions.defaultTimeoutMs}.
 *
 * Every operation it bounds answers as soon as its effect is recorded: the
 * service starts the long work — indexing, the model stages, analysis and
 * panel generation — without awaiting it and reports it through WebSocket
 * frames. A healthy service therefore answers well inside fifteen seconds, and
 * one that accepts the connection but stalls ends the call with the protocol
 * client's `TRANSPORT_DISCONNECTED` failure (`details.cancelled: 'timeout'`,
 * and a hint to check the service and try again) instead of leaving a command
 * or a view pending for as long as the editor runs.
 */
export const DEFAULT_EDITOR_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Deadlines, in milliseconds, for the editor operations whose service-side
 * work legitimately outlasts {@link DEFAULT_EDITOR_REQUEST_TIMEOUT_MS}.
 * `src/extension.ts` passes it as {@link ServiceClientOptions.operationTimeoutsMs}.
 * Each bound is the longest wait the service itself allows the operation, plus
 * room for the work that follows that wait:
 *
 * - `session.end` — 90 s. The route first waits up to 30 s (the service's
 *   `DEFAULT_END_SETTLE_TIMEOUT_MS`) for a cancelled in-flight operation of the
 *   session to settle, then awaits cleanup, which restores every modification
 *   of the session and verifies each restored file.
 * - `capture.start` — 90 s. Readiness is re-evaluated before the window is
 *   armed; when the page's hook was not in place before React loaded, the
 *   service asks the developer to reload the page and waits up to 60 s (its
 *   `DEFAULT_RELOAD_WAIT_MS`) for the reloaded page's agent, then arms both
 *   producers.
 * - `devServer.launch` — 120 s, the bound `debuggen.launchDevServer` already
 *   passes per call: detection, spawning the dev server with the telemetry
 *   preload, and up to 60 s (the launcher's `DEFAULT_READY_TIMEOUT_MS`) for a
 *   cold compile to start answering.
 * - `devServer.stop` — 30 s: the 5 s graceful stop of the process group, the
 *   escalation to `SIGKILL` and its confirmation, and the revocation of the
 *   preload's credential.
 * - `panel.data` — 30 s: a panel query reads the stored capture's events and
 *   correlates or aggregates them, which grows with the capture.
 *
 * Deliberately absent: `capture.stop` answers as soon as the capture's summary
 * is stored while analysis continues in the background, so the default bounds
 * it (a stop that resumes an interrupted analysis awaits that analysis; its
 * timeout ends only the editor's wait, and the analysis keeps reporting
 * through its frames); `session.list`, `session.get` and `health` are bounded
 * tighter still by the callers that issue them in the background.
 *
 * Frozen, so no consumer can widen a bound for every other caller.
 */
export const EDITOR_OPERATION_TIMEOUTS_MS: Readonly<Partial<Record<HttpOperation, number>>> =
  Object.freeze({
    'session.end': 90_000,
    'capture.start': 90_000,
    'devServer.launch': 120_000,
    'devServer.stop': 30_000,
    'panel.data': 30_000,
  });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Every HTTP operation the editor host may call: the protocol's whole
 * operation vocabulary minus `pair.complete` and `telemetry.event`, which
 * belong to the Chrome service worker and the Node preload respectively
 * (AAP §0.5.6).
 */
export type EditorHttpOperation = Exclude<
  HttpOperation,
  (typeof EDITOR_EXCLUDED_OPERATIONS)[number]
>;

/**
 * What this module needs from the editor credential store of `./auth`: the
 * cached token (read synchronously per request and per handshake), a read of
 * `auth.json` when nothing is cached yet, and the rotation re-read.
 *
 * A structural subset of `EditorCredentialStore`, so the real store is passed
 * as is and a test passes a three-method fake. Every member resolves rather
 * than rejects, per that module's contract; this module still guards against a
 * rejection.
 */
export type ServiceCredential = Pick<EditorCredentialStore, 'token' | 'read' | 'refresh'>;

/**
 * The options of the calls that act on one stored session and must therefore
 * reach the service that holds it: `session.end`, `session.get` and
 * `modifications.list`.
 *
 * A session lives in the store of the service that created it. When
 * `debuggen.serviceUrl` changes while a session is active, the new URL names
 * a service that does not hold that session — its `SESSION_NOT_FOUND` says
 * nothing about the session's instrumentation — so the caller names the
 * owning service explicitly (`ExtensionState.activeSessionEndpoint`).
 *
 * @example
 * ```ts
 * const endpoint = state.activeSessionEndpoint; // the service that created it
 * const ended = await client.endSession(sessionId, { endpoint, timeoutMs: 4_000 });
 * ```
 */
export interface SessionEndpointCallOptions extends HttpCallOptions {
  /**
   * The base URL of the service that owns the session. When its canonical
   * origin differs from the current base URL, the call — and the one repeat the
   * `UNAUTHORIZED` re-read policy allows — is sent through a one-off HTTP
   * client for that origin, with the same lazily read editor credential, and
   * nowhere else. Such a call first waits, bounded, for a socket announcing
   * the project to that service to be open, opening one when none is kept
   * (see "Announcing sockets outlive a URL switch and a disposal" above). A
   * value the service-origin policy refuses answers that `CONFIG_INVALID`
   * refusal without sending anything. Omitted or `undefined` means the current
   * base URL, exactly as before this option existed.
   */
  readonly endpoint?: string | undefined;
}

/** A listener for {@link ServiceClient.onStateChange}. */
export type ServiceStateListener = (state: ConnectionState, detail?: WsStateChangeDetail) => void;

/** A listener for {@link ServiceClient.onUnauthorized}. */
export type ServiceUnauthorizedListener = (detail: WsUnauthorizedDetail) => void;

/** The `vscode.Disposable` shape, without requiring the class. */
export interface ServiceClientDisposable {
  /** Releases what the disposable holds. */
  dispose(): void;
}

/**
 * Where the service base URL comes from, and how its changes are observed.
 *
 * The default, {@link createVsCodeServiceConfiguration}, reads and watches the
 * `debuggen.serviceUrl` setting; a test injects its own. Neither member may be
 * relied upon not to throw — the client guards both.
 */
export interface ServiceClientConfiguration {
  /**
   * The configured base URL, for example `http://127.0.0.1:43117`. An empty
   * string is a valid answer: the protocol clients refuse it as a
   * configuration error, which the client reports rather than throws.
   */
  readServiceUrl(): string;

  /**
   * Calls `listener` whenever the base URL setting may have changed.
   *
   * @returns A disposable that stops the notifications.
   */
  onDidChangeServiceUrl(listener: () => void): ServiceClientDisposable;
}

/**
 * How {@link createServiceClient} is configured.
 *
 * Only the credential is required. Every other member has a production
 * default and exists so a test can substitute a transport, a clock or a
 * configuration source without a running editor or service. Every optional
 * member declares `| undefined`, as `tsconfig.base.json` prescribes under
 * `exactOptionalPropertyTypes`, so a caller can forward its own optional values.
 */
export interface ServiceClientOptions {
  /**
   * The editor credential store (`createEditorCredentialStore()` from
   * `./auth`). Its token is resolved lazily on every request and every
   * handshake, never captured.
   */
  readonly credential: ServiceCredential;

  /**
   * The project root announced as `client.hello.projectRoot` — the absolute
   * path of the workspace folder the developer is debugging, as
   * `./discovery` resolved it. Omitted when no folder is open; replaced later
   * with {@link ServiceClient.setProjectRoot}.
   */
  readonly projectRoot?: string | undefined;

  /**
   * Where this client's records go: in production the OutputChannel-backed
   * logger `src/extension.ts` creates. Defaults to a logger that discards
   * everything. No record ever carries the credential, a payload, a response
   * body or the text of a thrown value — a caught value is recorded only
   * through {@link errorClassOf} and its error code.
   */
  readonly logger?: Logger | undefined;

  /**
   * The source of the service base URL. Defaults to
   * {@link createVsCodeServiceConfiguration}, the `debuggen.serviceUrl`
   * setting and its change events.
   */
  readonly configuration?: ServiceClientConfiguration | undefined;

  /** The socket implementation. Defaults to `ws` 8.21.3's `WebSocket`. */
  readonly webSocketConstructor?: WebSocketConstructorLike | undefined;

  /** The HTTP transport. Defaults to Node 24's global `fetch`, resolved per call. */
  readonly fetch?: FetchLike | undefined;

  /**
   * The deadline, in milliseconds, of an HTTP call that sets no `timeoutMs`
   * of its own and whose operation has no entry in
   * {@link ServiceClientOptions.operationTimeoutsMs}. Production passes
   * {@link DEFAULT_EDITOR_REQUEST_TIMEOUT_MS}, so a service that accepts the
   * connection but never answers ends every command's call with a retryable
   * `TRANSPORT_DISCONNECTED` failure instead of leaving it pending.
   *
   * Omitted — together with `operationTimeoutsMs` — means no deadline at all,
   * which is what a test or a caller that bounds every call itself relies on.
   * A value that is not a finite positive number also means no deadline, the
   * protocol client's rule.
   */
  readonly defaultTimeoutMs?: number | undefined;

  /**
   * Per-operation deadlines, in milliseconds, for operations whose
   * service-side work legitimately outlasts `defaultTimeoutMs`. Production
   * passes {@link EDITOR_OPERATION_TIMEOUTS_MS}.
   *
   * Every HTTP call resolves its deadline in one order: the call's own
   * `timeoutMs` when it states one (so a caller's tighter bound, such as the
   * four seconds `deactivate()` allows `session.end`, always wins), else this
   * table's entry for the operation, else `defaultTimeoutMs`. An entry that is
   * not a finite positive number is ignored and the default applies. The
   * deadline is resolved once per call, so the single repeat of a call refused
   * as `UNAUTHORIZED` is bounded exactly like the call it repeats.
   */
  readonly operationTimeoutsMs?: Readonly<Partial<Record<HttpOperation, number>>> | undefined;

  /** The timer pair of the socket client's reconnect curve. Defaults to the platform timers. */
  readonly timers?: TimerApi | undefined;

  /** The randomness of the reconnect jitter. Defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;

  /**
   * Overrides for the reconnect curve. Defaults to the protocol's
   * `DEFAULT_WS_BACKOFF`, the curve AAP §0.5.5 prescribes; production code
   * passes nothing.
   */
  readonly backoff?: WsBackoffOptions | undefined;

  /**
   * The base URL of the service whose announcing socket must survive a change
   * of `debuggen.serviceUrl` or of the announced project root: the owner of
   * the session the editor tracks, open or ended but still in view, so its end
   * and the cleanup details loaded after it are still admitted there.
   * `src/extension.ts` passes `() => state.activeSessionEndpoint`.
   *
   * Read, never cached, whenever a socket is replaced, whenever a request
   * addressed to an endpoint settles and on every
   * {@link ServiceClient.pruneRetainedConnections}. An answer the
   * service-origin policy refuses, a callback that throws, and an omitted
   * option all mean "keep nothing" — the behaviour before this option existed.
   *
   * @example
   * ```ts
   * const client = createServiceClient({
   *   credential,
   *   retainedEndpoint: () => state.activeSessionEndpoint,
   * });
   * state.onDidChange(() => client.pruneRetainedConnections());
   * ```
   */
  readonly retainedEndpoint?: (() => string | undefined) | undefined;
}

/**
 * The extension host's typed connection to the local service: one WebSocket
 * for the frames the service pushes and the answers the editor sends back, and
 * one named method per HTTP operation the editor performs.
 *
 * Shaped as a `vscode.Disposable`, so `src/extension.ts` pushes it into
 * `context.subscriptions`. Every asynchronous member resolves to a `Result`
 * and never rejects; no member throws for an expected condition (AAP §0.5.5).
 */
export interface ServiceClient extends ServiceClientDisposable {
  /**
   * The socket's connection state, one of the protocol's four
   * `CONNECTION_STATES` literals, passed through unchanged — the vocabulary
   * `ExtensionState.setConnectionStatus` and the DevTools pill share.
   */
  readonly state: ConnectionState;

  /**
   * The validated service origin both transports talk to, for example
   * `http://127.0.0.1:43117`, or `undefined` when the configured URL was
   * refused. Safe to display: it is the canonical loopback origin, never the
   * raw configured value.
   */
  readonly baseUrl: string | undefined;

  /**
   * Why the configured service URL was refused (`CONFIG_INVALID`, with the
   * broken rule in `details.rule`), or `undefined` when it was accepted. While
   * it is set every HTTP call answers this failure and the socket opens nothing.
   */
  readonly configurationError: DebuggenError | undefined;

  /** The project root the next `client.hello` announces, if any. */
  readonly projectRoot: string | undefined;

  /**
   * Opens the WebSocket, or resumes one the protocol client stopped retrying
   * (after a refused credential, once the developer has rotated or restarted).
   * Idempotent while connecting or open, never throws and never waits: with
   * the service absent the connection simply stays on the reconnect curve and
   * activation proceeds (AAP §0.5.5).
   */
  connect(): void;

  /**
   * Stops watching the configuration and releases every subscription and
   * listener at once, then closes every socket — the current one and any kept
   * for a session's service — as soon as every operation registered with
   * {@link ServiceClient.keepConnectionsFor} settled, and after
   * {@link CONNECTION_HOLD_TIMEOUT_MS} at the latest; immediately when none is
   * registered. Idempotent. HTTP operations stay callable afterwards — they
   * hold no connection — so `deactivate()` can still end the active session
   * whatever order the editor disposes things in, and the sockets it relies on
   * for the service's authorization are still announcing when it arrives.
   */
  dispose(): void;

  /**
   * Keeps every socket open until `operation` settled, even across
   * {@link ServiceClient.dispose}: the service admits an editor's session
   * request only while a live socket announces its project, and VS Code
   * disposes this client synchronously right after `deactivate()` returns its
   * promise, before the end that promise waits for has left the process.
   * Mirrors `ServiceProcess.keepAliveFor`. Register before the first `await`
   * of the operation's owner. After the sockets were finally closed there is
   * nothing left to hold and the operation is returned untouched.
   *
   * @param operation The work the sockets must outlive; its outcome is not
   *   inspected, and a rejection releases the hold like a resolution.
   * @returns The same promise.
   *
   * @example
   * ```ts
   * // In deactivate(), in the same turn VS Code disposes the client:
   * const ending = client.keepConnectionsFor(endAllSessions());
   * ```
   */
  keepConnectionsFor<T>(operation: Promise<T>): Promise<T>;

  /**
   * Closes every kept socket that no longer serves a purpose: one whose
   * service is not {@link ServiceClientOptions.retainedEndpoint} any more and
   * that no session request in flight relies on. Cheap — one callback read and
   * a pass over the kept sockets, at most a handful — and idempotent, so
   * `src/extension.ts` calls it on every store change. A no-op after
   * {@link ServiceClient.dispose}, when whatever is kept is closed with the
   * rest.
   */
  pruneRetainedConnections(): void;

  /**
   * Subscribes to connection-state changes of the socket, including those of a
   * socket client that replaced an earlier one after a configuration change or
   * a credential rotation. A replacement is announced as `reconnecting` with a
   * reason before the new socket reports its own states.
   *
   * @returns A function that removes the listener; calling it twice is harmless.
   */
  onStateChange(listener: ServiceStateListener): Unsubscribe;

  /**
   * Subscribes to the refused-credential signal (close code 4401, AAP §0.5.6):
   * raised when the service refused the editor credential and re-reading
   * `auth.json` produced no different token, so nothing will retry until the
   * developer acts — `debuggen.rotateServiceToken`, or restarting the service.
   * Deliberately separate from {@link ServiceClient.onStateChange}: the state
   * stays one of the four literals (`closed`).
   *
   * @returns A function that removes the listener; calling it twice is harmless.
   */
  onUnauthorized(listener: ServiceUnauthorizedListener): Unsubscribe;

  /**
   * Points both transports at a new service base URL. The HTTP client is
   * rebuilt and the socket client replaced; if a connection was requested it
   * reconnects against the new URL. The replaced socket is kept open when its
   * service is {@link ServiceClientOptions.retainedEndpoint}, and a socket
   * kept for the new URL and root becomes current instead of a second one
   * being opened. Driven automatically by changes to `debuggen.serviceUrl`; a
   * no-op when the value is unchanged.
   */
  setBaseUrl(url: string): void;

  /**
   * Replaces the project root announced as `client.hello.projectRoot` — a
   * single optional path, the only form the wire carries. A connected socket
   * is replaced so a fresh hello announces the new root; an open connection's
   * identity is never mutated, and the replaced socket is kept as
   * {@link ServiceClient.setBaseUrl} keeps one. A no-op when the value is
   * unchanged.
   */
  setProjectRoot(root: string | undefined): void;

  /**
   * Subscribes to one inbound message type, delegating to the protocol
   * client's typed dispatch: the handler receives the validated frame already
   * narrowed to that type (for a concrete `K`, `MessageHandler<K>` is exactly
   * `(message: MessageByType<K>) => void`). The subscription survives socket
   * replacement. A handler that throws is logged with the message type and
   * the thrown value's closed class and error code only — never its message,
   * its stack or the frame — and the connection is unaffected.
   *
   * The frames the extension host consumes, each routed one-to-one into
   * `ExtensionState` by `src/extension.ts`: `session.created`,
   * `session.updated`, `session.progress`, `instrumentation.plan`,
   * `instrumentation.ready`, `instrumentation.failed`, `capture.started`,
   * `capture.stopped`, `analysis.completed`, `panel.generated`,
   * `cleanup.completed`, `source.open` and `error` — and `session.bound`,
   * which the service also sends to the editor (AAP §0.4.2). Any other
   * `MessageType` is subscribable the same way.
   *
   * @returns A function that removes the subscription; calling it twice is harmless.
   */
  on<K extends MessageType>(type: K, handler: MessageHandler<K>): Unsubscribe;

  /**
   * Sends one frame to the service over the current socket client — the one
   * that replaced an earlier client after a configuration change or a
   * credential rotation, never a stale one.
   *
   * The frame the extension host sends today is `source.result`, the editor's
   * answer to a `source.open` the service forwarded: `src/extension.ts` sends
   * it with `ref` set to the `id` of the frame it answers, so the service can
   * relay the outcome to the DevTools panel that asked. The payload type is
   * fixed by `type` through the protocol's registry, so the wrong payload is a
   * compile error; the receiver validates it.
   *
   * Written now when the socket is open, otherwise queued by the protocol
   * client for the next handshake (`ok('queued')`) — both are successes. After
   * {@link ServiceClient.dispose} every frame is refused with
   * `TRANSPORT_DISCONNECTED`. Never throws. A refusal is logged by message
   * type and error code only, never the payload.
   *
   * @param type The message to send.
   * @param payload That message's payload.
   * @param options The envelope overrides `createEnvelope` accepts: the
   *   routing `sessionId`, the frame `id` and the timestamp.
   * @returns `ok('sent')`, `ok('queued')`, or `err(error)` when the frame could
   *   not be handed to any socket.
   */
  send<K extends MessageType>(
    type: K,
    payload: MessagePayload<K>,
    options?: CreateEnvelopeOptions,
  ): Result<SendOutcome, DebuggenError>;

  /**
   * `GET /health`: whether the service answers, and which protocol version it
   * speaks. Auth-exempt, so it works before any credential exists; an `Err`
   * is itself the answer "service not running". The liveness probe the
   * process manager's health port is wired to.
   */
  health(options?: HttpCallOptions): Promise<Result<HealthResponse, DebuggenError>>;

  /**
   * `session.create` (`POST /sessions`): starts a session with a question.
   * The body's optional `devServerUrl` carries the developer's own dev server
   * when the editor's probe of `debuggen.devServerUrl` got an answer; the
   * service verifies it again before recording it.
   */
  createSession(
    request: SessionCreateRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * `session.list` (`GET /sessions`): one page of the stored sessions the
   * announced workspace covers, most recently updated first, for the Sessions
   * tree.
   *
   * Resolves to the whole page body: `sessions` holds list rows
   * (`SessionListItem` — the fields a row renders, never a whole record, so no
   * plan, diff or analysis is transferred for a session that is merely
   * listed), `total` counts every in-scope session before paging, and
   * `nextOffset` is the offset of the following page, or `null` exactly when
   * this page ends the listing. Reopening a session (`getSession`) is how a
   * whole record is obtained.
   *
   * `window` travels as the `limit` and `offset` query parameters. An omitted
   * member gets the service's default (`SESSION_LIST_DEFAULT_LIMIT` rows,
   * offset `0`), and the page echoes the window it applied. A caller reaches
   * the rest of the listing by asking again at `nextOffset`, at most
   * `SESSION_LIST_MAX_LIMIT` rows at a time. A member outside that range is
   * refused locally with `PROTOCOL_INVALID_MESSAGE` before anything is sent,
   * exactly as the service would refuse it.
   *
   * @example
   * ```ts
   * const first = await client.listSessions({ limit: SESSION_LIST_MAX_LIMIT, offset: 0 });
   * if (isOk(first) && first.value.nextOffset !== null) {
   *   await client.listSessions({ limit: SESSION_LIST_MAX_LIMIT, offset: first.value.nextOffset });
   * }
   * ```
   *
   * @param window The page to ask for; omitted, the service's default window.
   * @param options The caller's abort signal and timeout.
   */
  listSessions(
    window?: ListPageRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionListResponse, DebuggenError>>;

  /**
   * `session.get` (`GET /sessions/:id`): one session — the reopen path, and the
   * authoritative record after an end. `options.endpoint` reads it from the
   * service that owns it; see {@link SessionEndpointCallOptions}.
   */
  getSession(
    sessionId: string,
    options?: SessionEndpointCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /** `session.question` (`POST /sessions/:id/question`): asks a follow-up question. */
  askQuestion(
    sessionId: string,
    request: SessionQuestionRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * `target.request` (`POST /sessions/:id/target/request`, body `{}`): asks the
   * service to push `target.request` to the Chrome DevTools tab bound to the
   * session, whose Debug Generator panel then enters element-picker mode
   * (AAP §0.4.2). The editor has no connection to that tab; the service, which
   * owns the binding, chooses the recipient, so the body names no tab.
   *
   * `Ok` means the push reached the bound tab's live connection, never that an
   * element was picked: the element the developer picks arrives later as the
   * record's `target` in `session.updated`. The failures a caller branches on
   * are the route's own contract — `SESSION_NOT_FOUND`, `SESSION_INVALID_STATE`
   * (ended or failed), `TAB_NOT_BOUND` (no DevTools tab is bound) and
   * `TRANSPORT_DISCONNECTED` (the bound tab's connection is offline, answered
   * with a status; or the service itself could not be reached, answered with
   * none).
   *
   * @example
   * ```ts
   * const asked = await client.requestTarget(sessionId);
   * if (isErr(asked) && asked.error.code === 'TAB_NOT_BOUND') {
   *   // Tell the developer to open the Debug Generator panel in the app's tab.
   * }
   * ```
   */
  requestTarget(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<TargetRequestResponse, DebuggenError>>;

  /**
   * `session.end` (`POST /sessions/:id/end`): ends the session and runs
   * cleanup, answering its outcome (`clean`, `partial`, `conflict` or
   * `pending`). A conflict is a successful reply, not a failure.
   * `options.endpoint` sends it to the service that owns the session, so a
   * `SESSION_NOT_FOUND` answer is that service's; see
   * {@link SessionEndpointCallOptions}.
   */
  endSession(
    sessionId: string,
    options?: SessionEndpointCallOptions,
  ): Promise<Result<SessionEndResponse, DebuggenError>>;

  /**
   * `capture.start` (`POST /sessions/:id/capture/start`): opens a capture
   * window. When another session already captures this project the failure
   * carries that session in `error.details.owningSessionId` (the `409` of
   * AAP §0.4.2), exactly as the protocol client reports it.
   */
  startCapture(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<CaptureStartResponse, DebuggenError>>;

  /** `capture.stop` (`POST /sessions/:id/capture/stop`): closes the window and summarises it. */
  stopCapture(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<CaptureStopResponse, DebuggenError>>;

  /**
   * `modifications.list` (`GET /sessions/:id/modifications`): one page of the
   * session's modification journal, in application order.
   * `options.endpoint` reads it from the service that owns the session; see
   * {@link SessionEndpointCallOptions}.
   *
   * Resolves to the whole page body. A page is bounded twice by the service —
   * at most `limit` records (`MODIFICATIONS_PAGE_DEFAULT_LIMIT` when the window
   * names none, `MODIFICATIONS_PAGE_MAX_LIMIT` at most) and at most
   * `MODIFICATIONS_PAGE_DIFF_BUDGET` UTF-8 bytes of diff text summed over its
   * records — so one answer never carries the whole journal's diffs when those
   * exceed the budget. `total` is the journal's full length and `nextOffset` is
   * `null` exactly when this page ends the journal; a caller reports `total`,
   * never the page's length, as the journal's size. A caller that needs every
   * record walks the pages through {@link readModificationJournal}.
   *
   * `window` travels as the `limit` and `offset` query parameters and is
   * refused locally, with `PROTOCOL_INVALID_MESSAGE`, when a member is out of
   * range. A caller that needs only the journal's size asks for `{ limit: 0 }`:
   * the page then carries `total` and no record, so no diff is transferred.
   *
   * @example
   * ```ts
   * const counted = await client.getModifications(sessionId, { limit: 0 });
   * if (isOk(counted)) report(counted.value.total); // no record, no diff
   * ```
   *
   * @param sessionId The session whose journal is read.
   * @param window The page to ask for; omitted, the service's default window.
   * @param options The caller's abort signal and timeout.
   */
  getModifications(
    sessionId: string,
    window?: ListPageRequest,
    options?: SessionEndpointCallOptions,
  ): Promise<Result<ModificationsResponse, DebuggenError>>;

  /**
   * `devServer.launch` (`POST /dev-server/launch`): probes for, or starts, the
   * project's dev server with the telemetry preload attached. A request that
   * names a `sessionId` ties a started dev server to that session: the service
   * stops it, and revokes its credential, when the session ends. Without one
   * the dev server is the developer's and keeps serving after sessions end.
   */
  launchDevServer(
    request: DevServerLaunchRequest,
    options?: HttpCallOptions,
  ): Promise<Result<DevServerLaunchResponse, DebuggenError>>;

  /**
   * `devServer.stop` (`POST /dev-server/stop`): stops the dev server the
   * service launched for a project; `stopped: false` is a success.
   */
  stopDevServer(
    request: DevServerStopRequest,
    options?: HttpCallOptions,
  ): Promise<Result<DevServerStopResponse, DebuggenError>>;

  /**
   * `pair.start` (`POST /pair/start`, editor credential required): mints the
   * one-time code `debuggen.pairChrome` shows. The editor never redeems a code
   * itself (AAP §0.5.6).
   */
  pairStart(options?: HttpCallOptions): Promise<Result<PairStartResponse, DebuggenError>>;

  /**
   * `credentials.rotate` (`POST /credentials/rotate`, editor credential
   * required): revokes every credential the service issued — this editor's,
   * every paired DevTools panel's and every launched dev server's — writes a
   * new editor credential to `$DEBUGGEN_HOME/auth.json` and closes every open
   * socket with 4401 (AAP §0.5.6). Resolves with how many credentials were
   * deleted and how many sockets were closed; no credential is on the wire.
   *
   * The body is always `{}`: rotation is all or nothing, so nothing a caller
   * could send may narrow it. The request presents the credential it is about
   * to revoke, and the reply is the last answer that credential earns. The
   * socket's own 4401 handling (see the module documentation) re-reads
   * `auth.json` and reconnects with the new token whichever of the reply and
   * the close arrives first; this method adds no reconnect of its own. A
   * failure is an `Err` carrying the service's message, which says whether the
   * rotation was applied — never a rejection.
   *
   * @param options Per-call transport options (timeout, abort signal).
   * @returns The rotation's tally, or the typed failure.
   *
   * @example
   * ```ts
   * const rotated = await client.rotateCredentials();
   * if (isOk(rotated)) {
   *   await credentials.refresh(); // the new token, from auth.json
   * }
   * ```
   */
  rotateCredentials(
    options?: HttpCallOptions,
  ): Promise<Result<CredentialsRotateResponse, DebuggenError>>;

  /**
   * `session.purge` (`POST /sessions/purge`, editor credential required): runs
   * the service's retention sweep now (AAP §0.4.2) — the sweep it otherwise
   * runs only as it starts. Sessions older than the service's
   * `DEBUGGEN_RETENTION_DAYS` window go with their telemetry, panels,
   * analyses, modification records and backup directories; stale code-index
   * caches and unreferenced backups past the seven-day grace go too; an aged
   * session holding an unresolved conflict is kept and named in the report.
   *
   * The body is always `{}`: the window is the service's configuration, never
   * the caller's. The reply is counts plus at most
   * `SESSION_PURGE_MAX_REPORTED_SESSIONS` retained session ids — no path, no
   * content. A failure is an `Err` carrying the service's message, never a
   * rejection.
   *
   * @param options Per-call transport options (timeout, abort signal).
   * @returns The sweep's report, or the typed failure.
   *
   * @example
   * ```ts
   * const purged = await client.purgeSessions();
   * if (isOk(purged) && purged.value.sessionsDeleted > 0) {
   *   await sessionsTree.refresh();
   * }
   * ```
   */
  purgeSessions(options?: HttpCallOptions): Promise<Result<SessionPurgeResponse, DebuggenError>>;

  /**
   * The typed passthrough to any editor operation in the protocol's route
   * table — the panel reads, `panel.data`, and whatever a later command needs —
   * without a new wrapper and without a hand-written path. Path parameters go
   * in `args.params` and are encoded by the protocol's `buildPath`.
   */
  request<O extends EditorHttpOperation>(
    operation: O,
    args?: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>>;
}

// ---------------------------------------------------------------------------
// The default configuration source
// ---------------------------------------------------------------------------

/**
 * The production {@link ServiceClientConfiguration}: the `debuggen.serviceUrl`
 * setting, read afresh on every call, and `workspace.onDidChangeConfiguration`
 * filtered to that one setting.
 *
 * The setting's default (`package.json` `contributes.configuration`) is the
 * single source of the default URL; nothing here restates it. A value that is
 * not a string — a hand-edited `settings.json` — reads as an empty string,
 * which the protocol clients refuse as a configuration error.
 *
 * @returns A configuration source bound to the running editor.
 */
export function createVsCodeServiceConfiguration(): ServiceClientConfiguration {
  return {
    readServiceUrl(): string {
      const value = vscode.workspace
        .getConfiguration(CONFIGURATION_SECTION)
        .get<unknown>(SERVICE_URL_KEY);
      return typeof value === 'string' ? value : '';
    },
    onDidChangeServiceUrl(listener: () => void): ServiceClientDisposable {
      return vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(SERVICE_URL_SETTING_ID)) {
          listener();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Thrown-value classification
// ---------------------------------------------------------------------------

/**
 * The error classes {@link errorClassOf} names: the ECMAScript native error
 * constructors, the product's own `DebuggenError`, and the two `DOMException`
 * names Node's `fetch`, `AbortSignal.timeout()` and `AbortController` raise.
 * Closed on purpose — a class outside this list is reported as
 * {@link UNLISTED_ERROR_CLASS}, because an application-defined `name` is
 * free text the thrower chose and can carry anything.
 */
const LISTED_ERROR_CLASSES = Object.freeze([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'DebuggenError',
  'AbortError',
  'TimeoutError',
] as const);

/** The class reported for an `Error` whose `name` is not in {@link LISTED_ERROR_CLASSES}. */
const UNLISTED_ERROR_CLASS = 'unlisted';

/**
 * Everything {@link errorClassOf} can answer: one of the listed error class
 * names, {@link UNLISTED_ERROR_CLASS} for any other `Error`, or — for a thrown
 * value that is not an `Error` at all — the result of its `typeof`. The two
 * halves cannot collide: class names are capitalised, `typeof` results never
 * are.
 */
export type ThrownValueClass =
  | (typeof LISTED_ERROR_CLASSES)[number]
  | typeof UNLISTED_ERROR_CLASS
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'symbol'
  | 'undefined'
  | 'object'
  | 'function';

/**
 * The error codes Node, its `fetch` (undici) and `ws` 8.21.3 attach to the
 * errors this client can meet that are not libuv system errors — URL and
 * argument validation, streams and sockets, aborts, `fetch` timeouts and `ws`
 * frame violations — plus the DNS resolver's `ENOTFOUND`. Listed by name so
 * that {@link knownErrorCodes} is a finite vocabulary, never a pattern.
 */
const NODE_ERROR_CODES = Object.freeze([
  'ABORT_ERR',
  'ENOTFOUND',
  'ERR_HTTP_HEADERS_SENT',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_PROTOCOL',
  'ERR_INVALID_STATE',
  'ERR_INVALID_URL',
  'ERR_OUT_OF_RANGE',
  'ERR_SOCKET_CLOSED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_UNHANDLED_ERROR',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DESTROYED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'WS_ERR_EXPECTED_FIN',
  'WS_ERR_EXPECTED_MASK',
  'WS_ERR_INVALID_CLOSE_CODE',
  'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH',
  'WS_ERR_INVALID_OPCODE',
  'WS_ERR_INVALID_UTF8',
  'WS_ERR_UNEXPECTED_MASK',
  'WS_ERR_UNEXPECTED_RSV_1',
  'WS_ERR_UNEXPECTED_RSV_2_3',
  'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH',
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
] as const);

/** The memo of {@link knownErrorCodes}, built on first use rather than at load. */
let knownErrorCodeSet: ReadonlySet<string> | undefined;

/**
 * Every error code a log record may copy from a caught value's `code`
 * property: the names of the running platform's libuv system errors
 * (`ECONNREFUSED`, `ENOENT`, `EAI_AGAIN`, … — `util.getSystemErrorMap()`, the
 * table Node itself names system errors from) and {@link NODE_ERROR_CODES}.
 * A finite vocabulary on purpose: a `code` property is a value its thrower
 * chose, and a pattern such as `E…` would still admit an invented
 * credential-shaped value. Anything outside the set is not logged. Should the
 * platform table be unavailable, only the listed codes remain.
 */
function knownErrorCodes(): ReadonlySet<string> {
  if (knownErrorCodeSet === undefined) {
    const codes = new Set<string>(NODE_ERROR_CODES);
    try {
      for (const [name] of getSystemErrorMap().values()) {
        codes.add(name);
      }
    } catch {
      // No platform table: the listed codes are still a closed vocabulary.
    }
    knownErrorCodeSet = codes;
  }
  return knownErrorCodeSet;
}

/**
 * Mints the correlation reference of one log record about a caught value.
 * `newMessageId()` draws from Web Crypto, which the extension host always
 * provides; the constant fallback keeps every caller's never-throws contract
 * should it ever be missing.
 */
function mintRef(): string {
  try {
    return newMessageId();
  } catch {
    return 'unavailable';
  }
}

/**
 * What kind of problem a protocol-client error reports, derived from its code
 * alone: the socket could not be opened or written (`socket`), an inbound
 * frame was refused (`frame`), the credential could not be produced
 * (`credential`), the service URL was refused (`configuration`), a hook failed
 * inside the transport (`internal`), or anything else (`other`).
 */
type ProtocolProblem = 'socket' | 'frame' | 'credential' | 'configuration' | 'internal' | 'other';

/** The {@link ProtocolProblem} of a protocol-client error code. */
function protocolProblemOf(code: string): ProtocolProblem {
  switch (code) {
    case 'TRANSPORT_DISCONNECTED':
      return 'socket';
    case 'PROTOCOL_INVALID_MESSAGE':
      return 'frame';
    case 'UNAUTHORIZED':
      return 'credential';
    case 'CONFIG_INVALID':
      return 'configuration';
    case 'INTERNAL':
      return 'internal';
    default:
      return 'other';
  }
}

/**
 * Classifies a caught or rejected value for a log record, by a closed
 * vocabulary that cannot carry the value's content.
 *
 * The answer is `"DebuggenError"` for a product error (including one built by
 * another bundle's copy of the class), the `name` of any other `Error` only
 * when that name is one of the listed classes (`TypeError`, `RangeError`,
 * `AbortError`, …) and `"unlisted"` otherwise, and the `typeof` of anything
 * that is not an `Error`. The message, the stack, the name of an unlisted
 * class and every other property are never read into the answer, so the
 * result is safe for the unredacted editor output channel whatever was thrown
 * (AAP §0.5.2).
 *
 * Never throws, including for a value whose property getters or proxy traps
 * throw: this runs inside `catch` blocks, where a second exception would
 * escape the one being reported.
 *
 * @example
 * ```ts
 * try {
 *   listener(state);
 * } catch (thrown) {
 *   logger.error('a listener threw', { errorClass: errorClassOf(thrown) });
 *   // { errorClass: 'TypeError' }, never the TypeError's message
 * }
 * ```
 *
 * @param value Any caught or rejected value.
 * @returns The value's class in the {@link ThrownValueClass} vocabulary.
 */
export function errorClassOf(value: unknown): ThrownValueClass {
  try {
    if (DebuggenError.is(value)) {
      return 'DebuggenError';
    }
    if (!(value instanceof Error)) {
      return typeof value;
    }
    const name: unknown = value.name;
    return LISTED_ERROR_CLASSES.find((listed) => listed === name) ?? UNLISTED_ERROR_CLASS;
  } catch {
    // A getter or a proxy trap threw while the value was being classified.
    return UNLISTED_ERROR_CLASS;
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * One inbound subscription, kept so it can be re-attached to a replacement
 * socket client. `attach` closes over the message type and the guarded
 * handler, which keeps the generic narrowing intact without storing a
 * type-erased handler.
 */
interface Subscription {
  /** Registers the guarded handler on a socket client. */
  readonly attach: (client: ReconnectingWsClient) => Unsubscribe;
  /** Removes the registration on the current socket client, when attached. */
  detach: Unsubscribe | undefined;
}

/** The operations that act on one stored session and accept an `endpoint`. */
type SessionScopedOperation = 'session.end' | 'session.get' | 'modifications.list';

/**
 * The mutable bookkeeping of one socket client, created before the client so
 * the client's hooks can close over it.
 */
interface SocketTrack {
  /**
   * The generation this socket client was last made current under, or
   * {@link NEVER_CURRENT_GENERATION}. Its hooks reach the listeners only while
   * this equals the client's current generation, which is what makes a kept
   * or replaced socket's events harmless and lets a kept socket become current
   * again by being stamped with a new generation.
   */
  generation: number;
  /** Session requests in flight that rely on this socket's announcement. */
  inFlight: number;
  /** How many times this socket reached `open` — each time a fresh hello was written. */
  opens: number;
  /** Set once the socket was closed by this module; it never opens again. */
  released: boolean;
  /** Wakes the requests waiting for this socket to open; each re-checks the state. */
  readonly waiters: Set<() => void>;
}

/**
 * One socket client and what it announces: the service it connects to and
 * the project root its hellos carry. At most one exists per pair.
 */
interface SocketSlot {
  readonly client: ReconnectingWsClient;
  /**
   * The canonical origin of its service, as `HttpClient.baseUrl` reports it
   * (`http://127.0.0.1:43117`), or `undefined` for a refused service URL.
   */
  readonly origin: string | undefined;
  /** The project root its hellos announce. */
  readonly projectRoot: string | undefined;
  readonly track: SocketTrack;
}

/**
 * The time budget of one call addressed to another service: the caller's
 * `timeoutMs` (or the client's default), shared between the wait for the
 * announcing socket, the request and its one repeat, so the whole call never
 * outlasts what the caller allowed. An absent, non-finite or non-positive
 * timeout is an unbounded budget, exactly as `HttpClient` reads it.
 */
class CallBudget {
  /** The epoch-millisecond deadline, or `undefined` for an unbounded budget. */
  readonly #deadline: number | undefined;

  constructor(timeoutMs: number | undefined) {
    this.#deadline =
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Date.now() + timeoutMs
        : undefined;
  }

  /**
   * The bound of the wait for the socket: `capMs`, and at most half of what
   * is left, so the request keeps the other half.
   */
  waitBound(capMs: number): number {
    const left = this.#left();
    return left === undefined ? capMs : Math.min(capMs, Math.floor(left / 2));
  }

  /** Whether more than `ms` is left, so a pause of `ms` still leaves time to send. */
  allows(ms: number): boolean {
    const left = this.#left();
    return left === undefined || left > ms;
  }

  /**
   * `args` with `timeoutMs` set to what is left — never below one
   * millisecond, because `HttpClient` reads zero as "no timeout".
   */
  apply<A extends { readonly timeoutMs?: number | undefined }>(args: A): A {
    const left = this.#left();
    return left === undefined ? args : { ...args, timeoutMs: Math.max(1, left) };
  }

  #left(): number | undefined {
    return this.#deadline === undefined ? undefined : this.#deadline - Date.now();
  }
}

/**
 * The canonical origin of a configured or captured service URL, or
 * `undefined` when the service-origin policy refuses it. Never logs the value.
 */
function canonicalOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const origin = parseServiceOrigin(value);
  return isOk(origin) ? origin.value : undefined;
}

/** Resolves after `ms` milliseconds; the timer never keeps the process alive. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * The Node error code of a caught value — its `code` property when that is one
 * of the {@link knownErrorCodes} — or `undefined`. A `DebuggenError`'s code is
 * reported as `errorCode` instead, never as an errno. Never throws.
 */
function errnoOf(value: unknown): string | undefined {
  try {
    if (typeof value !== 'object' || value === null || DebuggenError.is(value)) {
      return undefined;
    }
    if (!('code' in value)) {
      return undefined;
    }
    const code: unknown = value.code;
    return typeof code === 'string' && knownErrorCodes().has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The log fields of a `DebuggenError`'s `cause`, when it has one: the cause's
 * {@link errorClassOf} class and its known Node error code. The cause is
 * typically the raw exception a protocol boundary wrapped with
 * `DebuggenError.from`, so its message — which that wrapping copied into the
 * outer error — is exactly what must not be logged. Never throws.
 */
function causeLogFields(error: DebuggenError): LogFields {
  let cause: unknown;
  try {
    cause = error.cause;
  } catch {
    return { causeClass: UNLISTED_ERROR_CLASS };
  }
  if (cause === undefined) {
    return {};
  }
  const errno = errnoOf(cause);
  return errno === undefined
    ? { causeClass: errorClassOf(cause) }
    : { causeClass: errorClassOf(cause), causeErrno: errno };
}

/**
 * Describes a thrown value for a log record by projection only: a correlation
 * `ref` for the record, the value's {@link errorClassOf} class; for a
 * `DebuggenError`, its code from the closed vocabulary and the class of its
 * cause; otherwise a Node error code when the value carries one of the
 * {@link knownErrorCodes}. The message, the stack, the `name` of an unlisted
 * class and every other property stay out, so neither a listener's exception
 * nor an object thrown with a payload can put content into the unredacted
 * output channel (AAP §0.5.2). The call site adds what it knows — the message
 * type, the listener kind, the operation — and passes its own `ref` when the
 * same failure is also returned to a caller. Never throws.
 *
 * @param thrown The caught or rejected value.
 * @param ref The record's correlation reference; a fresh one by default.
 */
function describeThrown(thrown: unknown, ref: string = mintRef()): LogFields {
  const fields: LogFields = { ref, errorClass: errorClassOf(thrown) };
  try {
    if (DebuggenError.is(thrown)) {
      return { ...fields, errorCode: thrown.code, ...causeLogFields(thrown) };
    }
  } catch {
    // A proxy trap threw on the second look; the class alone is still true.
    return fields;
  }
  const errno = errnoOf(thrown);
  return errno === undefined ? fields : { ...fields, errno };
}

/**
 * The log fields of a state change: the state and the numeric facts of its
 * detail. The reason is the service's own close reason or one of the
 * protocol's constant sentences — never a credential — and is kept.
 */
function stateLogFields(
  state: ConnectionState,
  detail: WsStateChangeDetail | undefined,
): LogFields {
  return {
    state,
    code: detail?.code,
    reason: detail?.reason,
    attempt: detail?.attempt,
    delayMs: detail?.delayMs,
  };
}

/**
 * The log fields of a refused service URL: the error code and the name of the
 * broken service-origin rule. The configured value itself is never logged — it
 * may carry a pasted credential (AAP §0.5.2).
 */
function configurationLogFields(error: DebuggenError): LogFields {
  return { errorCode: error.code, rule: error.details?.rule };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * The {@link ServiceClient} implementation.
 *
 * State lives in ECMAScript private fields, so neither the credential the
 * socket last presented nor the transports can surface through
 * `util.inspect`, `JSON.stringify` or an enumerating logger.
 *
 * Re-entrancy is handled with a generation counter: the current socket client
 * is stamped with the current generation, its hooks read that stamp, and a
 * hook from a replaced, kept or disposed client is ignored. That is what keeps
 * a stale client's final `closed` state, or a rotation re-read that finished
 * after the URL changed, from reaching the listeners — and what lets a kept
 * socket become current again by being stamped anew.
 *
 * Only the current socket client's events reach the listeners. The sockets
 * kept for a session's service ({@link ServiceClientOptions.retainedEndpoint})
 * and those opened for a request to another service carry no subscription;
 * they exist for the announcement their hello makes.
 */
class ExtensionServiceClient implements ServiceClient {
  readonly #credential: ServiceCredential;
  readonly #logger: Logger;
  readonly #configuration: ServiceClientConfiguration;
  readonly #webSocketConstructor: WebSocketConstructorLike;
  readonly #fetch: FetchLike | undefined;
  readonly #defaultTimeoutMs: number | undefined;
  readonly #operationTimeoutsMs: Readonly<Partial<Record<HttpOperation, number>>> | undefined;
  readonly #timers: TimerApi | undefined;
  readonly #random: (() => number) | undefined;
  readonly #backoff: WsBackoffOptions | undefined;
  readonly #retainedEndpoint: (() => string | undefined) | undefined;

  /** Every inbound subscription, re-attached to each replacement socket client. */
  readonly #subscriptions = new Set<Subscription>();
  /** The connection-state listeners. */
  readonly #stateListeners = new Set<ServiceStateListener>();
  /** The refused-credential listeners. */
  readonly #unauthorizedListeners = new Set<ServiceUnauthorizedListener>();
  /**
   * The sockets kept open besides the current one: the retained endpoint's,
   * and those opened for a request to another service while it is in flight.
   */
  readonly #retained = new Set<SocketSlot>();
  /**
   * The credential each socket client last presented in a hello, kept only to
   * decide whether a re-read after a 4401 produced a different one. Secret:
   * never logged, never compared anywhere else, and unreachable through
   * `util.inspect` of this client.
   */
  readonly #presentedTokens = new WeakMap<SocketTrack, string>();

  /** The configured base URL, as read — compared, never logged. */
  #serviceUrl: string;
  /** The project root the next hello announces. */
  #projectRoot: string | undefined;
  /** The HTTP transport for {@link ExtensionServiceClient.#serviceUrl}. */
  #http: HttpClient;
  /** The current socket client, the one whose events reach the listeners. */
  #current: SocketSlot;
  /** The generation the current socket client is stamped with. */
  #generation = 0;
  /** Whether `connect()` was called and the connection is wanted. */
  #connectRequested = false;
  /** Whether `dispose()` ran. */
  #disposed = false;
  /** Whether a rotation re-read is in flight for the current generation. */
  #rotationPending = false;
  /** Operations registered with `keepConnectionsFor` that have not settled. */
  #holds = 0;
  /** Set once every socket was finally closed; no socket is opened after it. */
  #connectionsReleased = false;
  /** The bound on a disposal's deferred close, while one is pending. */
  #holdTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The state announced while a socket client is being replaced, reported by
   * {@link ExtensionServiceClient.state} for the duration of that announcement
   * so the getter always agrees with the last state a listener received.
   */
  #announcedState: ConnectionState | undefined;
  /** The configuration watcher, disposed with the client. */
  #configurationWatcher: ServiceClientDisposable | undefined;

  constructor(options: ServiceClientOptions) {
    this.#credential = options.credential;
    this.#logger = options.logger ?? noopLogger;
    this.#configuration = options.configuration ?? createVsCodeServiceConfiguration();
    this.#webSocketConstructor = options.webSocketConstructor ?? NODE_WEB_SOCKET;
    this.#fetch = options.fetch;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    // A frozen snapshot, so a caller mutating its own table afterwards cannot
    // change the deadlines of calls this client makes.
    this.#operationTimeoutsMs =
      options.operationTimeoutsMs === undefined
        ? undefined
        : Object.freeze({ ...options.operationTimeoutsMs });
    this.#timers = options.timers;
    this.#random = options.random;
    this.#backoff = options.backoff;
    this.#retainedEndpoint = options.retainedEndpoint;
    this.#projectRoot = options.projectRoot;

    this.#serviceUrl = this.#readConfiguredServiceUrl();
    this.#http = this.#createHttpClient();
    this.#current = this.#createSocketSlot(
      this.#serviceUrl,
      this.#http.baseUrl,
      this.#projectRoot,
      this.#generation,
    );
    this.#reportConfiguration();
    this.#configurationWatcher = this.#watchConfiguration();
  }

  // -------------------------------------------------------------------------
  // Lifecycle and connection state
  // -------------------------------------------------------------------------

  get state(): ConnectionState {
    return this.#announcedState ?? this.#current.client.state;
  }

  get baseUrl(): string | undefined {
    return this.#http.baseUrl;
  }

  get configurationError(): DebuggenError | undefined {
    return this.#http.configurationError;
  }

  get projectRoot(): string | undefined {
    return this.#projectRoot;
  }

  connect(): void {
    if (this.#disposed) {
      return;
    }
    this.#connectRequested = true;
    this.#connectSocket(this.#current.client);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#connectRequested = false;
    // Every hook of the current socket client, and any rotation re-read still
    // in flight, belongs to a generation that no longer exists.
    this.#generation += 1;
    this.#rotationPending = false;

    const watcher = this.#configurationWatcher;
    this.#configurationWatcher = undefined;
    if (watcher !== undefined) {
      try {
        watcher.dispose();
      } catch (thrown) {
        this.#logger.warn('the service URL watcher could not be disposed', describeThrown(thrown));
      }
    }

    for (const subscription of this.#subscriptions) {
      subscription.detach?.();
      subscription.detach = undefined;
    }
    this.#subscriptions.clear();
    this.#stateListeners.clear();
    this.#unauthorizedListeners.clear();

    if (this.#holds === 0) {
      this.#releaseConnections();
      return;
    }
    // An end registered by `deactivate()` is still on its way; the service
    // admits it only while a socket announces the project, so the sockets
    // close once it settled — and never later than the bound.
    this.#logger.info('keeping the service connections open until the registered requests settle', {
      pending: this.#holds,
      timeoutMs: CONNECTION_HOLD_TIMEOUT_MS,
    });
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = undefined;
      this.#logger.warn('the registered requests did not settle in time; closing the connections', {
        pending: this.#holds,
        timeoutMs: CONNECTION_HOLD_TIMEOUT_MS,
      });
      this.#releaseConnections();
    }, CONNECTION_HOLD_TIMEOUT_MS);
    this.#holdTimer.unref();
  }

  keepConnectionsFor<T>(operation: Promise<T>): Promise<T> {
    if (this.#connectionsReleased) {
      return operation;
    }
    this.#holds += 1;
    let settled = false;
    const release = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.#holds -= 1;
      if (this.#disposed && this.#holds === 0) {
        this.#releaseConnections();
      }
    };
    void operation.then(release, release);
    return operation;
  }

  pruneRetainedConnections(): void {
    this.#pruneRetained();
  }

  onStateChange(listener: ServiceStateListener): Unsubscribe {
    return this.#addListener(this.#stateListeners, listener);
  }

  onUnauthorized(listener: ServiceUnauthorizedListener): Unsubscribe {
    return this.#addListener(this.#unauthorizedListeners, listener);
  }

  setBaseUrl(url: string): void {
    if (this.#disposed || url === this.#serviceUrl) {
      return;
    }
    this.#serviceUrl = url;
    this.#http = this.#createHttpClient();
    this.#logger.info('service URL changed', {
      baseUrl: this.#http.baseUrl,
      accepted: this.#http.configurationError === undefined,
    });
    this.#replaceSocketClient(SERVICE_URL_CHANGED_REASON);
    this.#reportConfiguration();
  }

  setProjectRoot(root: string | undefined): void {
    if (this.#disposed || root === this.#projectRoot) {
      return;
    }
    this.#projectRoot = root;
    this.#logger.debug('announced project root changed', { announced: root !== undefined });
    this.#replaceSocketClient(PROJECT_ROOT_CHANGED_REASON);
  }

  // -------------------------------------------------------------------------
  // Inbound subscriptions
  // -------------------------------------------------------------------------

  on<K extends MessageType>(type: K, handler: MessageHandler<K>): Unsubscribe {
    if (this.#disposed) {
      return NOOP_UNSUBSCRIBE;
    }

    const guarded: MessageHandler<K> = (message) => {
      try {
        handler(message);
      } catch (thrown) {
        // Neither the frame nor the thrown value's text is logged: the payload
        // may carry a redacted URL, a question or a project path, and an
        // exception raised while handling it routinely quotes that payload.
        this.#logger.error('a service message handler threw', { type, ...describeThrown(thrown) });
      }
    };

    const subscription: Subscription = {
      attach: (client) => client.on(type, guarded),
      detach: undefined,
    };
    subscription.detach = subscription.attach(this.#current.client);
    this.#subscriptions.add(subscription);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      subscription.detach?.();
      subscription.detach = undefined;
      this.#subscriptions.delete(subscription);
    };
  }

  // -------------------------------------------------------------------------
  // Outbound frames
  // -------------------------------------------------------------------------

  send<K extends MessageType>(
    type: K,
    payload: MessagePayload<K>,
    options?: CreateEnvelopeOptions,
  ): Result<SendOutcome, DebuggenError> {
    let sent: Result<SendOutcome, DebuggenError>;
    if (this.#disposed) {
      sent = err(
        new DebuggenError('TRANSPORT_DISCONNECTED', SEND_AFTER_DISPOSE_MESSAGE, {
          hint: SEND_AFTER_DISPOSE_HINT,
          details: { type },
        }),
      );
    } else {
      try {
        sent = this.#current.client.send(type, payload, options);
      } catch (thrown) {
        // The protocol client answers every failure as an `Err` and does not
        // throw; this guard keeps the "never throws" contract even if it did.
        sent = err(DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED'));
      }
    }

    if (isErr(sent)) {
      // The type and the code only: the payload may carry a session's data.
      this.#logger.warn('a frame could not be sent to the service', {
        type,
        code: sent.error.code,
      });
    }
    return sent;
  }

  // -------------------------------------------------------------------------
  // HTTP operations
  // -------------------------------------------------------------------------

  health(options?: HttpCallOptions): Promise<Result<HealthResponse, DebuggenError>> {
    const bounded = this.#withDeadline('health', options);
    return this.#authenticated('health', (http) => http.health(bounded));
  }

  createSession(
    request: SessionCreateRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    return this.request('session.create', { ...options, body: request });
  }

  listSessions(
    window?: ListPageRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionListResponse, DebuggenError>> {
    // The page body as the protocol validated it — rows, `total` and the echoed
    // window together — so the Sessions tree can follow `nextOffset` to the end
    // of the listing. The window is encoded, and range-checked, by the protocol
    // client's `formatListPageQuery`; nothing here builds a query string.
    return this.request('session.list', { ...options, query: window });
  }

  getSession(
    sessionId: string,
    options?: SessionEndpointCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    const { endpoint, ...call } = options ?? {};
    return this.#requestAt(endpoint, 'session.get', { ...call, params: { id: sessionId } });
  }

  askQuestion(
    sessionId: string,
    request: SessionQuestionRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    return this.request('session.question', {
      ...options,
      params: { id: sessionId },
      body: request,
    });
  }

  requestTarget(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<TargetRequestResponse, DebuggenError>> {
    // The body is the route's strict `{}`: the binding, not the caller, decides
    // which tab enters picker mode (AAP §0.5.6).
    return this.request('target.request', { ...options, params: { id: sessionId }, body: {} });
  }

  endSession(
    sessionId: string,
    options?: SessionEndpointCallOptions,
  ): Promise<Result<SessionEndResponse, DebuggenError>> {
    const { endpoint, ...call } = options ?? {};
    return this.#requestAt(endpoint, 'session.end', {
      ...call,
      params: { id: sessionId },
      body: {},
    });
  }

  startCapture(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<CaptureStartResponse, DebuggenError>> {
    // The protocol client's own method, so the 409 ownership conflict arrives
    // with `details.owningSessionId` exactly as it parses it.
    const bounded = this.#withDeadline('capture.start', options);
    return this.#authenticated('capture.start', (http) => http.startCapture(sessionId, bounded));
  }

  stopCapture(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<CaptureStopResponse, DebuggenError>> {
    return this.request('capture.stop', { ...options, params: { id: sessionId }, body: {} });
  }

  getModifications(
    sessionId: string,
    window?: ListPageRequest,
    options?: SessionEndpointCallOptions,
  ): Promise<Result<ModificationsResponse, DebuggenError>> {
    // The page body, not just its records: `total` is the journal's size even
    // for a count-only `{ limit: 0 }` window, and `nextOffset` tells a paging
    // caller whether the count or the diff budget ended this page early.
    const { endpoint, ...call } = options ?? {};
    return this.#requestAt(endpoint, 'modifications.list', {
      ...call,
      params: { id: sessionId },
      query: window,
    });
  }

  launchDevServer(
    request: DevServerLaunchRequest,
    options?: HttpCallOptions,
  ): Promise<Result<DevServerLaunchResponse, DebuggenError>> {
    return this.request('devServer.launch', { ...options, body: request });
  }

  stopDevServer(
    request: DevServerStopRequest,
    options?: HttpCallOptions,
  ): Promise<Result<DevServerStopResponse, DebuggenError>> {
    return this.request('devServer.stop', { ...options, body: request });
  }

  pairStart(options?: HttpCallOptions): Promise<Result<PairStartResponse, DebuggenError>> {
    return this.request('pair.start', { ...options, body: {} });
  }

  rotateCredentials(
    options?: HttpCallOptions,
  ): Promise<Result<CredentialsRotateResponse, DebuggenError>> {
    return this.request('credentials.rotate', { ...options, body: {} });
  }

  purgeSessions(options?: HttpCallOptions): Promise<Result<SessionPurgeResponse, DebuggenError>> {
    return this.request('session.purge', { ...options, body: {} });
  }

  request<O extends EditorHttpOperation>(
    operation: O,
    args?: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>> {
    // The type already excludes these; the check stands for an untyped caller,
    // because the boundary it protects is a credential boundary (AAP §0.5.6).
    if (EDITOR_EXCLUDED_OPERATION_SET.has(operation)) {
      return Promise.resolve(
        err(
          new DebuggenError(
            'UNAUTHORIZED',
            `The editor client does not perform the ${operation} operation`,
            { hint: EXCLUDED_OPERATION_HINT, details: { operation } },
          ),
        ),
      );
    }
    // Resolved once, outside the send: the repeat after an `UNAUTHORIZED`
    // refusal reuses these arguments and is therefore bounded the same way.
    const bounded: HttpRequestArgs<O> = { ...args, timeoutMs: this.#timeoutFor(operation, args) };
    return this.#authenticated(operation, (http) => http.request(operation, bounded));
  }

  /**
   * One session-scoped call, sent to `endpoint` when given (see
   * {@link SessionEndpointCallOptions}) and to the current base URL otherwise.
   * With an endpoint, the HTTP client is resolved once, here, and pinned for
   * every attempt, so a URL change while the call is in flight cannot re-home
   * it; an endpoint other than the current one is reached through
   * {@link ExtensionServiceClient.#requestAnnounced}.
   */
  #requestAt<O extends SessionScopedOperation>(
    endpoint: string | undefined,
    operation: O,
    args: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>> {
    if (endpoint === undefined) {
      return this.request(operation, args);
    }
    const target = this.#httpFor(endpoint, operation);
    if (target === this.#http || target.baseUrl === undefined) {
      // The current service, whose current socket announces the project; or a
      // refused endpoint, which answers `CONFIG_INVALID` without sending.
      return this.#authenticated(operation, (http) => http.request(operation, args), target);
    }
    return this.#requestAnnounced(target, target.baseUrl, operation, args);
  }

  /**
   * A session request to `origin`, a service other than the current one,
   * sent while a socket announces the project there — the service admits an
   * editor's request only then (AAP §0.5.6).
   *
   * 1. Takes the socket kept for `origin`, or opens one, and marks it in use
   *    so no prune closes it before this call settled.
   * 2. Waits for it to be open, bounded by {@link ENDPOINT_SOCKET_OPEN_TIMEOUT_MS}
   *    and by half the call's budget ({@link CallBudget}). A socket that does
   *    not open in time — the service is down — does not stop the request:
   *    the service's own answer is what the caller reports.
   * 3. Sends the request with the rest of the budget.
   * 4. Repeats it exactly once, after {@link ANNOUNCEMENT_SETTLE_DELAY_MS},
   *    only when it was refused `PATH_OUTSIDE_PROJECT` and the socket (re)opened
   *    while this call waited — the one case in which the refusal can mean
   *    "the hello was not processed yet" rather than "not announced". The
   *    refusal is the service's admission check, decided before any handler
   *    runs, so the repeat cannot apply the operation twice.
   *
   * Never rejects. Once the sockets were finally closed after a disposal, no
   * socket is opened and the request is sent as it is.
   */
  async #requestAnnounced<O extends SessionScopedOperation>(
    target: HttpClient,
    origin: string,
    operation: O,
    args: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>> {
    const send = (budget: CallBudget): Promise<Result<HttpResponseBody<O>, DebuggenError>> =>
      this.#authenticated(operation, (http) => http.request(operation, budget.apply(args)), target);
    const budget = new CallBudget(args.timeoutMs ?? this.#defaultTimeoutMs);
    const slot = this.#announcingSlotFor(origin, operation);
    if (slot === undefined) {
      return send(budget);
    }

    slot.track.inFlight += 1;
    try {
      const opensBefore = slot.track.opens;
      await this.#waitForOpen(slot, budget.waitBound(ENDPOINT_SOCKET_OPEN_TIMEOUT_MS), args.signal);
      if (slot.client.state !== 'open') {
        this.#logger.info(
          "the connection announcing the project to the session's service is not open; sending anyway",
          { operation, baseUrl: origin, state: slot.client.state },
        );
      }
      const first = await send(budget);
      const openedDuringCall = slot.track.opens > opensBefore;
      if (
        isOk(first) ||
        first.error.code !== NOT_ANNOUNCED_CODE ||
        !openedDuringCall ||
        !budget.allows(ANNOUNCEMENT_SETTLE_DELAY_MS) ||
        args.signal?.aborted === true
      ) {
        return first;
      }
      await pause(ANNOUNCEMENT_SETTLE_DELAY_MS);
      this.#logger.info(
        'the service had not yet admitted the connection opened for this request; repeating it once',
        { operation, baseUrl: origin },
      );
      return await send(budget);
    } finally {
      slot.track.inFlight -= 1;
      this.#pruneRetained();
    }
  }

  /**
   * The socket that announces the project to `origin` for a request: the one
   * kept for it — preferably announcing the current root — resumed if it had
   * stopped; otherwise a new one, opened now and kept while the request needs
   * it. `undefined` once the sockets were finally closed after a disposal.
   */
  #announcingSlotFor(origin: string, operation: HttpOperation): SocketSlot | undefined {
    let found: SocketSlot | undefined;
    for (const slot of this.#retained) {
      if (slot.origin !== origin) {
        continue;
      }
      if (slot.projectRoot === this.#projectRoot) {
        found = slot;
        break;
      }
      found ??= slot;
    }
    if (found !== undefined) {
      if (found.client.state === 'closed') {
        // Stopped by a refused credential or a failed hello: resuming re-reads
        // the credential, as `connect()` does for the current socket.
        this.#connectSocket(found.client);
      }
      return found;
    }
    if (this.#connectionsReleased) {
      return undefined;
    }
    const opened = this.#createSocketSlot(
      origin,
      origin,
      this.#projectRoot,
      NEVER_CURRENT_GENERATION,
    );
    this.#retained.add(opened);
    this.#logger.info("opening a connection that announces the project to the session's service", {
      operation,
      baseUrl: origin,
      announced: this.#projectRoot !== undefined,
    });
    this.#connectSocket(opened.client);
    return opened;
  }

  /**
   * Resolves once `slot`'s socket is open, has stopped (`closed`: a refused
   * credential or configuration, or this module closed it), `timeoutMs`
   * elapsed or `signal` aborted — whichever comes first. Never rejects.
   */
  #waitForOpen(
    slot: SocketSlot,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const settledState = (): boolean =>
      slot.track.released || slot.client.state === 'open' || slot.client.state === 'closed';
    if (settledState() || signal?.aborted === true) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        slot.track.waiters.delete(check);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const check = (): void => {
        if (settledState()) {
          finish();
        }
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      timer.unref();
      slot.track.waiters.add(check);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /**
   * The HTTP client for `endpoint`: the current one when `endpoint` has the
   * current canonical origin, otherwise a one-off client for it with the same
   * lazily read credential, transport, logger and default timeout. A one-off
   * client for a refused value answers that `CONFIG_INVALID` without sending.
   */
  #httpFor(endpoint: string, operation: HttpOperation): HttpClient {
    const current = this.#http;
    const target = new HttpClient({
      baseUrl: endpoint,
      token: this.#tokenProvider,
      fetch: this.#fetch,
      logger: this.#logger,
      defaultTimeoutMs: this.#defaultTimeoutMs,
    });
    if (target.baseUrl !== undefined && target.baseUrl === current.baseUrl) {
      return current;
    }
    this.#logger.info("sending a session request to the session's own service", {
      operation,
      baseUrl: target.baseUrl,
      currentBaseUrl: current.baseUrl,
      accepted: target.configurationError === undefined,
    });
    return target;
  }

  // -------------------------------------------------------------------------
  // Construction of the two transports
  // -------------------------------------------------------------------------

  /** Reads the configured base URL, treating a failing configuration source as empty. */
  #readConfiguredServiceUrl(): string {
    try {
      return this.#configuration.readServiceUrl();
    } catch (thrown) {
      this.#logger.warn('the service URL setting could not be read', describeThrown(thrown));
      return '';
    }
  }

  /** Starts watching the base URL setting; a source that cannot be watched is logged. */
  #watchConfiguration(): ServiceClientDisposable | undefined {
    try {
      return this.#configuration.onDidChangeServiceUrl(() => {
        if (!this.#disposed) {
          this.setBaseUrl(this.#readConfiguredServiceUrl());
        }
      });
    } catch (thrown) {
      this.#logger.warn(
        'changes to the service URL setting cannot be observed',
        describeThrown(thrown),
      );
      return undefined;
    }
  }

  /** The HTTP transport for the current base URL, with the lazy credential. */
  #createHttpClient(): HttpClient {
    return new HttpClient({
      baseUrl: this.#serviceUrl,
      token: this.#tokenProvider,
      fetch: this.#fetch,
      logger: this.#logger,
      defaultTimeoutMs: this.#defaultTimeoutMs,
    });
  }

  /**
   * A socket client for `url`, announcing `projectRoot`, stamped with
   * `generation`. Its hooks reach the listeners only while its stamp is the
   * current generation; its state changes always update its own bookkeeping,
   * which is what the requests waiting for it read.
   *
   * @param url The service URL the socket opens, as configured or captured.
   * @param origin Its canonical origin, or `undefined` when it was refused.
   */
  #createSocketSlot(
    url: string,
    origin: string | undefined,
    projectRoot: string | undefined,
    generation: number,
  ): SocketSlot {
    const track: SocketTrack = {
      generation,
      inFlight: 0,
      opens: 0,
      released: false,
      waiters: new Set(),
    };
    // Bound to a local first: the resolver, not a value, is what the socket
    // client receives, and it is re-invoked on every handshake.
    const resolveForSocket = this.#socketTokenProvider(track);
    const client = new ReconnectingWsClient({
      url,
      webSocketConstructor: this.#webSocketConstructor,
      identity: { client: EDITOR_CLIENT_KIND, projectRoot },
      token: resolveForSocket,
      backoff: this.#backoff,
      logger: this.#logger,
      timers: this.#timers,
      random: this.#random,
      onStateChange: (state, detail) => {
        this.#handleStateChange(track, state, detail);
      },
      onProtocolError: (error) => {
        this.#handleProtocolError(track, error);
      },
      onUnauthorized: (detail) => {
        this.#handleUnauthorized(track, detail);
      },
      onQueueDrop: (detail) => {
        this.#handleQueueDrop(track, detail);
      },
    });
    return { client, origin, projectRoot, track };
  }

  /** Opens, or resumes, a socket client; the protocol client never throws, and this guards it anyway. */
  #connectSocket(client: ReconnectingWsClient): void {
    try {
      client.connect();
    } catch (thrown) {
      // The protocol client reports every failure through its hooks and does
      // not throw; this guard keeps activation unblockable even if it did.
      this.#logger.error('the service connection could not be started', describeThrown(thrown));
    }
  }

  /** Closes a socket client for good and wakes whatever waits for it to open. */
  #closeSlot(slot: SocketSlot, reason: string): void {
    slot.track.released = true;
    this.#presentedTokens.delete(slot.track);
    try {
      // Its final `closed` state belongs to a stale generation and is ignored.
      slot.client.close(undefined, reason);
    } catch (thrown) {
      this.#logger.warn('a service connection could not be closed', describeThrown(thrown));
    }
    this.#wakeWaiters(slot.track);
  }

  /** Lets every request waiting on a socket re-check its state. */
  #wakeWaiters(track: SocketTrack): void {
    for (const wake of [...track.waiters]) {
      wake();
    }
  }

  /**
   * The canonical origin of {@link ServiceClientOptions.retainedEndpoint}, or
   * `undefined` when there is none, it is refused, or the callback throws.
   */
  #retainedOrigin(): string | undefined {
    const read = this.#retainedEndpoint;
    if (read === undefined) {
      return undefined;
    }
    try {
      return canonicalOrigin(read());
    } catch (thrown) {
      this.#logger.warn('the retained service endpoint could not be read', describeThrown(thrown));
      return undefined;
    }
  }

  /**
   * Closes every kept socket that neither serves the retained endpoint nor
   * carries a session request in flight. After a disposal nothing is pruned:
   * whatever is kept closes with the rest once the registered work settled.
   */
  #pruneRetained(): void {
    if (this.#disposed || this.#retained.size === 0) {
      return;
    }
    const keep = this.#retainedOrigin();
    for (const slot of [...this.#retained]) {
      if (slot.track.inFlight > 0 || (keep !== undefined && slot.origin === keep)) {
        continue;
      }
      this.#retained.delete(slot);
      this.#logger.debug('released a service connection kept for a session', {
        baseUrl: slot.origin,
      });
      this.#closeSlot(slot, RETAINED_RELEASED_CLOSE_REASON);
    }
  }

  /**
   * Closes the current socket and every kept one, once: the end of a
   * disposal, immediately or after the registered operations settled.
   */
  #releaseConnections(): void {
    if (this.#connectionsReleased) {
      return;
    }
    this.#connectionsReleased = true;
    if (this.#holdTimer !== undefined) {
      clearTimeout(this.#holdTimer);
      this.#holdTimer = undefined;
    }
    const slots = [this.#current, ...this.#retained];
    this.#retained.clear();
    for (const slot of slots) {
      this.#closeSlot(slot, DISPOSED_CLOSE_REASON);
    }
  }

  /**
   * The credential, lazily: the store's cached token when it holds one,
   * otherwise a read of `auth.json` — the case of a service the editor did not
   * start, whose file nobody has read yet. Both protocol clients accept an
   * asynchronous answer and bound it by their own deadlines; an unreadable
   * file answers `undefined`, which they report as "no credential" without
   * sending anything.
   */
  readonly #tokenProvider: TokenProvider = () => {
    const cached = this.#credential.token();
    if (cached !== undefined) {
      return cached;
    }
    return this.#credential.read().then(
      (read) => (isOk(read) ? read.value : undefined),
      () => undefined,
    );
  };

  /**
   * {@link ExtensionServiceClient.#tokenProvider}, additionally remembering
   * what the socket client of `track` presented — the one value a 4401
   * re-read is compared against.
   */
  #socketTokenProvider(track: SocketTrack): TokenProvider {
    const remember = (token: string | undefined): string | undefined => {
      if (token === undefined || track.released) {
        this.#presentedTokens.delete(track);
      } else {
        this.#presentedTokens.set(track, token);
      }
      return token;
    };
    return () => {
      const resolved = this.#tokenProvider();
      return typeof resolved === 'string' || resolved === undefined
        ? remember(resolved)
        : resolved.then(remember);
    };
  }

  /** Logs a refused service URL once per HTTP client it was found for. */
  #reportConfiguration(): void {
    const refused = this.#http.configurationError;
    if (refused !== undefined) {
      this.#logger.warn(
        'the debuggen.serviceUrl setting is not a loopback origin of the local service',
        configurationLogFields(refused),
      );
    }
  }

  /**
   * Replaces the current socket client with one for the current configuration,
   * moving every subscription across.
   *
   * - The replaced socket is **kept** — reconnecting and announcing, but
   *   reaching no listener — when it is still running and either serves the
   *   retained endpoint or carries a session request in flight; otherwise it
   *   is closed. A refused (4401) socket is `closed` already and never kept.
   * - A kept socket for the new service and root **becomes current** instead
   *   of a second one being opened. Its live state, which its own hooks will
   *   not repeat, is announced with the reason.
   * - Otherwise a new client is created. When a connection is wanted the
   *   change is announced as `reconnecting` and it connects at once;
   *   otherwise the swap is silent and it waits for `connect()`.
   *
   * Every kept socket that no longer serves a purpose is closed afterwards.
   */
  #replaceSocketClient(reason: string): void {
    if (this.#disposed) {
      return;
    }
    const previous = this.#current;
    this.#generation += 1;
    this.#rotationPending = false;

    for (const subscription of this.#subscriptions) {
      subscription.detach?.();
      subscription.detach = undefined;
    }

    const origin = this.#http.baseUrl;
    const running = previous.client.state !== 'closed';
    // A new spelling of the same service and root (a trailing slash, say)
    // changes nothing on the wire: the running socket stays current.
    const unchanged =
      running &&
      origin !== undefined &&
      previous.origin === origin &&
      previous.projectRoot === this.#projectRoot;
    const adopted = unchanged ? previous : this.#takeRetained(origin, this.#projectRoot);
    if (!unchanged) {
      const keepPrevious =
        running &&
        previous.origin !== undefined &&
        (previous.track.inFlight > 0 || previous.origin === this.#retainedOrigin()) &&
        !this.#holdsSocketFor(previous.origin, previous.projectRoot);
      if (keepPrevious) {
        this.#retained.add(previous);
        this.#logger.debug("keeping the replaced connection open for the session's service", {
          baseUrl: previous.origin,
        });
      } else {
        this.#closeSlot(previous, REPLACED_CLOSE_REASON);
      }
    }

    const next =
      adopted ??
      this.#createSocketSlot(this.#serviceUrl, origin, this.#projectRoot, this.#generation);
    next.track.generation = this.#generation;
    this.#current = next;
    for (const subscription of this.#subscriptions) {
      subscription.detach = subscription.attach(next.client);
    }
    this.#pruneRetained();

    if (adopted !== undefined && adopted.client.state !== 'closed') {
      this.#logger.debug('the connection kept for this service is current again', {
        baseUrl: origin,
        state: adopted.client.state,
      });
      this.#announce(adopted.client.state, { reason });
      return;
    }
    if (!this.#connectRequested) {
      return;
    }
    this.#announce('reconnecting', { reason });
    this.connect();
  }

  /**
   * Removes and returns the kept socket for `origin` announcing `projectRoot`,
   * when there is one; `undefined` for a refused origin.
   */
  #takeRetained(
    origin: string | undefined,
    projectRoot: string | undefined,
  ): SocketSlot | undefined {
    if (origin === undefined) {
      return undefined;
    }
    for (const slot of this.#retained) {
      if (slot.origin === origin && slot.projectRoot === projectRoot) {
        this.#retained.delete(slot);
        return slot;
      }
    }
    return undefined;
  }

  /** Whether a kept socket already serves `origin` and `projectRoot`. */
  #holdsSocketFor(origin: string, projectRoot: string | undefined): boolean {
    for (const slot of this.#retained) {
      if (slot.origin === origin && slot.projectRoot === projectRoot) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Socket hooks
  // -------------------------------------------------------------------------

  /**
   * Records a state change of any socket client — counting its opens and
   * waking the requests waiting for it — and forwards it to every listener
   * when it is the current one.
   */
  #handleStateChange(
    track: SocketTrack,
    state: ConnectionState,
    detail: WsStateChangeDetail | undefined,
  ): void {
    if (state === 'open') {
      track.opens += 1;
    }
    this.#wakeWaiters(track);
    if (track.generation !== this.#generation || this.#disposed) {
      return;
    }
    this.#logger.debug('service connection state changed', stateLogFields(state, detail));
    this.#notify(this.#stateListeners, 'state', (listener) => {
      listener(state, detail);
    });
  }

  /**
   * Logs a frame the protocol client refused, a socket it could not open or
   * write, or a refused configuration — and keeps the connection: none of them
   * is fatal.
   *
   * Recorded are a correlation `ref`, the kind of problem derived from the
   * error code ({@link ProtocolProblem}), the code itself and the class and
   * known Node error code of its `cause` — never the message, and never any
   * part of the frame. Several of these errors are the protocol client's
   * `DebuggenError.from` wrapping of a raw exception — the `WebSocket`
   * constructor refusing the URL, a socket write failing, a handler throwing —
   * and that wrapping copies the exception's message, which can quote the URL,
   * a path or a payload, into the error it reports here.
   */
  #handleProtocolError(track: SocketTrack, error: DebuggenError): void {
    if (this.#disposed) {
      return;
    }
    const fields: LogFields = {
      ref: mintRef(),
      problem: protocolProblemOf(error.code),
      errorCode: error.code,
      ...causeLogFields(error),
    };
    if (track.generation !== this.#generation) {
      // A kept socket, or one opened for a request to another service: its
      // problems surface in the answer of the request that relies on it.
      this.#logger.debug('kept service connection problem', fields);
      return;
    }
    if (error.code === 'TRANSPORT_DISCONNECTED' || error.code === 'CONFIG_INVALID') {
      // A socket that could not be opened is the ordinary "service not
      // running" condition, retried on the curve; a refused service URL was
      // already warned about once, when the setting was read.
      this.#logger.debug('service connection problem', fields);
      return;
    }
    this.#logger.warn('service connection problem', fields);
  }

  /** Logs how many frames remain after a queued frame was dropped — a count only. */
  #handleQueueDrop(track: SocketTrack, detail: WsQueueDropDetail): void {
    if (track.generation !== this.#generation || this.#disposed) {
      return;
    }
    this.#logger.debug('service connection dropped a queued frame', { queued: detail.queued });
  }

  /**
   * The rotation path of AAP §0.5.6, for a refused (4401) or unavailable
   * credential: re-read `auth.json` once; reconnect with a fresh socket client
   * only if the token differs from the one this client presented; otherwise
   * raise the unauthorized signal and stop. One re-read per observed refusal,
   * and a second refusal of the same generation while that re-read is
   * pending is folded into it. A kept socket's refusal only leaves it
   * `closed`; the request that next relies on it resumes it.
   */
  #handleUnauthorized(track: SocketTrack, detail: WsUnauthorizedDetail): void {
    if (this.#disposed) {
      return;
    }
    if (track.generation !== this.#generation) {
      this.#logger.debug('a kept service connection was refused its credential', {
        code: detail.code,
      });
      return;
    }
    if (this.#rotationPending) {
      return;
    }
    const generation = track.generation;
    this.#rotationPending = true;
    const presented = this.#presentedTokens.get(track);
    this.#logger.info('the service refused the editor credential; reading it again', {
      code: detail.code,
    });

    void this.#refreshCredential().then((refreshed) => {
      try {
        this.#completeRotation(generation, presented, refreshed, detail);
      } catch (thrown) {
        // Nothing may escape into an unhandled rejection (AAP §0.5.5).
        this.#rotationPending = false;
        this.#logger.error(
          'the credential rotation could not be completed',
          describeThrown(thrown),
        );
      }
    });
  }

  /** Acts on the outcome of the re-read {@link ExtensionServiceClient.#handleUnauthorized} started. */
  #completeRotation(
    generation: number,
    presented: string | undefined,
    refreshed: Result<string, DebuggenError>,
    detail: WsUnauthorizedDetail,
  ): void {
    // A replacement created meanwhile (a URL or project change) resolves the
    // credential itself; a disposed client has nothing to reconnect.
    if (generation !== this.#generation || this.#disposed) {
      return;
    }
    this.#rotationPending = false;

    if (isOk(refreshed) && refreshed.value !== presented) {
      this.#logger.info('the editor credential changed on disk; reconnecting with it');
      this.#replaceSocketClient(CREDENTIAL_ROTATED_REASON);
      return;
    }

    this.#logger.warn('the service refused the editor credential', {
      code: detail.code,
      reason: detail.reason,
      credential: isOk(refreshed) ? 'unchanged' : 'unavailable',
      credentialErrorCode: isErr(refreshed) ? refreshed.error.code : undefined,
    });
    this.#notify(this.#unauthorizedListeners, 'unauthorized', (listener) => {
      listener(detail);
    });
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  /**
   * The deadline of one call of `operation`, in milliseconds: the call's own
   * `timeoutMs` when it states one, else the operation's entry in
   * {@link ServiceClientOptions.operationTimeoutsMs} when that entry is a
   * finite positive number, else {@link ServiceClientOptions.defaultTimeoutMs}.
   * `undefined` — no deadline — when none of the three applies.
   *
   * A stated `timeoutMs` wins even when it is not a finite positive number:
   * that is the caller's explicit choice, and the protocol client reads such
   * a value as "no deadline".
   *
   * @param operation The operation being called.
   * @param call The call's own options, when it passed any.
   * @returns The deadline to hand the protocol client.
   */
  #timeoutFor(
    operation: HttpOperation,
    call: { readonly timeoutMs?: number | undefined } | undefined,
  ): number | undefined {
    if (call?.timeoutMs !== undefined) {
      return call.timeoutMs;
    }
    const configured = this.#operationTimeoutsMs?.[operation];
    if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return this.#defaultTimeoutMs;
  }

  /**
   * `options` with the call's deadline filled in by
   * {@link ExtensionServiceClient.#timeoutFor}, for the named protocol methods
   * that take {@link HttpCallOptions}. The caller's signal is kept as it is.
   */
  #withDeadline(operation: HttpOperation, options: HttpCallOptions | undefined): HttpCallOptions {
    return { ...options, timeoutMs: this.#timeoutFor(operation, options) };
  }

  /**
   * Sends one call through the current HTTP client and applies the HTTP half
   * of the rotation policy: a protected operation refused as `UNAUTHORIZED`
   * re-reads `auth.json` once and is repeated once — only when the token on
   * disk differs from the one that was refused. The refusal is authentication
   * middleware answering before any handler ran, so the repeat cannot apply
   * an operation twice. Every other failure is returned as it is.
   *
   * @param target The HTTP client both attempts use; omitted, each attempt
   *   uses the client current when it is sent.
   */
  async #authenticated<T>(
    operation: HttpOperation,
    send: (http: HttpClient) => Promise<Result<T, DebuggenError>>,
    target?: HttpClient,
  ): Promise<Result<T, DebuggenError>> {
    const first = await this.#send(operation, send, target);
    if (isOk(first) || first.error.code !== 'UNAUTHORIZED' || isAuthExemptOperation(operation)) {
      return first;
    }

    const refused = this.#credential.token();
    const refreshed = await this.#refreshCredential();
    if (isErr(refreshed) || refreshed.value === refused) {
      return first;
    }

    this.#logger.info('the editor credential changed on disk; repeating the refused request once', {
      operation,
    });
    return this.#send(operation, send, target);
  }

  /**
   * One call on `target`, or on the current HTTP client when none is given, as
   * a promise that never rejects.
   *
   * `HttpClient` resolves every outcome; the catch keeps the contract even if
   * an injected transport or a caller's arguments throw where it does not
   * guard. The failure is logged by projection under a fresh correlation
   * reference, and the returned `INTERNAL` error carries the same reference in
   * its constant message and in `details.ref` — never the thrown value — so the
   * failure a command surfaces can be matched to its log line.
   */
  async #send<T>(
    operation: HttpOperation,
    send: (http: HttpClient) => Promise<Result<T, DebuggenError>>,
    target?: HttpClient,
  ): Promise<Result<T, DebuggenError>> {
    try {
      return await send(target ?? this.#http);
    } catch (thrown) {
      const ref = mintRef();
      this.#logger.error('a service request failed unexpectedly', {
        operation,
        ...describeThrown(thrown, ref),
      });
      return err(
        new DebuggenError(
          'INTERNAL',
          `The ${operation} request failed unexpectedly (reference ${ref}).`,
          { details: { operation, ref } },
        ),
      );
    }
  }

  /** `credential.refresh()`, as a promise that never rejects. */
  async #refreshCredential(): Promise<Result<string, DebuggenError>> {
    try {
      return await this.#credential.refresh();
    } catch (thrown) {
      this.#logger.warn('the editor credential could not be read again', describeThrown(thrown));
      return err(
        new DebuggenError('UNAUTHORIZED', 'The editor credential could not be read again', {
          hint: 'Check that the Debug Generator service is running, then run "Debug Generator: Rotate Service Token".',
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  /**
   * Adds a listener to a set and returns its idempotent unsubscribe. After
   * disposal nothing is added and the unsubscribe is a no-op.
   */
  #addListener<L>(listeners: Set<L>, listener: L): Unsubscribe {
    if (this.#disposed) {
      return NOOP_UNSUBSCRIBE;
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Calls every listener of a set, each isolated from the others and from the
   * transport: a listener that throws is logged and the rest still run.
   * Iterates a snapshot, so a listener may unsubscribe while it runs.
   */
  #notify<L>(listeners: ReadonlySet<L>, kind: string, invoke: (listener: L) => void): void {
    for (const listener of [...listeners]) {
      try {
        invoke(listener);
      } catch (thrown) {
        this.#logger.error('a service client listener threw', { kind, ...describeThrown(thrown) });
      }
    }
  }

  /**
   * Announces a state the client is moving to on its own account — a socket
   * client being replaced — with {@link ExtensionServiceClient.state}
   * reporting it for the duration of the announcement.
   */
  #announce(state: ConnectionState, detail: WsStateChangeDetail): void {
    this.#announcedState = state;
    try {
      this.#logger.debug('service connection state changed', stateLogFields(state, detail));
      this.#notify(this.#stateListeners, 'state', (listener) => {
        listener(state, detail);
      });
    } finally {
      this.#announcedState = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading a whole modification journal
// ---------------------------------------------------------------------------

/** The operation {@link readModificationJournal} walks, as its failures name it. */
const MODIFICATIONS_LIST_OPERATION = 'modifications.list' satisfies HttpOperation;

/**
 * The most pages {@link readModificationJournal} requests in one walk:
 * {@link MODIFICATIONS_PAGE_MAX_LIMIT}. The protocol admits no page that
 * carries no record while records remain, and a journal holds at most that
 * many records, so a service that keeps the paging rule ends every walk well
 * inside the cap; the cap only bounds one that does not.
 */
export const MODIFICATION_JOURNAL_PAGE_CAP = MODIFICATIONS_PAGE_MAX_LIMIT;

/** What {@link readModificationJournal} gathered from one walk of the journal. */
export interface ModificationJournalRead {
  /**
   * Every record the pages carried, in journal order, each id once: offset
   * paging over a journal that grows between two requests can repeat a record
   * on both pages, and the first occurrence is kept.
   */
  readonly modifications: readonly ModificationRecord[];
  /** The journal's length as the last page that answered counted it. */
  readonly total: number;
  /**
   * `true` exactly when a page answered `nextOffset: null`, so the walk reached
   * the journal's end. `false` when a failure, the deadline, the abort signal,
   * {@link MODIFICATION_JOURNAL_PAGE_CAP} or a page that did not move past the
   * one before ended it first.
   */
  readonly complete: boolean;
  /** How many pages answered. */
  readonly pages: number;
  /**
   * The failure that ended an incomplete walk: a page's own `Err`, or the
   * `TRANSPORT_DISCONNECTED` refusal to request another page once the deadline
   * elapsed (`details.cancelled: 'timeout'`) or the signal aborted
   * (`details.cancelled: 'aborted'`). Absent for a complete walk and for one
   * the page cap or a non-advancing page ended.
   */
  readonly failure?: DebuggenError | undefined;
}

/** The options of {@link readModificationJournal}. */
export interface ModificationJournalReadOptions extends SessionEndpointCallOptions {
  /**
   * The bound on the whole walk, in milliseconds, counted from the call. Each
   * page is sent with what is left of it as its `timeoutMs` — or with the
   * caller's own `timeoutMs` when that is tighter — and no page is requested
   * once nothing is left. Omitted, or not a finite positive number, means no
   * bound on the walk: each page is then bounded by `timeoutMs`, or by the
   * client's own deadline for the operation.
   */
  readonly deadlineMs?: number | undefined;
}

/** Whether `value` is a usable bound: a finite number above zero. */
function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Why the walk must not request another page, or `undefined` while it may:
 * the abort signal fired, or the walk's deadline elapsed. Each refusal has the
 * shape of the protocol client's own cancellation failure, so a caller renders
 * it exactly like a page that was cancelled in flight.
 *
 * @param signal The caller's abort signal, when one was given.
 * @param deadlineAt The walk's epoch-millisecond deadline, when it has one.
 * @param deadlineMs The walk's bound as the caller stated it, for the message.
 */
function journalWalkInterruption(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  deadlineMs: number | undefined,
): DebuggenError | undefined {
  if (signal?.aborted === true) {
    return new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      'The modification journal read was cancelled before the journal ended',
      {
        hint: 'The caller cancelled the read. Nothing was retried; read the journal again if the rest is still wanted.',
        details: { operation: MODIFICATIONS_LIST_OPERATION, cancelled: 'aborted' },
      },
    );
  }
  if (deadlineAt !== undefined && deadlineAt - Date.now() <= 0) {
    return new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      `The modification journal was not read to its end within ${String(deadlineMs)} ms`,
      {
        hint: 'The local service did not answer every page of the journal in time. Check that it is running and not stalled, then read the journal again.',
        details: {
          operation: MODIFICATIONS_LIST_OPERATION,
          cancelled: 'timeout',
          ...(deadlineMs === undefined ? {} : { timeoutMs: deadlineMs }),
        },
      },
    );
  }
  return undefined;
}

/**
 * The `timeoutMs` of the next page: what is left of the walk's deadline, or
 * the caller's own per-call bound when that is tighter; the caller's bound
 * unchanged — including `undefined` — when the walk has no deadline.
 *
 * @param callTimeoutMs The caller's `timeoutMs`, when one was given.
 * @param deadlineAt The walk's epoch-millisecond deadline, when it has one.
 */
function journalPageTimeout(
  callTimeoutMs: number | undefined,
  deadlineAt: number | undefined,
): number | undefined {
  if (deadlineAt === undefined) {
    return callTimeoutMs;
  }
  const remaining = Math.max(1, deadlineAt - Date.now());
  return isPositiveFinite(callTimeoutMs) ? Math.min(callTimeoutMs, remaining) : remaining;
}

/**
 * Reads a session's whole modification journal (`GET /sessions/:id/modifications`)
 * by walking its pages along `nextOffset`.
 *
 * The service bounds every page by count and by diff bytes, so a journal whose
 * diffs exceed one page's budget arrives in several pages, and a reader that
 * takes the first page for the journal silently loses the rest. The walk:
 *
 * - asks for the service's default window first — its largest page — so an
 *   ordinary journal costs exactly one request, then `{ offset: nextOffset }`
 *   for each following page;
 * - sends every page to `options.endpoint` with `options.signal`, and bounds it
 *   by `options.timeoutMs` and by what is left of `options.deadlineMs`;
 * - keeps records in journal order, each id once (the first occurrence), and
 *   reports the last answered page's `total`;
 * - stops complete at the page whose `nextOffset` is `null`, and incomplete —
 *   keeping every record gathered so far — at a later page's failure, a thrown
 *   page request, the deadline, the abort signal,
 *   {@link MODIFICATION_JOURNAL_PAGE_CAP} pages, or a `nextOffset` that does
 *   not move past the offset just requested.
 *
 * Nothing is logged here — records name the developer's files and carry their
 * source as diffs — and nothing is retried. A caller applies the gathered
 * records once, after the walk, and states an incomplete read as incomplete.
 *
 * @example
 * ```ts
 * const read = await readModificationJournal(client, sessionId, {
 *   endpoint: state.activeSessionEndpoint,
 *   deadlineMs: 3_000,
 * });
 * if (isOk(read)) {
 *   state.applyModificationJournal(sessionId, read.value.modifications, read.value.total);
 * }
 * ```
 *
 * @param client The service client; only `getModifications` is called.
 * @param sessionId The session whose journal is read.
 * @param options The owning endpoint, the abort signal, the per-page timeout
 *   and the deadline of the whole walk.
 * @returns The first page's failure as an `Err`; otherwise what the walk
 *   gathered, marked complete or not. Never rejects.
 */
export async function readModificationJournal(
  client: Pick<ServiceClient, 'getModifications'>,
  sessionId: string,
  options: ModificationJournalReadOptions = {},
): Promise<Result<ModificationJournalRead, DebuggenError>> {
  const { deadlineMs, timeoutMs, ...call } = options;
  const deadlineAt = isPositiveFinite(deadlineMs) ? Date.now() + deadlineMs : undefined;
  const statedDeadline = isPositiveFinite(deadlineMs) ? deadlineMs : undefined;

  const readPage = async (
    window: ListPageRequest | undefined,
  ): Promise<Result<ModificationsResponse, DebuggenError>> => {
    const interruption = journalWalkInterruption(call.signal, deadlineAt, statedDeadline);
    if (interruption !== undefined) {
      return err(interruption);
    }
    try {
      return await client.getModifications(sessionId, window, {
        ...call,
        timeoutMs: journalPageTimeout(timeoutMs, deadlineAt),
      });
    } catch (thrown) {
      // The client never rejects; a double or a wrapper might, and a throw on
      // a later page must not discard the records the earlier pages carried.
      return err(DebuggenError.from(thrown));
    }
  };

  const first = await readPage(undefined);
  if (isErr(first)) {
    return first;
  }

  const gathered: ModificationRecord[] = [];
  const seen = new Set<string>();
  const take = (answered: ModificationsResponse): void => {
    for (const record of answered.modifications) {
      if (!seen.has(record.id)) {
        seen.add(record.id);
        gathered.push(record);
      }
    }
  };

  let page = first.value;
  let pages = 1;
  let requestedOffset = 0;
  let failure: DebuggenError | undefined;
  take(page);

  while (
    page.nextOffset !== null &&
    page.nextOffset > requestedOffset &&
    pages < MODIFICATION_JOURNAL_PAGE_CAP
  ) {
    requestedOffset = page.nextOffset;
    const answer = await readPage({ offset: requestedOffset });
    if (isErr(answer)) {
      failure = answer.error;
      break;
    }
    page = answer.value;
    pages += 1;
    take(page);
  }

  return ok({
    modifications: gathered,
    total: page.total,
    complete: page.nextOffset === null,
    pages,
    ...(failure === undefined ? {} : { failure }),
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the extension host's connection to the local service.
 *
 * Construction reads the `debuggen.serviceUrl` setting (or the injected
 * configuration source), builds the HTTP client and the socket client and
 * starts watching the setting — no I/O, no socket, no timer, and it never
 * throws. Call {@link ServiceClient.connect} to open the socket; HTTP calls
 * work immediately.
 *
 * @example
 * ```ts
 * const credential = createEditorCredentialStore({ logger });
 * const client = createServiceClient({
 *   credential,
 *   logger,
 *   projectRoot,
 *   defaultTimeoutMs: DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
 *   operationTimeoutsMs: EDITOR_OPERATION_TIMEOUTS_MS,
 * });
 * context.subscriptions.push(credential, client);
 *
 * client.onStateChange((connection) => extensionState.setConnectionStatus(connection));
 * client.on(MESSAGE_TYPE.SESSION_PROGRESS, ({ payload }) => extensionState.applyProgress(payload));
 * client.connect();
 *
 * // Bounded by the default; a stalled service answers a timeout failure.
 * const created = await client.createSession({ projectRoot, question });
 * if (isErr(created)) {
 *   return view.showError(created.error); // "Service not running" is a state
 * }
 * ```
 *
 * @param options The credential store, and optionally the announced project
 * root, a logger, a configuration source, the request deadlines and injected
 * transports.
 * @returns A disposable client whose asynchronous members never reject.
 */
export function createServiceClient(options: ServiceClientOptions): ServiceClient {
  return new ExtensionServiceClient(options);
}
