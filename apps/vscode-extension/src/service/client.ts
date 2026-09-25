/**
 * The extension host's only wire to the local coordination service.
 *
 * Every HTTP request and every inbound WebSocket frame of the VS Code
 * extension passes through the {@link ServiceClient} this module builds:
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
 * - fan-out of the connection state and of the unauthorized signal to any
 *   number of listeners, with every listener isolated from the transport;
 * - one named method per HTTP operation the commands and views use, plus a
 *   typed passthrough for the rest — every path comes from the protocol's
 *   route table by operation id, never from a string written here.
 *
 * There is exactly one retry loop — the protocol client's reconnect curve.
 * Nothing here wraps a second one around it, and HTTP failures are returned as
 * typed `Err` values for the caller to render (AAP §0.5.5).
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

import * as vscode from 'vscode';
import { WebSocket } from 'ws';

import { HttpClient, ReconnectingWsClient, isAuthExemptOperation } from '@debuggen/protocol';
import type {
  CaptureStartResponse,
  CaptureStopResponse,
  ClientKind,
  ConnectionState,
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
  MessageHandler,
  MessageType,
  ModificationRecord,
  PairStartResponse,
  SessionCreateRequest,
  SessionEndResponse,
  SessionQuestionRequest,
  SessionRecord,
  TimerApi,
  TokenProvider,
  Unsubscribe,
  WebSocketConstructorLike,
  WsBackoffOptions,
  WsQueueDropDetail,
  WsStateChangeDetail,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, isOk, map, noopLogger } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';

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

/** The state-change reason announced when `debuggen.serviceUrl` changed. */
const SERVICE_URL_CHANGED_REASON = 'the service URL setting changed';

/** The state-change reason announced when the announced project root changed. */
const PROJECT_ROOT_CHANGED_REASON = 'the workspace project changed';

/** The state-change reason announced when a rotated credential is presented. */
const CREDENTIAL_ROTATED_REASON = 'the service credential was rotated';

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
   * everything. No record ever carries the credential, a payload or a
   * response body.
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
   * The timeout applied to an HTTP call that sets none, in milliseconds.
   * Omitted means no default timeout: several service operations (indexing,
   * a model stage) legitimately take long, so the caller that knows which
   * operation it waits on passes `timeoutMs` per call instead.
   */
  readonly defaultTimeoutMs?: number | undefined;

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
}

