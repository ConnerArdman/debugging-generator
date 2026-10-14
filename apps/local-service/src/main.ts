/**
 * The process entry point and composition root of `@debuggen/local-service`.
 *
 * ## The artefact contract this file satisfies
 *
 * `tsup.config.ts` declares exactly one entry, `main: 'src/main.ts'`, so this
 * module is the whole program: everything the service runs is reached through
 * the static imports below and collapses into a single `dist/main.js`.
 *
 * - `package.json` names `dist/main.js` as `main`, as its only `exports` entry
 *   and as the target of `"start": "node dist/main.js"`.
 * - The root `playwright.config.ts` `webServer` entry runs
 *   `node apps/local-service/dist/main.js`, polls `GET ${serviceUrl}/health`
 *   until it answers and stops the process with **SIGTERM** and a 12 s grace
 *   period, so the health route and the signal handling are load-bearing for
 *   every browser and end-to-end suite (AAP 0.8.3). The whole shutdown is held
 *   inside that grace, and inside the VS Code extension's 10 s one, by
 *   {@link SHUTDOWN_BUDGET}; `main.test.ts` fails if either grace shrinks
 *   below it.
 * - `apps/vscode-extension/esbuild.mjs` re-bundles these same sources into the
 *   VSIX, which is why every import is static and top-level (a computed
 *   `import()` of a local module would not survive that second bundle), why
 *   the prompt directory is always taken from `config.promptsDir` and never
 *   assumed to sit beside the bundle, and why {@link StartServiceOptions}
 *   accepts the store DDL inline: that bundle embeds `schema.sql` as a string
 *   (`embeddedSchemaSql()` of `./store/db.js`) and {@link main} hands it to
 *   {@link startService}, so the VSIX ships no `.sql` file. Every other build
 *   embeds nothing and the store finds its DDL on disk.
 *
 * ## Start-up order, and why it is this order
 *
 * {@link startService} runs one fixed sequence and reports every failure as a
 * typed `Err`, never a throw. A failure after a resource has been acquired
 * releases everything acquired so far, so a refused start leaves no open
 * database, no bound socket and no timer behind.
 *
 * 1. **Configuration** — `loadServiceConfig` over an **injected** environment.
 *    Nothing in {@link startService} reads `process.env`; {@link main} passes it
 *    after `dotenv`, so a suite's injected environment is authoritative. The
 *    prompt directory and its manifest are then checked read-only
 *    (`verifyPromptsDirectory`), so a missing `DEBUGGEN_PROMPTS_DIR` is refused
 *    like any other key before anything is created under `$DEBUGGEN_HOME`.
 * 2. **Logging** — one root logger, a `subsystem` child per area; the resolved
 *    configuration is logged once through its credential-free view.
 * 3. **The state tree** — `$DEBUGGEN_HOME`, `backups/` and `index/`, created and
 *    verified `0700` and symlink-free by `ensureSecureDir` (mkdir's own mode is
 *    umask-masked, which is why it is not used) — and its canonical location,
 *    resolved once with `realpath`: the value every project root is kept
 *    apart from. A refusal names the offending directory and its fix (for a
 *    too-open one: its mode and `chmod 700`).
 * 4. **The session store** — `openStore` from `./store/db.js`: the owner-only
 *    database file, WAL mode, the pragmas and the schema ladder.
 * 5. **The editor credential** — `AuthService.ensureEditorCredential` from
 *    `./server/auth.js`, the single owner of credential policy (AAP 0.5.6): the
 *    plaintext token lives only in `auth.json` (`0600`, written with
 *    `createFileExclusive`/`writeSecureFileAtomic` there) and the store keeps
 *    its SHA-256 digest. It runs after the store because the digest is written
 *    to the `credentials` table. The token is never logged here.
 * 6. **Modification reconciliation — before serving** (AAP 0.5.1). Every
 *    non-reverted journal record, whatever its session's status, is closed,
 *    restored from its backup or marked `conflict` by
 *    `reconcileModificationsOnStartup`. A developer who killed the service
 *    mid-session gets their files back here, before any client can open a new
 *    session. Then the **state-root overlap check**: a stored session whose
 *    canonical project root contains the canonical state root, or lies inside
 *    it, refuses the start (`FS_UNSAFE_PATH`, step `state-home-overlap`), so
 *    session data, backups and the credential never live in a working tree;
 *    so does one whose project root cannot be resolved on disk, because
 *    separation that cannot be shown is not assumed. The same check guards
 *    every new session, follow-up, dev-server launch and credential through
 *    the routes, and the instrumentation service repeats it before every
 *    install writes a backup or a patch.
 * 7. **Retention's dependencies** (AAP 0.4.2): the start-up `runRetention` pass
 *    — aged sessions, stale index caches and orphan backups, conflict backups
 *    exempt — is housekeeping, not correctness, so it is **started once the
 *    socket listens** and runs in the background in bounded transactions
 *    (see {@link startStartupRetention}); a large backlog never keeps the port
 *    closed. The same dependencies back `POST /sessions/purge`, which the
 *    editor command `debuggen.purgeSessions` calls to run the sweep on demand
 *    — scoped to that editor's announced workspace folders, while the start-up
 *    pass is machine-wide.
 * 8. **The model provider** — `createModelProvider` over the validated
 *    selection. An unusable selection is a configuration error and fails the
 *    start; a transport failure is a runtime condition reported per session by
 *    the stage that meets it (AAP 0.5.5), so nothing is contacted here.
 * 9. **The prompt tree** — `createPromptLoader` over `config.promptsDir`, then
 *    the manifest and every stage's current prompt are loaded eagerly, so a
 *    broken prompt tree fails the start rather than a session.
 * 10. **Subsystem wiring**, in dependency order, each handed only the
 *     collaborators it declares. Once the session manager has hydrated, the
 *     sessions the previous process left `instrumenting`, `ready` or
 *     `capturing` are settled by `settleInterruptedSessions` — still before
 *     serving: an interrupted install, a session whose patches step 6 removed
 *     and every capture the restart interrupted are failed, so no capture is
 *     advertised before a producer has taken its configuration; each failed
 *     capture's producers are owed their dormant configuration, and its
 *     cleanup verdict stays `partial` until they take it. A session that could
 *     not be settled fails the start.
 * 11. **One HTTP server, two protocols** — a single `node:http` server whose
 *     request listener is the hono application of `./server/http.js` and whose
 *     `upgrade` event is routed to the WebSocket server of `./server/ws.js` at
 *     protocol's `WS_PATH`. The bound port is read back, so `port: 0` yields a
 *     usable {@link ServiceHandle.url}. The server is created with
 *     {@link HTTP_SERVER_LIMITS} in force — header, request and keep-alive
 *     deadlines and a connection cap — so no connection holds a socket
 *     unbounded before the access boundary sees its request (CWE-400); a
 *     connection it refuses is answered by a raw `Connection: close` response
 *     carrying the application's own response-header policy
 *     (`./server/http.js`'s `RESPONSE_POLICY_HEADERS`):
 *     `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
 *     `X-Frame-Options: DENY` and
 *     `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
 *     The replies Node writes itself before any listener runs — the `417` for
 *     an unmet `Expect`, the `400` for an HTTP/1.1 request with no `Host` —
 *     carry the same policy, set on every response from construction.
 *     New connections are admitted at a bounded rate, and those that have sent
 *     no complete request — or idle with none in flight — share a bounded
 *     budget whose oldest member a newcomer evicts, so stalled connections
 *     cannot hold every slot ({@link createLimitedServer}).
 * 12. **Health** — `GET /health`, auth-exempt, answers from the first accepted
 *     connection. The start-up retention sweep begins on the next turn of the
 *     event loop, beside live clients: it keeps every session a client has
 *     touched since this process started, and drops each purged session's
 *     cached trace trees.
 *
 * ## What this file adds beside the subsystems
 *
 * A composition root composes. The only code of its own is the process
 * lifecycle and the adapters that bind one subsystem's declared port to
 * another's concrete surface where the two are not already structurally the
 * same object:
 *
 * - an **agent-readiness ledger** — the relayed `agent.ready` reports per
 *   DevTools credential and tab, written by the WebSocket router, and each
 *   such tab's latest committed navigation, written by the binding route, both
 *   read by the readiness gate for a session's live binding;
 * - the **server-agent presence** view of the client registry;
 * - the **source-open delivery** port over the client registry;
 * - the **credential issuer** the dev-server launcher mints, renews and revokes
 *   its scoped `server-agent` credential leases through — one credential per
 *   call, so one child's exit never revokes another dev server's credential;
 * - the **capture-time readiness re-evaluation** the capture stage uses to move
 *   a session whose page was not ready at install time to `ready`;
 * - the **producer replay** wiring: every producer connection is announced to
 *   the instrumentation service as it registers, a tab bound without an open
 *   capture has its page agent reconciled to dormant, and a cleanup verdict
 *   upgraded once a producer took its dormant configuration is recorded
 *   through the session manager;
 * - the **conflict reflection** ({@link conflictReflectingListener}): a
 *   conflict the watcher detects updates the session record through the
 *   session manager, which broadcasts `session.updated` to both user
 *   interfaces;
 * - an **effective configuration** whose `port` is the bound port once the
 *   socket listens, which is what a launched dev server's ingest URL and the
 *   dev-server probe's self-exclusion need under `port: 0`.
 *
 * ## Shutdown
 *
 * {@link ServiceHandle.close} is idempotent and runs against **one end-to-end
 * deadline** ({@link SHUTDOWN_BUDGET}), not a bound per step, so its total
 * duration is known and smaller than the grace of every process that manages
 * the service. In order ({@link releaseParts}):
 *
 * 1. it stops accepting work, cancels in-flight pipeline operations and stops
 *    the start-up retention sweep at its next step boundary;
 * 2. it **ends every live session** — every session still holding
 *    instrumentation — through `SessionManager.end`, exactly as an explicit
 *    `session.end` would: the capture window closes, the page agent goes
 *    dormant, the dev-server preload disables its instrumentations, every
 *    patched file is restored (a developer-edited one is left untouched and
 *    reported as a conflict) and `cleanup.completed` reaches the connected
 *    clients (AAP 0.5.1). Sessions whose patches overlap in one file are
 *    ended last-applied-first;
 * 3. it stops the dev servers this service launched, which revokes their
 *    scoped credentials, from a slice of the deadline no earlier step may use,
 *    and revokes those credentials itself should the launcher not confirm
 *    (AAP 0.5.6);
 * 4. it closes every WebSocket with the normal going-away code (never 4401,
 *    which means unauthorized), releases the in-memory subsystems and finally
 *    checkpoints and closes the database.
 *
 * Step 2 is bounded like every other step, and each session gets a fair share
 * of it, so one stalled session never starves another. A session it cannot
 * finish in time has its producers disarmed anyway and keeps its durable
 * journal, and step 6 of the next start restores it, so a stuck restore never
 * holds up a stop and a stop that is killed part-way loses nothing. A
 * referenced watchdog keeps the process alive until the database is closed,
 * even once the listener and sockets are gone. A crash (an uncaught exception) closes with
 * `{ liveSessions: 'retain' }`: a process that has just thrown past every
 * handler does not let its possibly inconsistent state drive writes into the
 * developer's tree, and leaves them to that same reconciliation.
 *
 * A launched dev server is counted as stopped only when the launcher observed
 * its exit. One that outlived its whole termination ladder is named — pid and
 * project root — in an `error` record for the `dev-servers` step, and the
 * shutdown's final record is then written at `warn` with the pids (or with
 * `devServers: 'unconfirmed'` when that step failed or was abandoned) instead
 * of as a clean stop.
 */

import { config as loadDotenvFile } from 'dotenv';

import {
  createAdapterRegistry,
  type AdapterRegistry,
  type ModificationRecord,
} from '@debuggen/instrumentation';
import {
  PROMPT_STAGES,
  createModelProvider,
  createPromptLoader,
  type ModelProvider,
  type PromptLoader,
} from '@debuggen/model-provider';
import {
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  SESSION_STATUSES,
  WS_PATH,
  type AgentReadyPayload,
  type ClientKind,
  type CleanupStatus,
  type ProtocolMessage,
  type SelectedTarget,
  type SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  nowEpochMs,
  ok,
  type LogFields,
  type Logger,
  type Result,
  type SessionId,
} from '@debuggen/shared';
import { ensureSecureDir, unsafePathReasonOf } from '@debuggen/shared/node';

import { realpathSync } from 'node:fs';
import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  reconcileModificationsOnStartup,
  createSessionCleanup,
  settleInterruptedSessions,
} from './cleanup/cleanup.js';
import type {
  CleanupOutcomeSink,
  InterruptedSessionsReport,
  SessionCleanup,
  StartupReconciliationReport,
} from './cleanup/cleanup.js';
import {
  PROJECT_ROOT_UNRESOLVABLE_REASON,
  STATE_HOME_OVERLAP_HINT,
  STATE_HOME_OVERLAP_REASON,
  canonicalizePath,
  describeServiceConfig,
  loadServiceConfig,
  stateHomeOverlap,
  toModelProviderOverrides,
  verifyPromptsDirectory,
  type ServiceConfig,
  type ServiceConfigOverrides,
  type StateHomeOverlap,
} from './config.js';
import { probeDevServer } from './dev-server/detect.js';
import {
  addressedServerAgentPresence,
  createDevServerLauncher,
  serverAgentCredentialIssuer,
} from './dev-server/launcher.js';
import type {
  DevServerLauncher,
  DevServerLauncherDeps,
  DevServerTerminationReport,
  ServerAgentConnections,
} from './dev-server/launcher.js';
import { documentLogFields } from './instrumentation/document-fingerprint.js';
import {
  MAX_RELOAD_WAIT_MS,
  collectObservedReadiness,
  collectReadinessEvidence,
  evaluateReadiness,
} from './instrumentation/readiness.js';
import type {
  BoundTabRef,
  BrowserAgentRegistry,
  CollectObservedReadinessDeps,
  ReadinessVerdict,
  ServerAgentReadinessSource,
  WaitForAgentReadyOptions,
} from './instrumentation/readiness.js';
import { createInstrumentationService } from './instrumentation/service.js';
import type {
  CodeAnalysisHandles,
  InstrumentationService,
  ProducerReconciler,
} from './instrumentation/service.js';
import { createInstrumentationWatcher } from './instrumentation/watcher.js';
import type {
  InstrumentationWatcher,
  ModificationConflictListener,
} from './instrumentation/watcher.js';
import {
  LOG_ERROR_FIELD_KEY,
  createServiceLogger,
  describeException,
  guardLogger,
  subsystemLogger,
  type ServiceLoggerOptions,
} from './logging.js';
import { createAnalysisFacts } from './analysis/facts.js';
import { createAnalysisSummarizer } from './analysis/summarize.js';
import { createPanelDataResolver } from './panels/data.js';
import { createFallbackPanelBuilder } from './panels/fallback.js';
import { createPanelGenerator } from './panels/generate.js';
import { createPanelValidator } from './panels/validate.js';
import { createContextBuilder } from './pipeline/context-builder.js';
import type { PipelineCodeHandles } from './pipeline/context-builder.js';
import { createCodeIndexLoader, createPipelineOrchestrator } from './pipeline/orchestrator.js';
import type { CodeIndexPort, PipelineOrchestrator } from './pipeline/orchestrator.js';
import type { CaptureReadinessRequest, CaptureReadinessSource } from './pipeline/stages/capture.js';
import { createAuthService } from './server/auth.js';
import type { AuthService, ConnectionRevoker } from './server/auth.js';
import {
  DEFAULT_MAX_CLIENTS,
  WS_CLOSE_GOING_AWAY,
  createClientRegistry,
  heldTabKey,
} from './server/clients.js';
import type { ClientRegistry } from './server/clients.js';
import {
  DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  RESPONSE_POLICY_HEADERS,
  createHttpApp,
} from './server/http.js';
import type { HttpApp } from './server/http.js';
import {
  createBindingRoutes,
  observingDocumentReports,
  redactSelectedTarget,
} from './server/routes/binding.js';
import type { BindingRoutes, NavigationRecorder } from './server/routes/binding.js';
import { devServerLookupFromLaunches } from './server/routes/sessions.js';
import { createWsServer } from './server/ws.js';
import type {
  AgentReadinessPort,
  TargetSelectionPort,
  WsConnectionFacts,
  WsServer,
} from './server/ws.js';
import { createSessionManager } from './sessions/manager.js';
import type { SessionManager } from './sessions/manager.js';
import {
  carriesWrappedExceptionText,
  createSessionProgress,
  isProductAuthoredText,
} from './sessions/progress.js';
import type { SessionProgress } from './sessions/progress.js';
import { createSessionReopener } from './sessions/reopen.js';
import { createSourceOpenHandler } from './source/open.js';
import type { SourceOpenClientPort } from './source/open.js';
import {
  createCorroborationCache,
  createSourceMapScopes,
  createSourceResolver,
} from './source/resolve.js';
import type { ModificationCorroborationPort, ParentEventPort } from './source/resolve.js';
import { embeddedSchemaSql, openStore } from './store/db.js';
import type { Store } from './store/db.js';
import { createModificationsRepo } from './store/modifications-repo.js';
import type {
  ModificationCorroborationReader,
  ModificationsRepo,
} from './store/modifications-repo.js';
import { createPanelsRepo } from './store/panels-repo.js';
import type { PanelsRepo } from './store/panels-repo.js';
import { runRetention } from './store/retention.js';
import type { RetentionDeps, RetentionReport } from './store/retention.js';
import { MAX_SESSION_LIST_LIMIT, createSessionsRepo } from './store/sessions-repo.js';
import type { SessionsRepo } from './store/sessions-repo.js';
import { createTelemetryRepo } from './store/telemetry-repo.js';
import type { TelemetryRepo } from './store/telemetry-repo.js';
import { createIngestAttributor } from './telemetry/attribute.js';
import type { AttributedEvent } from './telemetry/attribute.js';
import {
  TRACE_CACHE_LIMIT,
  TRACE_CACHE_MAX_TREE_NODES,
  TRACE_CACHE_NODE_BUDGET,
  createTraceCorrelator,
} from './telemetry/correlate.js';
import type { TraceCorrelator } from './telemetry/correlate.js';
import { createTelemetryIngest } from './telemetry/ingest.js';
import type { IngestSourceLocator } from './telemetry/ingest.js';
import { createLiveTail } from './telemetry/live-tail.js';
import type { LiveTail } from './telemetry/live-tail.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` bindings of the records this file emits itself, following
 * the convention of `./logging.js`: the source folder a record is about.
 */
const SUBSYSTEM_SERVICE = 'service';

/** The `subsystem` binding of the records about the HTTP and WebSocket surface. */
const SUBSYSTEM_SERVER = 'server';

/** The `subsystem` binding of the agent-readiness ledger's records. */
const SUBSYSTEM_READINESS = 'instrumentation.agents';

/**
 * The path of the unauthenticated health route, read from protocol's route
 * table (it is a contract with the Playwright `webServer` probe, VS Code service
 * discovery and `HttpClient.health()`), and reported in the "listening" line.
 */
const HEALTH_ROUTE = HTTP_ROUTES.health.pattern;

/**
 * This service build's version: the `version` of the `GET /health` body.
 *
 * The `version` of `apps/local-service/package.json`, kept in step by hand and
 * held to it by `main.test.ts`. A literal because no way of reading the manifest
 * holds in every layout this module runs in: importing `../package.json` puts a
 * file outside this project's `include` into the program, a build-time `define`
 * would be absent under `tsx watch src/main.ts`, and a run-time read of
 * `new URL('../package.json', import.meta.url)` names the VS Code extension's
 * manifest once these sources are re-bundled into the VSIX. Clients display it
 * and never parse it; compatibility is decided by `protocolVersion`.
 */
export const SERVICE_VERSION = '0.1.0';

/**
 * How long the HTTP server waits for open connections to drain before closing
 * them itself, in milliseconds. Idle keep-alive sockets are released at once;
 * this bounds the in-flight ones. The drain starts with the first shutdown step,
 * so it has ended long before {@link SHUTDOWN_BUDGET} does.
 */
const HTTP_DRAIN_GRACE_MS = 3_000;

/**
 * The deadlines and the connection cap the HTTP server enforces on every
 * connection before a route — and so before the access boundary — sees it
 * (CWE-400). See {@link HTTP_SERVER_LIMITS} for the values and why.
 */
export interface HttpServerLimits {
  /**
   * How long a request may take to deliver its complete header block, in
   * milliseconds: counted from the connection's establishment for its first
   * request and from the first byte of every later one, so a connection that
   * sends nothing at all is closed at this deadline too. Node's
   * `server.headersTimeout`; answered `408` and closed.
   */
  readonly headersTimeoutMs: number;

  /**
   * How long a request may take to arrive whole — header block and body — in
   * milliseconds, counted like {@link headersTimeoutMs}. Node's
   * `server.requestTimeout`. It ends once the request has arrived: a handler
   * that takes longer to answer, and a WebSocket upgraded on the connection,
   * are not bound by it. Never below {@link headersTimeoutMs}.
   */
  readonly requestTimeoutMs: number;

  /**
   * How long a keep-alive connection may sit idle after a response before the
   * server closes it, in milliseconds. Node's `server.keepAliveTimeout`.
   */
  readonly keepAliveTimeoutMs: number;

  /**
   * How often the server checks the two request deadlines above, in
   * milliseconds, and so how late past its deadline a stalled request can be
   * closed. Node's `connectionsCheckingInterval` server option.
   */
  readonly connectionsCheckingIntervalMs: number;

  /**
   * The most connections the server holds open at once — HTTP connections and
   * upgraded WebSocket sockets alike. A connection accepted past it is closed at
   * once, before a byte is read. Node's `server.maxConnections`: the hard
   * backstop behind the admission budget of the three limits below.
   */
  readonly maxConnections: number;

  /**
   * The admission bucket's capacity: how many new TCP connections the server
   * admits in one burst before {@link connectionsPerSecond} paces them. A
   * connection that finds the bucket empty is destroyed as it is accepted,
   * before a byte of it is parsed. See {@link createConnectionAdmission}.
   */
  readonly connectionBurst: number;

  /**
   * How many admissions the bucket regains per second, up to
   * {@link connectionBurst}: the sustained rate of new connections.
   */
  readonly connectionsPerSecond: number;

  /**
   * The most **unengaged** connections the server holds at once: connections
   * that have not delivered a complete request head yet, or that sit idle on
   * keep-alive with no response in flight — sockets that hold no slot a
   * legitimate client is waiting on. A new connection past it evicts the oldest
   * unengaged one. A connection with a request in flight is never unengaged, and
   * neither is one upgraded to WebSocket (`./server/ws.ts` applies its own
   * admission quotas to those).
   */
  readonly maxUnengagedConnections: number;

  /**
   * How many of {@link maxConnections}' slots the eviction keeps free for new
   * connections. Once the server holds `maxConnections − reservedConnections`
   * connections of any kind — the soft cap — a new connection evicts the oldest
   * unengaged one, and is refused only when none is left to evict. A reserve no
   * smaller than `maxConnections` leaves no room for a soft cap, so none applies
   * and the hard cap alone refuses (how a suite observes it with a cap of 2).
   */
  readonly reservedConnections: number;
}

/**
 * Replacements for members of {@link HTTP_SERVER_LIMITS}; see
 * {@link StartServiceOptions.httpLimits}. Every member accepts an explicit
 * `undefined`, which keeps the default.
 */
export type HttpServerLimitOverrides = {
  readonly [Limit in keyof HttpServerLimits]?: number | undefined;
};

/**
 * The time a request's header block may take, in milliseconds. Every client of
 * this service — the editor, the DevTools panel, a dev-server preload, the
 * guard scripts — sends its header block in one write over loopback, so ten
 * seconds is generous for them and short for a connection that trickles or
 * withholds it.
 */
const HTTP_HEADERS_TIMEOUT_MS = 10_000;

/**
 * What the whole-request deadline allows beyond a full header deadline and the
 * request-body guard's own time ceiling, in milliseconds: the time between the
 * header block and the route's first body read, and the check interval.
 */
const HTTP_REQUEST_TIMEOUT_SLACK_MS = 5_000;

/**
 * The WebSocket sockets {@link HTTP_SERVER_LIMITS}' connection cap provides
 * for: twice the client registry's {@link DEFAULT_MAX_CLIENTS} — every
 * registered client, and as many again for upgrades still awaiting their
 * `client.hello`, which is more than `./server/ws.ts` admits before a hello —
 * so the WebSocket surface meets its own cap before this one.
 */
const WEBSOCKET_SOCKET_ALLOWANCE = 2 * DEFAULT_MAX_CLIENTS;

/**
 * The HTTP connections {@link HTTP_SERVER_LIMITS}' connection cap provides for
 * beyond {@link WEBSOCKET_SOCKET_ALLOWANCE}: one developer's editor, DevTools
 * panels, dev-server preloads and scripts open a handful each.
 */
const HTTP_CONNECTION_HEADROOM = 512;

/**
 * The admission bucket's capacity: as many new connections at once as
 * {@link WEBSOCKET_SOCKET_ALLOWANCE} provides for, so every client of a full
 * registry reconnecting together after a service restart — or an integration
 * suite opening its connections — is admitted without waiting.
 */
const HTTP_CONNECTION_BURST = 512;

/**
 * The bucket's refill rate, per second: an emptied bucket admits a full
 * registry again within two seconds, while a flood of new connections is held
 * to this pace — below what one process can open — whatever it sends.
 */
const HTTP_CONNECTIONS_PER_SECOND = 256;

