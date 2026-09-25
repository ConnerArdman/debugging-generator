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
 *   until it answers and stops the process with **SIGTERM** and a 10 s grace
 *   period, so the health route and the signal handling are load-bearing for
 *   every browser and end-to-end suite (AAP 0.8.3).
 * - `apps/vscode-extension/esbuild.mjs` re-bundles these same sources into the
 *   VSIX, which is why every import is static and top-level (a computed
 *   `import()` of a local module would not survive that second bundle), why
 *   the prompt directory is always taken from `config.promptsDir` and never
 *   assumed to sit beside the bundle, and why {@link StartServiceOptions}
 *   accepts the store DDL inline.
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
 *    after `dotenv`, so a suite's injected environment is authoritative.
 * 2. **Logging** — one root logger, a `subsystem` child per area; the resolved
 *    configuration is logged once through its credential-free view.
 * 3. **The state tree** — `$DEBUGGEN_HOME`, `backups/` and `index/`, created and
 *    verified `0700` and symlink-free by `ensureSecureDir` (mkdir's own mode is
 *    umask-masked, which is why it is not used).
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
 *    session.
 * 7. **Retention — before serving** (AAP 0.4.2): `runRetention` purges aged
 *    sessions, stale index caches and orphan backups, conflict backups exempt.
 * 8. **The model provider** — `createModelProvider` over the validated
 *    selection. An unusable selection is a configuration error and fails the
 *    start; a transport failure is a runtime condition reported per session by
 *    the stage that meets it (AAP 0.5.5), so nothing is contacted here.
 * 9. **The prompt tree** — `createPromptLoader` over `config.promptsDir`, then
 *    the manifest and every stage's current prompt are loaded eagerly, so a
 *    broken prompt tree fails the start rather than a session.
 * 10. **Subsystem wiring**, in dependency order, each handed only the
 *     collaborators it declares.
 * 11. **One HTTP server, two protocols** — a single `node:http` server whose
 *     request listener is the hono application of `./server/http.js` and whose
 *     `upgrade` event is routed to the WebSocket server of `./server/ws.js` at
 *     protocol's `WS_PATH`. The bound port is read back, so `port: 0` yields a
 *     usable {@link ServiceHandle.url}.
 * 12. **Health** — `GET /health`, auth-exempt, answers from the first accepted
 *     connection.
 *
 * ## What this file adds beside the subsystems
 *
 * A composition root composes. The only code of its own is the process
 * lifecycle and the adapters that bind one subsystem's declared port to
 * another's concrete surface where the two are not already structurally the
 * same object:
 *
 * - an **agent-readiness ledger** — the relayed `agent.ready` reports per tab,
 *   written by the WebSocket router and read by the readiness gate;
 * - the **server-agent presence** view of the client registry;
 * - the **source-open delivery** port over the client registry;
 * - the **credential issuer** the dev-server launcher mints its scoped
 *   `server-agent` credentials through;
 * - the **capture-time readiness re-evaluation** the capture stage uses to move
 *   a session whose page was not ready at install time to `ready`;
 * - an **effective configuration** whose `port` is the bound port once the
 *   socket listens, which is what a launched dev server's ingest URL and the
 *   dev-server probe's self-exclusion need under `port: 0`.
 *
 * ## Shutdown
 *
 * {@link ServiceHandle.close} is idempotent and bounded. It stops accepting
 * requests, cancels in-flight pipeline work, stops the dev servers this service
 * launched (which expires their scoped credentials), closes every WebSocket
 * with the normal going-away code (never 4401, which means unauthorized),
 * releases the in-memory subsystems and finally checkpoints and closes the
 * database. It deliberately does **not** restore instrumented files: the
 * journal is durable and step 6 of the next start restores them, so a stuck
 * restore can never hold up a stop, and a stop that is killed part-way loses
 * nothing (AAP 0.5.1 lists service start as a cleanup trigger for exactly this
 * reason).
 */

import { config as loadDotenvFile } from 'dotenv';

import { createAdapterRegistry, type AdapterRegistry } from '@debuggen/instrumentation';
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
  WS_PATH,
  type AgentReadyPayload,
  type ClientKind,
  type ProtocolMessage,
  type SelectedTarget,
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
import { ensureSecureDir } from '@debuggen/shared/node';

import { realpathSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { reconcileModificationsOnStartup, createSessionCleanup } from './cleanup/cleanup.js';
import type { SessionCleanup, StartupReconciliationReport } from './cleanup/cleanup.js';
import {
  describeServiceConfig,
  loadServiceConfig,
  toModelProviderOverrides,
  type ServiceConfig,
  type ServiceConfigOverrides,
} from './config.js';
import { createDevServerLauncher } from './dev-server/launcher.js';
import type { DevServerLauncher, ServerAgentCredentialIssuer } from './dev-server/launcher.js';
import {
  MAX_RELOAD_WAIT_MS,
  collectObservedReadiness,
  collectReadinessEvidence,
  evaluateReadiness,
} from './instrumentation/readiness.js';
import type {
  BrowserAgentRegistry,
  CollectObservedReadinessDeps,
  ReadinessVerdict,
  ServerAgentReadinessSource,
  WaitForAgentReadyOptions,
} from './instrumentation/readiness.js';
import { createInstrumentationService } from './instrumentation/service.js';
import type { CodeAnalysisHandles, InstrumentationService } from './instrumentation/service.js';
import { createInstrumentationWatcher } from './instrumentation/watcher.js';
import type { InstrumentationWatcher } from './instrumentation/watcher.js';
import { createServiceLogger, subsystemLogger, type ServiceLoggerOptions } from './logging.js';
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
import type { AuthService } from './server/auth.js';
import { WS_CLOSE_GOING_AWAY, createClientRegistry } from './server/clients.js';
import type { ClientRegistry } from './server/clients.js';
import { createHttpApp } from './server/http.js';
import type { HttpApp } from './server/http.js';
import { createBindingRoutes } from './server/routes/binding.js';
import type { BindingRoutes } from './server/routes/binding.js';
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
import { createSessionProgress } from './sessions/progress.js';
import type { SessionProgress } from './sessions/progress.js';
import { createSessionReopener } from './sessions/reopen.js';
import { createSourceOpenHandler } from './source/open.js';
import type { SourceOpenClientPort } from './source/open.js';
import { createSourceResolver } from './source/resolve.js';
import type { ModificationCorroborationPort, ParentEventPort } from './source/resolve.js';
import { openStore } from './store/db.js';
import type { Store } from './store/db.js';
import { createModificationsRepo } from './store/modifications-repo.js';
import type { ModificationsRepo } from './store/modifications-repo.js';
import { createPanelsRepo } from './store/panels-repo.js';
import type { PanelsRepo } from './store/panels-repo.js';
import { runRetention } from './store/retention.js';
import type { RetentionReport } from './store/retention.js';
import { createSessionsRepo } from './store/sessions-repo.js';
import type { SessionsRepo } from './store/sessions-repo.js';
import { createTelemetryRepo } from './store/telemetry-repo.js';
import type { TelemetryRepo } from './store/telemetry-repo.js';
import { createIngestAttributor } from './telemetry/attribute.js';
import { createTraceCorrelator } from './telemetry/correlate.js';
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
 * this bounds the in-flight ones so the rest of the shutdown sequence runs well
 * inside Playwright's 10 s SIGTERM window.
 */
const HTTP_DRAIN_GRACE_MS = 3_000;

/**
 * The bound on each awaited shutdown step, in milliseconds. A step that has not
 * settled by then is logged as abandoned and the sequence moves on, so a stuck
 * collaborator — a dev server that ignores SIGTERM, a pipeline stage blocked on
 * the network — cannot keep the process alive. The launcher's own escalation to
 * SIGKILL happens inside this window (its default grace is 5 s).
 */
const SHUTDOWN_STEP_TIMEOUT_MS = 6_000;

/**
 * How often the client registry sweeps: it unregisters connections that stayed
 * offline past their grace period and closes any whose credential has expired.
 * The timer is `unref`'d by the registry and stopped by `closeAll`.
 */
const CLIENT_SWEEP_INTERVAL_MS = 30_000;

/**
 * The most tabs the agent-readiness ledger remembers a report for. One entry per
 * inspected tab; the oldest report is forgotten first, which is harmless because
 * the page agent reports again on its next document load.
 */
const MAX_TRACKED_AGENT_TABS = 256;

/** The client kind that can display a pairing code (AAP 0.5.6). */
const PAIRING_DISPLAY_KIND: ClientKind = 'vscode';

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
   */
  readonly inlineSchemaSql?: string | undefined;
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
   * The retention sweep's report, or `undefined` when the sweep could not run
   * at all (logged at `error`; retention never blocks a start).
   */
  readonly retention: RetentionReport | undefined;
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
   * call returns the same promise — bounded, and never rejects.
   */
  close(): Promise<void>;
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
interface ServiceLoggers {
  readonly root: Logger;
  readonly service: Logger;
  readonly server: Logger;
}

/**
 * Everything a start acquires that must be released again, filled in as the
 * start proceeds. One shutdown sequence ({@link releaseParts}) reads it, both
 * for {@link ServiceHandle.close} and for a start that fails part-way, so the
 * two paths cannot release in different orders.
 */
interface ServiceParts {
  store?: Store;
  auth?: AuthService;
  clients?: ClientRegistry;
  ledger?: AgentReadyLedger;
  watcher?: InstrumentationWatcher;
  instrumentation?: InstrumentationService;
  cleanup?: SessionCleanup;
  correlator?: TraceCorrelator;
  liveTail?: LiveTail;
  launcher?: DevServerLauncher;
  orchestrator?: PipelineOrchestrator;
  http?: HttpApp;
  ws?: WsServer;
  server?: Server;
}

/** The repositories over the one store, built once and shared. */
interface Repositories {
  readonly sessions: SessionsRepo;
  readonly panels: PanelsRepo;
  readonly telemetry: TelemetryRepo;
  readonly modifications: ModificationsRepo;
}

/* -------------------------------------------------------------------------------------------------
 * Failure reporting
 * ---------------------------------------------------------------------------------------------- */

/**
 * Wraps a caught value as the typed error a caller reports, keeping the original
 * reachable as `cause`. A specific code raised deeper survives; anything else
 * takes `fallbackCode`. The underlying message goes into `details.reason`, so
 * what a user interface renders stays short and stable.
 *
 * @param cause The caught value.
 * @param fallbackCode The code to apply when `cause` carries none.
 * @param message A complete sentence naming what failed.
 * @param hint The developer's next step.
 * @param details Diagnostic context — paths, ports, reasons; logged, so nothing
 * secret belongs in it.
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
    details: { ...details, reason: normalized.message },
    cause,
  });
}

/**
 * The loggable view of a failure: its code, hint and details beside the
 * message, never the message twice.
 */
function errorFields(error: DebuggenError): LogFields {
  return {
    code: error.code,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/** The message of a caught value, for a `reason` field; never the value itself. */
function reasonOf(cause: unknown): string {
  return DebuggenError.from(cause, 'INTERNAL').message;
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

/**
 * Awaits `work` for at most `timeoutMs`, never rejecting.
 *
 * Used for every awaited shutdown step. A rejection is logged; a timeout is
 * logged as the step being abandoned (what AAP-level "force-killed" means for a
 * step this file does not own — the launcher escalates its own children to
 * SIGKILL inside the window). The timer is cleared on settlement and `unref`'d,
 * so the bound itself never keeps the event loop alive.
 *
 * @param work The step, started by the caller.
 * @param timeoutMs The bound.
 * @param step A short name for the log record.
 * @param logger Where the outcome is reported.
 * @returns Whether the step settled within the bound.
 */
async function settleWithin(
  work: Promise<unknown>,
  timeoutMs: number,
  step: string,
  logger: Logger,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
    timer.unref();
  });

  const settled = work.then(
    () => 'settled' as const,
    (cause: unknown) => {
      logger.error('a shutdown step failed; continuing with the next one', {
        step,
        reason: reasonOf(cause),
      });
      return 'settled' as const;
    },
  );

  try {
    const outcome = await Promise.race([settled, timeout]);
    if (outcome === 'timeout') {
      logger.warn('a shutdown step did not finish in time and was abandoned', {
        step,
        timeoutMs,
      });
      return false;
    }
    return true;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
      reason: reasonOf(cause),
    });
  }
}