/**
 * The extension host's typed connection to the local service: one WebSocket
 * for the frames the service pushes, and one named method per HTTP operation
 * the editor performs.
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
   * Closes the socket, stops watching the configuration and releases every
   * subscription and listener. Idempotent. HTTP operations stay callable
   * afterwards — they hold no connection — so `deactivate()` can still end the
   * active session whatever order the editor disposes things in.
   */
  dispose(): void;

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
   * reconnects against the new URL. Driven automatically by changes to
   * `debuggen.serviceUrl`; a no-op when the value is unchanged.
   */
  setBaseUrl(url: string): void;

  /**
   * Replaces the project root announced as `client.hello.projectRoot` — a
   * single optional path, the only form the wire carries. A connected socket
   * is replaced so a fresh hello announces the new root; an open connection's
   * identity is never mutated. A no-op when the value is unchanged.
   */
  setProjectRoot(root: string | undefined): void;

  /**
   * Subscribes to one inbound message type, delegating to the protocol
   * client's typed dispatch: the handler receives the validated frame already
   * narrowed to that type (for a concrete `K`, `MessageHandler<K>` is exactly
   * `(message: MessageByType<K>) => void`). The subscription survives socket
   * replacement. A handler that throws is logged — its error's message and
   * stack, never the frame — and the connection is unaffected.
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
   * `GET /health`: whether the service answers, and which protocol version it
   * speaks. Auth-exempt, so it works before any credential exists; an `Err`
   * is itself the answer "service not running". The liveness probe the
   * process manager's health port is wired to.
   */
  health(options?: HttpCallOptions): Promise<Result<HealthResponse, DebuggenError>>;

  /** `session.create` (`POST /sessions`): starts a session with a question. */
  createSession(
    request: SessionCreateRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /** `session.list` (`GET /sessions`): every stored session, for the Sessions tree. */
  listSessions(options?: HttpCallOptions): Promise<Result<readonly SessionRecord[], DebuggenError>>;

  /** `session.get` (`GET /sessions/:id`): one session — the reopen path. */
  getSession(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /** `session.question` (`POST /sessions/:id/question`): asks a follow-up question. */
  askQuestion(
    sessionId: string,
    request: SessionQuestionRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * `session.end` (`POST /sessions/:id/end`): ends the session and runs
   * cleanup, answering its outcome (`clean`, `partial`, `conflict` or
   * `pending`). A conflict is a successful reply, not a failure.
   */
  endSession(
    sessionId: string,
    options?: HttpCallOptions,
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
   * `modifications.list` (`GET /sessions/:id/modifications`): the session's
   * modification journal, for the modifications list and its diff view.
   */
  getModifications(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<readonly ModificationRecord[], DebuggenError>>;

  /**
   * `devServer.launch` (`POST /dev-server/launch`): probes for, or starts, the
   * project's dev server with the telemetry preload attached.
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

/**
 * Describes a thrown value for a log record: the error's name, message and
 * stack, or only its runtime type when it is not an `Error`. Nothing else of
 * the value is kept, so an object thrown by a listener cannot put a payload
 * into the log.
 */
function describeThrown(thrown: unknown): LogFields {
  if (thrown instanceof Error) {
    return { errorName: thrown.name, error: thrown.message, stack: thrown.stack };
  }
  return { thrownType: typeof thrown };
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
 * Re-entrancy is handled with a generation counter: every socket client is
 * created under a generation, its hooks capture that number, and a hook from a
 * replaced (or disposed) client is ignored. That is what keeps a stale
 * client's final `closed` state, or a rotation re-read that finished after the
 * URL changed, from reaching the listeners.
 */
class ExtensionServiceClient implements ServiceClient {
  readonly #credential: ServiceCredential;
  readonly #logger: Logger;
  readonly #configuration: ServiceClientConfiguration;
  readonly #webSocketConstructor: WebSocketConstructorLike;
  readonly #fetch: FetchLike | undefined;
  readonly #defaultTimeoutMs: number | undefined;
  readonly #timers: TimerApi | undefined;
  readonly #random: (() => number) | undefined;
  readonly #backoff: WsBackoffOptions | undefined;

  /** Every inbound subscription, re-attached to each replacement socket client. */
  readonly #subscriptions = new Set<Subscription>();
  /** The connection-state listeners. */
  readonly #stateListeners = new Set<ServiceStateListener>();
  /** The refused-credential listeners. */
  readonly #unauthorizedListeners = new Set<ServiceUnauthorizedListener>();

  /** The configured base URL, as read — compared, never logged. */
  #serviceUrl: string;
  /** The project root the next hello announces. */
  #projectRoot: string | undefined;
  /** The HTTP transport for {@link ExtensionServiceClient.#serviceUrl}. */
  #http: HttpClient;
  /** The current socket client. */
  #ws: ReconnectingWsClient;
  /** The generation {@link ExtensionServiceClient.#ws} was created under. */
  #generation = 0;
  /** Whether `connect()` was called and the connection is wanted. */
  #connectRequested = false;
  /** Whether `dispose()` ran. */
  #disposed = false;
  /** Whether a rotation re-read is in flight for the current generation. */
  #rotationPending = false;
  /**
   * The credential the current socket client last presented in a hello, kept
   * only to decide whether a re-read after a 4401 produced a different one.
   * Secret: never logged, never compared anywhere else.
   */
  #presentedToken: string | undefined;
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
    this.#timers = options.timers;
    this.#random = options.random;
    this.#backoff = options.backoff;
    this.#projectRoot = options.projectRoot;

    this.#serviceUrl = this.#readConfiguredServiceUrl();
    this.#http = this.#createHttpClient();
    this.#ws = this.#createSocketClient(this.#generation);
    this.#reportConfiguration();
    this.#configurationWatcher = this.#watchConfiguration();
  }

  // -------------------------------------------------------------------------
  // Lifecycle and connection state
  // -------------------------------------------------------------------------

  get state(): ConnectionState {
    return this.#announcedState ?? this.#ws.state;
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
    try {
      this.#ws.connect();
    } catch (thrown) {
      // The protocol client reports every failure through its hooks and does
      // not throw; this guard keeps activation unblockable even if it did.
      this.#logger.error('the service connection could not be started', describeThrown(thrown));
    }
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
    this.#presentedToken = undefined;

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

    try {
      this.#ws.close(undefined, DISPOSED_CLOSE_REASON);
    } catch (thrown) {
      this.#logger.warn('the service connection could not be closed', describeThrown(thrown));
    }
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
        // The frame is deliberately not logged: its payload may carry a
        // redacted URL, a question or a project path.
        this.#logger.error('a service message handler threw', { type, ...describeThrown(thrown) });
      }
    };

    const subscription: Subscription = {
      attach: (client) => client.on(type, guarded),
      detach: undefined,
    };
    subscription.detach = subscription.attach(this.#ws);
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
  // HTTP operations
  // -------------------------------------------------------------------------

  health(options?: HttpCallOptions): Promise<Result<HealthResponse, DebuggenError>> {
    return this.#authenticated('health', (http) => http.health(options));
  }

  createSession(
    request: SessionCreateRequest,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    return this.request('session.create', { ...options, body: request });
  }

  async listSessions(
    options?: HttpCallOptions,
  ): Promise<Result<readonly SessionRecord[], DebuggenError>> {
    const listed = await this.request('session.list', { ...options });
    return map(listed, (body) => body.sessions);
  }

  getSession(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    return this.request('session.get', { ...options, params: { id: sessionId } });
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

  endSession(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<SessionEndResponse, DebuggenError>> {
    return this.request('session.end', { ...options, params: { id: sessionId }, body: {} });
  }

  startCapture(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<CaptureStartResponse, DebuggenError>> {
    // The protocol client's own method, so the 409 ownership conflict arrives
    // with `details.owningSessionId` exactly as it parses it.
    return this.#authenticated('capture.start', (http) => http.startCapture(sessionId, options));
  }

  stopCapture(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<CaptureStopResponse, DebuggenError>> {
    return this.request('capture.stop', { ...options, params: { id: sessionId }, body: {} });
  }

  async getModifications(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<readonly ModificationRecord[], DebuggenError>> {
    const listed = await this.request('modifications.list', {
      ...options,
      params: { id: sessionId },
    });
    return map(listed, (body) => body.modifications);
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
    return this.#authenticated(operation, (http) => http.request(operation, args));
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
   * A socket client for the current base URL and project root, created under
   * `generation`. Every hook ignores events once that generation is no longer
   * the current one.
   */
  #createSocketClient(generation: number): ReconnectingWsClient {
    // Bound to a local first: the resolver, not a value, is what the socket
    // client receives, and it is re-invoked on every handshake.
    const resolveForSocket = this.#socketTokenProvider(generation);
    return new ReconnectingWsClient({
      url: this.#serviceUrl,
      webSocketConstructor: this.#webSocketConstructor,
      identity: { client: EDITOR_CLIENT_KIND, projectRoot: this.#projectRoot },
      token: resolveForSocket,
      backoff: this.#backoff,
      logger: this.#logger,
      timers: this.#timers,
      random: this.#random,
      onStateChange: (state, detail) => {
        this.#handleStateChange(generation, state, detail);
      },
      onProtocolError: (error) => {
        this.#handleProtocolError(generation, error);
      },
      onUnauthorized: (detail) => {
        this.#handleUnauthorized(generation, detail);
      },
      onQueueDrop: (detail) => {
        this.#handleQueueDrop(generation, detail);
      },
    });
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
   * what the socket client of `generation` presented — the one value a 4401
   * re-read is compared against.
   */
  #socketTokenProvider(generation: number): TokenProvider {
    const remember = (token: string | undefined): string | undefined => {
      if (generation === this.#generation) {
        this.#presentedToken = token;
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
   * Replaces the socket client with one built from the current configuration,
   * moving every subscription across. When a connection is wanted the change
   * is announced as `reconnecting` and the new client connects at once;
   * otherwise the swap is silent and the new client waits for `connect()`.
   */
  #replaceSocketClient(reason: string): void {
    if (this.#disposed) {
      return;
    }
    const previous = this.#ws;
    this.#generation += 1;
    this.#rotationPending = false;
    this.#presentedToken = undefined;

    for (const subscription of this.#subscriptions) {
      subscription.detach?.();
      subscription.detach = undefined;
    }
    try {
      // Its final `closed` state belongs to the old generation and is ignored.
      previous.close(undefined, REPLACED_CLOSE_REASON);
    } catch (thrown) {
      this.#logger.warn(
        'the replaced service connection could not be closed',
        describeThrown(thrown),
      );
    }

    const next = this.#createSocketClient(this.#generation);
    this.#ws = next;
    for (const subscription of this.#subscriptions) {
      subscription.detach = subscription.attach(next);
    }

    if (!this.#connectRequested) {
      return;
    }
    this.#announce('reconnecting', { reason });
    this.connect();
  }

  // -------------------------------------------------------------------------
  // Socket hooks
  // -------------------------------------------------------------------------

  /** Forwards a state change of the current socket client to every listener. */
  #handleStateChange(
    generation: number,
    state: ConnectionState,
    detail: WsStateChangeDetail | undefined,
  ): void {
    if (generation !== this.#generation || this.#disposed) {
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
   * is fatal. The protocol builds each error from issue paths and codes and
   * constant sentences, never from a rejected value, a payload or the
   * credential, so its message is safe to record.
   */
  #handleProtocolError(generation: number, error: DebuggenError): void {
    if (generation !== this.#generation || this.#disposed) {
      return;
    }
    const fields: LogFields = { errorCode: error.code, error: error.message };
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
  #handleQueueDrop(generation: number, detail: WsQueueDropDetail): void {
    if (generation !== this.#generation || this.#disposed) {
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
   * pending is folded into it.
   */
  #handleUnauthorized(generation: number, detail: WsUnauthorizedDetail): void {
    if (generation !== this.#generation || this.#disposed || this.#rotationPending) {
      return;
    }
    this.#rotationPending = true;
    const presented = this.#presentedToken;
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
   * Sends one call through the current HTTP client and applies the HTTP half
   * of the rotation policy: a protected operation refused as `UNAUTHORIZED`
   * re-reads `auth.json` once and is repeated once — only when the token on
   * disk differs from the one that was refused. The refusal is authentication
   * middleware answering before any handler ran, so the repeat cannot apply
   * an operation twice. Every other failure is returned as it is.
   */
  async #authenticated<T>(
    operation: HttpOperation,
    send: (http: HttpClient) => Promise<Result<T, DebuggenError>>,
  ): Promise<Result<T, DebuggenError>> {
    const first = await this.#send(operation, send);
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
    return this.#send(operation, send);
  }

  /** One call on the current HTTP client, as a promise that never rejects. */
  async #send<T>(
    operation: HttpOperation,
    send: (http: HttpClient) => Promise<Result<T, DebuggenError>>,
  ): Promise<Result<T, DebuggenError>> {
    try {
      return await send(this.#http);
    } catch (thrown) {
      // `HttpClient` resolves every outcome; this keeps the contract even if a
      // transport stub rejects. The thrown value stays out of the message.
      this.#logger.error('a service request failed unexpectedly', {
        operation,
        ...describeThrown(thrown),
      });
      return err(
        new DebuggenError('INTERNAL', `The ${operation} request failed unexpectedly`, {
          details: { operation },
        }),
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
 * const client = createServiceClient({ credential, logger, projectRoot });
 * context.subscriptions.push(credential, client);
 *
 * client.onStateChange((connection) => extensionState.setConnectionStatus(connection));
 * client.on('session.progress', ({ payload }) => extensionState.applyProgress(payload));
 * client.connect();
 *
 * const created = await client.createSession({ projectRoot, question });
 * if (isErr(created)) {
 *   return view.showError(created.error); // "Service not running" is a state
 * }
 * ```
 *
 * @param options The credential store, and optionally the announced project
 * root, a logger, a configuration source and injected transports.
 * @returns A disposable client whose asynchronous members never reject.
 */
export function createServiceClient(options: ServiceClientOptions): ServiceClient {
  return new ExtensionServiceClient(options);
}