/**
 * The unengaged connections held at once: a quarter of the cap. Every client
 * of this service sends its request head in one write as it connects, so a
 * legitimate connection is unengaged for a moment, or while it idles on
 * keep-alive for at most {@link HttpServerLimits.keepAliveTimeoutMs}.
 */
const HTTP_MAX_UNENGAGED_CONNECTIONS = 256;

/**
 * The slots below the cap the eviction keeps free (the soft cap is 960): room
 * for the connections accepted while earlier ones are still being closed.
 */
const HTTP_RESERVED_CONNECTIONS = 64;

/**
 * The limits of the HTTP server {@link startService} listens with (CWE-400).
 *
 * The server's authentication runs in the application, after the request has
 * arrived, so without these a peer that opens connections and never completes
 * a request would hold a socket, a file descriptor and a parser each for as
 * long as it liked. With them every connection is bounded in number and in
 * time before any route reads a byte of it, and connections are admitted at a
 * bounded rate with a bounded share for those that serve nobody yet:
 *
 * | Limit | Value | Why |
 * | --- | --- | --- |
 * | `headersTimeoutMs` | 10 s | a stalled or empty connection is closed `408` within 11 s |
 * | `requestTimeoutMs` | 45 s | above the header deadline plus `../server/http.ts`'s {@link DEFAULT_REQUEST_BODY_TIMEOUT_MS} (30 s), so a trickling body meets that guard's own `408` first |
 * | `keepAliveTimeoutMs` | 5 s | an idle keep-alive connection is released |
 * | `connectionsCheckingIntervalMs` | 1 s | how late past a deadline the close comes |
 * | `maxConnections` | 1 024 | {@link WEBSOCKET_SOCKET_ALLOWANCE} (512) plus {@link HTTP_CONNECTION_HEADROOM} (512) |
 * | `connectionBurst` | 512 | {@link HTTP_CONNECTION_BURST}: a reconnect storm of a full registry is admitted at once |
 * | `connectionsPerSecond` | 256 | {@link HTTP_CONNECTIONS_PER_SECOND}: a flood is paced below the speed it can open sockets |
 * | `maxUnengagedConnections` | 256 | {@link HTTP_MAX_UNENGAGED_CONNECTIONS}: stalled or idle sockets can take a quarter of the cap, never all of it |
 * | `reservedConnections` | 64 | {@link HTTP_RESERVED_CONNECTIONS}: from 960 held connections on, a newcomer evicts an unengaged one |
 *
 * Every peer of this service is on loopback, where a per-address quota cannot
 * tell one client from another, so the admission budget is global rather than
 * per peer; see {@link createConnectionAdmission} for how it still keeps a
 * slot for a legitimate client. A connection refused at the cap, past the
 * admission rate or with nothing left to evict, and a connection evicted, is
 * reported at `warn`, at most once per
 * {@link DROPPED_CONNECTIONS_REPORT_INTERVAL_MS} for each kind, with counts
 * only. No environment variable changes these (the service's settings are the
 * `SERVICE_ENV_KEYS` of `./config.ts`, each documented in the root
 * `.env.example`); {@link StartServiceOptions.httpLimits} is the suites' seam.
 */
export const HTTP_SERVER_LIMITS: HttpServerLimits = Object.freeze({
  headersTimeoutMs: HTTP_HEADERS_TIMEOUT_MS,
  requestTimeoutMs:
    HTTP_HEADERS_TIMEOUT_MS + DEFAULT_REQUEST_BODY_TIMEOUT_MS + HTTP_REQUEST_TIMEOUT_SLACK_MS,
  keepAliveTimeoutMs: 5_000,
  connectionsCheckingIntervalMs: 1_000,
  maxConnections: WEBSOCKET_SOCKET_ALLOWANCE + HTTP_CONNECTION_HEADROOM,
  connectionBurst: HTTP_CONNECTION_BURST,
  connectionsPerSecond: HTTP_CONNECTIONS_PER_SECOND,
  maxUnengagedConnections: HTTP_MAX_UNENGAGED_CONNECTIONS,
  reservedConnections: HTTP_RESERVED_CONNECTIONS,
});

/**
 * The shortest time between two `warn` records about one kind of connection
 * the server refused or evicted — at {@link HttpServerLimits.maxConnections},
 * past the admission rate, with nothing left to evict, or evicted — in
 * milliseconds. Events in between are counted and reported with the next
 * record of their kind.
 */
export const DROPPED_CONNECTIONS_REPORT_INTERVAL_MS = 10_000;

/**
 * How one shutdown spends its time, in milliseconds. See {@link SHUTDOWN_BUDGET}.
 */
export interface ShutdownBudget {
  /**
   * The end-to-end bound: from the first step of {@link releaseParts} to the
   * store's close. A step that has not settled when its slice ends is logged as
   * abandoned and the sequence moves on.
   */
  readonly totalMs: number;

  /** The most the cancellation of in-flight pipeline operations may take. */
  readonly pipelineMs: number;

  /**
   * Held back from every step before the dev-server launcher, so terminating
   * the children this service launched — `SIGTERM`, the launcher's
   * {@link DEV_SERVER_STOP_GRACE_MS}, `SIGKILL`, its exit confirmation and the
   * revocation of their credentials — always has its time, however long ending
   * the live sessions took.
   */
  readonly launcherReserveMs: number;

  /**
   * Held back from every step before the last ones: flushing the live tail,
   * the WebSocket close handshakes, the HTTP listener, the in-memory subsystems
   * and the store's checkpoint and close.
   */
  readonly finalReserveMs: number;
}

/**
 * The shutdown budget of this service.
 *
 * `totalMs` is chosen against the two processes that stop the service, each of
 * which sends `SIGTERM` and escalates to `SIGKILL` after a grace:
 *
 * | Manager | Grace | Where |
 * | --- | --- | --- |
 * | the VS Code extension's service supervisor | 10 s | `apps/vscode-extension/src/service/process.ts` |
 * | Playwright's `webServer` | 12 s | `playwright.config.ts` |
 *
 * The service's own lifetime after `SIGTERM` is at most `totalMs` plus the
 * {@link EXIT_BACKSTOP_MS} backstop — 8.5 s — so it has exited before either
 * grace ends; `main.test.ts` reads both graces and fails if one shrinks below
 * that. Within the total, the launcher's reserve covers its worst case — the
 * {@link DEV_SERVER_STOP_GRACE_MS} wait, `SIGKILL`, its
 * {@link LAUNCHER_KILL_CONFIRM_MS} exit confirmation — **plus**
 * {@link LAUNCHER_REVOCATION_SLACK_MS} for the credential revocation it performs
 * only after both waits, so a child that is slow to die still has its
 * credential revoked before the store closes. Ending the live sessions receives
 * everything the pipeline does not use up to those two reserves: at least 1 s,
 * and in the usual case — a pipeline that cancels at once — about 2 s, against
 * the few milliseconds a restore of a handful of files takes.
 */
export const SHUTDOWN_BUDGET: ShutdownBudget = Object.freeze({
  totalMs: 8_000,
  pipelineMs: 1_000,
  launcherReserveMs: 4_500,
  finalReserveMs: 1_500,
});

/**
 * The `SIGTERM` → `SIGKILL` grace this service gives a dev server it launched,
 * in milliseconds — shorter than the launcher's 5 s default so that the
 * termination, its escalation and its exit confirmation fit
 * {@link ShutdownBudget.launcherReserveMs}. `next dev` stops on `SIGTERM` in
 * well under a second; the grace only matters for a child that ignores it.
 */
export const DEV_SERVER_STOP_GRACE_MS = 2_000;

/**
 * How long the launcher waits for a child's exit after `SIGKILL` before it
 * gives up observing it and revokes the child's credential anyway, in
 * milliseconds. The launcher's own constant (`KILL_CONFIRM_MS` in
 * `./dev-server/launcher.ts`) is private; this mirror is what the budget is
 * computed from, and `main.test.ts` fails if the two ever differ.
 */
export const LAUNCHER_KILL_CONFIRM_MS = 2_000;

/**
 * The margin the launcher's reserve keeps beyond its two waits, in
 * milliseconds: the revocation of the child's credential and the removal of
 * its registry entry, which the launcher performs only after both waits, plus
 * timer granularity.
 */
export const LAUNCHER_REVOCATION_SLACK_MS = 500;

/**
 * How long past the deadline the shutdown watchdog keeps the event loop alive,
 * in milliseconds. Every step is bounded by the deadline, so the sequence has
 * finished well before the watchdog would release the loop.
 */
const SHUTDOWN_WATCHDOG_MARGIN_MS = 1_000;

/**
 * How much margin the backstop around ending the live sessions adds to their
 * slice, in milliseconds. {@link endLiveSessions} enforces the slice itself and
 * reports what it left; the backstop only fires if something it awaits before
 * the first session (reading the journal) never answers.
 */
const LIVE_SESSIONS_BACKSTOP_MARGIN_MS = 100;

/**
 * The `msg` of the record a shutdown writes when launched dev servers are still
 * running after the dev-server step. Constant; the record names them by pid and
 * project root.
 */
const DEV_SERVERS_SURVIVED_MESSAGE = 'launched dev servers are still running after shutdown';

/**
 * How often the client registry sweeps: it unregisters connections that stayed
 * offline past their grace period and closes any whose credential has expired.
 * The timer is `unref`'d by the registry and stopped by `closeAll`.
 */
const CLIENT_SWEEP_INTERVAL_MS = 30_000;

/**
 * The most tabs the agent-readiness ledger remembers, counted per DevTools
 * credential and tab. One entry per credential's tab holds both its latest
 * report and its latest navigation, so the two share one lifetime: a write of
 * either makes the entry the most recent, and the least recently written entry
 * is forgotten whole. That fails closed — readiness then sees no report for the
 * tab and asks for a reload, and the page agent reports again on its next
 * document load — whereas a report that outlived the navigation recorded after
 * it would be trusted on sight.
 */
const MAX_TRACKED_AGENT_TABS = 256;

/** The client kind that can display a pairing code (AAP 0.5.6). */
const PAIRING_DISPLAY_KIND: ClientKind = 'vscode';

/**
 * The tier whose events carry page-document stacks the source-map route maps
 * (fetch/XHR initiators and browser errors), and so the only tier whose
 * `producerId` keys a shared source-map scope in {@link createIngestSourceLocator}.
 */
const BROWSER_TIER = 'browser' satisfies AttributedEvent['tier'];

/** The signals that mean "stop": the two a developer and a test runner send. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/* -------------------------------------------------------------------------------------------------
 * Public surface
 * ---------------------------------------------------------------------------------------------- */

/**
 * How a host steers {@link startService}.
 *
 * Every member is optional and accepts an explicit `undefined`, so a caller may
 * spread a partially filled record — the repository compiles with
 * `exactOptionalPropertyTypes`.
 */
export interface StartServiceOptions {
  /**
   * The environment configuration is resolved from. Defaults to an **empty
   * object**, never to `process.env`: `startService` is pure with respect to the
   * process it runs in, so a suite gets exactly the settings it passed.
   * {@link main} passes `process.env` after `dotenv` has populated it. The same
   * record is the parent environment of every dev server the launcher starts.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;

  /**
   * Settings the host has already decided, winning over the environment per
   * setting — how a suite pins a temporary `$DEBUGGEN_HOME` and an ephemeral
   * port (`port: 0`).
   */
  readonly overrides?: ServiceConfigOverrides | undefined;

  /** Seams for the logger `createServiceLogger` builds (destination, level, bindings). */
  readonly loggerOptions?: ServiceLoggerOptions | undefined;

  /** A pre-built root logger, used instead of `createServiceLogger` when given. */
  readonly logger?: Logger | undefined;

  /**
   * A pre-built model provider, used instead of `createModelProvider` when given
   * — how a suite substitutes a scripted provider without an environment.
   */
  readonly provider?: ModelProvider | undefined;

  /**
   * The clock, in epoch milliseconds, handed to every subsystem that accepts
   * one. Defaults to each subsystem's own (`nowEpochMs`).
   */
  readonly now?: (() => number) | undefined;

  /**
   * The session store's DDL, inlined by an embedding host's bundler. Forwarded
   * to `openStore`, where it replaces the filesystem probe for `schema.sql`.
   *
   * {@link main} passes `embeddedSchemaSql()` from `./store/db.js`: the text
   * `apps/vscode-extension/esbuild.mjs` embeds in the editor extension's
   * service bundle, `undefined` in every other build. A suite passes its own
   * text or leaves it out.
   */
  readonly inlineSchemaSql?: string | undefined;

  /**
   * Builds the dev-server launcher from the collaborators this function
   * composes (the effective configuration, the root logger, the access
   * boundary's credential issuer, the environment). Defaults to
   * `createDevServerLauncher`; a suite substitutes a wrapper around it to
   * observe what the shutdown does with the launcher's termination report
   * without spawning a process.
   */
  readonly createLauncher?: ((deps: DevServerLauncherDeps) => DevServerLauncher) | undefined;

  /**
   * Replacements for members of {@link HTTP_SERVER_LIMITS} — how a suite
   * observes a deadline in milliseconds rather than seconds, or the connection
   * cap and the admission budget with a handful of sockets rather than
   * hundreds. Never read from the environment. Every member given must be a
   * positive safe integer, and the header deadline may not exceed the request
   * deadline; otherwise the start is refused `CONFIG_INVALID` before the
   * filesystem is touched. A shortened request deadline is no longer above the
   * request-body guard's, so the server's own `408` may then answer first.
   */
  readonly httpLimits?: HttpServerLimitOverrides | undefined;
}

/**
 * What the start-up maintenance of steps 5–7 found, kept on the handle so a
 * suite (or a developer reading the log) can see that crash recovery ran.
 */
export interface StartupReport {
  /** Whether step 5 minted a new editor credential and wrote `auth.json`. */
  readonly editorCredentialCreated: boolean;

  /** The modification reconciliation's report: restored, closed, conflicts. */
  readonly reconciliation: StartupReconciliationReport;

  /**
   * What became of the sessions the previous process left `instrumenting`,
   * `ready` or `capturing`: which were failed, and why. Taken after the
   * reconciliation, so a session whose patches it removed is never left
   * claiming them; a start that returns has no unsettled session.
   */
  readonly interruptedSessions: InterruptedSessionsReport;

  /**
   * The start-up retention sweep, which runs in the background once the
   * service listens: resolves with its report when it finishes (`interrupted:
   * true` when a stop cut it short), or with `undefined` when it could not run
   * at all (logged at `error`; retention never blocks a start). Never rejects.
   * A suite that asserts on what the start purged awaits it.
   */
  readonly retention: Promise<RetentionReport | undefined>;
}

/**
 * A started service: where it is listening, what it composed, and how to stop
 * it. Returned inside an `Ok` only once the socket is listening, so holding one
 * is a statement that the service is serving.
 */
export interface ServiceHandle {
  /** The base URL clients use, from the configured host and the **bound** port. */
  readonly url: string;

  /** The interface the server is bound to, as configured. */
  readonly host: string;

  /** The port the server is actually bound to; never `0`. */
  readonly port: number;

  /** The protocol path the WebSocket server answers upgrades on. */
  readonly wsPath: string;

  /**
   * The effective configuration every subsystem was handed; its `port` is the
   * bound port.
   */
  readonly config: ServiceConfig;

  /**
   * The service's root logger, so the process-level records {@link main} owns go
   * through the same logger, level and redaction policy as the service's own.
   */
  readonly logger: Logger;

  /** The open session store, for suites that assert on persisted state. */
  readonly store: Store;

  /** The session manager, for suites that drive a session without HTTP. */
  readonly manager: SessionManager;

  /**
   * The service's own access boundary — the instance every HTTP route and the
   * WebSocket handshake authorize through, wired to the client registry as its
   * revoker. Exposed so an integration suite can mint the `devtools` and
   * `server-agent` credentials, start pairing and rotate every credential
   * through the real lifecycle: a second `AuthService` over the same store
   * would share the credential rows but not the revoker, so its rotation could
   * not close the sockets this one tracks (AAP §0.5.6).
   */
  readonly auth: AuthService;

  /** What the start-up maintenance found. */
  readonly startup: StartupReport;

  /**
   * Stops the service: see this module's "Shutdown" section. Idempotent — every
   * call returns the same promise, so the first call's `options` decide —
   * bounded by {@link SHUTDOWN_BUDGET}, and never rejects.
   */
  close(options?: ServiceCloseOptions): Promise<void>;
}

/**
 * What a stop does with the sessions that still hold instrumentation.
 *
 * - `end` — end each one through `SessionManager.end`, exactly as an explicit
 *   `session.end` would: its patched files are restored (or reported as
 *   conflicts), its page agent and dev-server preload are disarmed and its
 *   clients receive `cleanup.completed`. What a graceful stop does.
 * - `retain` — leave each one, and its modification journal, exactly as it is,
 *   for the next start's reconciliation (AAP 0.5.1): the state a crashed or
 *   killed process leaves. What the crash handlers of {@link main} use, and how
 *   a suite reproduces a crash in-process.
 */
export type LiveSessionDisposition = 'end' | 'retain';

/** Options for {@link ServiceHandle.close}. */
export interface ServiceCloseOptions {
  /** What happens to the live sessions. Defaults to `end`. */
  readonly liveSessions?: LiveSessionDisposition | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The root logger and the children this file emits through. The root is kept
 * apart because several modules (`describeServiceConfig`, the store, retention)
 * put their own `subsystem` field on their records, and a child already bound
 * to that key would emit it twice in one JSON record.
 */
export interface ServiceLoggers {
  readonly root: Logger;
  readonly service: Logger;
  readonly server: Logger;
}

/**
 * The collaborators a stop ends the live sessions through
 * ({@link endLiveSessions}).
 */
export interface LiveSessionPorts {
  /** The one writer of session state; `end` runs the whole end-of-session sequence. */
  readonly manager: Pick<SessionManager, 'end'>;

  /** The session index, read for the non-terminal sessions. */
  readonly sessions: Pick<SessionsRepo, 'list'>;

  /** The modification journal, read for the sessions whose files are patched. */
  readonly modifications: Pick<ModificationsRepo, 'listAllOpen'>;

  /**
   * The arming state, read for the sessions whose producers are armed, and the
   * disarm a session that could not be ended in time is still given, so its
   * page agent and dev-server preload never outlive the stop.
   */
  readonly instrumentation?:
    | (Pick<InstrumentationService, 'arming'> &
        Partial<Pick<InstrumentationService, 'disarmCapture'>>)
    | undefined;
}

/**
 * Everything a start acquires that must be released again, filled in as the
 * start proceeds. One shutdown sequence ({@link releaseParts}) reads it, both
 * for {@link ServiceHandle.close} and for a start that fails part-way, so the
 * two paths cannot release in different orders.
 *
 * Each member is typed by what the sequence calls on it, which is also what
 * lets `main.test.ts` drive the sequence with stand-ins that hang or fail.
 */
export interface ServiceParts {
  store?: Pick<Store, 'close'>;
  auth?: Pick<AuthService, 'close' | 'revokeServerAgentCredentials'>;
  clients?: Pick<ClientRegistry, 'closeAll'>;
  ledger?: Pick<AgentReadyLedger, 'close'>;
  watcher?: Pick<InstrumentationWatcher, 'dispose'>;
  instrumentation?: Pick<InstrumentationService, 'dispose'>;
  cleanup?: Pick<SessionCleanup, 'dispose'>;
  correlator?: Pick<TraceCorrelator, 'close'>;
  liveTail?: Pick<LiveTail, 'flush' | 'close'>;
  launcher?: Pick<DevServerLauncher, 'dispose' | 'list'>;
  orchestrator?: Pick<PipelineOrchestrator, 'dispose'>;
  http?: Pick<HttpApp, 'close'>;
  ws?: Pick<WsServer, 'close'>;
  server?: Server;

  /**
   * The start-up retention sweep, set once the service listens. A stop aborts
   * it first and waits for it to settle before the store closes, so it never
   * meets a closed store part-way through a session.
   */
  retention?: Pick<StartupRetentionRun, 'abort' | 'settled'>;

  /**
   * Set only once the service is serving, so a start refused part-way — a
   * port already in use, say — never ends a session it did not serve.
   */
  liveSessions?: LiveSessionPorts;
}

/**
 * What {@link releaseParts} learned about the dev servers this service
 * launched, so the shutdown's final record never calls a stop clean that was
 * not:
 *
 * - `stopped` — none is left running (or none was launched);
 * - `running` — the launcher reported these pids still running after their
 *   termination ran to the end;
 * - `unconfirmed` — the dev-server step failed or was abandoned at its bound,
 *   so whether any is still running is unknown.
 */
export type DevServerRelease =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'running'; readonly pids: readonly number[] }
  | { readonly kind: 'unconfirmed' };

/** The {@link DevServerRelease} of a shutdown that left no launched dev server running. */
const DEV_SERVERS_STOPPED: DevServerRelease = Object.freeze({ kind: 'stopped' });

/** The repositories over the one store, built once and shared. */
interface Repositories {
  readonly sessions: SessionsRepo;
  readonly panels: PanelsRepo;
  readonly telemetry: TelemetryRepo;
  /** The journal, with the metadata-only read the ingest locator corroborates through. */
  readonly modifications: ModificationsRepo & ModificationCorroborationReader;
}

/* -------------------------------------------------------------------------------------------------
 * Failure reporting
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `msg` of the record a refused start writes. Constant, so the record can
 * never carry the failure's own text: it names the failure by its `step` and
 * `code` (see {@link errorFields}) instead.
 */
const STARTUP_REFUSED_MESSAGE = 'the Debug Generator service could not start';

/**
 * The start-up step a refused start names, in the order {@link startService}
 * runs them — the closed context that replaces the failure's message in the
 * record, so two failures with one code are still told apart.
 */
type StartupStep =
  | 'state-tree'
  | 'store'
  | 'access-boundary'
  | 'editor-credential'
  | 'server-agent-leases'
  | 'reconciliation'
  | 'state-home-overlap'
  | 'model-provider'
  | 'prompts'
  | 'session-hydration'
  | 'cleanup-settlement'
  | 'interrupted-sessions'
  | 'http'
  | 'websocket'
  | 'websocket-attach'
  | 'listen';

/**
 * What standard error says in place of a failure message that is text copied
 * from a wrapped exception (see `carriesWrappedExceptionText` in
 * `./sessions/progress.ts`).
 */
const STARTUP_FAILURE_FALLBACK_MESSAGE = 'The Debug Generator service could not start.';

/** The next step standard error names when the failure carried none of its own. */
const STARTUP_FAILURE_FALLBACK_HINT =
  'Check the DEBUGGEN_* settings and the service log, which names the start-up step that failed, then start the service again.';

/**
 * Wraps a caught value as the typed error a caller reports, keeping the original
 * reachable as `cause`. A specific code raised deeper survives; anything else
 * takes `fallbackCode`.
 *
 * The message and hint are the caller's fixed sentences. What the caught value
 * was enters `details` only as its closed `errorClass` / `errorCode` from
 * {@link describeException} — never its own message or name, which quote
 * whatever the failing call was handed (a path, an address, a statement) and
 * would reach whatever surface reads `details` (CWE-532). The log record
 * itself is written through {@link errorFields}, which copies neither the
 * hint nor the details into ordinary fields.
 *
 * @param cause The caught value.
 * @param fallbackCode The code to apply when `cause` carries none.
 * @param message A complete sentence naming what failed.
 * @param hint The developer's next step.
 * @param details Diagnostic context — paths, ports, subsystems; logged, so
 * nothing secret belongs in it.
 * @returns The error to return inside an `Err`.
 */
function wrapStartupFailure(
  cause: unknown,
  fallbackCode: 'FS_UNSAFE_PATH' | 'INTERNAL' | 'CONFIG_INVALID',
  message: string,
  hint: string,
  details: LogFields,
): DebuggenError {
  const normalized = DebuggenError.from(cause, fallbackCode);
  return new DebuggenError(normalized.code, message, {
    hint,
    details: { ...details, ...describeException(cause) },
    cause,
  });
}

/**
 * The loggable view of a failure: its code, the closed class and code of the
 * value it wraps (`causeClass`, `causeCode`), and the error itself under
 * {@link LOG_ERROR_FIELD_KEY}. The caller adds the `step` that met it.
 *
 * Never the message, the hint or the details as ordinary fields (CWE-532).
 * A failure reaching this file from a collaborator may have been built by
 * `DebuggenError.from`, which keeps a wrapped exception's message verbatim, and
 * a collaborator's `hint` and `details` are free text and free-form context it
 * composed — a path, a URL with its query, a statement — which the logger's
 * field walk only credential-scrubs, so at `error` they would reach a record
 * written to a file by default. Nothing here can tell that text from a sentence
 * the product wrote, so none of it is copied: the record names the failure by
 * its code and step, and the error travels under the error key, where the
 * service logger's error serializer — the one place that decides what an error
 * may contribute at each level — emits it.
 *
 * @example
 * ```ts
 * log.error(STARTUP_REFUSED_MESSAGE, { step: 'prompts', ...errorFields(error) });
 * // {"step":"prompts","code":"CONFIG_INVALID","err":{"type":"DebuggenError","code":"CONFIG_INVALID",…}}
 * ```
 */