/* -------------------------------------------------------------------------------------------------
 * Composition adapters
 * ---------------------------------------------------------------------------------------------- */

/**
 * The relayed page-agent reports, per tab: the one object that is both the
 * WebSocket router's {@link AgentReadinessPort} (where a relayed `agent.ready`
 * is written) and the readiness gate's {@link BrowserAgentRegistry} (where it
 * is read), so the report the gate judges is exactly the report the router
 * accepted.
 */
export interface AgentReadyLedger extends AgentReadinessPort, BrowserAgentRegistry {
  /**
   * Records a relayed report as the tab's newest one and wakes the waits it
   * answers. Synchronous; refused with `TRANSPORT_DISCONNECTED` after
   * {@link AgentReadyLedger.close}.
   */
  agentReady(
    payload: AgentReadyPayload,
    client: WsConnectionFacts,
  ): Result<AgentReadyReceipt, DebuggenError>;

  /** When the report {@link BrowserAgentRegistry.latestAgentReady} returns was received. */
  latestAgentReadyAt(tabId: number): number | undefined;

  /** Resolves every pending wait with `undefined` and forgets every report. Idempotent. */
  close(): void;
}

/** What {@link AgentReadyLedger.agentReady} acknowledges: the tab and document recorded. */
export interface AgentReadyReceipt {
  readonly tabId: number;
  readonly documentId: string;
}