function errorFields(error: DebuggenError): LogFields {
  const cause: unknown = error.cause;
  const described = cause === undefined ? undefined : describeException(cause);
  return {
    code: error.code,
    ...(described === undefined ? {} : { causeClass: described.errorClass }),
    ...(described?.errorCode === undefined ? {} : { causeCode: described.errorCode }),
    [LOG_ERROR_FIELD_KEY]: error,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Step 3 — the state tree
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates `$DEBUGGEN_HOME`, the backup root and the index cache, and verifies
 * that each is a private (`0700`) directory this account owns.
 *
 * The state root is established first and then declared as the boundary
 * (`upTo`) of the two below it, which turns the check from "the tail this call
 * created is private" into "every directory from the state root down is private
 * and none is a symbolic link" (AAP 0.5.6: this tree holds the session database,
 * the editor credential and the backups of a developer's patched files).
 *
 * A policy refusal of `@debuggen/shared/node` — one that carries a known
 * `details.reason` (see {@link unsafePathReasonOf}) — is reported with that
 * refusal's own sentences, which name the offending directory and the exact
 * fix: for `group-or-other-permissions`, its mode (`0755`), the required
 * `0700` and the `chmod 700 <dir>` that restores it, rather than a generic
 * checklist whose "permissions allow this account to write it" points the
 * other way. Those sentences are composed by that module from the path and the
 * mode alone, so they are product copy; the refusal stays reachable as
 * `cause`, and `details` keep the reason for the log. Anything else — an errno
 * from `mkdir` (`EACCES`, `ENOTDIR`, `ENOSPC`) — keeps the fixed wording below,
 * because the raised text is the platform's and may quote more than the path.
 *
 * @param config The resolved configuration, whose paths are already absolute.
 * @returns `Ok` when the tree is present and private, `Err` naming the path that
 * could not be established.
 */
function prepareStateTree(config: ServiceConfig): Result<void, DebuggenError> {
  try {
    ensureSecureDir(config.debuggenHome);
    ensureSecureDir(config.backupsDir, { upTo: config.debuggenHome });
    ensureSecureDir(config.indexCacheDir, { upTo: config.debuggenHome });
    return ok(undefined);
  } catch (cause) {
    const reason = unsafePathReasonOf(cause);
    if (reason !== undefined && DebuggenError.is(cause)) {
      const hint = cause.hint === undefined ? '' : `${cause.hint} `;
      return err(
        new DebuggenError(
          'FS_UNSAFE_PATH',
          `The Debug Generator state directory cannot be used: ${cause.message}`,
          {
            hint: `${hint}Alternatively, set DEBUGGEN_HOME to another location and start again.`,
            details: {
              subsystem: SUBSYSTEM_SERVICE,
              reason,
              debuggenHome: config.debuggenHome,
              backupsDir: config.backupsDir,
              indexCacheDir: config.indexCacheDir,
            },
            cause,
          },
        ),
      );
    }
    return err(
      wrapStartupFailure(
        cause,
        'FS_UNSAFE_PATH',
        'Could not prepare the Debug Generator state directory.',
        `Check that ${config.debuggenHome} is a directory you own, that no component of the path is a symbolic link, and that its permissions allow this account to write it; or set DEBUGGEN_HOME to another location and start again.`,
        {
          subsystem: SUBSYSTEM_SERVICE,
          debuggenHome: config.debuggenHome,
          backupsDir: config.backupsDir,
          indexCacheDir: config.indexCacheDir,
        },
      ),
    );
  }
}

/**
 * The state root as the filesystem resolves it — every symbolic link on the
 * way followed — taken once, right after {@link prepareStateTree} created it.
 *
 * Every overlap check of the running service compares a project root against
 * this one value (see "The state root stays outside every project" in
 * `./config.ts`): the start-up check of the stored sessions below, and the
 * checks the session and dev-server routes make before a session is created
 * or questioned and before a dev server is launched or credentialed.
 *
 * @param config The resolved configuration.
 * @returns The canonical state root, or an `FS_UNSAFE_PATH` refusal naming it.
 */
async function resolveCanonicalStateHome(
  config: ServiceConfig,
): Promise<Result<string, DebuggenError>> {
  const canonical = await canonicalizePath(config.debuggenHome);
  if (isErr(canonical)) {
    return err(
      new DebuggenError(
        'FS_UNSAFE_PATH',
        'Could not resolve the Debug Generator state directory to its location on disk.',
        {
          hint: `Check that ${config.debuggenHome} and every directory above it are readable by this account and that no symbolic link on the way loops; or set DEBUGGEN_HOME to another location and start again.`,
          details: { subsystem: SUBSYSTEM_SERVICE, debuggenHome: config.debuggenHome },
          cause: canonical.error,
        },
      ),
    );
  }
  return canonical;
}

/**
 * The message of a start refused because a stored session's project overlaps
 * the state root. Constant, and naming no path: it reaches standard error and
 * the VS Code output channel.
 */
const STATE_HOME_OVERLAP_STARTUP_MESSAGE =
  'The Debug Generator service did not start: the project of a stored session contains DEBUGGEN_HOME or lies inside it, so session data, file backups and the editor credential would sit in that project.';

/**
 * The message of a start refused because the project folder of a stored
 * session could not be resolved on disk, so it could not be shown to lie
 * apart from the state root. Constant, and naming no path, like
 * {@link STATE_HOME_OVERLAP_STARTUP_MESSAGE}.
 */
export const STORED_PROJECT_UNRESOLVABLE_STARTUP_MESSAGE =
  'The Debug Generator service did not start: the project folder of a stored session could not be resolved on disk, so it cannot be shown to lie outside DEBUGGEN_HOME.';

/**
 * The recovery instruction of that refusal. Either step ends it: a folder
 * this account can read again resolves on the next start, and a new state
 * directory holds no stored session to check.
 */
export const STORED_PROJECT_UNRESOLVABLE_STARTUP_HINT =
  'Restore this account’s access to the project folders of your earlier sessions — every folder above them must be searchable and no symbolic link on the way may loop — or set DEBUGGEN_HOME to a new state directory outside every project, then start the service again.';

/**
 * Refuses to serve when the state root overlaps the project of any stored
 * session, or when a stored project cannot be shown to lie apart from it:
 * session data and backups live outside every target project, so a session
 * never pollutes its git status (CWE-200).
 *
 * Run after the modification reconciliation, which must still restore every
 * file a previous process left instrumented, and before anything else writes
 * into the store. Every distinct stored project root is canonicalised through
 * `canonicalizePath` of `./config.ts` — a root that no longer exists through
 * its nearest existing ancestor, so a deleted project still resolves — and
 * compared with `canonicalStateHome`.
 *
 * Fails closed. A root that cannot be canonicalised at all — a folder above it
 * this account can no longer search, a symbolic-link loop — refuses the start:
 * two lexically disjoint spellings prove nothing about separation, because the
 * unresolved part may be a link into the state root. The refusal is constant
 * text naming no path and tells the developer how to recover (restore access,
 * or start over in a new state directory); its `details` carry counts only.
 * An overlap proven for another root is reported in its place, because it is
 * the definite finding.
 *
 * @param sessions The session index, read in pages of its largest size.
 * @param canonicalStateHome The state root as {@link resolveCanonicalStateHome} resolved it.
 * @returns `Ok`; or an `FS_UNSAFE_PATH` refusal — `details.reason`
 *   `state-home-overlaps-project` with the first relation met and how many
 *   stored projects overlap, or `project-root-unresolvable` with how many
 *   stored projects could not be resolved of how many were checked; or the
 *   store failure that prevented reading the index.
 */
async function refuseStoredProjectOverlap(
  sessions: Pick<SessionsRepo, 'list'>,
  canonicalStateHome: string,
): Promise<Result<void, DebuggenError>> {
  const roots = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = sessions.list({ limit: MAX_SESSION_LIST_LIMIT, offset });
    if (isErr(page)) {
      return page;
    }
    const { items, total } = page.value;
    for (const item of items) {
      roots.add(item.projectRoot);
    }
    offset += items.length;
    if (items.length === 0 || offset >= total) {
      break;
    }
  }

  let first: StateHomeOverlap | undefined;
  let overlapping = 0;
  let unresolved = 0;
  for (const root of roots) {
    const canonical = await canonicalizePath(root);
    if (isErr(canonical)) {
      unresolved += 1;
      continue;
    }
    const relation = stateHomeOverlap(canonicalStateHome, canonical.value);
    if (relation !== undefined) {
      overlapping += 1;
      first ??= relation;
    }
  }

  if (first !== undefined) {
    return err(
      new DebuggenError('FS_UNSAFE_PATH', STATE_HOME_OVERLAP_STARTUP_MESSAGE, {
        hint: STATE_HOME_OVERLAP_HINT,
        details: {
          subsystem: SUBSYSTEM_SERVICE,
          reason: STATE_HOME_OVERLAP_REASON,
          relation: first,
          overlappingProjects: overlapping,
        },
      }),
    );
  }
  if (unresolved > 0) {
    return err(
      new DebuggenError('FS_UNSAFE_PATH', STORED_PROJECT_UNRESOLVABLE_STARTUP_MESSAGE, {
        hint: STORED_PROJECT_UNRESOLVABLE_STARTUP_HINT,
        details: {
          subsystem: SUBSYSTEM_SERVICE,
          reason: PROJECT_ROOT_UNRESOLVABLE_REASON,
          unresolvedProjects: unresolved,
          storedProjects: roots.size,
        },
      }),
    );
  }
  return ok(undefined);
}

/* -------------------------------------------------------------------------------------------------
 * The effective configuration
 * ---------------------------------------------------------------------------------------------- */

/**
 * The configuration every subsystem is handed: the resolved one, except that
 * `port` reads the **bound** port once the socket is listening.
 *
 * Several subsystems need the port the service actually answers on, not the one
 * it was asked for: the dev-server launcher builds a launched child's ingest URL
 * from it, and dev-server detection excludes the service's own port when it
 * reads a child's "listening on" line. With a configured port those are the
 * same number; with `port: 0` (how a suite avoids collisions) only the bound
 * value is right. Each of those subsystems reads `config.port` when it acts,
 * never at construction, and none of them acts before the socket is bound — a
 * launch is itself an HTTP request — so a getter over the bound value gives
 * every one of them the right answer without constructing them after `listen`.
 *
 * @param config The resolved configuration.
 * @param boundPort The bound port, or `undefined` before `listen` completes.
 * @returns A frozen configuration whose `port` is live.
 */
function createEffectiveConfig(
  config: ServiceConfig,
  boundPort: () => number | undefined,
): ServiceConfig {
  const view: ServiceConfig = { ...config };
  Object.defineProperty(view, 'port', {
    enumerable: true,
    configurable: false,
    get: (): number => boundPort() ?? config.port,
  });
  return Object.freeze(view);
}

/**
 * The base URL of a bound socket. A bare IPv6 literal is bracketed, because
 * `DEBUGGEN_HOST=::1` is a supported configuration and `http://::1:43117` is not
 * a URL.
 */
function formatServiceUrl(host: string, port: number): string {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

/* -------------------------------------------------------------------------------------------------
 * Bounded waiting
 * ---------------------------------------------------------------------------------------------- */

/** A monotonic clock in milliseconds: what every shutdown deadline is measured on. */
function monotonicNow(): number {
  return performance.now();
}

/** How a bounded wait ended. */
type BoundedOutcome<T> =
  | { readonly kind: 'settled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly cause: unknown }
  | { readonly kind: 'timeout' };

/**
 * Starts `work` and waits for it for at most `timeoutMs`, never rejecting. A
 * synchronous throw from `work` is a rejection like any other. The timer is
 * cleared on settlement and `unref`'d, so the bound itself never keeps the event
 * loop alive; work that times out keeps running unobserved.
 */
async function raceWithin<T>(
  work: () => PromiseLike<T> | T,
  timeoutMs: number,
): Promise<BoundedOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedOutcome<T>>((resolve) => {
    timer = setTimeout(
      () => {
        resolve({ kind: 'timeout' });
      },
      Math.max(0, timeoutMs),
    );
    timer.unref();
  });

  let running: Promise<BoundedOutcome<T>>;
  try {
    running = Promise.resolve(work()).then(
      (value): BoundedOutcome<T> => ({ kind: 'settled', value }),
      (cause: unknown): BoundedOutcome<T> => ({ kind: 'rejected', cause }),
    );
  } catch (cause) {
    running = Promise.resolve({ kind: 'rejected', cause });
  }

  try {
    return await Promise.race([running, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Runs one awaited shutdown step for at most `timeoutMs`, never rejecting.
 *
 * A failure is logged and the sequence continues; a timeout is logged as the
 * step being abandoned (what "force-killed" means for a step this file does not
 * own — the launcher escalates its own children to `SIGKILL` inside its slice).
 *
 * @param work Starts the step.
 * @param timeoutMs The step's slice of the deadline.
 * @param step A short name for the log record.
 * @param logger Where the outcome is reported.
 * @returns How the step ended: `settled` within its slice, with the value the
 * step resolved — so a step that reports something (the dev-server launcher's
 * termination report) is read rather than discarded — `rejected`, or `timeout`
 * (abandoned). The last two have already been logged.
 */
async function settleWithin<T>(
  work: () => PromiseLike<T> | T,
  timeoutMs: number,
  step: string,
  logger: Logger,
): Promise<BoundedOutcome<T>> {
  const outcome = await raceWithin(work, timeoutMs);
  switch (outcome.kind) {
    case 'settled':
      break;
    case 'rejected':
      logger.error('a shutdown step failed; continuing with the next one', {
        step,
        ...describeException(outcome.cause),
      });
      break;
    case 'timeout':
      logger.warn('a shutdown step did not finish in time and was abandoned', {
        step,
        timeoutMs: Math.max(0, Math.round(timeoutMs)),
      });
      break;
  }
  return outcome;
}

/**
 * The one deadline of a shutdown: every awaited step is handed a slice of what
 * is left of it, never a bound of its own.
 */
interface ShutdownDeadline {
  /** What is left of the deadline, in milliseconds; never negative. */
  remainingMs(): number;

  /**
   * What the next step may spend: what is left, less `reserveMs` held back for
   * the steps after it, and no more than `capMs` when one is given. Never
   * negative — a step whose slice is zero is started and abandoned at once.
   */
  allowance(reserveMs: number, capMs?: number): number;
}

/** Starts a deadline `totalMs` from now on `clock`. */
function createShutdownDeadline(totalMs: number, clock: () => number): ShutdownDeadline {
  const dueAt = clock() + totalMs;
  const remainingMs = (): number => Math.max(0, dueAt - clock());
  return Object.freeze({
    remainingMs,
    allowance: (reserveMs: number, capMs?: number): number => {
      const available = Math.max(0, remainingMs() - reserveMs);
      return capMs === undefined ? available : Math.min(capMs, available);
    },
  });
}

/**
 * Runs one synchronous release step, logging rather than raising a failure, so
 * one broken collaborator cannot stop the rest of the sequence.
 */
function releaseQuietly(step: string, logger: Logger, release: () => unknown): void {
  try {
    release();
  } catch (cause) {
    logger.error('a shutdown step failed; continuing with the next one', {
      step,
      ...describeException(cause),
    });
  }
}

/**
 * Reads the dev-server step's report: every launched dev server the launcher
 * could not end — its credential already revoked, its exit never observed — is
 * named in one `error` record under the failed-step convention of this
 * section (`step: 'dev-servers'`), by count, pid and project root, the
 * launcher having logged each one's refused signals itself.
 *
 * @param report What `DevServerLauncher.dispose` resolved.
 * @param logger Where the survivors are reported.
 * @returns The pids still running; empty when every launched dev server stopped.
 */
function reportDevServerSurvivors(
  report: DevServerTerminationReport,
  logger: Logger,
): readonly number[] {
  const pids = report.survivors.map((survivor) => survivor.pid);
  if (pids.length > 0) {
    logger.error(DEV_SERVERS_SURVIVED_MESSAGE, {
      step: 'dev-servers',
      survivors: pids.length,
      pids,
      projectRoots: report.survivors.map((survivor) => survivor.projectRoot),
    });
  }
  return pids;
}

/**
 * The distinct project roots of the dev servers the launcher holds, read
 * before it is disposed — what {@link revokeLaunchedCredentials} needs should
 * the disposal not settle. A launcher that cannot list is logged and answers
 * none.
 */
function launchedProjectRoots(launcher: Pick<DevServerLauncher, 'list'>, logger: Logger): string[] {
  try {
    return [...new Set(launcher.list().map((server) => server.projectRoot))];
  } catch (cause) {
    logger.error('the launched dev servers could not be listed before stopping them', {
      ...describeException(cause),
    });
    return [];
  }
}

/**
 * The fallback of shutdown step 5: the launcher did not settle, so it may not
 * yet have revoked the scoped credential of a child it could not confirm
 * stopped — and a launched child's credential has no expiry of its own, it
 * lasts until revoked. Every server-agent credential of each such project is
 * therefore revoked here, before the store closes (AAP 0.5.6: the credential
 * ends with the launched process). Deliberately project-wide: a credential the
 * launcher cannot account for is not left valid across a restart. A process
 * that is in fact still running re-authenticates only through a new launch or
 * a new credential. Logged, never raised.
 */
function revokeLaunchedCredentials(
  auth: Pick<AuthService, 'revokeServerAgentCredentials'>,
  projectRoots: readonly string[],
  logger: Logger,
): void {
  for (const projectRoot of projectRoots) {
    try {
      const revoked = auth.revokeServerAgentCredentials(projectRoot);
      if (isErr(revoked)) {
        logger.error('the credentials of a launched dev server could not be revoked at shutdown', {
          projectRoot,
          code: revoked.error.code,
        });
      } else {
        logger.warn(
          'the launcher did not confirm its dev servers stopped; their server-agent credentials were revoked before the store closed',
          { projectRoot, revoked: revoked.value },
        );
      }
    } catch (cause) {
      logger.error('the credentials of a launched dev server could not be revoked at shutdown', {
        projectRoot,
        ...describeException(cause),
      });
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Composition adapters
 * ---------------------------------------------------------------------------------------------- */

/**
 * The relayed page-agent reports and the committed navigations, per DevTools
 * credential and tab: the one object that is the WebSocket router's
 * {@link AgentReadinessPort} (where a relayed `agent.ready` is written), the
 * binding route's {@link NavigationRecorder} (where every accepted
 * `tab.navigated` is written) and the readiness gate's
 * {@link BrowserAgentRegistry} (where both are read), so the report the gate
 * judges is exactly the report the router accepted, and a reload the route
 * accepted marks it as possibly left behind.
 *
 * **Whose evidence.** A Chrome tab id is unique only within one browser, so two
 * paired browsers inspect tabs whose ids collide. Every report and navigation
 * is therefore kept under the credential that relayed it — the connection
 * principal's `tokenHash`, the `boundBy` of that credential's binding — and
 * the tab id together (`heldTabKey`), and every read names a
 * {@link BoundTabRef}: the session's live binding supplies the holder, and a
 * session whose binding is absent or is another tab reads nothing. One
 * browser's report of its tab 7 never makes another browser's session bound
 * to *its* tab 7 ready (AAP §0.5.6, §0.7.1 Group 2). The credential digest is
 * a map key only: no log line carries it or the key.
 *
 * **A report's receipt time** is when its document was last confirmed as the
 * tab's current one. Readiness distrusts a report on sight when
 * `latestNavigationAt > latestAgentReadyAt`. A report of a new document
 * confirms it, and so does a repeat of the stored document with no
 * navigation recorded after its receipt. A replay of the stored document after
 * a later navigation — the Chrome side re-relays the report it retained for a
 * tab, which a navigation does not clear there — confirms nothing: its payload
 * is stored, but its receipt time stays the earlier one, so the navigation
 * still reads as after it.
 *
 * **Ordering within one millisecond.** The clock has whole milliseconds, so a
 * reload and the new document's report can share one tick. The ledger
 * therefore stamps a navigation strictly after the report it follows (the
 * report's receipt time plus one when the clock has not moved past it) and a
 * confirming report no earlier than the navigation it follows (the
 * navigation's stamp when that is ahead of the clock). Otherwise both carry
 * the clock's reading.
 *
 * **One lifetime per credential's tab.** A tab's report and its navigation,
 * under one credential, are one entry: a write of either makes the entry the
 * most recent, and beyond the size bound the least recently written entry is
 * forgotten whole. A report therefore never outlives the navigation recorded
 * after it — which would read as current — and a forgotten entry reads as a
 * tab no agent reported for, so readiness asks for a reload.
 */
export interface AgentReadyLedger
  extends AgentReadinessPort, BrowserAgentRegistry, NavigationRecorder {
  /**
   * Records a relayed report as the newest one of the tab it names under the
   * relaying connection's credential, with its receipt time as the ledger
   * overview describes, and wakes the waits it answers: those of a session
   * whose live binding is that credential's binding of that tab, for any
   * report or for a document other than the one it names — so a replay of the
   * known document answers none, and another browser's session bound to a tab
   * of the same id is never woken. Synchronous; refused with
   * `TRANSPORT_DISCONNECTED` after {@link AgentReadyLedger.close}.
   */
  agentReady(
    payload: AgentReadyPayload,
    client: WsConnectionFacts,
  ): Result<AgentReadyReceipt, DebuggenError>;

  /**
   * When the document of the report {@link BrowserAgentRegistry.latestAgentReady}
   * returns for `tab` was last confirmed current, in epoch milliseconds: its
   * receipt, or that of a later report of the same document no navigation
   * preceded. `undefined` when no report is remembered for the session's
   * binding of that tab.
   */
  latestAgentReadyAt(tab: BoundTabRef): number | undefined;

  /**
   * When the binding route last recorded a committed navigation of the
   * session's bound tab by its binding's credential, in epoch milliseconds;
   * `undefined` when none is remembered. Always after the receipt time of the
   * report that entry held when the navigation was recorded.
   */
  latestNavigationAt(tab: BoundTabRef): number | undefined;

  /**
   * Records a committed navigation of `tabId` by the credential `holder` (the
   * navigating connection's `tokenHash`), stamped as the ledger overview
   * describes, and notes it at `debug` by tab id alone — never the holder.
   * Synchronous; throws nothing of its own. A no-op after
   * {@link AgentReadyLedger.close}, for an empty holder and for a tab id that
   * is not a non-negative safe integer.
   */
  recordNavigation(holder: string, tabId: number): void;

  /** Resolves every pending wait with `undefined` and forgets every report and navigation. Idempotent. */
  close(): void;
}

/** What {@link AgentReadyLedger.agentReady} acknowledges: the tab and document recorded. */
export interface AgentReadyReceipt {
  readonly tabId: number;
  readonly documentId: string;
}

/** Collaborators of {@link createAgentReadyLedger}. */
export interface AgentReadyLedgerDeps {
  /**
   * Where accepted reports are noted at `debug`. Never receives a page URL or
   * a raw document id: the page-supplied `documentId` is logged only as its
   * `document` fingerprint and `documentIdCanonical` flag
   * (`./instrumentation/document-fingerprint.ts`).
   */
  readonly logger: Logger;
  /**
   * The live bindings — the client registry in production. A
   * {@link BoundTabRef}'s holder is the `boundBy` of its session's binding
   * when that binding is the named tab, read at every lookup and at every
   * wake, so a bind made after a wait started still lets the binding's own
   * browser answer it.
   */
  readonly bindings: Pick<ClientRegistry, 'bindingForSession'>;
  /** The clock a report and a navigation are stamped with, in epoch milliseconds. */
  readonly now?: (() => number) | undefined;
  /**
   * The most entries remembered — one per credential and tab —
   * {@link MAX_TRACKED_AGENT_TABS} by default (and for a value that is not a
   * positive safe integer). An entry's report and its navigation are one:
   * a write of either makes the entry the most recent, and beyond the bound
   * the least recently written entry is forgotten whole.
   */
  readonly maxTabs?: number | undefined;
}

/** One stored report and its receipt time. */
interface AgentReport {
  /** The newest payload relayed for the tab, a replay's included. */
  readonly payload: AgentReadyPayload;
  /**
   * When the payload's document was last confirmed as the tab's current one,
   * in epoch milliseconds (see "A report's receipt time" in
   * {@link AgentReadyLedger}): a replay after a later navigation keeps it.
   */
  readonly receivedAt: number;
}

/**
 * Everything the ledger knows about one credential's tab: its tab id, and at
 * least one of the other members. One entry, so a report and the navigation
 * that may have left it behind are remembered and forgotten together.
 */
interface TabEvidence {
  /**
   * The tab the entry is about. Kept in the entry because the map key carries
   * a credential digest and is never logged: log lines name this id alone.
   */
  readonly tabId: number;
  /** The tab's newest relayed report; absent until one arrives. */
  readonly report?: AgentReport;
  /**
   * When the binding route last recorded a committed navigation of the tab,
   * in epoch milliseconds; absent until one is recorded.
   */
  readonly navigatedAt?: number;
}

/** One pending {@link BrowserAgentRegistry.waitForAgentReady}. */
interface AgentWaiter {
  /** The session and tab awaited; its holder is resolved when a report arrives. */
  readonly tab: BoundTabRef;
  readonly afterDocumentId: string | undefined;
  readonly settle: (payload: AgentReadyPayload | undefined) => void;
}

/**
 * Creates the agent-readiness ledger.
 *
 * The ledger replaces a credential's tab's report on every accepted
 * `agent.ready`, so the newest document's facts are the only ones returned;
 * the WebSocket router calls it only after the relaying DevTools connection
 * has been authorized for the tab the report names. Every read and wait names
 * a {@link BoundTabRef} and is answered from the entry of the session's
 * binding credential for that tab — nothing when the session's live binding
 * is absent or is another tab — so one paired browser's report never answers
 * for another browser's session bound to a tab of the same id. A wait
 * resolves with the first such report whose document differs from the one the
 * caller already knows (or with any report when it knows none), with
 * `undefined` on its timeout, on abort and on {@link AgentReadyLedger.close};
 * it never rejects and never outlives its bound.
 *
 * It is also the binding route's {@link NavigationRecorder}: every
 * `tab.navigated` the route accepts is stamped here under the navigating
 * credential, and readiness reads the stamp back through
 * {@link BrowserAgentRegistry.latestNavigationAt}, which is how a reload or a
 * same-URL load marks the stored report as possibly left behind. A report's
 * receipt time is when its document was last confirmed current, so a replay of
 * that document after a later navigation confirms nothing and stays behind the
 * navigation; stamps are ordered within one millisecond; and an entry's report
 * and navigation share one eviction lifetime — each as the
 * {@link AgentReadyLedger} overview describes. A navigation logs the tab id
 * alone at `debug`, and so does forgetting an entry: no line carries a
 * credential digest or an entry key.
 *
 * @param deps The logger and the live bindings, and optionally a clock and a size bound.
 * @returns The ledger.
 *
 * @example
 * ```ts
 * const ledger = createAgentReadyLedger({ logger, bindings: clients });
 * // `clients` holds `connection`'s binding of payload.tabId to sessionId.
 * const tab = { sessionId, tabId: payload.tabId };
 * ledger.agentReady(payload, connection); // from the WebSocket router
 * ledger.latestAgentReady(tab); // → payload
 * ledger.latestAgentReady({ sessionId: otherBrowsersSession, tabId: payload.tabId }); // → undefined
 * ledger.recordNavigation(connection.principal.tokenHash, payload.tabId); // the binding route: a reload
 * ledger.latestNavigationAt(tab); // → later than latestAgentReadyAt(tab)
 * ledger.agentReady(payload, connection); // the old document replayed: confirms nothing
 * ledger.latestNavigationAt(tab); // → still later than latestAgentReadyAt(tab)
 * ```
 */
export function createAgentReadyLedger(deps: AgentReadyLedgerDeps): AgentReadyLedger {
  const log = subsystemLogger(deps.logger, SUBSYSTEM_READINESS);
  const { bindings } = deps;
  const now = deps.now ?? nowEpochMs;
  const requestedMax = deps.maxTabs ?? MAX_TRACKED_AGENT_TABS;
  const maxTabs =
    Number.isSafeInteger(requestedMax) && requestedMax > 0 ? requestedMax : MAX_TRACKED_AGENT_TABS;
  /**
   * Each credential's tab's report and navigation, in one entry, by
   * `heldTabKey(holder, tabId)`. Insertion order is recency order: every
   * write deletes and re-inserts its entry. The keys carry credential digests
   * and are never logged.
   */
  const evidence = new Map<string, TabEvidence>();
  /** Pending waits by the tab id they await; each resolves its holder on wake. */
  const waiters = new Map<number, Set<AgentWaiter>>();
  let closed = false;

  /**
   * The credential whose evidence answers for `tab`: the `boundBy` of the
   * session's live binding when that binding is the named tab, else
   * `undefined` — the session has no evidence for that tab. A lookup that
   * throws answers `undefined` too, noted at `debug` by the tab id alone, so
   * a faulty registry can withhold evidence but never lend another's.
   */
  function holderOf(tab: BoundTabRef): string | undefined {
    try {
      const binding = bindings.bindingForSession(tab.sessionId);
      return binding !== undefined && binding.tabId === tab.tabId ? binding.boundBy : undefined;
    } catch (cause) {
      log.debug('the binding of a session could not be read; its tab reads as unreported', {
        tabId: tab.tabId,
        errorName: cause instanceof Error ? cause.name : typeof cause,
      });
      return undefined;
    }
  }

  /** The entry that answers for `tab`, or `undefined` when its session has none. */
  function evidenceOf(tab: BoundTabRef): TabEvidence | undefined {
    const holder = holderOf(tab);
    return holder === undefined ? undefined : evidence.get(heldTabKey(holder, tab.tabId));
  }

  /**
   * Stores a credential's tab's merged evidence as the most recently written
   * entry, then forgets whole entries, least recently written first, beyond
   * the bound — so a report never outlives the navigation recorded after it,
   * nor the reverse.
   */
  function remember(key: string, entry: TabEvidence): void {
    evidence.delete(key);
    evidence.set(key, entry);
    while (evidence.size > maxTabs) {
      const oldest = evidence.entries().next();
      if (oldest.done === true) {
        break;
      }
      const [oldestKey, forgotten] = oldest.value;
      evidence.delete(oldestKey);
      // Readiness now finds no report for that tab and asks for a reload.
      // The entry's own tab id, never its key: that carries a credential digest.
      log.debug('forgot the readiness evidence of the least recently written tab', {
        tabId: forgotten.tabId,
      });
    }
  }

  /** Whether a report answers a wait: a different document, or any when none is known. */
  function answers(afterDocumentId: string | undefined, payload: AgentReadyPayload): boolean {
    return afterDocumentId === undefined || payload.documentId !== afterDocumentId;
  }

  function agentReady(
    payload: AgentReadyPayload,
    client: WsConnectionFacts,
  ): Result<AgentReadyReceipt, DebuggenError> {
    if (closed) {
      return err(
        new DebuggenError(
          'TRANSPORT_DISCONNECTED',
          'The Debug Generator service is shutting down and records no further page-agent reports.',
          { details: { reason: 'service-closing' } },
        ),
      );
    }
    const clockNow = now();
    // The relaying credential's own entry for the tab: another paired
    // browser's tab of the same id is another entry, never read or written here.
    const holder = client.principal.tokenHash;
    const key = heldTabKey(holder, payload.tabId);
    const known = evidence.get(key);
    const stored = known?.report;
    const navigatedAt = known?.navigatedAt;
    // A replay: the document the tab already reported, relayed again after a
    // navigation was recorded past that report. The Chrome side re-relays the
    // report it retained for a tab, which a navigation does not clear there,
    // and the navigation may have replaced that document — so the frame
    // confirms nothing. Its payload is stored, but it keeps the earlier
    // receipt and is never lent the navigation's stamp: readiness still sees
    // the navigation after it and does not trust it on sight.
    const replayAfterNavigation =
      stored !== undefined &&
      stored.payload.documentId === payload.documentId &&
      navigatedAt !== undefined &&
      navigatedAt > stored.receivedAt;
    // Anything else — another document, or the same one with no navigation
    // after its receipt — confirms its document now, and is never stamped
    // before the navigation it follows: a navigation recorded ahead of the
    // clock (see recordNavigation) lends the report its stamp, so readiness
    // never reads it as left behind by that navigation.
    let receivedAt = clockNow;
    if (replayAfterNavigation) {
      receivedAt = stored.receivedAt;
    } else if (navigatedAt !== undefined && navigatedAt > clockNow) {
      receivedAt = navigatedAt;
    }
    remember(key, { ...known, tabId: payload.tabId, report: { payload, receivedAt } });
    // The id is page-controlled text: the ledger keeps it for matching, the
    // log line carries only its fingerprint and shape flag (CWE-532). The
    // credential is named by the connection id alone, never by its digest.
    log.debug('recorded a page-agent readiness report', {
      tabId: payload.tabId,
      ...documentLogFields(payload.documentId),
      reactDetected: payload.reactDetected,
      installedBeforeReact: payload.installedBeforeReact,
      replayAfterNavigation,
      clientId: client.id,
    });
    const pending = waiters.get(payload.tabId);
    if (pending !== undefined) {
      for (const waiter of [...pending]) {
        // Resolved now, not when the wait began: a session bound after its
        // wait started is still woken by its own binding's browser, and one
        // whose tab of this id another browser reports is not woken at all.
        if (holderOf(waiter.tab) === holder && answers(waiter.afterDocumentId, payload)) {
          waiter.settle(payload);
        }
      }
    }
    return ok({ tabId: payload.tabId, documentId: payload.documentId });
  }

  function waitForAgentReady(
    tab: BoundTabRef,
    options: WaitForAgentReadyOptions,
  ): Promise<AgentReadyPayload | undefined> {
    const current = evidenceOf(tab)?.report?.payload;
    if (current !== undefined && answers(options.afterDocumentId, current)) {
      return Promise.resolve(current);
    }
    if (closed || options.signal?.aborted === true) {
      return Promise.resolve(undefined);
    }

    const requested = options.timeoutMs ?? MAX_RELOAD_WAIT_MS;
    const timeoutMs = Math.min(Math.max(0, requested), MAX_RELOAD_WAIT_MS);
    const { tabId } = tab;

    return new Promise((resolve) => {
      const signal = options.signal;
      const owner = waiters.get(tabId) ?? new Set<AgentWaiter>();
      waiters.set(tabId, owner);

      // Both callbacks run on a later tick, by which time `waiter` exists.
      const onAbort = (): void => {
        waiter.settle(undefined);
      };
      const timer = setTimeout(() => {
        waiter.settle(undefined);
      }, timeoutMs);
      timer.unref();

      const waiter: AgentWaiter = {
        tab: { sessionId: tab.sessionId, tabId },
        afterDocumentId: options.afterDocumentId,
        settle: (payload) => {
          if (!owner.delete(waiter)) {
            return;
          }
          if (owner.size === 0 && waiters.get(tabId) === owner) {
            waiters.delete(tabId);
          }
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(payload);
        },
      };

      owner.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function recordNavigation(holder: string, tabId: number): void {
    if (
      closed ||
      typeof holder !== 'string' ||
      holder.length === 0 ||
      !Number.isSafeInteger(tabId) ||
      tabId < 0
    ) {
      return;
    }
    // Strictly after the report it follows: when the clock has not moved past
    // the report's receipt (one millisecond, or a clock stepped back), the
    // navigation is stamped one past it, so readiness's `navigatedAt >
    // observedAt` holds and the report is not trusted on sight. Only the
    // navigating credential's entry is touched: another browser's report of a
    // tab with the same id is not made to look left behind.
    const clockNow = now();
    const key = heldTabKey(holder, tabId);
    const known = evidence.get(key);
    const reportedAt = known?.report?.receivedAt;
    const navigatedAt =
      reportedAt !== undefined && reportedAt >= clockNow ? reportedAt + 1 : clockNow;
    remember(key, { ...known, tabId, navigatedAt });
    // The tab id alone: the navigated URL is page-shaped text and never reaches
    // the ledger (CWE-532), and the holder is a credential digest.
    log.debug('recorded a committed navigation of a tab', { tabId });
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    for (const set of [...waiters.values()]) {
      for (const waiter of [...set]) {
        waiter.settle(undefined);
      }
    }
    waiters.clear();
    evidence.clear();
  }

  return Object.freeze({
    agentReady,
    latestAgentReady: (tab: BoundTabRef): AgentReadyPayload | undefined =>
      evidenceOf(tab)?.report?.payload,
    latestAgentReadyAt: (tab: BoundTabRef): number | undefined =>
      evidenceOf(tab)?.report?.receivedAt,
    latestNavigationAt: (tab: BoundTabRef): number | undefined => evidenceOf(tab)?.navigatedAt,
    recordNavigation,
    waitForAgentReady,
    close,
  });
}

/**
 * The readiness gate's view of the connected dev-server preloads, over the
 * client registry: a project has a server agent while at least one of its
 * `server-agent` connections is online, and the registry's snapshot of the
 * most recent one carries the heartbeat (`lastSeenAt`) the preload-bound
 * adapters measure staleness against.
 */
function serverAgentPresenceOf(clients: ClientRegistry): ServerAgentReadinessSource {
  return Object.freeze({
    hasServerAgentForProject: (projectRoot: string): boolean =>
      clients.serverAgentsForProject(projectRoot).some((client) => client.online),
    serverAgentForProject: (projectRoot: string) => clients.serverAgentForProject(projectRoot),
  });
}

/**
 * The launcher's view of the connected preloads, over the client registry:
 * whether an online `server-agent` connection authenticated with a given
 * credential digest. The launcher matches it against its children's own
 * credentials, so preload evidence is about one process — never the project.
 * Exported for its tests.
 */
export function serverAgentConnectionsOf(clients: ClientRegistry): ServerAgentConnections {
  return Object.freeze({
    isCredentialConnected: (tokenHash: string): boolean =>
      clients
        .list({ kind: 'server-agent', online: true })
        .some((client) => client.principal.tokenHash === tokenHash),
  });
}

/**
 * The readiness gate's preload evidence for one session's dev-server address:
 * {@link addressedServerAgentPresence} over the client registry — a connection
 * the launcher places at another address of the project is no evidence for
 * this one.
 */
function serverAgentsAt(
  clients: ClientRegistry,
  launcher: Pick<DevServerLauncher, 'addressOfCredential'>,
  devServerUrl: string | undefined,
): ServerAgentReadinessSource {
  return addressedServerAgentPresence(clients, launcher, devServerUrl);
}

/**
 * The access boundary's connection revoker, over the client registry:
 * rotation closes every socket (`revokeAll`), and revoking one credential
 * closes exactly the connections authenticated with it (`closeCredential`) —
 * a revoked dev server's socket, never another credential's of the same
 * project. Exported for its tests.
 */
export function connectionRevokerOf(clients: ClientRegistry): ConnectionRevoker {
  return Object.freeze({
    revokeAll: (code: number, reason?: string) => clients.revokeAll(code, reason),
    closeCredential: (tokenHash: string, code: number, reason?: string): number => {
      let closed = 0;
      for (const client of clients.list()) {
        if (client.principal.tokenHash !== tokenHash) {
          continue;
        }
        try {
          client.socket.close(code, reason);
          closed += 1;
        } catch {
          // A socket that cannot be closed is gone already; the registry forgets it below.
        }
        clients.unregister(client.id);
      }
      return closed;
    },
  });
}

/**
 * The delivery port `source.open` forwards through: the session's clients of
 * one kind, over the client registry.
 *
 * The registry routes a session's fan-out to an editor by the session's project
 * root, which it learns from the first session record it carries. A location
 * clicked in a panel reopened from storage can arrive before any record has
 * been sent in this process, so the project is taught from the store first.
 */
function sourceOpenDeliveryOf(
  clients: ClientRegistry,
  sessions: Pick<SessionsRepo, 'get'>,
  logger: Logger,
): SourceOpenClientPort {
  return Object.freeze({
    sendToSessionClients(
      sessionId: SessionId,
      clientKind: ClientKind,
      message: ProtocolMessage,
    ): number {
      if (clients.projectForSession(sessionId) === undefined) {
        const record = sessions.get(sessionId);
        if (isErr(record)) {
          logger.warn('could not read the session a source location belongs to', {
            sessionId,
            code: record.error.code,
          });
        } else if (record.value !== undefined) {
          const tracked = clients.trackSession(sessionId, record.value.projectRoot);
          if (isErr(tracked)) {
            logger.warn('could not route a source location to the session’s editors', {
              sessionId,
              code: tracked.error.code,
            });
          }
        }
      }
      return clients.broadcastToKinds(sessionId, [clientKind], message);
    },
  });
}

/**
 * Where a `target.selected` goes: the session record's current target, which
 * the first pipeline stage reads. The WebSocket router has already proved the
 * sender holds the session's tab binding.
 *
 * The descriptor is redacted before the record sees it (AAP §0.5.2): its URL's
 * query values become `?` per key and its text, selector, tag and component
 * names are pattern-scrubbed, so neither the store nor the `session.updated`
 * broadcast ever holds what the page rendered raw.
 */
function targetSelectionOf(manager: SessionManager): TargetSelectionPort {
  return Object.freeze({
    selected: (sessionId: SessionId, target: SelectedTarget) =>
      manager.patch(sessionId, { target: redactSelectedTarget(target) }),
  });
}

/**
 * Where the conflict watcher's {@link ModificationConflictListener} goes: the
 * session manager's `recordModificationConflict`, which rewrites the session
 * record's mirrored modification and broadcasts `session.updated` — so the
 * record-driven views of both user interfaces (the editor's modification
 * badge, the DevTools session summary) show `conflict` as soon as the
 * watcher's progress row does (AAP §0.5.1), not at the session's next change.
 *
 * Late-bound: the watcher is created before the manager (the manager needs
 * the cleanup runner, which needs the watcher), so the listener reads
 * `managerRef.current` on each call. A conflict reported before the manager
 * exists — nothing is watched before `listen`, so none is expected — is
 * logged and dropped: the journal and the persisted progress row already
 * hold it, and the record catches up at its next write through the store's
 * overlay. A refusal from the manager is logged the same way. Log records
 * carry the session id, the record id and the error code only, never a
 * path or the conflict's diff (AAP §0.5.2). A rejection is left to the
 * watcher, which catches and logs every listener failure.
 *
 * @param managerRef The cell `startService` fills once the manager exists.
 * @param logger Where a dropped or refused reflection is reported.
 * @returns The listener handed to `createInstrumentationWatcher`.
 *
 * @example
 * ```ts
 * const managerRef: { current?: SessionManager } = {};
 * const watcher = createInstrumentationWatcher({
 *   modifications,
 *   listener: conflictReflectingListener(managerRef, loggers.service),
 *   config,
 * });
 * // … the cleanup runner, then:
 * managerRef.current = createSessionManager({ … });
 * ```
 */
export function conflictReflectingListener(
  managerRef: {
    readonly current?: Pick<SessionManager, 'recordModificationConflict'> | undefined;
  },
  logger: Logger,
): ModificationConflictListener {
  return Object.freeze({
    async onModificationConflict({
      sessionId,
      record,
    }: Parameters<ModificationConflictListener['onModificationConflict']>[0]): Promise<void> {
      const manager = managerRef.current;
      if (manager === undefined) {
        logger.warn(
          'a modification conflict arrived before the session manager was ready; the session shows it at its next change',
          { sessionId, recordId: record.id },
        );
        return;
      }
      const reflected = await manager.recordModificationConflict(sessionId, record);
      if (isErr(reflected)) {
        logger.warn(
          'a modification conflict could not be reflected in its session; the journal still records it',
          { sessionId, recordId: record.id, code: reflected.error.code },
        );
      }
    },
  });
}

/** The code-analysis handles the instrumentation context is built from, in its field names. */
function toInstrumentationHandles(handles: PipelineCodeHandles): CodeAnalysisHandles {
  return {
    graph: handles.graph,
    queries: handles.queries,
    routeMap: handles.routeMap,
    summary: handles.projectSummary,
    project: handles.loaded,
  };
}

/** Collaborators of {@link createIngestSourceLocator}. */
export interface IngestSourceLocatorDeps {
  /** Where a batch's session — its project root and dev-server URL — is read. */
  readonly sessions: Pick<SessionsRepo, 'get'>;
  /** The code index shared with the pipeline, so a project is indexed once. */
  readonly codeIndex: Pick<CodeIndexPort, 'load'>;
  /**
   * The modification journal the patch route corroborates a stamp against —
   * in production its metadata-only `listCorroborationsBySession`, which never
   * loads a diff, and `listPatchEvidenceBySessionFile`, which loads the diffs
   * of one file the metadata found in force, to prove the stamp's exact
   * position and symbol. Read through a per-capture cache (see
   * {@link createIngestSourceLocator}).
   */
  readonly modifications: ModificationCorroborationPort;
  /** The stored spans a database query's enclosing function is found through. */
  readonly events: ParentEventPort;
  /** The service's root logger. */
  readonly logger: Logger;
  /** The clock the cross-batch caches expire entries on; defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
}

/**
 * The source-location port of telemetry ingest (its step 7½): each batch is
 * resolved by `./source/resolve.ts` over the batch's own session — its project
 * root, its code index, the modification journal, the stored parent spans and
 * its dev-server URL, which pins where the source-map route may fetch a chunk's
 * map from (AAP §0.4.2, "Source resolution path").
 *
 * A resolver is built per batch over what outlives the batch. Source maps come
 * from one {@link createSourceMapScopes} registry held by this port: a batch
 * uses the scope of its dev-server URL, its capture and the one page document
 * (`producerId`, minted per document — AAP §0.2.3) its browser events came
 * from, and takes that scope's lookup for one batch
 * (the scope's `forBatch`). A batch reads each chunk its events point
 * into once; the batches of one document in one capture share the parsed maps,
 * so a map is fetched and parsed once per build of its chunk rather than once
 * per batch. A batch with no browser event (a dev-server preload's spans, which
 * no source map describes), or whose browser events came from more than one
 * document, uses no shared scope and resolves through a cache of its own.
 *
 * A rebuilt chunk is never mapped through its old map, however it was rebuilt —
 * by the product's own patch between captures or by a developer's edit applied
 * by hot module replacement during one: the scope keeps a parsed map with the
 * digest of the chunk it was read for, and the batch's own read of the chunk
 * decides whether it still applies (see {@link createSourceMapScopes}). Idle
 * expiry and the registry's bound release the maps of documents and captures
 * that are gone.
 *
 * The code index is the pipeline's, normally loaded already by the session's
 * own stages; a load that is still running is shared rather than started again
 * for every batch of a burst. An index that cannot be loaded leaves the routes
 * that need none — patch metadata and the source map — to answer on their own.
 *
 * The patch route's journal reads go through one {@link createCorroborationCache}
 * held by this port and keyed by the batch's `(session, capture)`, so the
 * batches of one capture window share one metadata-only read (file, status and
 * applied time — never a diff) instead of making one each.
 *
 * Ingest hands each call its locate budget as `options.signal`, and it is
 * honoured as a budget rather than a cancellation: it is forwarded to
 * `resolveEvents` as `budget`, which stops starting events when it fires and
 * answers with the locations found by then, and the wait for a still-loading
 * code index is raced against it. When the budget fires before the index has
 * loaded, the call answers with no locations at once — the batch is stored
 * without them — while the shared load runs on for the batches after it.
 *
 * @param deps The session store, code index, journal, telemetry store and logger.
 * @returns The port handed to `createTelemetryIngest`.
 */
export function createIngestSourceLocator(deps: IngestSourceLocatorDeps): IngestSourceLocator {
  const loading = new Map<string, Promise<Result<PipelineCodeHandles, DebuggenError>>>();
  const corroborations = createCorroborationCache({
    journal: deps.modifications,
    now: deps.now,
  });
  const sourceMaps = createSourceMapScopes({ now: deps.now });

  const codeFor = (projectRoot: string): Promise<Result<PipelineCodeHandles, DebuggenError>> => {
    const inFlight = loading.get(projectRoot);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const started = deps.codeIndex.load(projectRoot).finally(() => {
      loading.delete(projectRoot);
    });
    loading.set(projectRoot, started);
    return started;
  };

  return Object.freeze({
    locate: async (events, attribution, options) => {
      const budget = options?.signal;
      const session = deps.sessions.get(attribution.sessionId);
      if (!session.ok) {
        return session;
      }
      const record = session.value;
      if (record === undefined) {
        return ok(new Map());
      }
      const loaded = await withinBudget(codeFor(record.projectRoot), budget);
      if (loaded.kind === 'expired') {
        // The budget expired while the index was still loading: nothing could
        // be started in time, so the batch is stored without locations. The
        // shared load keeps running, and a later batch finds it ready.
        return ok(new Map());
      }
      const code = loaded.value;
      const handles = code.ok ? code.value : undefined;
      // One page document's batches within one capture share a scope; see the
      // notes above. Only a browser event can take the source-map route, so a
      // batch without one (a dev-server preload's spans) is resolved without a
      // shared scope and never takes a slot a page document's maps would
      // otherwise keep; nor is a batch whose browser events span two documents,
      // which may run different builds of the same chunk.
      const document = soleBrowserDocument(events);
      const sourceMap =
        document === undefined
          ? undefined
          : sourceMaps.scopeFor(
              `${record.devServerUrl}\u0000${attribution.captureId}\u0000${document}`,
            );
      const resolver = createSourceResolver({
        projectRoot: record.projectRoot,
        queries: handles?.queries,
        routeMap: handles?.routeMap,
        graph: handles?.graph,
        modifications: corroborations.forCapture(attribution.captureId),
        events: deps.events,
        devServerOrigin: record.devServerUrl,
        sourceMapLookup: sourceMap?.forBatch(),
        logger: deps.logger,
      });
      return resolver.resolveEvents(events, budget === undefined ? undefined : { budget });
    },
  } satisfies IngestSourceLocator);
}

/**
 * The page document a batch's browser events all came from: their shared
 * `producerId`, or `undefined` when the batch has no browser event or its
 * browser events came from more than one document (a relayed buffer that
 * straddles a reload), neither of which may take a shared source-map scope.
 */
function soleBrowserDocument(events: readonly AttributedEvent[]): string | undefined {
  let document: string | undefined;
  for (const event of events) {
    if (event.tier !== BROWSER_TIER) {
      continue;
    }
    if (document === undefined) {
      document = event.producerId;
    } else if (event.producerId !== document) {
      return undefined;
    }
  }
  return document;
}

/** What {@link withinBudget} observed: the promise settled first, or the budget fired first. */
type BudgetedWait<T> =
  { readonly kind: 'settled'; readonly value: T } | { readonly kind: 'expired' };

/**
 * Awaits `pending` unless `budget` fires first.
 *
 * Only this caller stops waiting: the promise is a load other batches may be
 * sharing, so it is neither cancelled nor dropped, and its settlement is still
 * observed. A rejection is passed on exactly as awaiting `pending` directly
 * would pass it on.
 *
 * @param pending The load to wait for.
 * @param budget The caller's budget, if it has one.
 * @returns `settled` with the value, or `expired` when the budget fired first
 * (including when it had fired already).
 */
function withinBudget<T>(
  pending: Promise<T>,
  budget: AbortSignal | undefined,
): Promise<BudgetedWait<T>> {
  const settled = pending.then((value): BudgetedWait<T> => ({ kind: 'settled', value }));
  if (budget === undefined) {
    return settled;
  }
  if (budget.aborted) {
    // Observed, so a later rejection of the shared load is never unhandled here.
    settled.catch(() => undefined);
    return Promise.resolve({ kind: 'expired' });
  }
  return new Promise<BudgetedWait<T>>((resolve, reject) => {
    const onBudget = (): void => {
      resolve({ kind: 'expired' });
    };
    budget.addEventListener('abort', onBudget, { once: true });
    settled.then(
      (outcome) => {
        budget.removeEventListener('abort', onBudget);
        resolve(outcome);
      },
      (cause: unknown) => {
        budget.removeEventListener('abort', onBudget);
        reject(cause instanceof Error ? cause : new Error('The code index load failed.'));
      },
    );
  });
}

/** Collaborators of {@link createCaptureReadinessSource}. */
interface CaptureReadinessDeps {
  readonly sessions: Pick<SessionsRepo, 'get'>;
  readonly instrumentation: Pick<InstrumentationService, 'buildContext'>;
  readonly codeIndex: CodeIndexPort;
  readonly adapters: AdapterRegistry;
  readonly progress: SessionProgress;
  readonly observe: Omit<CollectObservedReadinessDeps, 'logger' | 'now'>;
  /**
   * The preload evidence for a session's dev-server address, replacing
   * `observe.serverAgents` for that session (see {@link serverAgentsAt}).
   */
  readonly serverAgentsAt?:
    ((devServerUrl: string | undefined) => ServerAgentReadinessSource) | undefined;
  readonly logger: Logger;
  readonly now?: (() => number) | undefined;
}

/**
 * The capture stage's readiness re-evaluation (`CaptureReadinessSource`).
 *
 * The install evaluates readiness once; a page reloaded, a tab bound or a
 * preload connected after that is only seen if the verdict is taken again when
 * a capture starts, which is what moves an `instrumenting` session to `ready`.
 * This composes the same three steps the install uses — the observed evidence
 * (`collectReadinessEvidence`), the adapter context
 * (`InstrumentationService.buildContext` over the project's code handles, from
 * the same code-index loader the pipeline uses) and the verdict
 * (`evaluateReadiness`) — with a reload-prompt ledger of its own, so a document
 * is asked to reload at most once by this path.
 */
function createCaptureReadinessSource(deps: CaptureReadinessDeps): CaptureReadinessSource {
  const reloadPrompts = new Set<string>();

  async function evaluate(
    request: CaptureReadinessRequest,
  ): Promise<Result<ReadinessVerdict, DebuggenError>> {
    const session = deps.sessions.get(request.sessionId);
    if (isErr(session)) {
      return session;
    }
    const recordedUrl = session.value?.devServerUrl;
    const devServerUrl =
      recordedUrl === undefined || recordedUrl.length === 0 ? undefined : recordedUrl;

    const evidence = await collectReadinessEvidence(
      {
        ...deps.observe,
        ...(deps.serverAgentsAt === undefined
          ? {}
          : { serverAgents: deps.serverAgentsAt(devServerUrl) }),
        logger: deps.logger,
        now: deps.now,
      },
      {
        sessionId: request.sessionId,
        projectRoot: request.projectRoot,
        boundTab: request.boundTab,
        plan: request.plan,
        devServerUrl,
        signal: request.signal,
      },
    );
    if (isErr(evidence)) {
      return evidence;
    }

    const code = await deps.codeIndex.load(request.projectRoot, { signal: request.signal });
    if (isErr(code)) {
      return code;
    }

    const context = deps.instrumentation.buildContext({
      sessionId: request.sessionId,
      projectRoot: request.projectRoot,
      plan: request.plan,
      code: toInstrumentationHandles(code.value),
      readiness: evidence.value.observed,
      signal: request.signal,
    });
    if (isErr(context)) {
      return context;
    }

    return evaluateReadiness(
      {
        adapters: deps.adapters,
        agents: deps.observe.agents,
        progress: deps.progress,
        logger: deps.logger,
        now: deps.now,
        reloadPrompts,
      },
      {
        context: context.value,
        plan: request.plan,
        boundTab: request.boundTab,
        devServer: evidence.value.devServer,
        allowReloadPrompt: request.allowReloadPrompt,
        requireServerAgent: request.requireServerAgent,
        signal: request.signal,
      },
    );
  }

  return Object.freeze({ evaluateReadiness: evaluate });
}

/**
 * The readiness port the WebSocket router relays `agent.ready` to: the ledger
 * records the report, then the session bound to the reporting tab is re-gated.
 *
 * A session's install often runs before its tab is bound (the panel binds after
 * the editor created the session) or before the page it will capture has
 * reloaded, so the install's verdict cannot be the last word. The service
 * worker re-relays the tab's latest report on every new binding and every
 * document sends one when it loads, so re-gating on each report is what moves
 * the session to "Ready to capture" — or asks for the one reload a late hook
 * needs — as soon as the page can actually be observed. The report's own answer
 * is returned unchanged; the re-gate never delays or fails it.
 *
 * @param ledger The ledger that records the report.
 * @param bindings Where the reporting tab's binding is looked up.
 * @param pipeline The orchestrator that re-gates the bound session.
 * @param logger The service's root logger.
 * @returns The port handed to the WebSocket router.
 */
export function regatingReadinessPort(
  ledger: AgentReadinessPort,
  bindings: Pick<ClientRegistry, 'bindingForTab'>,
  pipeline: Pick<PipelineOrchestrator, 'regate'>,
  logger: Logger,
): AgentReadinessPort {
  const log = subsystemLogger(logger, SUBSYSTEM_READINESS);
  return Object.freeze({
    agentReady: async (payload: AgentReadyPayload, client: WsConnectionFacts) => {
      const recorded = await ledger.agentReady(payload, client);
      const binding = recorded.ok
        ? bindings.bindingForTab(payload.tabId, client.principal)
        : undefined;
      if (binding !== undefined) {
        void pipeline.regate({ sessionId: binding.sessionId }).then((outcome) => {
          if (!outcome.ok) {
            log.debug('the bound session was not re-gated after a page-agent report', {
              sessionId: binding.sessionId,
              tabId: payload.tabId,
              code: outcome.error.code,
            });
          }
        });
      }
      return recorded;
    },
  } satisfies AgentReadinessPort);
}

/**
 * The binding routes the WebSocket router dispatches to, with one addition:
 * the session a tab was just bound to is re-gated.
 *
 * A session's install usually runs before the panel binds its tab, so the
 * install's verdict can only ask for a binding. A page that carries an agent
 * reports it and is re-gated by {@link regatingReadinessPort}, but a page that
 * was open before the extension was enabled carries none and never reports, so
 * the report alone would leave the session in `instrumenting` without ever
 * asking for the one reload that recovers it. Re-gating on the bind is what
 * surfaces that request (or admits a tab whose report is already on file). The
 * bind's own answer is returned unchanged; the re-gate never delays or fails it.
 * The other two routes are delegated explicitly, so a route added to
 * {@link BindingRoutes} is a compile error here rather than a missing member.
 *
 * @param binding The binding routes that do the work.
 * @param pipeline The orchestrator that re-gates the bound session.
 * @param logger The service's root logger.
 * @returns The routes handed to the WebSocket router.
 */
export function regatingBindingRoutes(
  binding: BindingRoutes,
  pipeline: Pick<PipelineOrchestrator, 'regate'>,
  logger: Logger,
): BindingRoutes {
  const log = subsystemLogger(logger, SUBSYSTEM_READINESS);
  return Object.freeze({
    handleSessionBind: async (payload, connection) => {
      const bound = await binding.handleSessionBind(payload, connection);
      if (bound.ok) {
        const { sessionId, tabId } = bound.value;
        void pipeline.regate({ sessionId }).then((outcome) => {
          if (!outcome.ok) {
            log.debug('the bound session was not re-gated after its tab was bound', {
              sessionId,
              tabId,
              code: outcome.error.code,
            });
          }
        });
      }
      return bound;
    },
    handleTabNavigated: (payload, connection) => binding.handleTabNavigated(payload, connection),
    handleSessionUnbind: (payload, connection) => binding.handleSessionUnbind(payload, connection),
  } satisfies BindingRoutes);
}

/**
 * The binding routes with one addition: a tab bound (or kept across a
 * same-origin navigation) while its session has no open capture has its page
 * agent reconciled to dormant.
 *
 * The binding route re-arms an open capture itself. Without one, the tab's
 * page agent may still hold the session's last capture: a dormant
 * `agent.config` that could not be delivered while the service worker was
 * away, or a configuration the service worker kept across a restart of this
 * service, which forgot that it had ever armed it. The instrumentation
 * service's `reconcileBoundSession` sends the dormant configuration for the
 * outstanding disarm, the capture it still has armed there, or a last stored
 * capture an earlier process opened — nothing when it knows that page is
 * dormant, which is why the capture's start time is passed along. The route's
 * own answer is returned unchanged; the reconciliation never delays or fails
 * it. The unbind route is delegated explicitly, so a route added to
 * {@link BindingRoutes} is a compile error here rather than a missing member.
 *
 * @param binding The binding routes that do the work.
 * @param producers The instrumentation service's producer reconciler.
 * @param sessions The session store, read for the project root and last capture.
 * @param logger The service's root logger.
 * @returns The routes handed on to the WebSocket router.
 */
export function reconcilingBindingRoutes(
  binding: BindingRoutes,
  producers: Pick<ProducerReconciler, 'reconcileBoundSession'>,
  sessions: Pick<SessionsRepo, 'get'>,
  logger: Logger,
): BindingRoutes {
  const log = subsystemLogger(logger, SUBSYSTEM_READINESS);

  /** Reconciles the page agent of a session whose tab the route did not re-arm. */
  function reconcile(sessionId: string, tabId: number): void {
    try {
      const loaded = sessions.get(sessionId);
      if (isErr(loaded) || loaded.value === undefined) {
        log.debug('the bound session could not be read, so its page agent was not reconciled', {
          sessionId,
          tabId,
          ...(isErr(loaded) ? { code: loaded.error.code } : {}),
        });
        return;
      }
      const record = loaded.value;
      const last = record.captures.at(-1);
      const reconciled = producers.reconcileBoundSession({
        sessionId,
        projectRoot: record.projectRoot,
        ...(last === undefined
          ? {}
          : { lastCaptureId: last.id, lastCaptureStartedAt: last.startedAt }),
      });
      if (isErr(reconciled)) {
        log.warn('the bound tab’s page agent could not be reconciled', {
          sessionId,
          tabId,
          code: reconciled.error.code,
        });
      }
    } catch (cause) {
      log.error('reconciling the bound tab’s page agent threw', {
        sessionId,
        tabId,
        code: DebuggenError.from(cause, 'INTERNAL').code,
      });
    }
  }

  return Object.freeze({
    handleSessionBind: async (payload, connection) => {
      const bound = await binding.handleSessionBind(payload, connection);
      if (bound.ok && bound.value.rearm.status === 'no-active-capture') {
        reconcile(bound.value.sessionId, bound.value.tabId);
      }
      return bound;
    },
    handleTabNavigated: async (payload, connection) => {
      const navigated = await binding.handleTabNavigated(payload, connection);
      if (
        navigated.ok &&
        navigated.value.kind === 'kept' &&
        navigated.value.rearm.status === 'no-active-capture'
      ) {
        reconcile(navigated.value.announced.payload.sessionId, payload.tabId);
      }
      return navigated;
    },
    handleSessionUnbind: (payload, connection) => binding.handleSessionUnbind(payload, connection),
  } satisfies BindingRoutes);
}

/**
 * The instrumentation service as the pipeline sees it: every method delegated,
 * plus the capture-time readiness re-evaluation. Delegated explicitly rather
 * than spread, so a method the service adds is a compile error here instead of
 * a silently missing member.
 */
function withCaptureReadiness(
  service: InstrumentationService,
  readiness: CaptureReadinessSource,
): InstrumentationService & CaptureReadinessSource {
  return Object.freeze({
    buildContext: (input) => service.buildContext(input),
    install: (request) => service.install(request),
    armCapture: (request) => service.armCapture(request),
    disarmCapture: (request) => service.disarmCapture(request),
    restoreArming: (input) => service.restoreArming(input),
    arming: (sessionId) => service.arming(sessionId),
    isInstalling: (sessionId) => service.isInstalling(sessionId),
    stopSession: (sessionId) => service.stopSession(sessionId),
    dispose: () => service.dispose(),
    evaluateReadiness: (request) => readiness.evaluateReadiness(request),
  } satisfies InstrumentationService & CaptureReadinessSource);
}

/* -------------------------------------------------------------------------------------------------
 * Step 9 — the prompt tree
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validates the prompt tree eagerly: the manifest parses and names a current
 * version for every stage, and every one of those files loads. A broken tree —
 * a VSIX whose copy is incomplete, a manifest edited by hand — then fails the
 * start with the loader's own hint instead of failing a developer's session at
 * its first model call.
 *
 * @param loader The loader over `config.promptsDir`.
 * @returns `ok` with the stage → version map the sessions will record, or the
 * loader's first failure.
 */
function validatePromptTree(
  loader: PromptLoader,
): Result<Readonly<Record<string, string>>, DebuggenError> {
  const versions = loader.versions();
  if (isErr(versions)) {
    return versions;
  }
  for (const stage of PROMPT_STAGES) {
    const loaded = loader.load(stage);
    if (isErr(loaded)) {
      return loaded;
    }
  }
  return ok(versions.value);
}

/* -------------------------------------------------------------------------------------------------
 * Step 11 — the one HTTP server
 * ---------------------------------------------------------------------------------------------- */

/**
 * Resolves the limits the HTTP server is created with: {@link HTTP_SERVER_LIMITS}
 * with the host's {@link StartServiceOptions.httpLimits} applied.
 *
 * Every member — the deadlines, the cap and the admission budget alike — must
 * be a positive safe integer: a zero burst, rate or unengaged budget would
 * refuse every connection, and a fractional or infinite one has no meaning as
 * a count of sockets or milliseconds.
 *
 * @param overrides The replacements, if any.
 * @returns The limits, or `CONFIG_INVALID` naming the offending members when
 *   one is not a positive safe integer or the header deadline exceeds the
 *   request deadline (which Node itself would reject with a throw).
 */
function resolveHttpServerLimits(
  overrides: HttpServerLimitOverrides | undefined,
): Result<HttpServerLimits, DebuggenError> {
  const limits: HttpServerLimits = {
    headersTimeoutMs: overrides?.headersTimeoutMs ?? HTTP_SERVER_LIMITS.headersTimeoutMs,
    requestTimeoutMs: overrides?.requestTimeoutMs ?? HTTP_SERVER_LIMITS.requestTimeoutMs,
    keepAliveTimeoutMs: overrides?.keepAliveTimeoutMs ?? HTTP_SERVER_LIMITS.keepAliveTimeoutMs,
    connectionsCheckingIntervalMs:
      overrides?.connectionsCheckingIntervalMs ?? HTTP_SERVER_LIMITS.connectionsCheckingIntervalMs,
    maxConnections: overrides?.maxConnections ?? HTTP_SERVER_LIMITS.maxConnections,
    connectionBurst: overrides?.connectionBurst ?? HTTP_SERVER_LIMITS.connectionBurst,
    connectionsPerSecond:
      overrides?.connectionsPerSecond ?? HTTP_SERVER_LIMITS.connectionsPerSecond,
    maxUnengagedConnections:
      overrides?.maxUnengagedConnections ?? HTTP_SERVER_LIMITS.maxUnengagedConnections,
    reservedConnections: overrides?.reservedConnections ?? HTTP_SERVER_LIMITS.reservedConnections,
  };
  const invalid = (Object.keys(limits) as (keyof HttpServerLimits)[]).filter(
    (limit) => !Number.isSafeInteger(limits[limit]) || limits[limit] <= 0,
  );
  if (invalid.length > 0) {
    return err(
      new DebuggenError(
        'CONFIG_INVALID',
        'The HTTP server limits must be positive whole numbers.',
        {
          hint: 'Pass positive integers for the HTTP server limits the host overrides, or leave them out to keep the defaults.',
          details: { subsystem: SUBSYSTEM_SERVER, invalid },
        },
      ),
    );
  }
  if (limits.headersTimeoutMs > limits.requestTimeoutMs) {
    return err(
      new DebuggenError(
        'CONFIG_INVALID',
        'The HTTP header deadline may not exceed the whole-request deadline.',
        {
          hint: 'Pass a headersTimeoutMs no greater than requestTimeoutMs.',
          details: { subsystem: SUBSYSTEM_SERVER, invalid: ['headersTimeoutMs'] },
        },
      ),
    );
  }
  return ok(Object.freeze(limits));
}

/**
 * The responses of each connection that have not finished yet, keyed by the
 * connection's socket. Read by {@link createClientErrorHandler} to decide
 * whether a raw error response can still be written without corrupting one
 * already under way; an entry goes with its socket.
 */
type OpenResponses = WeakMap<object, Set<ServerResponse>>;

/**
 * Wraps the application's request listener so every response is recorded in
 * `open` until it closes (finished, or its connection ended), and the
 * admission control is told when a connection becomes engaged — a request
 * arrived — and when its last response in flight has closed.
 *
 * @param listener The application's request listener.
 * @param open Where the unfinished responses are recorded.
 * @param activity The admission control's hooks.
 * @returns The listener the server's `request` event is routed to.
 */
function trackOpenResponses(
  listener: RequestListener,
  open: OpenResponses,
  activity: ConnectionActivity,
): RequestListener {
  return (request, response) => {
    const socket = request.socket;
    let responses = open.get(socket);
    if (responses === undefined) {
      responses = new Set();
      open.set(socket, responses);
    }
    const unfinished = responses;
    unfinished.add(response);
    activity.requestStarted(socket);
    response.once('close', () => {
      unfinished.delete(response);
      if (unfinished.size === 0) {
        activity.responsesSettled(socket);
      }
    });
    listener(request, response);
  };
}

/** The statuses a connection the HTTP server refused is answered with. */
type ClientErrorStatus = 400 | 408 | 413 | 431;

/** Matches a CR or LF — either would end a header line inside a raw response head. */
const RAW_HEAD_LINE_BREAK = /[\r\n]/u;

/**
 * Writes one entry of the application's response-header policy as a raw head
 * line, its lower-case name in canonical casing — each hyphen-separated word
 * capitalised, as Node writes the names it sets itself.
 *
 * @param name The header's lower-case name.
 * @param value The header's value.
 * @returns The line, without its CRLF.
 * @throws {RangeError} When the name or value holds a CR or LF, which would
 * split the head. The policy is a constant, so this surfaces a programming
 * error the moment this module loads, never at a refused connection.
 *
 * @example
 * ```ts
 * rawPolicyHeaderLine('x-frame-options', 'DENY'); // 'X-Frame-Options: DENY'
 * ```
 */
function rawPolicyHeaderLine(name: string, value: string): string {
  if (RAW_HEAD_LINE_BREAK.test(name) || RAW_HEAD_LINE_BREAK.test(value)) {
    throw new RangeError(
      `The response-policy header ${JSON.stringify(name)} cannot be written into a raw response head.`,
    );
  }
  const canonical = name
    .split('-')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('-');
  return `${canonical}: ${value}`;
}

/**
 * Builds one entry of {@link CLIENT_ERROR_RESPONSES}.
 *
 * @param status The status.
 * @returns The complete response head, with no body: the status line,
 * `Connection: close`, `Content-Length: 0` and one line per header of
 * `RESPONSE_POLICY_HEADERS`.
 */
function rawClientErrorResponse(status: ClientErrorStatus): Buffer {
  return Buffer.from(
    [
      `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Error'}`,
      'Connection: close',
      'Content-Length: 0',
      ...Object.entries(RESPONSE_POLICY_HEADERS).map(([name, value]) =>
        rawPolicyHeaderLine(name, value),
      ),
      '',
      '',
    ].join('\r\n'),
    'latin1',
  );
}

/**
 * The raw response for each {@link ClientErrorStatus}. Written straight to the
 * socket, below the application, so it carries what the application sets on
 * every response it sends — `./server/http.js`'s `RESPONSE_POLICY_HEADERS`,
 * read from that one definition: no caching, no content sniffing, no framing
 * (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`) and CSP
 * `default-src 'none'` — with no body (`Content-Length: 0`) and
 * `Connection: close`, because the connection is closed right after it.
 */
const CLIENT_ERROR_RESPONSES: Readonly<Record<ClientErrorStatus, Buffer>> = Object.freeze({
  400: rawClientErrorResponse(400),
  408: rawClientErrorResponse(408),
  413: rawClientErrorResponse(413),
  431: rawClientErrorResponse(431),
});

/**
 * The `ServerResponse` class the HTTP server builds every response with: the
 * platform's own, holding `./server/http.js`'s `RESPONSE_POLICY_HEADERS`
 * from construction.
 *
 * Node answers some requests itself, before any `request` listener — and so
 * before the application's listener can stamp the policy — runs: the `417`
 * for an `Expect` other than `100-continue`, and the `400` for an HTTP/1.1
 * request with no `Host` (RFC 9112 §3.2 requires it). Both are written
 * through a response of this class, and `writeHead` merges the headers set
 * here into the ones it is passed, so those replies carry the policy too,
 * with Node's own status and semantics unchanged. The application's replies
 * set the same values again; a header set twice by name is sent once.
 *
 * @example
 * ```ts
 * createServer<typeof IncomingMessage, typeof ServerResponse>({
 *   ServerResponse: PolicyServerResponse,
 * });
 * ```
 */
class PolicyServerResponse<
  Request extends IncomingMessage = IncomingMessage,
> extends ServerResponse<Request> {
  /**
   * @param request The request the response answers.
   * @param options The server's response options (`highWaterMark`,
   * `rejectNonStandardBodyWrites`), which Node passes as a second argument.
   */
  constructor(request: Request, options?: object) {
    // `@types/node` declares the base constructor with the request alone, but
    // Node's own takes the options too; they reach it unchanged, so the
    // server's write buffering and body-write rules are exactly Node's.
    const platformArguments = [request, options] as unknown as [Request];
    super(...platformArguments);
    for (const [name, value] of Object.entries(RESPONSE_POLICY_HEADERS)) {
      this.setHeader(name, value);
    }
  }
}

/**
 * The status Node answers a refused connection with, by its error code: an
 * oversized header block `431`, oversized chunk extensions `413`, a missed
 * header or request deadline `408`, anything else `400`.
 *
 * @param code The error's code, if it has one.
 * @returns The status.
 */
function clientErrorStatusOf(code: string | undefined): ClientErrorStatus {
  switch (code) {
    case 'HPE_HEADER_OVERFLOW':
      return 431;
    case 'HPE_CHUNK_EXTENSIONS_OVERFLOW':
      return 413;
    case 'ERR_HTTP_REQUEST_TIMEOUT':
      return 408;
    default:
      return 400;
  }
}

/** The shape of a Node error code: upper-case letters, digits and underscores. */
const NODE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

/**
 * The server's `clientError` listener: what Node itself does — answer a
 * connection its parser refused or whose request missed a deadline, then
 * destroy it — with {@link CLIENT_ERROR_RESPONSES} in place of Node's bare
 * responses.
 *
 * The response is written only while the socket is writable and none of its
 * unfinished responses has sent its head, so a response under way is never
 * corrupted; a transport error (`ECONNRESET`) leaves nothing to answer. The
 * `debug` record carries the error's code, the status and whether it was
 * written — never a byte of what the peer sent.
 *
 * @param open The unfinished responses per socket.
 * @param logger The server logger.
 * @returns The listener.
 */
function createClientErrorHandler(
  open: OpenResponses,
  logger: Logger,
): (error: Error, socket: Duplex) => void {
  return (error, socket) => {
    const raw: unknown = (error as { code?: unknown }).code;
    const code = typeof raw === 'string' && NODE_ERROR_CODE_PATTERN.test(raw) ? raw : undefined;
    const status = clientErrorStatusOf(code);
    const underway = [...(open.get(socket) ?? [])].some((response) => response.headersSent);
    const answered = socket.writable && !underway;
    if (answered) {
      socket.write(CLIENT_ERROR_RESPONSES[status]);
    }
    socket.destroy();
    logger.debug('closed a connection the HTTP server could not serve', {
      errorCode: code ?? 'unknown',
      status,
      answered,
    });
  };
}

/**
 * A `warn` reporter for one kind of connection event: each call counts one
 * event, and a record is written at most once every
 * {@link DROPPED_CONNECTIONS_REPORT_INTERVAL_MS} with how many were counted
 * since the previous record under `countField`, beside the fields `fields`
 * returns at that moment. Counts and limits only; never an address or a port.
 *
 * @param logger The server logger.
 * @param message The record's constant message.
 * @param countField The field the event count is reported under.
 * @param fields The record's other fields, read when a record is written.
 * @returns The function to call once per event.
 */
function throttledConnectionReport(
  logger: Logger,
  message: string,
  countField: string,
  fields: () => LogFields,
): () => void {
  let unreported = 0;
  let reportedAt = Number.NEGATIVE_INFINITY;
  return () => {
    unreported += 1;
    const at = performance.now();
    if (at - reportedAt < DROPPED_CONNECTIONS_REPORT_INTERVAL_MS) {
      return;
    }
    logger.warn(message, { ...fields(), [countField]: unreported });
    unreported = 0;
    reportedAt = at;
  };
}

/**
 * Reports connections the server refused at {@link HttpServerLimits.maxConnections}
 * (Node's `drop` event), through {@link throttledConnectionReport}.
 *
 * @param server The server.
 * @param maxConnections The cap in force, for the record.
 * @param logger The server logger.
 */
function reportDroppedConnections(server: Server, maxConnections: number, logger: Logger): void {
  server.on(
    'drop',
    throttledConnectionReport(
      logger,
      'refused connections: the HTTP server holds its maximum number of connections',
      'droppedConnections',
      () => ({ maxConnections }),
    ),
  );
}

/**
 * What {@link trackOpenResponses} tells the admission control about a
 * connection's requests: when one arrives whole, and when the last response in
 * flight on the connection has closed.
 */
interface ConnectionActivity {
  /** A complete request head arrived on `socket`; its response is now in flight. */
  requestStarted(socket: Duplex): void;
  /** No response is in flight on `socket` any more. */
  responsesSettled(socket: Duplex): void;
}

/**
 * The connection admission control of the HTTP server (CWE-400): what stops a
 * local process from filling every one of {@link HttpServerLimits.maxConnections}'
 * slots with connections that never complete a request, which the deadlines
 * alone only bound in time. Two budgets apply to every TCP connection as it is
 * accepted — before a byte of it is parsed, and so before the access boundary
 * could tell a client from an attacker:
 *
 * 1. **An admission rate** — a token bucket of
 *    {@link HttpServerLimits.connectionBurst} admissions, regaining
 *    {@link HttpServerLimits.connectionsPerSecond} per second. A connection
 *    that finds it empty is destroyed at once: it costs one accept, never a
 *    parser, a timer or a slot. The burst absorbs every client reconnecting
 *    together after a restart; the rate is what a flood is held to.
 * 2. **An unengaged budget** — at most
 *    {@link HttpServerLimits.maxUnengagedConnections} connections that hold no
 *    slot a legitimate client is waiting on: those that have not delivered a
 *    complete request head yet, and those idle on keep-alive with no response
 *    in flight. When a new connection arrives and that budget is full — or the
 *    server already holds its soft cap of `maxConnections −`
 *    {@link HttpServerLimits.reservedConnections} connections of any kind —
 *    the **oldest** unengaged connection is evicted to make room, and the
 *    newcomer is refused only if there is none to evict.
 *
 * Eviction is what keeps the service answering under a flood: a flood's
 * sockets are the unengaged ones, so each newcomer displaces the longest
 * stalled of them, and a legitimate client — which sends its request head in
 * the same write that follows its connect — is engaged before the next wave
 * reaches it. A connection with a request in flight, whose handler may be
 * slow, is never evicted, and neither is one handed to the WebSocket server by
 * the `upgrade` event: `./server/ws.ts` applies its own pending-handshake and
 * open-socket quotas to those, and they still count towards the soft cap
 * because they hold a slot. Node's `maxConnections` stays the hard backstop.
 *
 * The budget is global, not per peer. Every peer of this service is a process
 * on this machine speaking over loopback, where the source address is
 * 127.0.0.1 for the editor, the DevTools panel, a dev-server preload and an
 * attacker alike and the source port is chosen by the kernel, so no
 * per-address or per-port quota can tell them apart; what can be told apart is
 * whether a connection is doing anything, which is what the budget measures.
 *
 * Refusals past the rate, refusals with nothing to evict and evictions are
 * each reported at `warn` through {@link throttledConnectionReport}.
 *
 * @param server The server, before it listens; its `connection` and `upgrade`
 *   events are observed here.
 * @param limits The resolved limits.
 * @param logger The server logger.
 * @returns The activity hooks {@link trackOpenResponses} reports each request
 *   and each settled response to.
 */
function createConnectionAdmission(
  server: Server,
  limits: HttpServerLimits,
  logger: Logger,
): ConnectionActivity {
  // A reserve that leaves no room below the cap sets no soft cap.
  const softMaxConnections =
    limits.reservedConnections < limits.maxConnections
      ? limits.maxConnections - limits.reservedConnections
      : Number.POSITIVE_INFINITY;
  /** Every admitted connection still open, and whether it was upgraded. */
  const admitted = new Map<Duplex, { upgraded: boolean }>();
  /** The admitted connections that are unengaged, oldest first (insertion order). */
  const unengaged = new Set<Duplex>();
  let tokens = limits.connectionBurst;
  let refilledAt = performance.now();

  const budgetFields = (): LogFields => ({
    openConnections: admitted.size,
    unengagedConnections: unengaged.size,
    maxUnengagedConnections: limits.maxUnengagedConnections,
    maxConnections: limits.maxConnections,
    reservedConnections: limits.reservedConnections,
  });
  const reportRateRefusal = throttledConnectionReport(
    logger,
    'refused connections: new connections arrived faster than the HTTP server admits them',
    'refusedConnections',
    () => ({
      connectionBurst: limits.connectionBurst,
      connectionsPerSecond: limits.connectionsPerSecond,
    }),
  );
  const reportEviction = throttledConnectionReport(
    logger,
    'closed stalled or idle connections to admit new ones',
    'evictedConnections',
    budgetFields,
  );
  const reportBusyRefusal = throttledConnectionReport(
    logger,
    'refused connections: every connection the HTTP server holds is serving a request',
    'refusedConnections',
    budgetFields,
  );

  /** Takes one admission from the bucket, refilled for the time since the last take. */
  const takeAdmission = (): boolean => {
    const at = performance.now();
    tokens = Math.min(
      limits.connectionBurst,
      tokens + ((at - refilledAt) * limits.connectionsPerSecond) / 1_000,
    );
    refilledAt = at;
    if (tokens < 1) {
      return false;
    }
    tokens -= 1;
    return true;
  };

  const forget = (socket: Duplex): void => {
    admitted.delete(socket);
    unengaged.delete(socket);
  };

  /** Destroys the oldest unengaged connection; `false` when there is none. */
  const evictOldestUnengaged = (): boolean => {
    const oldest = unengaged.values().next();
    if (oldest.done === true) {
      return false;
    }
    forget(oldest.value);
    oldest.value.destroy();
    reportEviction();
    return true;
  };

  // Registered after Node's own connection listener, and synchronous: the
  // first byte is read on a later turn, so a socket destroyed here is never
  // parsed.
  server.on('connection', (socket: Duplex) => {
    if (!takeAdmission()) {
      socket.destroy();
      reportRateRefusal();
      return;
    }
    while (
      unengaged.size >= limits.maxUnengagedConnections ||
      admitted.size >= softMaxConnections
    ) {
      if (!evictOldestUnengaged()) {
        // Only the soft cap leaves nothing to evict: every connection held is
        // serving a request or is a WebSocket.
        socket.destroy();
        reportBusyRefusal();
        return;
      }
    }
    admitted.set(socket, { upgraded: false });
    unengaged.add(socket);
    socket.once('close', () => {
      forget(socket);
    });
  });

  // Prepended, so the socket is excluded before `./server/ws.ts` takes it. An
  // upgrade this listener alone would receive (the WebSocket server has
  // detached during a stop) has nobody to answer it and is closed.
  server.prependListener('upgrade', (_request: IncomingMessage, socket: Duplex) => {
    const state = admitted.get(socket);
    if (state !== undefined) {
      state.upgraded = true;
      unengaged.delete(socket);
    }
    if (server.listenerCount('upgrade') <= 1) {
      socket.destroy();
    }
  });

  return {
    requestStarted: (socket) => {
      unengaged.delete(socket);
    },
    responsesSettled: (socket) => {
      const state = admitted.get(socket);
      if (state === undefined || state.upgraded || socket.destroyed) {
        return;
      }
      // Re-inserted, so an idle connection is as old as its idleness.
      unengaged.delete(socket);
      unengaged.add(socket);
    },
  };
}

/**
 * Creates the one HTTP server with {@link HTTP_SERVER_LIMITS}' deadlines,
 * connection cap and admission budget in force (CWE-400): the admission
 * control of {@link createConnectionAdmission}, fed by the response tracking
 * of {@link trackOpenResponses}, the raw `clientError` answer of
 * {@link createClientErrorHandler} and the refusal report of
 * {@link reportDroppedConnections}. Every response it builds is a
 * {@link PolicyServerResponse}, so the replies Node writes itself carry the
 * response-header policy. Upgrade routing is attached by the caller.
 *
 * Exported so `./main.test.ts` can drive the admission budget with a handler
 * it controls — a slow one — which no route of the composed service offers.
 *
 * @param listener The application's request listener.
 * @param limits The resolved limits.
 * @param logger The server logger.
 * @returns The server, not yet listening.
 */
export function createLimitedServer(
  listener: RequestListener,
  limits: HttpServerLimits,
  logger: Logger,
): Server {
  const open: OpenResponses = new WeakMap();
  const server = createServer<typeof IncomingMessage, typeof ServerResponse>({
    ServerResponse: PolicyServerResponse,
    headersTimeout: limits.headersTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
    connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
  });
  server.maxConnections = limits.maxConnections;
  const admission = createConnectionAdmission(server, limits, logger);
  server.on('request', trackOpenResponses(listener, open, admission));
  server.on('clientError', createClientErrorHandler(open, logger));
  reportDroppedConnections(server, limits.maxConnections, logger);
  return server;
}

/**
 * Binds the server and resolves once it is listening, with the bound port.
 *
 * Settles exactly once, on the first of: `listening` (`Ok`, the port read back
 * from the socket's `AddressInfo`), `error` (`Err`), or a synchronous throw from
 * `listen` (`Err`). `EADDRINUSE` — what a second service instance or a stale
 * process produces — arrives as a typed error naming the host and port to free
 * or change.
 *
 * @param server The server, with its request listener and upgrade routing set.
 * @param config The resolved configuration; `port: 0` asks the OS to choose.
 * @returns The bound port, or the refusal.
 */
function listen(server: Server, config: ServiceConfig): Promise<Result<number, DebuggenError>> {
  return new Promise((resolve) => {
    let settled = false;

    const refuse = (cause: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.off('listening', onListening);
      resolve(
        err(
          wrapStartupFailure(
            cause,
            'INTERNAL',
            `Could not bind the Debug Generator service to ${formatServiceUrl(config.host, config.port)}.`,
            `Another process is most likely already listening on ${config.host} port ${config.port}: stop it, set DEBUGGEN_PORT to a free port, or set DEBUGGEN_PORT=0 to let the operating system choose one.`,
            { subsystem: SUBSYSTEM_SERVER, host: config.host, port: config.port },
          ),
        ),
      );
    };

    const onListening = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.off('error', refuse);
      const address: AddressInfo | string | null = server.address();
      if (address === null || typeof address === 'string') {
        resolve(
          err(
            new DebuggenError('INTERNAL', 'The service socket reported no TCP address.', {
              hint: 'Set DEBUGGEN_HOST to a loopback IP address such as 127.0.0.1.',
              details: { subsystem: SUBSYSTEM_SERVER, host: config.host },
            }),
          ),
        );
        return;
      }
      resolve(ok(address.port));
    };

    server.once('error', refuse);
    server.once('listening', onListening);
    try {
      server.listen(config.port, config.host);
    } catch (cause) {
      refuse(cause);
    }
  });
}

/**
 * Stops the server accepting connections and waits, bounded, for the open ones
 * to end. Idle keep-alive sockets are released immediately; anything still open
 * after {@link HTTP_DRAIN_GRACE_MS} is closed outright. Never rejects.
 */
function closeHttpServer(server: Server, logger: Logger): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(grace);
      resolve();
    };

    const grace = setTimeout(() => {
      logger.warn('HTTP connections were still open after the drain period; closing them', {
        graceMs: HTTP_DRAIN_GRACE_MS,
      });
      server.closeAllConnections();
      finish();
    }, HTTP_DRAIN_GRACE_MS);
    grace.unref();

    server.close(() => {
      finish();
    });
    server.closeIdleConnections();
  });
}

/* -------------------------------------------------------------------------------------------------
 * Releasing what a start acquired
 * ---------------------------------------------------------------------------------------------- */

/** Every session status but the terminal one: the statuses a stop can end. */
const ENDABLE_STATUSES: readonly SessionStatus[] = Object.freeze(
  SESSION_STATUSES.filter((status) => status !== 'ended'),
);

/**
 * The statuses in which a session holds instrumentation whatever its journal
 * says: an install that may have configured producers or written files before
 * the pipeline was cancelled, and an open capture window with armed producers.
 */
const INSTRUMENTING_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'instrumenting',
  'capturing',
]);

/** The most file paths or session ids one shutdown log record lists. */
const MAX_LOGGED_SHUTDOWN_ITEMS = 50;

/** One live session a stop ended, and what its cleanup reported. */
export interface EndedLiveSession {
  readonly sessionId: SessionId;

  /** The session's recorded cleanup verdict, as its clients received it in `cleanup.completed`. */
  readonly cleanup: CleanupStatus;

  /**
   * The project-relative files left as the developer edited them — never
   * overwritten, their originals kept in `$DEBUGGEN_HOME/backups`.
   */
  readonly conflictFiles: readonly string[];
}

/** What {@link endLiveSessions} did. */
export interface LiveSessionsReport {
  /**
   * The live sessions found, in the order they were ended: every session whose
   * patch was applied on top of another's before that other, otherwise most
   * recently updated first (see {@link orderForRestore}).
   */
  readonly live: readonly SessionId[];

  /** The sessions that reached `ended`, with their cleanup verdicts. */
  readonly ended: readonly EndedLiveSession[];

  /**
   * The live sessions not ended — refused, failed, out of time, or left because
   * a session whose patch sits on top of theirs was one of those. Each was
   * still sent its dormant producer configurations; its journal is durable, and
   * the next start restores its files.
   */
  readonly unfinished: readonly SessionId[];

  /** Whether any session's end did not settle within its share of the slice. */
  readonly timedOut: boolean;
}

/** Options for {@link endLiveSessions}. */
export interface EndLiveSessionsOptions {
  /** The slice of the shutdown deadline this step may spend, in milliseconds. */
  readonly timeoutMs: number;

  /** Where the outcome is reported. */
  readonly logger: Logger;

  /** The monotonic clock the slice is measured on. Defaults to `performance.now`. */
  readonly clock?: (() => number) | undefined;
}

/**
 * The live sessions: every session that is not `ended` and still holds
 * instrumentation this service must remove — an open (non-`reverted`) journal
 * record, whatever the session's status (AAP 0.5.1); an install or capture in
 * progress; or producers the instrumentation service still has armed. A session
 * that holds none of these has nothing to clean up, so it is left open and a
 * follow-up can continue it after the restart.
 *
 * A journal that cannot be read is logged and the other criteria still apply;
 * the next start's reconciliation reads the journal again.
 *
 * @returns The live sessions, most recently updated first, with the open
 * journal records of those sessions; or the store failure that prevented
 * listing the sessions at all.
 */
async function findLiveSessions(
  ports: LiveSessionPorts,
  logger: Logger,
): Promise<Result<LiveSessionSet, DebuggenError>> {
  let open: readonly ModificationRecord[] = [];
  const read = await ports.modifications.listAllOpen();
  if (isErr(read)) {
    logger.warn(
      'the modification journal could not be read at shutdown; only installing, capturing and armed sessions are ended now',
      { code: read.error.code },
    );
  } else {
    open = read.value;
  }
  const patched = new Set<string>(open.map((record) => record.sessionId));

  const sessions: LiveSession[] = [];
  let offset = 0;
  for (;;) {
    const page = ports.sessions.list({
      statuses: ENDABLE_STATUSES,
      limit: MAX_SESSION_LIST_LIMIT,
      offset,
    });
    if (isErr(page)) {
      return page;
    }
    const { items, total } = page.value;
    for (const item of items) {
      if (
        patched.has(item.id) ||
        INSTRUMENTING_STATUSES.has(item.status) ||
        ports.instrumentation?.arming(item.id)?.armedCaptureId !== undefined
      ) {
        sessions.push({ sessionId: item.id, projectRoot: item.projectRoot });
      }
    }
    offset += items.length;
    if (items.length === 0 || offset >= total) {
      const live = new Set<string>(sessions.map((session) => session.sessionId));
      return ok({ sessions, records: open.filter((record) => live.has(record.sessionId)) });
    }
  }
}

/** One live session: what ending it, or disarming it, needs. */
interface LiveSession {
  readonly sessionId: SessionId;
  readonly projectRoot: string;
}

/** The live sessions, most recently updated first, and their open journal records. */
interface LiveSessionSet {
  readonly sessions: readonly LiveSession[];
  readonly records: readonly ModificationRecord[];
}

/**
 * Whether the record `later` was applied on top of `earlier` — both on the
 * same file — which means `later` must be restored first. Exact when the two
 * hashes chain (`later` found the file exactly as `earlier` left it); otherwise
 * the application times decide, and equal times decide nothing.
 */
function appliedOnTop(later: ModificationRecord, earlier: ModificationRecord): boolean {
  if (later.originalHash === earlier.instrumentedHash) {
    return true;
  }
  if (earlier.originalHash === later.instrumentedHash) {
    return false;
  }
  return later.appliedAt > earlier.appliedAt;
}

/**
 * The order the live sessions are ended in, so that the patches of different
 * sessions on one file are unwound strictly last-applied-first.
 *
 * Each session restores its own records in reverse; across sessions, the
 * engine verifies every restore against that record's `instrumentedHash`, so a
 * file restored out of order is reported as a conflict instead of being
 * overwritten — safe, but a false conflict that leaves a patch behind. For
 * every file two live sessions have both patched, the session whose patch was
 * applied on top of the other's ({@link appliedOnTop}) therefore goes first; the
 * sessions are sorted topologically over those edges, ties and unconstrained
 * sessions keeping the session index's order (most recently updated first). A
 * cycle — two sessions each on top of the other in different files — has no
 * safe order at session granularity: it is broken at the earliest remaining
 * session in index order and logged, and whatever it leaves is reported as a
 * conflict, never overwritten.
 *
 * @param set The live sessions and their open records.
 * @param logger Where a broken cycle is reported.
 * @returns Every live session exactly once, and for each the sessions whose
 * patches sit on top of its own.
 */
function orderForRestore(set: LiveSessionSet, logger: Logger): RestoreOrder {
  // Records are keyed by project and file: two projects may share a relative path.
  const projectOf = new Map<string, string>(
    set.sessions.map((session) => [session.sessionId, session.projectRoot]),
  );
  const byFile = new Map<string, ModificationRecord[]>();
  for (const record of set.records) {
    const key = `${projectOf.get(record.sessionId) ?? ''}\u0000${record.file}`;
    const onFile = byFile.get(key);
    if (onFile === undefined) {
      byFile.set(key, [record]);
    } else {
      onFile.push(record);
    }
  }

  // before.get(a) holds every session that must be ended before `a`.
  const before = new Map<string, Set<string>>(
    set.sessions.map((session) => [session.sessionId, new Set<string>()]),
  );
  for (const onFile of byFile.values()) {
    for (const a of onFile) {
      for (const b of onFile) {
        if (a.sessionId !== b.sessionId && appliedOnTop(b, a)) {
          before.get(a.sessionId)?.add(b.sessionId);
        }
      }
    }
  }

  const ordered: LiveSession[] = [];
  const done = new Set<string>();
  const remaining = [...set.sessions];
  while (remaining.length > 0) {
    let index = remaining.findIndex((session) =>
      [...(before.get(session.sessionId) ?? [])].every((id) => done.has(id)),
    );
    if (index === -1) {
      index = 0;
      logger.warn(
        'live sessions patched the same files in an interleaved order; a patch that cannot be unwound in order is reported as a conflict',
        { sessionId: remaining[0]?.sessionId },
      );
    }
    const [next] = remaining.splice(index, 1);
    if (next !== undefined) {
      ordered.push(next);
      done.add(next.sessionId);
    }
  }
  return { sessions: ordered, onTopOf: before };
}

/** What {@link orderForRestore} decided. */
interface RestoreOrder {
  /** Every live session exactly once, in the order to end them. */
  readonly sessions: readonly LiveSession[];

  /**
   * For each session, the sessions whose patches were applied on top of its
   * own in some file — every one must be unwound before this session can be.
   */
  readonly onTopOf: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Ends every live session (see {@link findLiveSessions}) within `timeoutMs` —
 * the first half of AAP 0.5.1's end-of-session guarantee at a graceful stop.
 *
 * Each session is ended through `SessionManager.end`, the same sequence an
 * explicit `session.end` runs, so nothing here restates it: the capture window
 * closes, the conflict watcher stops, the page agent receives its dormant
 * `agent.config` and the dev-server preload its capture-less
 * `server-agent.config`, every patched file is restored with its hash verified
 * — a file the developer edited is left untouched and reported as a conflict —
 * and the one `cleanup.completed` message goes to the session's clients.
 *
 * Sessions are ended one at a time, in {@link orderForRestore}'s order, so the
 * patches two sessions made to one file are unwound last-applied-first and a
 * restore never races another restore.
 *
 * The slice is enforced here, and shared fairly: each session may spend at
 * most what is left divided by the sessions still to end, so one session whose
 * end stalls cannot starve an independent one — every live session is
 * attempted. A session whose end does not settle in its share, or that could
 * not be ended at all, is reported `unfinished` and is still sent its dormant
 * `agent.config` and capture-less `server-agent.config` directly, so no
 * producer outlives the stop; its journal is durable, the cleanup runner's
 * disposal that follows stops an abandoned pass before its next record, and
 * the next start restores the files. A session under an unfinished one — whose
 * patch that other session's sits on top of, in some file — is not attempted
 * either, because its restore would meet the other session's bytes and record
 * a false conflict; it is disarmed and left to the next start the same way.
 * Never rejects.
 *
 * @param ports The manager, the session index, the journal and the arming state.
 * @param options The slice, the logger and the clock.
 * @returns What was ended, what was not, and whether any share ran out.
 */
export async function endLiveSessions(
  ports: LiveSessionPorts,
  options: EndLiveSessionsOptions,
): Promise<LiveSessionsReport> {
  const clock = options.clock ?? monotonicNow;
  const log = options.logger;
  const dueAt = clock() + Math.max(0, options.timeoutMs);
  const nothing: LiveSessionsReport = Object.freeze({
    live: [],
    ended: [],
    unfinished: [],
    timedOut: false,
  });

  const found = await raceWithin(() => findLiveSessions(ports, log), dueAt - clock());
  if (found.kind === 'timeout') {
    log.warn('the live sessions could not be listed in time; the next start restores their files', {
      timeoutMs: options.timeoutMs,
    });
    return Object.freeze({ ...nothing, timedOut: true });
  }
  if (found.kind === 'rejected') {
    log.error('the live sessions could not be listed; the next start restores their files', {
      ...describeException(found.cause),
    });
    return nothing;
  }
  if (isErr(found.value)) {
    log.error('the live sessions could not be listed; the next start restores their files', {
      code: found.value.error.code,
      reason: found.value.error.message,
    });
    return nothing;
  }

  const order = orderForRestore(found.value.value, log);
  const live = order.sessions;
  if (live.length === 0) {
    log.debug('no session holds instrumentation, so none is ended');
    return nothing;
  }
  log.info('ending the live sessions before stopping', {
    sessions: live.length,
    timeoutMs: Math.round(options.timeoutMs),
  });

  const ended: EndedLiveSession[] = [];
  const unfinished: LiveSession[] = [];
  const unfinishedIds = new Set<string>();
  let timedOut = false;

  for (const [index, session] of live.entries()) {
    const { sessionId } = session;
    // A patch still sitting on top of this session's could not be unwound, so
    // restoring this session now would meet those bytes and record a false
    // conflict. Its producers are disarmed below and the journal is left intact.
    const blockedBy = [...(order.onTopOf.get(sessionId) ?? [])].filter((id) =>
      unfinishedIds.has(id),
    );
    if (blockedBy.length > 0) {
      log.warn(
        'a live session was not ended because a session that patched the same files after it could not be ended',
        { sessionId, blockedBy: blockedBy.slice(0, MAX_LOGGED_SHUTDOWN_ITEMS) },
      );
      unfinished.push(session);
      unfinishedIds.add(sessionId);
      continue;
    }
    // A fair share of what is left: a stalled end spends no more than its
    // share, and every later session still receives its own.
    const share = (dueAt - clock()) / (live.length - index);
    const outcome =
      share > 0 ? await raceWithin(() => ports.manager.end(sessionId), share) : undefined;
    if (outcome === undefined || outcome.kind === 'timeout') {
      timedOut = true;
      log.warn('a live session did not finish ending within its share of the shutdown deadline', {
        sessionId,
        shareMs: Math.max(0, Math.round(share)),
      });
      unfinished.push(session);
      unfinishedIds.add(sessionId);
      continue;
    }
    if (outcome.kind === 'rejected') {
      log.error('ending a live session failed; the next start restores its files', {
        sessionId,
        ...describeException(outcome.cause),
      });
      unfinished.push(session);
      unfinishedIds.add(sessionId);
      continue;
    }
    if (isErr(outcome.value)) {
      log.warn('a live session could not be ended; the next start restores its files', {
        sessionId,
        code: outcome.value.error.code,
      });
      unfinished.push(session);
      unfinishedIds.add(sessionId);
      continue;
    }

    const cleanup = outcome.value.value.cleanup;
    const conflictFiles = cleanup.conflicts.map((conflict) => conflict.file);
    ended.push(Object.freeze({ sessionId, cleanup: cleanup.status, conflictFiles }));
    if (cleanup.status === 'conflict') {
      log.warn(
        'files edited while instrumented were not overwritten; their originals are kept in the backup directory',
        {
          sessionId,
          conflicts: conflictFiles.length,
          files: conflictFiles.slice(0, MAX_LOGGED_SHUTDOWN_ITEMS),
        },
      );
    } else if (cleanup.status !== 'clean') {
      log.warn('a live session ended with its cleanup incomplete; the next start retries it', {
        sessionId,
        cleanup: cleanup.status,
      });
    }
  }

  // What could not be ended still has its producers disarmed now; its files
  // are restored from the durable journal by the next start.
  for (const session of unfinished) {
    disarmUnfinished(ports, session, log);
  }

  const unfinishedList = unfinished.map((session) => session.sessionId);
  if (unfinishedList.length > 0) {
    log.warn(
      'some live sessions could not be ended before stopping; their producers were disarmed and the next start restores their files',
      {
        unfinished: unfinishedList.length,
        timedOut,
        sessionIds: unfinishedList.slice(0, MAX_LOGGED_SHUTDOWN_ITEMS),
      },
    );
  }
  log.info('live sessions ended', {
    ended: ended.length,
    clean: ended.filter((session) => session.cleanup === 'clean').length,
    conflict: ended.filter((session) => session.cleanup === 'conflict').length,
    unfinished: unfinishedList.length,
  });

  return Object.freeze({
    live: Object.freeze(live.map((session) => session.sessionId)),
    ended: Object.freeze(ended),
    unfinished: Object.freeze(unfinishedList),
    timedOut,
  });
}

/**
 * Sends a live session that could not be ended its dormant page-agent and
 * capture-less dev-server configurations, through the instrumentation service
 * that owns both (the same call cleanup makes first). Idempotent, synchronous
 * and file-free, so it is safe beside an end still running in the background.
 * Logged, never raised.
 */
function disarmUnfinished(ports: LiveSessionPorts, session: LiveSession, logger: Logger): void {
  const { sessionId, projectRoot } = session;
  try {
    const disarmed = ports.instrumentation?.disarmCapture?.({ sessionId, projectRoot });
    if (disarmed === undefined) {
      return;
    }
    if (isErr(disarmed)) {
      logger.warn('the producers of a session that could not be ended were not disarmed', {
        sessionId,
        code: disarmed.error.code,
      });
      return;
    }
    logger.info('the producers of a session that could not be ended were disarmed', {
      sessionId,
      agentDisarmed: disarmed.value.agentDisarmed,
      serverAgent: disarmed.value.serverAgent,
    });
  } catch (cause) {
    logger.error('disarming a session that could not be ended failed', {
      sessionId,
      ...describeException(cause),
    });
  }
}

/**
 * Releases everything in `parts`, in the one order both a failed start and
 * {@link ServiceHandle.close} use, against one deadline. Every step is guarded,
 * every awaited step is handed a slice of what is left of `budget.totalMs`, and
 * nothing here throws:
 *
 * 1. **stop accepting** — new requests on a kept-alive connection are answered
 *    `503`, the listener stops accepting and starts draining, pending
 *    agent-readiness waits resolve, and the start-up retention sweep is asked
 *    to stop at its next step boundary;
 * 2. **cancel in-flight pipeline operations** (at most `budget.pipelineMs`),
 *    which may otherwise still be installing instrumentation or writing the
 *    store — an install still running would make its session's cleanup refuse
 *    — and wait, from the same allowance, for the retention sweep to settle,
 *    so its last transaction commits before the sessions are ended and the
 *    store closes;
 * 3. **end the live sessions** ({@link endLiveSessions}) with everything left
 *    but the two reserves — while the sockets that carry the disarming
 *    configurations and `cleanup.completed` are still open, the dev servers
 *    whose preload is disarmed are still running and the cleanup runner is
 *    still live. Skipped for `liveSessions: 'retain'` and for a start that was
 *    refused before serving;
 * 4. **stop the cleanup runner**: a pass abandoned in step 3 stops before its
 *    next record, and the durable journal leaves the rest to the next start;
 * 5. **stop the dev servers this service launched**, which revokes their scoped
 *    `server-agent` credentials, from a slice that includes
 *    `budget.launcherReserveMs` — no earlier step can have spent it — and
 *    reading the launcher's report, so a dev server that outlived its
 *    termination is named rather than counted as stopped. Should the
 *    launcher still not settle, the outcome is unconfirmed and the
 *    server-agent credentials of every project it had launched are revoked
 *    here, before the store closes, so no launched child's credential
 *    survives the stop (AAP 0.5.6);
 * 6. **flush the live tail**, close every WebSocket with the going-away code
 *    and wait for the HTTP listener, from `budget.finalReserveMs`;
 * 7. release the in-memory subsystems, the client registry and the access
 *    boundary;
 * 8. **checkpoint the write-ahead log and close the database** — always, and
 *    last, so nothing above writes to a closed store.
 *
 * Every step timer is `unref`'d so that it never keeps a *finished* process
 * alive. The sequence itself must keep it alive, though: once the listener and
 * the sockets have closed, a step waiting on a promise that nothing references
 * would otherwise let Node exit mid-sequence, skipping every later step — the
 * store's close included. A **referenced** watchdog timer therefore holds the
 * event loop open from the first step until the store is closed, and at most
 * {@link SHUTDOWN_WATCHDOG_MARGIN_MS} past the deadline.
 *
 * Exported for `main.test.ts`, which drives it with stand-ins that hang, in
 * this process and in a child process that receives no other handle.
 *
 * @param parts What the start acquired.
 * @param loggers The service's loggers.
 * @param options What happens to the live sessions, the budget and the clock.
 * @returns What became of the launched dev servers, for the shutdown's final
 * record.
 */
export async function releaseParts(
  parts: ServiceParts,
  loggers: ServiceLoggers,
  options: ReleasePartsOptions = {},
): Promise<DevServerRelease> {
  const budget = options.budget ?? SHUTDOWN_BUDGET;
  const watchdog = setTimeout(() => {
    loggers.service.warn(
      'the shutdown watchdog released the event loop before the sequence ended',
      {
        deadlineMs: budget.totalMs,
      },
    );
  }, budget.totalMs + SHUTDOWN_WATCHDOG_MARGIN_MS);
  try {
    return await runReleaseSequence(parts, loggers, options, budget);
  } finally {
    clearTimeout(watchdog);
  }
}

/** The eight steps of {@link releaseParts}, under the watchdog it holds. */
async function runReleaseSequence(
  parts: ServiceParts,
  loggers: ServiceLoggers,
  options: ReleasePartsOptions,
  budget: ShutdownBudget,
): Promise<DevServerRelease> {
  const log = loggers.service;
  const clock = options.clock ?? monotonicNow;
  const startedAt = clock();
  const deadline = createShutdownDeadline(budget.totalMs, clock);
  const beforeLauncher = budget.launcherReserveMs + budget.finalReserveMs;
  const {
    store,
    auth,
    clients,
    ledger,
    watcher,
    instrumentation,
    cleanup,
    correlator,
    liveTail,
    launcher,
    orchestrator,
    http,
    ws,
    server,
    liveSessions,
    retention,
  } = parts;

  // 1 — stop accepting, and stop the start-up retention sweep starting work.
  if (http !== undefined) {
    releaseQuietly('http-app', log, () => {
      http.close();
    });
  }
  const serverClosed =
    server === undefined ? Promise.resolve() : closeHttpServer(server, loggers.server);
  if (ledger !== undefined) {
    releaseQuietly('agent-ledger', log, () => {
      ledger.close();
    });
  }
  if (retention !== undefined) {
    releaseQuietly('retention', log, () => {
      retention.abort();
    });
  }

  // 2 — pipeline work in flight, and the retention sweep's last step.
  if (orchestrator !== undefined) {
    await settleWithin(
      () => orchestrator.dispose(),
      deadline.allowance(beforeLauncher, budget.pipelineMs),
      'pipeline',
      log,
    );
  }
  if (retention !== undefined) {
    await settleWithin(
      () => retention.settled,
      deadline.allowance(beforeLauncher, budget.pipelineMs),
      'retention',
      log,
    );
  }

  // 3 — the live sessions, while everything their cleanup needs still runs.
  if (liveSessions !== undefined) {
    if ((options.liveSessions ?? 'end') === 'end') {
      // `endLiveSessions` enforces `slice` itself and reports what it left; the
      // outer bound is only the backstop for a journal read that never answers.
      const slice = deadline.allowance(beforeLauncher);
      await settleWithin(
        () => endLiveSessions(liveSessions, { timeoutMs: slice, logger: log, clock }),
        slice + LIVE_SESSIONS_BACKSTOP_MARGIN_MS,
        'live-sessions',
        log,
      );
    } else {
      log.info(
        'live sessions are retained as they are; the next start reconciles their modification journal',
      );
    }
  }

  // 4 — the cleanup runner.
  if (cleanup !== undefined) {
    releaseQuietly('session-cleanup', log, () => {
      cleanup.dispose();
    });
  }

  // 5 — launched dev servers and their credentials. The report is read, not
  // discarded: a dev server still running is named, and a step that failed
  // or was abandoned leaves the outcome unconfirmed rather than clean.
  let devServers: DevServerRelease = DEV_SERVERS_STOPPED;
  if (launcher !== undefined) {
    const launched = launchedProjectRoots(launcher, log);
    const disposed = await settleWithin(
      () => launcher.dispose(),
      deadline.allowance(budget.finalReserveMs),
      'dev-servers',
      log,
    );
    if (disposed.kind === 'settled') {
      const pids = reportDevServerSurvivors(disposed.value, log);
      devServers = pids.length === 0 ? DEV_SERVERS_STOPPED : { kind: 'running', pids };
    } else {
      devServers = { kind: 'unconfirmed' };
      if (auth !== undefined) {
        revokeLaunchedCredentials(auth, launched, log);
      }
    }
  }

  // 6 — the live tail, the sockets, the listener.
  if (liveTail !== undefined) {
    await settleWithin(() => liveTail.flush(), deadline.allowance(0), 'live-tail', log);
  }
  if (ws !== undefined) {
    await settleWithin(() => ws.close(), deadline.allowance(0), 'websockets', log);
  }
  await settleWithin(() => serverClosed, deadline.allowance(0), 'http-server', log);

  // 7 — in-memory subsystems.
  if (instrumentation !== undefined) {
    await settleWithin(
      () => instrumentation.dispose(),
      deadline.allowance(0),
      'instrumentation',
      log,
    );
  }
  if (watcher !== undefined) {
    await settleWithin(() => watcher.dispose(), deadline.allowance(0), 'watcher', log);
  }
  if (liveTail !== undefined) {
    releaseQuietly('live-tail', log, () => {
      liveTail.close();
    });
  }
  if (correlator !== undefined) {
    releaseQuietly('correlator', log, () => {
      correlator.close();
    });
  }
  if (clients !== undefined) {
    releaseQuietly('clients', log, () => {
      clients.closeAll(WS_CLOSE_GOING_AWAY);
    });
  }
  if (auth !== undefined) {
    releaseQuietly('auth', log, () => {
      auth.close();
    });
  }

  // 8 — the store, last.
  if (store !== undefined) {
    releaseQuietly('store', log, () => {
      store.close();
    });
  }

  const elapsedMs = Math.round(clock() - startedAt);
  const fields = { elapsedMs, deadlineMs: budget.totalMs };
  if (elapsedMs > budget.totalMs) {
    log.warn('the shutdown sequence overran its deadline', fields);
  } else {
    log.debug('the shutdown sequence finished within its deadline', fields);
  }
  return devServers;
}

/** Options for {@link releaseParts}. */
export interface ReleasePartsOptions {
  /** What happens to the live sessions. Defaults to `end`. */
  readonly liveSessions?: LiveSessionDisposition | undefined;

  /** The time budget. Defaults to {@link SHUTDOWN_BUDGET}. */
  readonly budget?: ShutdownBudget | undefined;

  /** The monotonic clock the deadline is measured on. Defaults to `performance.now`. */
  readonly clock?: (() => number) | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Starting the service
 * ---------------------------------------------------------------------------------------------- */

/**
 * Starts the local service. See this module's header for the twelve steps and
 * why they run in this order.
 *
 * Reads no `process` state — not the environment, not the working directory,
 * not the signals — which is what lets an integration suite start several
 * services in one process, each with its own temporary state root, an ephemeral
 * port and the deterministic provider.
 *
 * @param options The environment, overrides and seams. Defaults to an empty
 * record, which resolves the service's own defaults.
 * @returns `Ok` with a listening {@link ServiceHandle}, or `Err` with the first
 * failure that prevented the start — `CONFIG_INVALID` from the configuration,
 * the HTTP server limits, the provider selection or the prompt tree, `FS_UNSAFE_PATH` from the state
 * tree or the store files, `STORE_ERROR` from the store or the modification
 * journal, `INTERNAL` from wiring or the bind. Everything acquired before the
 * failure has been released by the time it is returned.
 *
 * @example Starting a throwaway instance in a suite
 * ```ts
 * const started = await startService({
 *   env: { DEBUGGEN_PROVIDER: 'deterministic' },
 *   overrides: { debuggenHome: tempDir, port: 0, logLevel: 'silent' },
 * });
 * if (isErr(started)) {
 *   throw started.error;
 * }
 * const response = await fetch(`${started.value.url}/health`);
 * await started.value.close();
 * ```
 */
export async function startService(
  options: StartServiceOptions = {},
): Promise<Result<ServiceHandle, DebuggenError>> {
  const env = options.env ?? {};
  const now = options.now;
  const clock: { readonly now?: () => number } = now === undefined ? {} : { now };

  // 1 — configuration, from the injected environment only. The prompt tree's
  // directory and manifest are checked here too — read-only, before the logger
  // or anything else can write under DEBUGGEN_HOME — so a missing or mistyped
  // DEBUGGEN_PROMPTS_DIR (or a bundle shipped without its prompts) is refused
  // like every other configuration key, leaving nothing behind. Step 9 still
  // validates the tree's contents.
  const loaded = loadServiceConfig(env, options.overrides);
  if (isErr(loaded)) {
    return loaded;
  }
  const promptsPresent = verifyPromptsDirectory(loaded.value);
  if (isErr(promptsPresent)) {
    return promptsPresent;
  }
  const resolved = loaded.value;
  const httpLimits = resolveHttpServerLimits(options.httpLimits);
  if (isErr(httpLimits)) {
    return httpLimits;
  }

  // 2 — logging. The configuration is logged once, through its credential-free
  // view, on the root (its fields carry their own `subsystem`). An injected
  // logger is guarded like the built one, so no log call on a shutdown or
  // failure path of this file can throw and skip the step after it.
  const root = guardLogger(options.logger ?? createServiceLogger(resolved, options.loggerOptions));
  const loggers: ServiceLoggers = {
    root,
    service: subsystemLogger(root, SUBSYSTEM_SERVICE),
    server: subsystemLogger(root, SUBSYSTEM_SERVER),
  };
  root.info('service configuration resolved', describeServiceConfig(resolved));

  // Written once, when `listen` resolves; read by the effective configuration.
  const bound: { port?: number } = {};
  const config = createEffectiveConfig(resolved, () => bound.port);

  // 3 — the state tree, before anything writes into it, and its canonical
  // location, which every project root is kept apart from.
  const tree = prepareStateTree(config);
  if (isErr(tree)) {
    loggers.service.error(STARTUP_REFUSED_MESSAGE, {
      step: 'state-tree' satisfies StartupStep,
      ...errorFields(tree.error),
    });
    return tree;
  }
  const canonicalHome = await resolveCanonicalStateHome(config);
  if (isErr(canonicalHome)) {
    loggers.service.error(STARTUP_REFUSED_MESSAGE, {
      step: 'state-tree' satisfies StartupStep,
      ...errorFields(canonicalHome.error),
    });
    return canonicalHome;
  }
  const canonicalStateHome = canonicalHome.value;

  const parts: ServiceParts = {};
  const refuse = async (
    step: StartupStep,
    error: DebuggenError,
  ): Promise<Result<never, DebuggenError>> => {
    loggers.service.error(STARTUP_REFUSED_MESSAGE, { step, ...errorFields(error) });
    await releaseParts(parts, loggers);
    return err(error);
  };

  // 4 — the session store and its repositories.
  const opened = openStore({ config, logger: root, inlineDdl: options.inlineSchemaSql });
  if (isErr(opened)) {
    return refuse('store', opened.error);
  }
  const store = opened.value;
  parts.store = store;
  const repos: Repositories = {
    sessions: createSessionsRepo({ store, logger: root, ...clock }),
    panels: createPanelsRepo({ store, logger: root, ...clock }),
    telemetry: createTelemetryRepo({ store, logger: root }),
    modifications: createModificationsRepo({ store, logger: root, ...clock }),
  };

  // The client registry exists before the access boundary because it is the
  // boundary's revoker: rotation closes every socket through it.
  const clients = createClientRegistry({
    logger: root,
    sweepIntervalMs: CLIENT_SWEEP_INTERVAL_MS,
    ...clock,
  });
  parts.clients = clients;

  // 5 — the editor credential. The token is written to auth.json by the auth
  // service and is never seen, held or logged here.
  const authCreated = createAuthService({
    store,
    config,
    logger: root,
    revoker: connectionRevokerOf(clients),
    ...clock,
  });
  if (isErr(authCreated)) {
    return refuse('access-boundary', authCreated.error);
  }
  const auth = authCreated.value;
  parts.auth = auth;
  const editor = auth.ensureEditorCredential();
  if (isErr(editor)) {
    return refuse('editor-credential', editor.error);
  }
  loggers.service.info('editor credential ready', {
    authFilePath: config.authFilePath,
    created: editor.value.created,
  });

  // A dev server a crashed service launched is supervised by nothing now, and
  // no retry of a revocation that service could not finish survives it: revoke
  // those leases before serving (AAP 0.5.6). A lease whose holder still runs
  // is left to that holder. Each lease row is the durable record of its own
  // pending revocation, so a failure here fails the start, like the journal
  // reconciliation below: serving would leave a credential authenticating that
  // no process supervises, and the next start tries again.
  const orphanedLeases = auth.revokeOrphanedServerAgentLeases();
  if (isErr(orphanedLeases)) {
    return refuse('server-agent-leases', orphanedLeases.error);
  }
  if (orphanedLeases.value > 0) {
    loggers.service.info('revoked leftover dev-server credential leases', {
      revoked: orphanedLeases.value,
    });
  }

  // 6 — crash recovery, before anything can serve: every open journal record,
  // whatever its session's status. A journal that cannot be read at all fails
  // the start, because serving on top of unreconciled patches would let a new
  // session instrument files an old one never restored.
  const reconciled = await reconcileModificationsOnStartup({
    modifications: repos.modifications,
    sessions: repos.sessions,
    config,
    logger: root,
    ...clock,
  });
  if (isErr(reconciled)) {
    return refuse('reconciliation', reconciled.error);
  }
  if (reconciled.value.conflicts > 0 || reconciled.value.unresolved > 0) {
    loggers.service.warn('start-up reconciliation left files for the developer to resolve', {
      status: reconciled.value.status,
      conflicts: reconciled.value.conflicts,
      unresolved: reconciled.value.unresolved,
      restored: reconciled.value.restored,
    });
  }

  // The state root stays outside every project. Checked only now, so the
  // reconciliation above has already restored every file a previous process
  // left instrumented; a stored session whose project contains the state root,
  // lies inside it, or cannot be resolved on disk to show it lies apart,
  // refuses the start before anything else is written there or served.
  const apart = await refuseStoredProjectOverlap(repos.sessions, canonicalStateHome);
  if (isErr(apart)) {
    return refuse('state-home-overlap', apart.error);
  }

  // 7 — retention's dependencies. Housekeeping, not correctness, so the
  // start-up sweep itself is started only once the socket listens (see
  // `startStartupRetention` after step 11): a large backlog must never keep the
  // port closed. The same dependencies serve `session.purge`
  // (`debuggen.purgeSessions`) below, so the start-up pass and the on-demand one
  // apply one rule set.
  const retentionDeps: RetentionDeps = {
    store,
    sessions: repos.sessions,
    telemetry: repos.telemetry,
    modifications: repos.modifications,
    panels: repos.panels,
    config,
    logger: root,
    ...clock,
  };

  // 8 — the model provider. Construction contacts nothing, so only a selection
  // that cannot work at all (a configuration error) can fail here; a transport
  // failure surfaces per session, in the stage that meets it.
  let provider: ModelProvider;
  if (options.provider === undefined) {
    const created = createModelProvider({
      env,
      overrides: toModelProviderOverrides(config),
      logger: root,
    });
    if (isErr(created)) {
      return refuse('model-provider', created.error);
    }
    provider = created.value;
  } else {
    provider = options.provider;
  }

  // 9 — the prompt tree, validated eagerly.
  const promptLoader = createPromptLoader({ promptsDir: config.promptsDir, env, logger: root });
  const prompts = validatePromptTree(promptLoader);
  if (isErr(prompts)) {
    return refuse('prompts', prompts.error);
  }
  loggers.service.info('model provider and prompts ready', {
    provider: provider.id,
    promptsDir: promptLoader.promptsDir,
    promptVersions: { ...prompts.value },
  });

  // 10 — subsystem wiring, in dependency order.
  // Readiness evidence is kept per DevTools credential and read for a
  // session's live binding, so the ledger reads the bindings from the registry.
  const ledger = createAgentReadyLedger({ logger: root, bindings: clients, ...clock });
  parts.ledger = ledger;
  const serverAgents = serverAgentPresenceOf(clients);
  const adapters = createAdapterRegistry({ logger: root });
  const progress = createSessionProgress({
    sessions: repos.sessions,
    broadcaster: clients,
    logger: root,
    ...clock,
  });

  // Telemetry: correlation, the live tail and ingest.
  // The trace cache is capped by entries and by total nodes (≈1 KiB each, so ≈50 MiB at most).
  const correlator = createTraceCorrelator({
    telemetry: repos.telemetry,
    logger: root,
    cacheLimit: TRACE_CACHE_LIMIT,
    cacheNodeBudget: TRACE_CACHE_NODE_BUDGET,
    maxCachedTreeNodes: TRACE_CACHE_MAX_TREE_NODES,
  });
  parts.correlator = correlator;
  // The tail reads each frame's per-capture stored count from the same
  // repository instance ingest commits through, so the panel's capture
  // counter agrees with the store rather than with the paced tail.
  const liveTail = createLiveTail({
    broadcaster: clients,
    arrivals: repos.telemetry,
    logger: root,
    ...clock,
  });
  parts.liveTail = liveTail;

  // Instrumentation: the conflict watcher, the dev-server launcher whose children
  // the readiness gate observes, and the installer driver. The driver asks the
  // session manager who owns a project's capture; the manager does not exist
  // yet (it needs the cleanup runner, which needs the driver), so the lookup is
  // late-bound and answers "nobody" until it does — before `listen`, nothing can
  // ask. The watcher's conflict listener reaches the manager through the same
  // late-bound cell, so a conflict updates the session record (and sends
  // `session.updated`) the moment the watcher reports it.
  const managerRef: { current?: SessionManager } = {};
  const watcher = createInstrumentationWatcher({
    modifications: repos.modifications,
    progress,
    listener: conflictReflectingListener(managerRef, loggers.service),
    config,
    logger: root,
    ...clock,
  });
  parts.watcher = watcher;
  const launcher = (options.createLauncher ?? createDevServerLauncher)({
    config,
    logger: root,
    credentials: serverAgentCredentialIssuer(auth),
    // Preload evidence is matched to each child's own credential, never to
    // the project (a plain server on another port would pass that test).
    serverAgentConnections: serverAgentConnectionsOf(clients),
    parentEnv: env,
    detectDeps: { serverAgents },
    stopGraceMs: DEV_SERVER_STOP_GRACE_MS,
    ...clock,
  });
  parts.launcher = launcher;
  const instrumentation = createInstrumentationService({
    config,
    // The one canonical state root, re-checked before every install writes.
    canonicalStateHome,
    logger: root,
    modifications: repos.modifications,
    progress,
    broadcaster: clients,
    agentChannel: clients,
    serverAgentChannel: clients,
    watcher,
    agents: ledger,
    serverAgents,
    devServers: launcher,
    captures: {
      captureOwnerForProject: (projectRoot: string) =>
        managerRef.current?.captureOwnerForProject(projectRoot),
    },
    adapters,
    ...clock,
  });
  parts.instrumentation = instrumentation;

  // Cleanup, then the sessions it serves. A cleanup verdict upgraded after the
  // pass — its runtime hooks confirmed dormant once a producer reconnected —
  // is recorded through the manager, the single emitter of
  // `cleanup.completed`; the manager is created after the runner, so the sink
  // is late-bound, and nothing can confirm dormancy before `listen`.
  const outcomeSink: CleanupOutcomeSink = {
    recordCleanupOutcome: (sessionId, outcome) =>
      managerRef.current === undefined
        ? err(
            new DebuggenError(
              'SESSION_INVALID_STATE',
              'The cleanup verdict arrived before the session manager was ready.',
              {
                hint: 'The session keeps its earlier cleanup verdict; end the session again to re-run cleanup.',
                details: { sessionId },
              },
            ),
          )
        : managerRef.current.recordCleanupOutcome(sessionId, outcome),
  };
  const cleanup = createSessionCleanup({
    modifications: repos.modifications,
    sessions: repos.sessions,
    config,
    instrumentation,
    watcher,
    progress,
    outcomeSink,
    logger: root,
    ...clock,
  });
  parts.cleanup = cleanup;
  const sessionManager = createSessionManager({
    sessions: repos.sessions,
    broadcaster: clients,
    progress,
    cleanup,
    // Ending a session stops the dev servers launched for it (AAP 0.7.1 Group 2).
    devServers: launcher,
    config,
    logger: root,
    ...clock,
  });
  managerRef.current = sessionManager;
  const hydrated = await sessionManager.hydrate();
  if (isErr(hydrated)) {
    return refuse('session-hydration', hydrated.error);
  }
  // The cleanup reports the previous service could not complete — a stopped
  // dev server whose credential still authenticated when it stopped — are
  // settled now that every lease it held is revoked (step 5) and the journal
  // is reconciled (step 6). A report that cannot be settled stays `partial`,
  // truthfully; a store error fails the start like the passes before it.
  const settledCleanups = await sessionManager.settleIncompleteCleanups();
  if (isErr(settledCleanups)) {
    return refuse('cleanup-settlement', settledCleanups.error);
  }
  if (settledCleanups.value > 0) {
    loggers.service.info('settled the partial cleanup reports of ended sessions', {
      settled: settledCleanups.value,
    });
  }
  // The second half of crash recovery, before the first client is served: a
  // session left `instrumenting` or `capturing` by the previous process, or
  // `ready` with patches the reconciliation above removed, is failed. A failed
  // capture's producers are owed their dormant configuration until they
  // reconnect, and its session's cleanup is held at `partial` by the runner
  // until they are confirmed dormant.
  const settled = await settleInterruptedSessions(
    {
      sessions: repos.sessions,
      manager: sessionManager,
      instrumentation,
      verdicts: cleanup,
      logger: root,
      ...clock,
    },
    reconciled.value,
  );
  if (isErr(settled)) {
    return refuse('interrupted-sessions', settled.error);
  }
  const interruptedSessions = settled.value;
  // Fail closed: a session that could not be failed would be served as still
  // capturing what the restart ended, and one whose verdict could not be held
  // would be served claiming a clean cleanup. The next start settles them again.
  const [unsettled] = interruptedSessions.errors;
  if (unsettled !== undefined) {
    return refuse(
      'interrupted-sessions',
      new DebuggenError(
        unsettled.code,
        'The sessions the previous run left in progress could not be settled, so the Debug Generator service did not start.',
        {
          hint: 'Check that the Debug Generator state directory is writable and not full, then start the service again.',
          details: {
            reason: 'interrupted-sessions-unsettled',
            sessionId: unsettled.sessionId,
            unsettled: interruptedSessions.errors.length,
          },
        },
      ),
    );
  }
  const reopener = createSessionReopener({
    sessions: repos.sessions,
    panels: repos.panels,
    broadcaster: clients,
    logger: root,
    ...clock,
  });

  const attributor = createIngestAttributor({
    sessions: repos.sessions,
    sessionManager,
    logger: root,
    ...clock,
  });
  // One code-index loader for the whole service: ingest places events in the
  // same index the pipeline stages query.
  const codeIndex = createCodeIndexLoader({ config, logger: root });
  const ingest = createTelemetryIngest({
    telemetry: repos.telemetry,
    sessions: repos.sessions,
    attributor,
    correlator,
    liveTail,
    sources: createIngestSourceLocator({
      sessions: repos.sessions,
      codeIndex,
      // Metadata first: a patch stamp's diff is read only for a file the
      // metadata found in force, and only that file's records.
      modifications: {
        listBySession: (sessionId) => repos.modifications.listCorroborationsBySession(sessionId),
        listPatchEvidence: (sessionId, file) =>
          repos.modifications.listPatchEvidenceBySessionFile(sessionId, file),
      },
      events: repos.telemetry,
      logger: root,
      ...clock,
    }),
    logger: root,
    ...clock,
  });

  // Analysis and panels.
  const summarizer = createAnalysisSummarizer({
    telemetry: repos.telemetry,
    sessions: repos.sessions,
    panels: repos.panels,
    correlator,
    logger: root,
    ...clock,
  });
  const facts = createAnalysisFacts({
    evidence: repos.telemetry,
    store: repos.panels,
    logger: root,
    ...clock,
  });
  const validator = createPanelValidator({ evidence: facts, captures: summarizer, logger: root });
  const fallback = createFallbackPanelBuilder({ validator, captures: summarizer, logger: root });
  const panelGenerator = createPanelGenerator({
    provider,
    prompts: promptLoader,
    validator,
    fallback,
    panels: repos.panels,
    captures: summarizer,
    broadcaster: clients,
    sessions: repos.sessions,
    logger: root,
  });
  const panelData = createPanelDataResolver({
    telemetry: repos.telemetry,
    correlator,
    sessions: repos.sessions,
    captures: summarizer,
    logger: root,
    ...clock,
  });

  // Source navigation.
  const sourceOpen = createSourceOpenHandler({
    sessions: repos.sessions,
    clients: sourceOpenDeliveryOf(clients, repos.sessions, loggers.server),
    logger: root,
    ...clock,
  });

  // The pipeline. The code-index loader created with ingest serves the
  // orchestrator and the capture-time readiness re-evaluation too, so a
  // project is indexed once.
  const contextBuilder = createContextBuilder({ promptLoader, config, logger: root, ...clock });
  const observe: Omit<CollectObservedReadinessDeps, 'logger' | 'now'> = {
    serverAgents,
    agents: ledger,
    devServers: launcher,
    config,
  };
  const captureReadiness = createCaptureReadinessSource({
    sessions: repos.sessions,
    instrumentation,
    codeIndex,
    adapters,
    progress,
    observe,
    serverAgentsAt: (devServerUrl) => serverAgentsAt(clients, launcher, devServerUrl),
    logger: root,
    now,
  });
  const orchestrator = createPipelineOrchestrator({
    config,
    logger: root,
    provider,
    promptLoader,
    contextBuilder,
    sessions: sessionManager,
    progress,
    sessionsRepo: repos.sessions,
    panelsRepo: repos.panels,
    telemetryRepo: repos.telemetry,
    instrumentation: withCaptureReadiness(instrumentation, captureReadiness),
    modifications: repos.modifications,
    summarizer,
    facts,
    panelGenerator,
    broadcaster: clients,
    adapters,
    observeReadiness: (request) =>
      collectObservedReadiness(
        {
          ...observe,
          serverAgents: serverAgentsAt(clients, launcher, request.devServerUrl),
          logger: root,
          now,
        },
        request,
      ),
    codeIndex,
    ...clock,
  });
  parts.orchestrator = orchestrator;

  // 11 — one HTTP server, two protocols.
  const http = createHttpApp({
    auth,
    config,
    logger: root,
    // Every session create and follow-up, and every dev-server launch and
    // credential, refuses a project root that overlaps the state root.
    canonicalStateHome,
    manager: sessionManager,
    reopener,
    orchestrator,
    sessions: repos.sessions,
    panels: repos.panels,
    modifications: repos.modifications,
    bindings: clients,
    // A new session's dev server: one the launcher started, else the URL the
    // editor sent once a loopback probe got an answer (AAP 0.2.3).
    devServers: devServerLookupFromLaunches(launcher, {
      probe: (url: string) => probeDevServer(url, { logger: root }),
    }),
    // `session.purge` (`debuggen.purgeSessions`): the start-up sweep's own
    // dependencies, reported the way the start-up sweep is, but scoped to the
    // requesting editor's workspace — the start-up pass alone is machine-wide.
    // The sweep logs its counts itself; a request that joins a running sweep of
    // its own scope shares its result. Unlike the start-up pass, this one runs
    // beside a warm trace cache, so each purged session's cached trees are
    // dropped as its rows are.
    retention: {
      purge: async (scope) => {
        const purged = await runRetention(
          {
            ...retentionDeps,
            onSessionDeleted: (sessionId) => {
              correlator.invalidate(sessionId);
            },
          },
          { scope },
        );
        if (isErr(purged)) {
          loggers.service.error('the on-demand retention sweep could not run', {
            ...errorFields(purged.error),
            reason: purged.error.message,
          });
        } else if (purged.value.errors.length > 0) {
          loggers.service.warn('the on-demand retention sweep left some items in place', {
            issues: purged.value.errors.length,
          });
        }
        return purged;
      },
    },
    resolver: panelData,
    ingest,
    launcher,
    serviceVersion: SERVICE_VERSION,
    isPairingAvailable: () => clients.list({ kind: PAIRING_DISPLAY_KIND, online: true }).length > 0,
  });
  if (isErr(http)) {
    return refuse('http', http.error);
  }
  parts.http = http.value;

  const binding = createBindingRoutes({
    clients,
    sessions: repos.sessions,
    manager: sessionManager,
    reopener,
    arming: instrumentation,
    // A tab refused a re-bind to an ended session is returned to dormant by
    // its worker, which settles the page disarm the session still owes.
    endedSessions: instrumentation,
    progress,
    // The ledger the readiness gate reads: every navigation the route accepts
    // is what lets readiness distrust a report a reload left behind.
    navigations: ledger,
    logger: root,
    ...clock,
  });
  const ws = createWsServer({
    auth,
    clients,
    binding: regatingBindingRoutes(
      reconcilingBindingRoutes(binding, instrumentation, repos.sessions, root),
      orchestrator,
      root,
    ),
    telemetry: http.value.telemetry,
    // Every report the ledger accepts also reaches the binding route, whose
    // kept navigations a new document proves reloads (and only then announces).
    readiness: regatingReadinessPort(
      observingDocumentReports(ledger, binding),
      clients,
      orchestrator,
      root,
    ),
    targets: targetSelectionOf(sessionManager),
    sourceOpen,
    producers: instrumentation,
    logger: root,
  });
  if (isErr(ws)) {
    return refuse('websocket', ws.error);
  }
  parts.ws = ws.value;

  // Every connection is bounded in number and in time before a route sees it.
  const server = createLimitedServer(
    http.value.requestListener satisfies RequestListener,
    httpLimits.value,
    loggers.server,
  );
  parts.server = server;
  const attached = ws.value.attach(server);
  if (isErr(attached)) {
    return refuse('websocket-attach', attached.error);
  }
  const listened = await listen(server, resolved);
  if (isErr(listened)) {
    return refuse('listen', listened.error);
  }
  bound.port = listened.value;
  server.on('error', (cause: unknown) => {
    loggers.server.error('the HTTP server reported an error after start-up', {
      ...describeException(cause),
    });
  });
  // Read back from the server, so the record states what is enforced.
  loggers.server.info('the HTTP server enforces its connection limits', {
    headersTimeoutMs: server.headersTimeout,
    requestTimeoutMs: server.requestTimeout,
    keepAliveTimeoutMs: server.keepAliveTimeout,
    connectionsCheckingIntervalMs: httpLimits.value.connectionsCheckingIntervalMs,
    maxConnections: server.maxConnections,
    connectionBurst: httpLimits.value.connectionBurst,
    connectionsPerSecond: httpLimits.value.connectionsPerSecond,
    maxUnengagedConnections: httpLimits.value.maxUnengagedConnections,
    reservedConnections: httpLimits.value.reservedConnections,
  });
  // Only now does a stop end live sessions: a start refused before this point
  // served no client, so it leaves every session to whoever serves them next.
  parts.liveSessions = {
    manager: sessionManager,
    sessions: repos.sessions,
    modifications: repos.modifications,
    instrumentation,
  };

  // The start-up retention sweep, now that the port is open (AAP 0.4.2: it
  // runs on every start). It runs beside live clients, so it is handed the two
  // collaborators a sweep needs while serving: the registry's view of which
  // sessions a client has touched since this process started — those are kept
  // however old, so a session reopened mid-sweep is never deleted under the
  // manager that is about to write it back — and the trace cache's
  // invalidation for every session it deletes. A stop aborts it (see
  // `releaseParts`).
  const startupRetention = startStartupRetention(
    {
      ...retentionDeps,
      isSessionInUse: (sessionId) => clients.projectForSession(sessionId) !== undefined,
      onSessionDeleted: (sessionId) => {
        correlator.invalidate(sessionId);
      },
    },
    loggers,
  );
  parts.retention = startupRetention;

  // 12 — serving. `GET /health` answers from here on.
  return ok(
    createServiceHandle({
      url: formatServiceUrl(config.host, listened.value),
      host: config.host,
      port: listened.value,
      config,
      loggers,
      store,
      manager: sessionManager,
      auth,
      startup: {
        editorCredentialCreated: editor.value.created,
        reconciliation: reconciled.value,
        interruptedSessions,
        retention: startupRetention.settled,
      },
      parts,
    }),
  );
}

/**
 * The start-up retention sweep, running in the background, and how a stop
 * ends it: {@link startStartupRetention} returns it and {@link releaseParts}
 * aborts it, then waits for it to settle before the store closes.
 */
export interface StartupRetentionRun {
  /**
   * Resolves with the sweep's report once it has finished — with
   * `interrupted: true` when a stop aborted it — or with `undefined` when it
   * could not run at all (logged at `error`). Never rejects.
   */
  readonly settled: Promise<RetentionReport | undefined>;

  /** Asks the sweep to stop at its next step boundary. Idempotent. */
  abort(): void;
}

/**
 * Starts the machine-wide start-up retention sweep **after** the listener is
 * bound, so a large backlog never keeps `GET /health` — or any client — waiting
 * (a store of half a million events once held the port closed for over a
 * minute).
 *
 * The first batch runs on a later turn of the event loop, never inside
 * {@link startService}'s own turn, so the start returns — and `main` logs
 * "listening" — before any purge work. From then on the sweep holds the event
 * loop for at most one bounded store transaction at a time (see
 * `./store/retention.ts`, "Atomic per session, bounded per transaction"), and
 * requests are served between them. A sweep that cannot run is logged and the
 * next start sweeps again; one that left items in place says how many; an
 * aborted one says so at `info`. Retention never fails a running service.
 *
 * @param deps The sweep's dependencies, in-use predicate and deletion listener
 * included.
 * @param loggers The service's loggers.
 * @returns The running sweep.
 */
function startStartupRetention(deps: RetentionDeps, loggers: ServiceLoggers): StartupRetentionRun {
  const controller = new AbortController();
  const run = async (): Promise<RetentionReport | undefined> => {
    await yieldToEventLoop();
    const swept = await runRetention(deps, { signal: controller.signal });
    if (isErr(swept)) {
      loggers.service.error(
        'the retention sweep could not run; it runs again on the next start',
        errorFields(swept.error),
      );
      return undefined;
    }
    if (swept.value.interrupted === true) {
      loggers.service.info(
        'the start-up retention sweep was stopped by the shutdown; the next start sweeps again',
        { sessionsDeleted: swept.value.sessionsDeleted },
      );
    }
    if (swept.value.errors.length > 0) {
      loggers.service.warn('the retention sweep left some items in place', {
        issues: swept.value.errors.length,
      });
    }
    return swept.value;
  };
  const settled = run().catch((cause: unknown): undefined => {
    // `runRetention` answers every failure as a `Result`; this is the guard
    // that keeps a defect from becoming an unhandled rejection.
    loggers.service.error('the start-up retention sweep failed unexpectedly', {
      ...describeException(cause),
    });
    return undefined;
  });
  return Object.freeze({
    settled,
    abort: (): void => {
      controller.abort();
    },
  });
}

/** What {@link createServiceHandle} assembles a handle from. */
interface ServiceHandleInput {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly config: ServiceConfig;
  readonly loggers: ServiceLoggers;
  readonly store: Store;
  readonly manager: SessionManager;
  readonly auth: AuthService;
  readonly startup: StartupReport;
  readonly parts: ServiceParts;
}

/**
 * Assembles the handle a successful start returns.
 *
 * The shutdown is memoised in one promise, which makes
 * {@link ServiceHandle.close} idempotent under both signals, a suite's explicit
 * call and a crash handler at once: the first caller runs the sequence and every
 * other caller awaits it, so the first caller's options decide. The handle is
 * frozen because it is shared with signal handlers and must not be re-pointed
 * by whoever holds it.
 */
function createServiceHandle(input: ServiceHandleInput): ServiceHandle {
  const { loggers, parts, url } = input;
  let closing: Promise<void> | undefined;

  const shutdown = async (options: ServiceCloseOptions): Promise<void> => {
    const liveSessions = options.liveSessions ?? 'end';
    loggers.service.info('stopping the Debug Generator service', { url, liveSessions });
    try {
      const devServers = await releaseParts(parts, loggers, { liveSessions });
      // The final record does not call the stop clean while a launched dev
      // server may still be running: it says which, or that it is unknown.
      if (devServers.kind === 'stopped') {
        loggers.service.info('the Debug Generator service has stopped', { url });
      } else {
        loggers.service.warn('the Debug Generator service has stopped', {
          url,
          devServers: devServers.kind,
          ...(devServers.kind === 'running' ? { devServerPids: devServers.pids } : {}),
        });
      }
    } catch (cause) {
      // `releaseParts` guards every step; this keeps the memoised promise
      // resolvable even if a guard is ever bypassed, because a rejected
      // `closing` would make every later `close()` reject too.
      loggers.service.error('the shutdown sequence failed', { ...describeException(cause) });
    }
  };

  return Object.freeze({
    url,
    host: input.host,
    port: input.port,
    wsPath: WS_PATH,
    config: input.config,
    logger: loggers.root,
    store: input.store,
    manager: input.manager,
    auth: input.auth,
    startup: Object.freeze(input.startup),
    close: (options: ServiceCloseOptions = {}): Promise<void> => {
      closing ??= shutdown(options);
      return closing;
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * The process
 * ---------------------------------------------------------------------------------------------- */

/**
 * How long after a completed shutdown the process is ended explicitly if
 * something outside the service's control still holds the event loop open (a
 * third-party handle, a child that ignored every signal). `unref`'d, so a clean
 * stop exits on its own well before it fires. Part of the service's lifetime
 * after `SIGTERM`, so {@link SHUTDOWN_BUDGET} plus this value is what the
 * managing processes' graces are checked against.
 */
export const EXIT_BACKSTOP_MS = 500;

/**
 * Writes a start-up failure to stderr in the form a developer reads in a
 * terminal or in Playwright's captured output: the code, the message and the
 * hint, in one write so the lines cannot interleave with another writer's.
 * stderr rather than the logger, because a failure may predate a usable
 * logger (a rejected `DEBUGGEN_LOG_LEVEL` is itself a configuration failure).
 * `details` are deliberately omitted: they are diagnostic context for the log.
 *
 * The message is printed only when it is product copy — a configuration
 * refusal, a {@link wrapStartupFailure} sentence, a collaborator's own
 * sentence. A failure that reached here through `DebuggenError.from` (a
 * collaborator's catch-all, or this module's own last-resort `catch`) carries
 * the wrapped exception's text instead, which may quote a path, an address or
 * a statement, and the terminal, the VS Code output channel and Playwright's
 * captured output all keep what is written here; so {@link carriesWrappedExceptionText}
 * swaps it for {@link STARTUP_FAILURE_FALLBACK_MESSAGE} and a `cause:` line
 * naming the wrapped value's closed class and code, and prints such a
 * failure's hint only when {@link isProductAuthoredText} proves it, else
 * {@link STARTUP_FAILURE_FALLBACK_HINT} (CWE-209).
 */
function reportStartupFailure(error: DebuggenError): void {
  const wrapped = carriesWrappedExceptionText(error);
  const lines = [
    `debuggen: ${error.code}: ${wrapped ? STARTUP_FAILURE_FALLBACK_MESSAGE : error.message}`,
  ];
  if (wrapped) {
    const cause = describeException(error.cause);
    const causeCode = cause.errorCode === undefined ? '' : ` ${cause.errorCode}`;
    lines.push(`debuggen: cause: ${cause.errorClass}${causeCode}`);
  }
  // A wrapped failure's hint is as untrusted as its message — `DebuggenError.from`
  // salvages one from a branded foreign error — so it is printed only when it is
  // proven product text; otherwise the fixed fallback hint is.
  const hint = wrapped
    ? isProductAuthoredText(error.hint)
      ? error.hint
      : STARTUP_FAILURE_FALLBACK_HINT
    : error.hint;
  if (hint !== undefined) {
    lines.push(`debuggen: hint: ${hint}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * Wires the process's signals and crash handlers to one shutdown.
 *
 * - **SIGINT / SIGTERM** close the handle once, ending every live session so
 *   the developer's files are restored and the producers disarmed before the
 *   process exits (AAP 0.5.1). A repeated signal while the shutdown is running
 *   — Ctrl-C pressed twice — ends the process at once; the journal is durable,
 *   so the next start still restores every patched file.
 * - **`uncaughtException` / `unhandledRejection`** are logged at `fatal`
 *   through the service's own logger, set exit code 1 and run the same
 *   shutdown with `liveSessions: 'retain'`, so a crash is never silent and
 *   never leaves a listening socket in a state nobody can reason about, while
 *   the state that has just thrown does not drive writes into the developer's
 *   tree — the next start's reconciliation restores those files from the
 *   journal.
 *
 * `process.exitCode` is set rather than exiting at once, so stdout still flushes
 * the record that explains the exit; an `unref`'d backstop ends the process if
 * something outside the service keeps it alive after the shutdown completed.
 */
function installProcessHandlers(handle: ServiceHandle): void {
  const lifecycle = subsystemLogger(handle.logger, SUBSYSTEM_SERVICE);
  let stopping = false;

  const stop = (reason: string, fields: LogFields, liveSessions: LiveSessionDisposition): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    lifecycle.info(reason, fields);
    void handle.close({ liveSessions }).then(() => {
      setTimeout(() => {
        lifecycle.warn('the process was still alive after shutdown; exiting', {
          backstopMs: EXIT_BACKSTOP_MS,
        });
        process.exit();
      }, EXIT_BACKSTOP_MS).unref();
    });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (stopping) {
        lifecycle.warn('received a second shutdown signal; exiting without waiting', { signal });
        process.exit(process.exitCode ?? 1);
      }
      stop('received a shutdown signal', { signal }, 'end');
    });
  }

  const crash = (kind: string, cause: unknown): void => {
    // A value that reached the process boundary is by definition one no step
    // anticipated, so none of its own text is known to be safe: the record
    // carries its product code and its closed class only.
    lifecycle.fatal(`${kind} reached the process boundary`, {
      code: DebuggenError.from(cause, 'INTERNAL').code,
      ...describeException(cause),
    });
    process.exitCode = 1;
    stop(`stopping after ${kind}`, {}, 'retain');
  };

  process.on('uncaughtException', (cause: unknown) => {
    crash('an uncaught exception', cause);
  });
  process.on('unhandledRejection', (cause: unknown) => {
    crash('an unhandled promise rejection', cause);
  });
}

/**
 * The process entry: loads `.env`, starts the service and wires the signals.
 *
 * The only function in this workspace that reads `process.env`, sets the exit
 * code or installs signal handlers. `dotenv` runs here and nowhere else —
 * quietly, and without inspecting its result, because an absent `.env` is the
 * normal case — so an injected environment in a suite stays authoritative.
 *
 * On failure it prints the code, message and hint to stderr and sets exit code
 * 1. On success it logs the listening URL once, which is the line a developer
 * looks for and the one Playwright's captured output shows.
 *
 * @returns A promise that resolves once the service is listening or the failure
 * has been reported. It does not wait for the service to stop: the bound socket
 * keeps the process alive, and the signal handlers end it.
 */
export async function main(): Promise<void> {
  loadDotenvFile({ quiet: true });

  // The DDL the editor extension's bundle embeds (none in any other build), so
  // the packaged service migrates its store without a `.sql` file on disk.
  const started = await startService({ env: process.env, inlineSchemaSql: embeddedSchemaSql() });
  if (isErr(started)) {
    reportStartupFailure(started.error);
    process.exitCode = 1;
    return;
  }

  const handle = started.value;
  installProcessHandlers(handle);
  handle.logger.info('the Debug Generator service is listening', {
    subsystem: SUBSYSTEM_SERVICE,
    url: handle.url,
    host: handle.host,
    port: handle.port,
    wsPath: handle.wsPath,
    protocolVersion: PROTOCOL_VERSION,
    healthRoute: HEALTH_ROUTE,
  });
}

/**
 * Whether this module is the program the runtime was asked to run.
 *
 * Compares the real path of `process.argv[1]` with the real path of this module,
 * which holds for both supported invocations — `node dist/main.js` and
 * `tsx watch src/main.ts` — and through a symbolic link in either path. It is
 * what lets a suite `import` this module for {@link startService} without a
 * listener appearing as a side effect of the import.
 *
 * @param argv The process arguments, injectable so the decision can be tested.
 * @param moduleUrl This module's URL, injectable for the same reason.
 * @returns `true` only when the entry script is this module.
 */
export function isProcessEntry(
  argv: readonly string[] = process.argv,
  moduleUrl: string = import.meta.url,
): boolean {
  const entry = argv[1];
  if (entry === undefined || entry.length === 0) {
    return false;
  }
  try {
    // Inside the `try`: a module URL that is not a `file:` URL (a bundler that
    // rewrote `import.meta`) must answer `false`, never throw at import time.
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(entry).href === moduleUrl;
  }
}

if (isProcessEntry()) {
  main().catch((cause: unknown) => {
    // `main` handles every failure it can name; this covers the ones it cannot,
    // so the process still reports a reason and a non-zero status.
    reportStartupFailure(DebuggenError.from(cause, 'INTERNAL'));
    process.exitCode = 1;
  });
}