/** Collaborators of {@link createAgentReadyLedger}. */
export interface AgentReadyLedgerDeps {
  /** Where accepted reports are noted at `debug`. Never receives a page URL. */
  readonly logger: Logger;
  /** The clock a report is stamped with, in epoch milliseconds. */
  readonly now?: (() => number) | undefined;
  /** The most tabs remembered; the oldest report is forgotten first. */
  readonly maxTabs?: number | undefined;
}

/** One stored report and when it arrived. */
interface AgentReport {
  readonly payload: AgentReadyPayload;
  readonly receivedAt: number;
}

/** One pending {@link BrowserAgentRegistry.waitForAgentReady}. */
interface AgentWaiter {
  readonly afterDocumentId: string | undefined;
  readonly settle: (payload: AgentReadyPayload | undefined) => void;
}

/**
 * Creates the agent-readiness ledger.
 *
 * The ledger replaces a tab's report on every accepted `agent.ready`, so the
 * newest document's facts are the only ones returned; the WebSocket router
 * calls it only after the relaying DevTools connection has been authorized for
 * the tab the report names. A wait resolves with the first report whose
 * document differs from the one the caller already knows (or with any report
 * when it knows none), with `undefined` on its timeout, on abort and on
 * {@link AgentReadyLedger.close}; it never rejects and never outlives its bound.
 *
 * @param deps The logger, and optionally a clock and a size bound.
 * @returns The ledger.
 *
 * @example
 * ```ts
 * const ledger = createAgentReadyLedger({ logger });
 * ledger.agentReady(payload, connection); // from the WebSocket router
 * ledger.latestAgentReady(payload.tabId); // → payload
 * ```
 */
export function createAgentReadyLedger(deps: AgentReadyLedgerDeps): AgentReadyLedger {
  const log = subsystemLogger(deps.logger, SUBSYSTEM_READINESS);
  const now = deps.now ?? nowEpochMs;
  const requestedMax = deps.maxTabs ?? MAX_TRACKED_AGENT_TABS;
  const maxTabs =
    Number.isSafeInteger(requestedMax) && requestedMax > 0 ? requestedMax : MAX_TRACKED_AGENT_TABS;
  const reports = new Map<number, AgentReport>();
  const waiters = new Map<number, Set<AgentWaiter>>();
  let closed = false;

  /** Stores a report as the tab's most recent one, evicting beyond the bound. */
  function remember(tabId: number, report: AgentReport): void {
    reports.delete(tabId);
    reports.set(tabId, report);
    while (reports.size > maxTabs) {
      const oldest = reports.keys().next();
      if (oldest.done === true) {
        break;
      }
      reports.delete(oldest.value);
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
    remember(payload.tabId, { payload, receivedAt: now() });
    log.debug('recorded a page-agent readiness report', {
      tabId: payload.tabId,
      documentId: payload.documentId,
      reactDetected: payload.reactDetected,
      installedBeforeReact: payload.installedBeforeReact,
      clientId: client.id,
    });
    const pending = waiters.get(payload.tabId);
    if (pending !== undefined) {
      for (const waiter of [...pending]) {
        if (answers(waiter.afterDocumentId, payload)) {
          waiter.settle(payload);
        }
      }
    }
    return ok({ tabId: payload.tabId, documentId: payload.documentId });
  }

  function waitForAgentReady(
    tabId: number,
    options: WaitForAgentReadyOptions,
  ): Promise<AgentReadyPayload | undefined> {
    const current = reports.get(tabId)?.payload;
    if (current !== undefined && answers(options.afterDocumentId, current)) {
      return Promise.resolve(current);
    }
    if (closed || options.signal?.aborted === true) {
      return Promise.resolve(undefined);
    }

    const requested = options.timeoutMs ?? MAX_RELOAD_WAIT_MS;
    const timeoutMs = Math.min(Math.max(0, requested), MAX_RELOAD_WAIT_MS);

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
    reports.clear();
  }

  return Object.freeze({
    agentReady,
    latestAgentReady: (tabId: number): AgentReadyPayload | undefined => reports.get(tabId)?.payload,
    latestAgentReadyAt: (tabId: number): number | undefined => reports.get(tabId)?.receivedAt,
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
 * The dev-server launcher's credential port, over the access boundary: a
 * launched child receives a `server-agent` credential scoped to its one project
 * root (AAP 0.5.6), and the credentials of that project are revoked when the
 * child exits or is stopped.
 */
function credentialIssuerOf(auth: AuthService): ServerAgentCredentialIssuer {
  return Object.freeze({
    issue: (input: { readonly projectRoot: string; readonly expiresAt?: number | undefined }) =>
      auth.issueServerAgentCredential({
        projectRoot: input.projectRoot,
        expiresAt: input.expiresAt,
      }),
    revoke: (input: { readonly projectRoot: string }) =>
      auth.revokeServerAgentCredentials(input.projectRoot),
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
 */
function targetSelectionOf(manager: SessionManager): TargetSelectionPort {
  return Object.freeze({
    selected: (sessionId: SessionId, target: SelectedTarget) =>
      manager.patch(sessionId, { target }),
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
  /** The modification journal the patch route corroborates a stamp against. */
  readonly modifications: ModificationCorroborationPort;
  /** The stored spans a database query's enclosing function is found through. */
  readonly events: ParentEventPort;
  /** The service's root logger. */
  readonly logger: Logger;
}

/**
 * The source-location port of telemetry ingest (its step 7½): each batch is
 * resolved by `./source/resolve.ts` over the batch's own session — its project
 * root, its code index, the modification journal, the stored parent spans and
 * its dev-server URL, which pins where the source-map route may fetch a chunk's
 * map from (AAP §0.4.2, "Source resolution path").
 *
 * The resolver is built per batch, so one batch shares one source-map cache
 * and a chunk the dev server rebuilt between batches is never mapped through
 * a stale document. The code index is the pipeline's, normally loaded already
 * by the session's own stages; a load that is still running is shared rather
 * than started again for every batch of a burst. An index that cannot be
 * loaded leaves the routes that need none — patch metadata and the source map
 * — to answer on their own.
 *
 * @param deps The session store, code index, journal, telemetry store and logger.
 * @returns The port handed to `createTelemetryIngest`.
 */
export function createIngestSourceLocator(deps: IngestSourceLocatorDeps): IngestSourceLocator {
  const loading = new Map<string, Promise<Result<PipelineCodeHandles, DebuggenError>>>();

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
    locate: async (events, attribution) => {
      const session = deps.sessions.get(attribution.sessionId);
      if (!session.ok) {
        return session;
      }
      const record = session.value;
      if (record === undefined) {
        return ok(new Map());
      }
      const code = await codeFor(record.projectRoot);
      const handles = code.ok ? code.value : undefined;
      const resolver = createSourceResolver({
        projectRoot: record.projectRoot,
        queries: handles?.queries,
        routeMap: handles?.routeMap,
        graph: handles?.graph,
        modifications: deps.modifications,
        events: deps.events,
        devServerOrigin: record.devServerUrl,
        logger: deps.logger,
      });
      return resolver.resolveEvents(events);
    },
  } satisfies IngestSourceLocator);
}

/** Collaborators of {@link createCaptureReadinessSource}. */
interface CaptureReadinessDeps {
  readonly sessions: Pick<SessionsRepo, 'get'>;
  readonly instrumentation: Pick<InstrumentationService, 'buildContext'>;
  readonly codeIndex: CodeIndexPort;
  readonly adapters: AdapterRegistry;
  readonly progress: SessionProgress;
  readonly observe: Omit<CollectObservedReadinessDeps, 'logger' | 'now'>;
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
    const devServerUrl = session.value?.devServerUrl;

    const evidence = await collectReadinessEvidence(
      { ...deps.observe, logger: deps.logger, now: deps.now },
      {
        sessionId: request.sessionId,
        projectRoot: request.projectRoot,
        boundTab: request.boundTab,
        plan: request.plan,
        devServerUrl:
          devServerUrl === undefined || devServerUrl.length === 0 ? undefined : devServerUrl,
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
      const binding = recorded.ok ? bindings.bindingForTab(payload.tabId) : undefined;
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

/**
 * Releases everything in `parts`, in the one order both a failed start and
 * {@link ServiceHandle.close} use. Every step is guarded, awaited steps are
 * bounded by {@link SHUTDOWN_STEP_TIMEOUT_MS}, and nothing here throws:
 *
 * 1. stop accepting — new requests on a kept-alive connection are answered
 *    `503`, the listener stops accepting, pending agent-readiness waits resolve;
 * 2. stop the cleanup runner (the journal stays durable; the next start
 *    restores anything a cut-short cleanup left) and cancel in-flight pipeline
 *    operations, which may otherwise still be writing the store;
 * 3. stop the dev servers this service launched, which also revokes their
 *    scoped `server-agent` credentials;
 * 4. flush the live tail, then close every WebSocket with the going-away code
 *    and wait for the HTTP server to finish;
 * 5. release the in-memory subsystems and the client registry;
 * 6. checkpoint the write-ahead log and close the database — last, so nothing
 *    above can write to a closed store.
 */
async function releaseParts(parts: ServiceParts, loggers: ServiceLoggers): Promise<void> {
  const log = loggers.service;
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
  } = parts;

  // 1 — stop accepting.
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

  // 2 — cleanup and pipeline work in flight.
  if (cleanup !== undefined) {
    releaseQuietly('session-cleanup', log, () => {
      cleanup.dispose();
    });
  }
  if (orchestrator !== undefined) {
    await settleWithin(orchestrator.dispose(), SHUTDOWN_STEP_TIMEOUT_MS, 'pipeline', log);
  }

  // 3 — launched dev servers and their credentials.
  if (launcher !== undefined) {
    await settleWithin(launcher.dispose(), SHUTDOWN_STEP_TIMEOUT_MS, 'dev-servers', log);
  }

  // 4 — the live tail, the sockets, the listener.
  if (liveTail !== undefined) {
    await settleWithin(liveTail.flush(), SHUTDOWN_STEP_TIMEOUT_MS, 'live-tail', log);
  }
  if (ws !== undefined) {
    await settleWithin(ws.close(), SHUTDOWN_STEP_TIMEOUT_MS, 'websockets', log);
  }
  await settleWithin(serverClosed, SHUTDOWN_STEP_TIMEOUT_MS, 'http-server', log);

  // 5 — in-memory subsystems.
  if (instrumentation !== undefined) {
    await settleWithin(instrumentation.dispose(), SHUTDOWN_STEP_TIMEOUT_MS, 'instrumentation', log);
  }
  if (watcher !== undefined) {
    await settleWithin(watcher.dispose(), SHUTDOWN_STEP_TIMEOUT_MS, 'watcher', log);
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

  // 6 — the store, last.
  if (store !== undefined) {
    releaseQuietly('store', log, () => {
      store.close();
    });
  }
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
 * the provider selection or the prompt tree, `FS_UNSAFE_PATH` from the state
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

  // 1 — configuration, from the injected environment only.
  const loaded = loadServiceConfig(env, options.overrides);
  if (isErr(loaded)) {
    return loaded;
  }
  const resolved = loaded.value;

  // 2 — logging. The configuration is logged once, through its credential-free
  // view, on the root (its fields carry their own `subsystem`).
  const root = options.logger ?? createServiceLogger(resolved, options.loggerOptions);
  const loggers: ServiceLoggers = {
    root,
    service: subsystemLogger(root, SUBSYSTEM_SERVICE),
    server: subsystemLogger(root, SUBSYSTEM_SERVER),
  };
  root.info('service configuration resolved', describeServiceConfig(resolved));

  // Written once, when `listen` resolves; read by the effective configuration.
  const bound: { port?: number } = {};
  const config = createEffectiveConfig(resolved, () => bound.port);

  // 3 — the state tree, before anything writes into it.
  const tree = prepareStateTree(config);
  if (isErr(tree)) {
    loggers.service.error(tree.error.message, errorFields(tree.error));
    return tree;
  }

  const parts: ServiceParts = {};
  const refuse = async (error: DebuggenError): Promise<Result<never, DebuggenError>> => {
    loggers.service.error(error.message, errorFields(error));
    await releaseParts(parts, loggers);
    return err(error);
  };

  // 4 — the session store and its repositories.
  const opened = openStore({ config, logger: root, inlineDdl: options.inlineSchemaSql });
  if (isErr(opened)) {
    return refuse(opened.error);
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
    revoker: clients,
    ...clock,
  });
  if (isErr(authCreated)) {
    return refuse(authCreated.error);
  }
  const auth = authCreated.value;
  parts.auth = auth;
  const editor = auth.ensureEditorCredential();
  if (isErr(editor)) {
    return refuse(editor.error);
  }
  loggers.service.info('editor credential ready', {
    authFilePath: config.authFilePath,
    created: editor.value.created,
  });

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
    return refuse(reconciled.error);
  }
  if (reconciled.value.conflicts > 0 || reconciled.value.unresolved > 0) {
    loggers.service.warn('start-up reconciliation left files for the developer to resolve', {
      status: reconciled.value.status,
      conflicts: reconciled.value.conflicts,
      unresolved: reconciled.value.unresolved,
      restored: reconciled.value.restored,
    });
  }

  // 7 — retention. Housekeeping, not correctness: a sweep that cannot run is
  // logged and the start continues, and the next start sweeps again.
  const swept = await runRetention({
    store,
    sessions: repos.sessions,
    telemetry: repos.telemetry,
    modifications: repos.modifications,
    panels: repos.panels,
    config,
    logger: root,
    ...clock,
  });
  let retention: RetentionReport | undefined;
  if (isErr(swept)) {
    loggers.service.error('the retention sweep could not run; it runs again on the next start', {
      ...errorFields(swept.error),
      reason: swept.error.message,
    });
  } else {
    retention = swept.value;
    if (swept.value.errors.length > 0) {
      loggers.service.warn('the retention sweep left some items in place', {
        issues: swept.value.errors.length,
      });
    }
  }

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
      return refuse(created.error);
    }
    provider = created.value;
  } else {
    provider = options.provider;
  }

  // 9 — the prompt tree, validated eagerly.
  const promptLoader = createPromptLoader({ promptsDir: config.promptsDir, env, logger: root });
  const prompts = validatePromptTree(promptLoader);
  if (isErr(prompts)) {
    return refuse(prompts.error);
  }
  loggers.service.info('model provider and prompts ready', {
    provider: provider.id,
    promptsDir: promptLoader.promptsDir,
    promptVersions: { ...prompts.value },
  });

  // 10 — subsystem wiring, in dependency order.
  const ledger = createAgentReadyLedger({ logger: root, ...clock });
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
  const correlator = createTraceCorrelator({ telemetry: repos.telemetry, logger: root });
  parts.correlator = correlator;
  const liveTail = createLiveTail({ broadcaster: clients, logger: root, ...clock });
  parts.liveTail = liveTail;

  // Instrumentation: the conflict watcher, the dev-server launcher whose children
  // the readiness gate observes, and the installer driver. The driver asks the
  // session manager who owns a project's capture; the manager does not exist
  // yet (it needs the cleanup runner, which needs the driver), so the lookup is
  // late-bound and answers "nobody" until it does — before `listen`, nothing can
  // ask.
  const watcher = createInstrumentationWatcher({
    modifications: repos.modifications,
    progress,
    config,
    logger: root,
    ...clock,
  });
  parts.watcher = watcher;
  const launcher = createDevServerLauncher({
    config,
    logger: root,
    credentials: credentialIssuerOf(auth),
    parentEnv: env,
    detectDeps: { serverAgents },
    ...clock,
  });
  parts.launcher = launcher;
  const managerRef: { current?: SessionManager } = {};
  const instrumentation = createInstrumentationService({
    config,
    logger: root,
    modifications: repos.modifications,
    progress,
    broadcaster: clients,
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

  // Cleanup, then the sessions it serves.
  const cleanup = createSessionCleanup({
    modifications: repos.modifications,
    sessions: repos.sessions,
    config,
    instrumentation,
    watcher,
    progress,
    logger: root,
    ...clock,
  });
  parts.cleanup = cleanup;
  const sessionManager = createSessionManager({
    sessions: repos.sessions,
    broadcaster: clients,
    progress,
    cleanup,
    config,
    logger: root,
    ...clock,
  });
  managerRef.current = sessionManager;
  const hydrated = await sessionManager.hydrate();
  if (isErr(hydrated)) {
    return refuse(hydrated.error);
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
      modifications: repos.modifications,
      events: repos.telemetry,
      logger: root,
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
      collectObservedReadiness({ ...observe, logger: root, now }, request),
    codeIndex,
    ...clock,
  });
  parts.orchestrator = orchestrator;

  // 11 — one HTTP server, two protocols.
  const http = createHttpApp({
    auth,
    config,
    logger: root,
    manager: sessionManager,
    reopener,
    orchestrator,
    sessions: repos.sessions,
    panels: repos.panels,
    modifications: repos.modifications,
    bindings: clients,
    devServers: devServerLookupFromLaunches(launcher),
    resolver: panelData,
    ingest,
    launcher,
    serviceVersion: SERVICE_VERSION,
    isPairingAvailable: () => clients.list({ kind: PAIRING_DISPLAY_KIND, online: true }).length > 0,
  });
  if (isErr(http)) {
    return refuse(http.error);
  }
  parts.http = http.value;

  const binding = createBindingRoutes({
    clients,
    sessions: repos.sessions,
    manager: sessionManager,
    reopener,
    arming: instrumentation,
    logger: root,
    ...clock,
  });
  const ws = createWsServer({
    auth,
    clients,
    binding: regatingBindingRoutes(binding, orchestrator, root),
    telemetry: http.value.telemetry,
    readiness: regatingReadinessPort(ledger, clients, orchestrator, root),
    targets: targetSelectionOf(sessionManager),
    sourceOpen,
    logger: root,
  });
  if (isErr(ws)) {
    return refuse(ws.error);
  }
  parts.ws = ws.value;

  const server = createServer(http.value.requestListener satisfies RequestListener);
  parts.server = server;
  const attached = ws.value.attach(server);
  if (isErr(attached)) {
    return refuse(attached.error);
  }
  const listened = await listen(server, resolved);
  if (isErr(listened)) {
    return refuse(listened.error);
  }
  bound.port = listened.value;
  server.on('error', (cause: unknown) => {
    loggers.server.error('the HTTP server reported an error after start-up', {
      reason: reasonOf(cause),
    });
  });

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
        retention,
      },
      parts,
    }),
  );
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
 * other caller awaits it. The handle is frozen because it is shared with signal
 * handlers and must not be re-pointed by whoever holds it.
 */
function createServiceHandle(input: ServiceHandleInput): ServiceHandle {
  const { loggers, parts, url } = input;
  let closing: Promise<void> | undefined;

  const shutdown = async (): Promise<void> => {
    loggers.service.info('stopping the Debug Generator service', { url });
    try {
      await releaseParts(parts, loggers);
      loggers.service.info('the Debug Generator service has stopped', { url });
    } catch (cause) {
      // `releaseParts` guards every step; this keeps the memoised promise
      // resolvable even if a guard is ever bypassed, because a rejected
      // `closing` would make every later `close()` reject too.
      loggers.service.error('the shutdown sequence failed', { reason: reasonOf(cause) });
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
    close: (): Promise<void> => {
      closing ??= shutdown();
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
 * stop exits on its own well before it fires.
 */
const EXIT_BACKSTOP_MS = 2_000;

/**
 * Writes a start-up failure to stderr in the form a developer reads in a
 * terminal or in Playwright's captured output: the code, the message and the
 * hint, in one write so the lines cannot interleave with another writer's.
 * stderr rather than the logger, because a failure may predate a usable
 * logger (a rejected `DEBUGGEN_LOG_LEVEL` is itself a configuration failure).
 * `details` are deliberately omitted: they are diagnostic context for the log.
 */
function reportStartupFailure(error: DebuggenError): void {
  const lines = [`debuggen: ${error.code}: ${error.message}`];
  if (error.hint !== undefined) {
    lines.push(`debuggen: hint: ${error.hint}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * Wires the process's signals and crash handlers to one shutdown.
 *
 * - **SIGINT / SIGTERM** close the handle once. A repeated signal while the
 *   shutdown is running — Ctrl-C pressed twice — ends the process at once; the
 *   journal is durable, so the next start still restores every patched file.
 * - **`uncaughtException` / `unhandledRejection`** are logged at `fatal`
 *   through the service's own logger, set exit code 1 and run the same
 *   shutdown, so a crash is never silent and never leaves a listening socket
 *   in a state nobody can reason about.
 *
 * `process.exitCode` is set rather than exiting at once, so stdout still flushes
 * the record that explains the exit; an `unref`'d backstop ends the process if
 * something outside the service keeps it alive after the shutdown completed.
 */
function installProcessHandlers(handle: ServiceHandle): void {
  const lifecycle = subsystemLogger(handle.logger, SUBSYSTEM_SERVICE);
  let stopping = false;

  const stop = (reason: string, fields: LogFields): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    lifecycle.info(reason, fields);
    void handle.close().then(() => {
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
      stop('received a shutdown signal', { signal });
    });
  }

  const crash = (kind: string, cause: unknown): void => {
    const error = DebuggenError.from(cause, 'INTERNAL');
    lifecycle.fatal(`${kind} reached the process boundary`, {
      ...errorFields(error),
      reason: error.message,
    });
    process.exitCode = 1;
    stop(`stopping after ${kind}`, {});
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

  const started = await startService({ env: process.env });
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
