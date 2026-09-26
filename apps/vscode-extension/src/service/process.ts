/**
 * The lifetime of the **embedded** local service: the one module of the VS Code
 * extension that spawns, supervises and terminates a child process.
 *
 * AAP §0.7.1 Group 3 gives the extension host the job of starting "the embedded
 * service (or the workspace build during development) when `/health` fails".
 * The embedded service is the copy of `apps/local-service` that `esbuild.mjs`
 * bundles into the VSIX — `dist/service/main.js` (ESM, every npm dependency
 * inlined), its sibling `dist/service/package.json` (`{"type":"module"}`) and
 * the versioned prompt tree `dist/service/prompts/**`. This module decides
 * whether to start it, starts it, streams its output into an output channel,
 * restarts it after a crash under a bounded policy, and stops it.
 *
 * ## What this module owns
 *
 * - **The decision to spawn.** {@link ServiceProcess.ensureRunning} probes the
 *   service first, through an injected {@link ServiceHealthProbe}, and spawns
 *   nothing when something already answers (another editor window's service, a
 *   terminal-started one, a test harness's). It never spawns against the
 *   developer's wish: with `debuggen.autoStartService` off only a
 *   user-initiated call (`Debug Generator: Start Local Service`) starts one.
 * - **The child.** Spawned with Node — never through a shell — with an explicit
 *   working directory, a copied environment and its output piped; see
 *   {@link resolveNodeRuntime} for the single most breakage-prone decision here,
 *   which executable is "Node" inside an editor that is itself Electron.
 * - **Supervision.** An unexpected exit of a healthy child is restarted with the
 *   bounded exponential policy of {@link planRestart}; after the last attempt
 *   the module settles in `failed` with an actionable message instead of
 *   looping. An exit while a stop is waiting to signal the child is never
 *   answered with a restart.
 * - **Address moves.** A live child is never stopped, signalled or replaced
 *   because `debuggen.serviceUrl` changed: it may be the one process that can
 *   still end an active session and remove its instrumentation. The injected
 *   probe follows the setting, so a probe answer is attributed to the child
 *   only while the configured origin is the child's own; an answer at another
 *   origin is a service this module did not start (`external`), and no answer
 *   there is a `service-url-changed` failure with the child still reported.
 *   {@link ServiceProcess.restart}, which the developer chooses, is the one
 *   way to move a live child to the new address.
 * - **Termination.** {@link ServiceProcess.stop} quiesces first (see "Ordering"
 *   below), then sends `SIGTERM`, waits a real grace window and only then
 *   escalates to `SIGKILL` — unless its caller declined the escalation.
 *
 * ## What it deliberately does not do
 *
 * - **No HTTP of its own.** Liveness is the injected probe — structurally the
 *   protocol `HttpClient`'s `health()`, which `client.ts` owns. This module does
 *   not import `./client`, which keeps `src/service/` acyclic and this file
 *   testable with a fake probe.
 * - **No credential format knowledge.** `./auth` owns `$DEBUGGEN_HOME/auth.json`.
 *   This module calls its `ensure()` before spawning, so the service adopts the
 *   credential the editor already holds (AAP §0.5.6), and hands the child the
 *   state directory as `DEBUGGEN_HOME` — never a token, in argv or anywhere else.
 * - **No dev-server spawning.** The target project's dev server, its Node
 *   preload and its scoped `server-agent` credential belong to the service's
 *   `dev-server/launcher.ts`, which finds the bundled preload beside its own
 *   bundle. `DEBUGGEN_TOKEN` and `DEBUGGEN_INGEST_URL` are therefore never set
 *   for the service, and an inherited copy is removed from its environment.
 * - **No user interface.** Every expected condition is a typed `Result`
 *   (AAP §0.5.5); `src/extension.ts` and the commands decide what to show.
 *
 * ## Ordering on shutdown (AAP §0.5.1)
 *
 * The service restores every instrumented file while it handles
 * `POST /sessions/:id/end`. `deactivate()` in `src/extension.ts` sends that
 * request for the active session and calls {@link ServiceProcess.stop} in the
 * same synchronous step, and `stop()` refuses to race ahead of the request:
 * it first awaits every operation registered through
 * {@link ServiceProcess.keepAliveFor}, its own `awaitInFlight` promise and its
 * `beforeStop` hook — bounded, so a hung request cannot hold the editor open —
 * and only then signals the child.
 *
 * - **The stop is recorded at once.** A child that exits during the quiesce is
 *   not restarted, and a restart scheduled or probing after an earlier crash
 *   gives up (the stop generation it was planned under has moved on).
 * - **One stop owns the termination.** VS Code disposes `context.subscriptions`
 *   right after `deactivate()` returned its promise; while a stop is in flight
 *   {@link ServiceProcess.dispose} leaves the child to it instead of starting
 *   a second quiesce and `SIGTERM` → `SIGKILL` sequence beside it.
 * - **Accepted work is never interrupted.** The service carries on with an
 *   end request after the client that sent it went away — it first waits for
 *   a cancelled pipeline step (an install) to settle, then restores the files
 *   — and a signal would cut that short. A caller whose awaited end did not
 *   conclude within its bound releases the child with
 *   {@link StopOptions.release}: it is left running, unsignalled and
 *   unsupervised, so the restore completes on the service's own schedule, and
 *   a later window uses it as the `external` service it then is. Only a child
 *   the configured service URL still names is released, because only then did
 *   the awaited request reach it.
 * - **`SIGKILL` is what cuts a shutdown short.** On `SIGTERM` the service runs
 *   its own bounded shutdown (stop launched dev servers, close sockets,
 *   checkpoint the store). The grace window before `SIGKILL` is long enough for
 *   that in the ordinary case and an escalation is logged; a caller that is
 *   going away while nothing it knows of has concluded declines it with
 *   {@link StopOptions.escalate}, and the child is left to finish on its own.
 *
 * The service also reconciles every non-reverted modification record on its
 * next start, so a hard kill is recoverable — a safety net, not a licence.
 *
 * A child that is slow to become healthy is likewise never killed for being
 * slow: start-up reconciles modification records before the service listens,
 * and a signal that arrives before its handlers are installed ends it at once.
 *
 * ## Credential hygiene (AAP §0.5.2, §0.5.6)
 *
 * The child's environment is assembled from a copy of `process.env` (the parent
 * object is never mutated) and is never logged. Every line of the child's
 * output passes {@link createOutputScrubber} before it reaches the output
 * channel or a failure message: the editor credential's exact value, the values
 * of secret-named environment variables, bearer and key-value credentials,
 * provider-key and JWT shapes and long mixed-case base64url runs are replaced.
 *
 * The lifecycle records sent to the injected logger — which `src/extension.ts`
 * prints, unredacted, into the "Debug Generator" output — are held to a
 * stricter rule than the child's scrubbed output: they carry closed
 * vocabularies and numbers only. A failure is logged by its error code, its
 * `details.reason` from this module's {@link SERVICE_FAILURE_REASONS} and its
 * exit code, signal or errno — never its message, which for an early exit is
 * the child's own stderr report. A caught value is logged by its code, closed
 * class and a Node error code from the finite set of known system and Node
 * codes — never its text and never an unknown `code`. `debuggen.serviceUrl` is
 * logged as its validated loopback origin, never as configured, because a
 * pasted URL can carry userinfo or a query credential. An unexpected failure
 * that is returned to a caller names a correlation reference its log record
 * carries too, instead of the thrown text.
 *
 * ## Vocabulary
 *
 * {@link ServiceProcessState} describes **the process** — whether a service is
 * answering and who started it. It is not the WebSocket connection state
 * (`connecting`, `connected`, …), which belongs to `client.ts` and the
 * protocol's reconnecting client; the two are rendered side by side and are
 * never mixed.
 *
 * ## No work at load time
 *
 * Importing this module reads no environment variable, touches no file and
 * starts no timer; every seam — spawn, probe, clock, timers, environment,
 * filesystem checks, settings, output channel — is injectable and defaults to
 * the real thing at construction or call time. There is no top-level `await`:
 * the host bundle is CommonJS, emitted by `esbuild.mjs`.
 *
 * @packageDocumentation
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getSystemErrorMap } from 'node:util';

import * as vscode from 'vscode';

import { PROVIDER_IDS } from '@debuggen/protocol';
import type { ProviderId } from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
  isErr,
  isOk,
  newMessageId,
  noopLogger,
  nowEpochMs,
  ok,
} from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import { editorCredentialFailureReason } from './auth';
import type { EditorCredentialStore } from './auth';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The name of the output channel the child's stdout and stderr are streamed into. */
export const SERVICE_OUTPUT_CHANNEL_NAME = 'Debug Generator Service';

/**
 * The service URL when `debuggen.serviceUrl` yields none — the manifest's own
 * default, and the address `apps/local-service/src/config.ts` binds when
 * neither `DEBUGGEN_HOST` nor `DEBUGGEN_PORT` is set.
 */
export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:43117';

/**
 * The lowest Node.js major version the bundled service is built for.
 *
 * `esbuild.mjs` targets `node24` for `dist/service/main.js`, the repository pins
 * Node 24 (AAP §0.3.1), and the session store is the built-in `node:sqlite`
 * module — which is why an Electron whose embedded Node is older is not used as
 * the service's runtime while a real Node is available.
 */
export const MIN_SERVICE_NODE_MAJOR = 24;

/**
 * How long a freshly spawned service has to answer `GET /health` before
 * {@link ServiceProcess.ensureRunning} reports that it has not answered yet, in
 * milliseconds.
 *
 * Generous on purpose: before it listens, the service opens and migrates its
 * store and reconciles every outstanding modification record (restoring files
 * a previous run left instrumented), which on a cold machine takes seconds. A
 * child that is still starting when this expires is **not** killed — it keeps
 * being watched in the background and becomes `running` when it answers.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/** The pause between two health probes while a child starts, in milliseconds. */
export const DEFAULT_HEALTH_POLL_INTERVAL_MS = 250;

/** The pause between two probes once the start-up budget is spent, in milliseconds. */
export const SLOW_START_POLL_INTERVAL_MS = 1_000;

/** The bound on one health probe, in milliseconds. */
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * The grace window between `SIGTERM` and `SIGKILL`, in milliseconds.
 *
 * The service's shutdown stops the dev servers it launched (each with a grace
 * window of its own), closes every socket and checkpoints the store; ten
 * seconds is the window the root Playwright configuration gives the same
 * process, and it is what keeps an escalation exceptional.
 */
export const DEFAULT_STOP_GRACE_MS = 10_000;

/** How long to wait for the exit event after `SIGKILL`, in milliseconds. */
export const KILL_CONFIRM_TIMEOUT_MS = 2_000;

/**
 * The bound on the quiesce step of {@link ServiceProcess.stop}, in
 * milliseconds: how long `stop()` waits for in-flight end-of-session requests
 * and its `beforeStop` hook before it signals the child anyway.
 */
export const DEFAULT_QUIESCE_TIMEOUT_MS = 15_000;

/** How long to wait for the service to write `auth.json` after it answered, in milliseconds. */
export const CREDENTIAL_SETTLE_TIMEOUT_MS = 3_000;

/** The longest output line forwarded to the output channel; longer lines are truncated. */
export const MAX_OUTPUT_LINE_LENGTH = 8_192;

/**
 * The most characters of child output the output channel retains. When the
 * budget is spent the channel is cleared and a marker line says so, so a
 * long-running, chatty service cannot grow the editor's memory without bound.
 */
export const MAX_RETAINED_OUTPUT_CHARS = 2_000_000;

/**
 * The longest unterminated output fragment buffered while waiting for a line
 * break; a fragment reaching it is flushed as a line of its own.
 */
export const MAX_PENDING_OUTPUT_CHARS = 65_536;

/** How many scrubbed stderr lines are kept to explain an early exit. */
export const STDERR_TAIL_LINES = 40;

/** The replacement for every scrubbed value. */
export const REDACTION_MARKER = '[redacted]';

/** The configuration section every `debuggen.*` setting lives under. */
const CONFIGURATION_SECTION = 'debuggen';

/** The fully qualified settings this module reacts to, for `affectsConfiguration`. */
const WATCHED_SETTINGS = Object.freeze([
  `${CONFIGURATION_SECTION}.serviceUrl`,
  `${CONFIGURATION_SECTION}.provider`,
  `${CONFIGURATION_SECTION}.autoStartService`,
]);

/** Settings whose change needs a restart of a running embedded service to take effect. */
const RESTART_SETTINGS = Object.freeze([
  `${CONFIGURATION_SECTION}.serviceUrl`,
  `${CONFIGURATION_SECTION}.provider`,
]);

/**
 * Variables the service never needs and must not inherit: the `server-agent`
 * credential, ingest URL and project root the service's launcher mints for a
 * target project's dev server (AAP §0.5.6). A copy in the editor's own
 * environment — VS Code started from a terminal that had run the instrumented
 * dev script — is dropped rather than handed to the service.
 */
const FOREIGN_CREDENTIAL_VARIABLES = Object.freeze([
  'DEBUGGEN_TOKEN',
  'DEBUGGEN_INGEST_URL',
  'DEBUGGEN_PROJECT_ROOT',
]);

/** The variable that makes an Electron binary behave as plain Node. */
const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';

/** The developer's recovery whenever the service is not running. */
const START_COMMAND_HINT =
  'Run "Debug Generator: Start Local Service", or enable debuggen.autoStartService to let the extension start it.';

/** The developer's recovery for a missing or incomplete bundle. */
const BUILD_EXTENSION_HINT =
  'Build the extension (pnpm --filter debug-generator build) or reinstall it, then run "Debug Generator: Start Local Service".';

/** The developer's recovery when no usable Node runtime can be found. */
const NODE_RUNTIME_HINT = `Install Node.js ${String(MIN_SERVICE_NODE_MAJOR)} or later and make "node" available on PATH, or update VS Code, then run "Debug Generator: Start Local Service".`;

/** The developer's recovery after the service exited or stopped answering. */
const SERVICE_OUTPUT_HINT = `Open the "${SERVICE_OUTPUT_CHANNEL_NAME}" output for the reason, then run "Debug Generator: Start Local Service".`;

/** The developer's fix for a service URL this module cannot start a service for. */
const SERVICE_URL_HINT =
  'Set debuggen.serviceUrl to a loopback address with an explicit port, for example http://127.0.0.1:43117.';

/** The prefix the service writes its start-up failure lines with (`reportStartupFailure` in its `main.ts`). */
const STARTUP_FAILURE_PREFIX = 'debuggen: ';

/**
 * The start-up failure line that carries the service's recovery hint. It is
 * only recognised so it is never mistaken for a failure line: the hint itself
 * stays in the output channel, and a surfaced failure carries
 * {@link SERVICE_OUTPUT_HINT} instead.
 */
const STARTUP_HINT_PREFIX = 'debuggen: hint: ';

/** Membership over the closed error-code vocabulary, for codes read back from the child's stderr. */
const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(DEBUGGEN_ERROR_CODES);

/** Membership over the provider pair the manifest enumerates. */
const PROVIDER_SET: ReadonlySet<string> = new Set<string>(PROVIDER_IDS);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Every state of the service **process**, as this editor window sees it:
 *
 * | State | Meaning |
 * | --- | --- |
 * | `idle` | nothing attempted yet, or the service is not running and auto-start is off |
 * | `starting` | a child this module spawned has not answered `/health` yet (first start or a restart) |
 * | `running` | a child this module spawned answers `/health` and is supervised |
 * | `external` | a service this module did not spawn answers `/health` at the configured URL; it is never restarted or killed from here (a child of this window kept on its previous address after `debuggen.serviceUrl` moved is still stopped by `stop()` and retired by `restart()`) |
 * | `failed` | the last start or the restart policy gave up; the status carries the error |
 * | `stopped` | this module stopped its child, released it to finish accepted work on its own (see {@link StopOptions.release}), or the module was disposed |
 *
 * Not the WebSocket connection state — see the module overview.
 */
export const SERVICE_PROCESS_STATES = Object.freeze([
  'idle',
  'starting',
  'running',
  'external',
  'failed',
  'stopped',
] as const);

/** One member of {@link SERVICE_PROCESS_STATES}. */
export type ServiceProcessState = (typeof SERVICE_PROCESS_STATES)[number];

/** Who started the service that answers: this module (`embedded`) or anything else (`external`). */
export type ServiceMode = 'embedded' | 'external';

/** Which service entry a child was spawned from. */
export type ServiceEntryOrigin = 'bundled' | 'workspace';

/**
 * How the Node runtime for the child was chosen; see {@link resolveNodeRuntime}.
 *
 * `configured` — an injected `nodePath`; `host-node` — the extension host is
 * itself plain Node; `host-electron` — the editor's Electron binary run as Node;
 * `path` — the first `node` on `PATH`.
 */
export type NodeRuntimeSource = 'configured' | 'host-node' | 'host-electron' | 'path';

/**
 * A snapshot of the service process, handed to status listeners and returned
 * by the lifecycle operations. Immutable; a new snapshot is built on every
 * change.
 */
export interface ServiceStatus {
  /** The process state. */
  readonly state: ServiceProcessState;

  /** Who owns the answering service; `undefined` while nothing answers. */
  readonly mode: ServiceMode | undefined;

  /**
   * The child's process id while the status describes a live child of this
   * module; `undefined` in the `external` state, even when a child of this
   * window is still kept on the address `debuggen.serviceUrl` named before.
   */
  readonly pid: number | undefined;

  /** The entry the current or last child was spawned from. */
  readonly origin: ServiceEntryOrigin | undefined;

  /** How the current or last child's runtime was chosen. */
  readonly runtime: NodeRuntimeSource | undefined;

  /** The service URL the status refers to, from `debuggen.serviceUrl`. */
  readonly serviceUrl: string;

  /** Consecutive unexpected exits the restart policy has answered so far. */
  readonly restartAttempts: number;

  /**
   * Whether a setting the running child was started with (`debuggen.serviceUrl`
   * or `debuggen.provider`) changed since; a restart applies it.
   */
  readonly settingsChanged: boolean;

  /** The last failure, kept until a later start succeeds. */
  readonly error: DebuggenError | undefined;

  /** When this snapshot's state was entered, in epoch milliseconds. */
  readonly since: number;
}

/**
 * Whether a status describes a service that answers: `running` (ours) or
 * `external` (someone else's). What `ExtensionState.setServiceReachable` takes.
 *
 * @param status A snapshot from {@link ServiceProcess.status}.
 * @returns `true` when a service answers `/health`.
 */
export function isServiceReachable(status: Pick<ServiceStatus, 'state'>): boolean {
  return status.state === 'running' || status.state === 'external';
}

/**
 * The embedded artefacts inside the installed extension, resolved by
 * `src/extension.ts` from `context.extensionUri` (never from `__dirname`
 * arithmetic) and handed in as absolute filesystem paths. The layout is
 * `esbuild.mjs`'s `LAYOUT`.
 */
export interface EmbeddedPaths {
  /** `dist/service/main.js` — the bundled service, ESM. */
  readonly serviceMain: string;

  /** `dist/service/prompts` — passed to the child as `DEBUGGEN_PROMPTS_DIR`. */
  readonly servicePromptsDir: string;

  /**
   * `dist/service/store/schema.sql` — informational: the service probes it
   * relative to its own module URL, so nothing is passed for it. Checked only
   * to make an incomplete bundle a clear failure rather than a store error.
   */
  readonly serviceSchema?: string | undefined;

  /**
   * `dist/telemetry/node/register.mjs` — informational: the service's
   * dev-server launcher finds the preload beside its own bundle. A missing
   * preload is logged, because server spans would then be unavailable.
   */
  readonly telemetryPreload?: string | undefined;
}

/**
 * The workspace build of the service, used during development when the
 * bundled entry is absent (AAP §0.7.1 Group 3: "or the workspace build during
 * development"). Resolved by `src/extension.ts`; the bundled entry always wins
 * when it exists.
 */
export interface WorkspaceServiceEntry {
  /** Absolute path of the workspace build, typically `apps/local-service/dist/main.js`. */
  readonly serviceMain: string;

  /**
   * The prompt directory to pass as `DEBUGGEN_PROMPTS_DIR`. When absent, the
   * workspace build derives it from its own location, which is correct inside
   * a checkout.
   */
  readonly servicePromptsDir?: string | undefined;
}

/** Options of one liveness probe. The shape of the protocol client's `HttpCallOptions`. */
export interface ServiceHealthProbeOptions {
  /** Cancels the probe. */
  readonly signal?: AbortSignal | undefined;

  /** The bound on the probe, in milliseconds. */
  readonly timeoutMs?: number | undefined;
}

/**
 * The liveness port this module consumes: `GET /health`, which is
 * auth-exempt and therefore callable before any credential exists.
 * Satisfied structurally by `HttpClient.health()` from `@debuggen/protocol`
 * (through `client.ts`) and injected by `src/extension.ts`.
 */
export interface ServiceHealthProbe {
  /** Resolves `Ok` when the service answered with a valid health body. */
  health(options?: ServiceHealthProbeOptions): Promise<Result<unknown, DebuggenError>>;
}

/** The part of the editor credential store this module drives (see `./auth`). */
export type ServiceCredentialPort = Pick<
  EditorCredentialStore,
  'paths' | 'ensure' | 'waitForCredential'
>;

/** The stream surface of a child's piped stdout or stderr that this module reads. */
export interface ChildOutputStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * The part of `node:child_process`'s `ChildProcess` this module uses. A real
 * `ChildProcess` satisfies it structurally; tests supply a fake.
 */
export interface ChildProcessLike {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: ChildOutputStream | null;
  readonly stderr: ChildOutputStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** The spawn options this module always passes — the invariant part of the invocation. */
export interface ServiceSpawnOptions {
  /** The bundle's own directory, never the developer's workspace. */
  readonly cwd: string;
  /** A copy of the parent environment with the service's variables applied. */
  readonly env: Readonly<Record<string, string>>;
  /** Never a shell: the entry path is an argument, not a command line. */
  readonly shell: false;
  /** No console window on Windows. */
  readonly windowsHide: true;
  /** No stdin (nothing can prompt); stdout and stderr piped into the output channel. */
  readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
  /** The child belongs to the extension host's process group. */
  readonly detached: false;
}

/** The structural spawn function; the default wraps `node:child_process`'s `spawn`. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: ServiceSpawnOptions,
) => ChildProcessLike;

/** The output-channel surface this module writes to; a `vscode.OutputChannel` satisfies it. */
export interface ServiceOutputChannel {
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

/** The disposable shape shared with `vscode.Disposable`. */
export interface DisposableLike {
  dispose(): void;
}

/** The part of a configuration-change event this module reads. */
export interface ConfigurationChangeLike {
  affectsConfiguration(section: string): boolean;
}

/**
 * The settings this module reads, snapshotted at call time. The default
 * reader is `workspace.getConfiguration("debuggen")`.
 */
export interface ServiceProcessSettings {
  /** `debuggen.autoStartService`; anything but a boolean reads as "off". */
  readonly autoStartService: boolean;

  /** `debuggen.serviceUrl`, as configured. */
  readonly serviceUrl: string;

  /**
   * `debuggen.provider` as the developer set it explicitly (user, workspace or
   * folder scope), or `undefined` when it holds only the manifest default.
   */
  readonly providerExplicit: unknown;

  /** The manifest default of `debuggen.provider`. */
  readonly providerDefault: unknown;
}

/** One-shot scheduling: runs `callback` after `delayMs` and returns its cancellation. */
export type ScheduleLike = (callback: () => void, delayMs: number) => () => void;

/** What a filesystem path currently names; see {@link ServiceProcessDeps.pathKind}. */
export type PathKind = 'file' | 'directory' | 'missing' | 'other';

/**
 * The bounded exponential restart policy for a supervised child. See
 * {@link planRestart}.
 */
export interface RestartPolicy {
  /** The delay before the first restart, in milliseconds. */
  readonly initialDelayMs: number;
  /** The ceiling every later delay is clamped to, in milliseconds. */
  readonly maxDelayMs: number;
  /** The growth factor between two consecutive delays (≥ 1). */
  readonly factor: number;
  /** How many consecutive restarts are attempted before settling in `failed`. */
  readonly maxAttempts: number;
  /**
   * How long a child must have been healthy for its exit to count as a fresh
   * failure rather than one more in a series, in milliseconds.
   */
  readonly stableAfterMs: number;
}

/**
 * The default restart policy: 1 s, 2 s, 4 s, 8 s, 16 s — five attempts, then
 * `failed` — with the series forgotten after a minute of health. Deliberately
 * unrelated to the WebSocket reconnect policy (`DEFAULT_WS_BACKOFF` of the
 * protocol's reconnecting client): reconnecting a socket is cheap and endless,
 * restarting a process that keeps dying is neither.
 */
export const DEFAULT_RESTART_POLICY: RestartPolicy = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
  maxAttempts: 5,
  stableAfterMs: 60_000,
});

/** What {@link planRestart} decided. */
export type RestartDecision =
  | {
      /** Restart after `delayMs`; this is restart number `attempt` of the series. */
      readonly action: 'restart';
      readonly attempt: number;
      readonly delayMs: number;
    }
  | {
      /** The series reached `maxAttempts`: settle in `failed`. */
      readonly action: 'give-up';
      readonly attempts: number;
    };

/**
 * Everything {@link createServiceProcess} needs. Only `paths`, `probe` and
 * `credential` are required; every other member defaults to the real
 * implementation, read at construction or call time — never at module load.
 *
 * Optional members are declared `| undefined` as well because the repository
 * compiles with `exactOptionalPropertyTypes`, which lets a caller forward its
 * own possibly-absent option unchanged.
 */
export interface ServiceProcessDeps {
  /** The embedded artefacts, resolved from `context.extensionUri`. */
  readonly paths: EmbeddedPaths;

  /** The development fallback used only when `paths.serviceMain` is absent. */
  readonly workspaceService?: WorkspaceServiceEntry | undefined;

  /** Liveness, satisfied by the protocol `HttpClient` behind `client.ts`. */
  readonly probe: ServiceHealthProbe;

  /** The editor credential store from `./auth`. */
  readonly credential: ServiceCredentialPort;

  /**
   * An explicit Node executable for the child; wins over every other choice
   * (see {@link resolveNodeRuntime}). An absolute path or a bare command name
   * looked up on `PATH`.
   */
  readonly nodePath?: string | undefined;

  /** Where lifecycle facts are logged. Defaults to a no-op logger. Never receives the environment. */
  readonly logger?: Logger | undefined;

  /** The parent environment copied for the child. Defaults to `process.env`, read at spawn time. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;

  /** The spawn function. Defaults to `node:child_process`'s `spawn`. */
  readonly spawn?: SpawnLike | undefined;

  /** The settings reader. Defaults to `workspace.getConfiguration("debuggen")`. */
  readonly readSettings?: (() => ServiceProcessSettings) | undefined;

  /**
   * The configuration-change subscription. Defaults to
   * `workspace.onDidChangeConfiguration`.
   */
  readonly onDidChangeConfiguration?:
    ((listener: (event: ConfigurationChangeLike) => void) => DisposableLike) | undefined;

  /**
   * The output-channel factory, called lazily on the first spawn or
   * {@link ServiceProcess.showOutput}. Defaults to `window.createOutputChannel`.
   */
  readonly createOutputChannel?: ((name: string) => ServiceOutputChannel) | undefined;

  /** The clock, in epoch milliseconds. Defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;

  /** One-shot timers. Defaults to `setTimeout`/`clearTimeout`, unref'd. */
  readonly schedule?: ScheduleLike | undefined;

  /** Filesystem classification of a path. Defaults to `fs.statSync`. */
  readonly pathKind?: ((target: string) => PathKind) | undefined;

  /** Whether a path names an executable file. Defaults to `fs.accessSync(…, X_OK)`. */
  readonly isExecutable?: ((target: string) => boolean) | undefined;

  /** The host's `process.execPath`. Defaults to the real one. */
  readonly execPath?: string | undefined;

  /** The host's `process.versions`. Defaults to the real one. */
  readonly versions?: Readonly<{ node: string; electron?: string | undefined }> | undefined;

  /** The host's `process.platform`. Defaults to the real one. */
  readonly platform?: NodeJS.Platform | undefined;

  /** The restart policy. Defaults to {@link DEFAULT_RESTART_POLICY}. */
  readonly restartPolicy?: RestartPolicy | undefined;

  /** Defaults to {@link DEFAULT_STARTUP_TIMEOUT_MS}. */
  readonly startupTimeoutMs?: number | undefined;

  /** Defaults to {@link DEFAULT_HEALTH_POLL_INTERVAL_MS}. */
  readonly healthPollIntervalMs?: number | undefined;

  /** Defaults to {@link SLOW_START_POLL_INTERVAL_MS}. */
  readonly slowStartPollIntervalMs?: number | undefined;

  /** Defaults to {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS}. */
  readonly healthProbeTimeoutMs?: number | undefined;

  /** Defaults to {@link DEFAULT_STOP_GRACE_MS}. */
  readonly stopGraceMs?: number | undefined;

  /** Defaults to {@link DEFAULT_QUIESCE_TIMEOUT_MS}. */
  readonly quiesceTimeoutMs?: number | undefined;
}

/** Options of {@link ServiceProcess.ensureRunning}. */
export interface EnsureRunningOptions {
  /**
   * `true` when the developer asked for the service explicitly (the
   * `debuggen.startService` command). A user-initiated call starts the service
   * even with `debuggen.autoStartService` off, and clears a previous failure;
   * an automatic call (activation, a dropped connection) does neither.
   */
  readonly userInitiated?: boolean | undefined;
}

/** Options of {@link ServiceProcess.stop}. */
export interface StopOptions {
  /**
   * An operation that must settle before the child is signalled — typically
   * the `POST /sessions/:id/end` that `deactivate()` sent, during which the
   * service restores every instrumented file (AAP §0.5.1).
   */
  readonly awaitInFlight?: Promise<unknown> | undefined;

  /** A hook run, and awaited, before the child is signalled. Its failure is logged, not propagated. */
  readonly beforeStop?: (() => Promise<unknown>) | undefined;

  /** The bound on the quiesce step. Defaults to the module's quiesce timeout. */
  readonly quiesceTimeoutMs?: number | undefined;

  /** The grace window between `SIGTERM` and `SIGKILL`. Defaults to the module's grace. */
  readonly graceMs?: number | undefined;

  /**
   * Whether a child that is still running when the grace window expires is
   * sent `SIGKILL`. Defaults to `true`.
   *
   * `false` leaves a child that received `SIGTERM` to finish its own shutdown
   * instead — for a caller that is going away (`deactivate()`) without knowing
   * that the service has nothing left to do: `SIGKILL` is the one signal the
   * service cannot finish its shutdown after. A function is read when the
   * grace window expires, so the decision can depend on something that
   * settles meanwhile (whether the end-of-session request concluded); a
   * function that throws counts as `false`, and the throw is logged.
   *
   * @example
   * ```ts
   * let ended = false;
   * void endRequest.then(() => { ended = true; });
   * await serviceProcess.stop({ awaitInFlight: endRequest, escalate: () => ended });
   * ```
   */
  readonly escalate?: boolean | (() => boolean) | undefined;

  /**
   * Whether the child is **released** instead of signalled once the quiesce
   * ends. Defaults to `false`.
   *
   * A released child is left running, is no longer supervised, and is never
   * signalled by this module again — not by this stop, a later one, or
   * `dispose()`. It is for a caller that is going away while the service is
   * still carrying out work it accepted and a signal would interrupt: an
   * end-of-session request that timed out on the client is still being served
   * — the service waits for a cancelled install to settle before it restores
   * the files — and the service's `SIGTERM` shutdown does not wait for that.
   * A later editor window finds the released service answering and uses it as
   * `external`.
   *
   * A function is read when the quiesce ends. A function that throws counts as
   * `true`, the answer that never interrupts a restore, and the throw is
   * logged. Either way the child is released only while the configured
   * service URL still names it: the awaited request went to that URL, so a
   * child kept on a previous address cannot be carrying it out, and is
   * stopped as usual.
   *
   * @example
   * ```ts
   * let settled = false;
   * void endRequest.finally(() => { settled = true; });
   * await serviceProcess.stop({ awaitInFlight: endRequest, release: () => !settled });
   * ```
   */
  readonly release?: boolean | (() => boolean) | undefined;
}

/**
 * The embedded service's lifecycle, as the extension host drives it.
 *
 * `src/extension.ts` constructs one per window, pushes it into
 * `context.subscriptions`, calls {@link ServiceProcess.ensureRunning} from its
 * asynchronous start-up (never awaiting it on the activation path) and, in
 * `deactivate()`, calls {@link ServiceProcess.stop} together with the active
 * session's end request, awaiting that request before it acts on the child:
 * a child whose end is still being served is released rather than signalled.
 *
 * Every asynchronous member resolves and never rejects.
 */
export interface ServiceProcess extends DisposableLike {
  /** The current snapshot. */
  readonly status: ServiceStatus;

  /** The output channel, once created (on the first spawn or {@link ServiceProcess.showOutput}). */
  readonly outputChannel: ServiceOutputChannel | undefined;

  /**
   * Makes sure a service answers: probes, and — when nothing answers and
   * starting one is allowed — ensures the editor credential, spawns the
   * embedded service and waits for its health. Concurrent calls share one
   * attempt. Resolves `Ok` with a `running` or `external` snapshot.
   *
   * A live child of this window whose address `debuggen.serviceUrl` no longer
   * names is kept, never replaced, for automatic and user-initiated calls
   * alike: the result is then the `external` service answering at the new
   * address, or a failure with `details.reason` `service-url-changed` while
   * the status still describes the child. {@link ServiceProcess.restart}
   * moves it.
   */
  ensureRunning(options?: EnsureRunningOptions): Promise<Result<ServiceStatus, DebuggenError>>;

  /**
   * Stops the child this module spawned: quiesce, `SIGTERM`, grace window,
   * then `SIGKILL` unless {@link StopOptions.escalate} declines it — or, when
   * {@link StopOptions.release} asks for it at the end of the quiesce, no
   * signal at all: the child is released to finish accepted work on its own.
   * Never touches a service this module did not spawn. Idempotent; safe when
   * nothing was spawned.
   *
   * The stop request is recorded synchronously, when `stop()` is called, not
   * when its quiesce ends: a child that exits while the stop waits is not
   * restarted, a restart already scheduled after a crash is cancelled, and a
   * scheduled restart already probing gives up instead of launching.
   *
   * A requested stop also holds off automatic starts: until a user-initiated
   * {@link ServiceProcess.ensureRunning} or {@link ServiceProcess.restart}, an
   * automatic `ensureRunning` (a dropped connection during shutdown, say)
   * reports "not running" instead of spawning the service straight back.
   *
   * While the returned promise is pending, the stop owns the child's
   * termination: {@link ServiceProcess.dispose} does not start a second one.
   */
  stop(options?: StopOptions): Promise<void>;

  /**
   * Stops this module's child (as {@link ServiceProcess.stop}) and starts a
   * fresh one. User-initiated by nature, so it ignores `autoStartService` and
   * resets the restart series. Refused for an `external` service — unless
   * this window still holds a child of its own (one kept after
   * `debuggen.serviceUrl` moved), which it retires — and for a child a stop
   * released ({@link StopOptions.release}), which is no longer this window's
   * to signal. The only way a live child is moved to a new service URL.
   */
  restart(options?: StopOptions): Promise<Result<ServiceStatus, DebuggenError>>;

  /**
   * Registers an operation {@link ServiceProcess.stop} and
   * {@link ServiceProcess.dispose} wait for before signalling the child — the
   * end-of-session request above all. Returns the same promise.
   */
  keepAliveFor<T>(operation: Promise<T>): Promise<T>;

  /** Subscribes to status changes; the listener receives every new snapshot. */
  onDidChangeStatus(listener: (status: ServiceStatus) => void): DisposableLike;

  /** Reveals the service output channel, creating it when needed. */
  showOutput(preserveFocus?: boolean): void;

  /**
   * Terminates the child (after the registered operations settle, bounded),
   * disposes the output channel and the configuration listener. Idempotent;
   * never throws.
   *
   * When a {@link ServiceProcess.stop} or {@link ServiceProcess.restart} is
   * still running — `deactivate()`'s stop, which VS Code follows with this
   * call at once — that stop keeps ownership of the child's termination, with
   * its own bounds and escalation decision; `dispose()` then starts no quiesce
   * or signal of its own. A child that stop released is never signalled here.
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// The restart policy (pure)
// ---------------------------------------------------------------------------

/** `value` when it is a finite number, else `fallback`. */
function numberOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/**
 * Decides what happens after a supervised child exited unexpectedly: restart
 * it after a delay, or give up. Pure and table-testable.
 *
 * The delay of restart number `n` is `initialDelayMs × factor^(n−1)`, clamped
 * to `maxDelayMs`; there is no jitter, because one editor window restarts one
 * process and a deterministic schedule is what a developer reading the output
 * channel expects. A child that stayed healthy for at least `stableAfterMs`
 * before it exited starts a fresh series, so one crash a day never accumulates
 * into a give-up, while a child that dies within a minute of every start does.
 *
 * @param policy The policy; non-finite members fall back to the defaults.
 * @param previousAttempts Restarts already made in the current series.
 * @param healthyForMs How long the exiting child had been healthy, in milliseconds.
 * @returns The decision.
 */
export function planRestart(
  policy: RestartPolicy,
  previousAttempts: number,
  healthyForMs = 0,
): RestartDecision {
  const stableAfterMs = Math.max(
    0,
    numberOrDefault(policy.stableAfterMs, DEFAULT_RESTART_POLICY.stableAfterMs),
  );
  const maxAttempts = Math.max(
    0,
    Math.trunc(numberOrDefault(policy.maxAttempts, DEFAULT_RESTART_POLICY.maxAttempts)),
  );
  const made = Math.max(0, Math.trunc(numberOrDefault(previousAttempts, 0)));
  const series = numberOrDefault(healthyForMs, 0) >= stableAfterMs ? 0 : made;
  if (series >= maxAttempts) {
    return Object.freeze({ action: 'give-up', attempts: series });
  }

  const attempt = series + 1;
  const initial = Math.max(
    0,
    numberOrDefault(policy.initialDelayMs, DEFAULT_RESTART_POLICY.initialDelayMs),
  );
  const ceiling = Math.max(
    initial,
    numberOrDefault(policy.maxDelayMs, DEFAULT_RESTART_POLICY.maxDelayMs),
  );
  const factor = Math.max(1, numberOrDefault(policy.factor, DEFAULT_RESTART_POLICY.factor));
  const raw = initial * factor ** (attempt - 1);
  const delayMs = Math.round(Number.isFinite(raw) ? Math.min(ceiling, raw) : ceiling);
  return Object.freeze({ action: 'restart', attempt, delayMs });
}

// ---------------------------------------------------------------------------
// The Node runtime (pure over its inputs)
// ---------------------------------------------------------------------------

/** The executable the child is spawned with. */
export interface NodeRuntime {
  /** The absolute path (or, for a configured bare name, the resolved path) of the executable. */
  readonly command: string;

  /** Whether the executable is Electron and needs `ELECTRON_RUN_AS_NODE=1` to behave as Node. */
  readonly runAsNode: boolean;

  /** How it was chosen. */
  readonly source: NodeRuntimeSource;

  /**
   * The Node major version of the executable when it is known without running
   * it (the host's own runtime), else `undefined`.
   */
  readonly nodeMajor: number | undefined;
}

/** The inputs of {@link resolveNodeRuntime}; every host fact is injected. */
export interface NodeRuntimeInput {
  /** An explicit executable; see {@link ServiceProcessDeps.nodePath}. */
  readonly nodePath?: string | undefined;
  /** The host's `process.execPath`. */
  readonly execPath: string;
  /** The host's `process.versions`. */
  readonly versions: Readonly<{ node: string; electron?: string | undefined }>;
  /** The environment `PATH` is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The host platform, which decides the `PATH` delimiter and executable suffix. */
  readonly platform: NodeJS.Platform;
  /** Whether a path names an executable file. */
  readonly isExecutable: (target: string) => boolean;
}

/** The major version in a `process.versions.node` string, or `undefined`. */
function nodeMajorOf(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version.trim());
  const major = match?.[1];
  return major === undefined ? undefined : Number(major);
}

/** The path module matching `platform`, so a suite can resolve Windows paths on Linux. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** An environment variable read case-insensitively on Windows, where names are. */
function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') {
    return env[name];
  }
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * The first executable named `name` on `PATH`, or `undefined`.
 *
 * On Windows only `.exe` and `.com` candidates are considered: a `.cmd` or
 * `.bat` shim cannot be spawned without a shell, and this module never uses
 * one. Relative `PATH` entries are skipped — they would resolve against
 * whatever the working directory happens to be.
 */
function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  isExecutable: (target: string) => boolean,
): string | undefined {
  const paths = pathFor(platform);
  const searchPath = envValue(env, 'PATH', platform);
  if (searchPath === undefined || searchPath.trim() === '') {
    return undefined;
  }
  const suffixes = platform === 'win32' && paths.extname(name) === '' ? ['.exe', '.com'] : [''];
  for (const rawDirectory of searchPath.split(paths.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, '$1');
    if (directory === '' || !paths.isAbsolute(directory)) {
      continue;
    }
    for (const suffix of suffixes) {
      const candidate = paths.join(directory, `${name}${suffix}`);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Chooses the executable the embedded service runs under.
 *
 * Inside the VS Code extension host `process.execPath` is **Electron**, not
 * Node: spawning it with a script argument would start a second editor. The
 * documented way to run a plain Node script with the Electron binary is the
 * environment variable `ELECTRON_RUN_AS_NODE=1` — how VS Code runs its own
 * Node helpers — and it needs no Node installation at all, which matters
 * because an editor started from a desktop launcher often has a minimal
 * `PATH`. Its embedded Node, however, must be recent enough for the bundle
 * (built for Node {@link MIN_SERVICE_NODE_MAJOR}, using the built-in
 * `node:sqlite` store), which is true of current editors and not of every
 * editor `engines.vscode` admits. Hence the precedence, first match wins:
 *
 * 1. **`configured`** — an explicit `nodePath` (`src/extension.ts` forwards the
 *    test harness's `DEBUGGEN_TEST_NODE` or a developer's choice). An absolute
 *    path must be an executable file; a bare name is looked up on `PATH`. A
 *    configured runtime that cannot be found is a failure, never a silent
 *    fallback, because the developer asked for that one.
 * 2. **`host-node`** — the host is plain Node (no `process.versions.electron`):
 *    `process.execPath` is Node itself.
 * 3. **`host-electron`** — the host is Electron whose embedded Node is at least
 *    {@link MIN_SERVICE_NODE_MAJOR}: `process.execPath` with
 *    `ELECTRON_RUN_AS_NODE=1`.
 * 4. **`path`** — an older Electron: the first `node` executable on `PATH`.
 * 5. **`host-electron`** again, as the last resort when `PATH` has no `node`:
 *    the service may then refuse to start, and its own stderr — streamed into
 *    the output channel and parsed into the failure — says why.
 *
 * @param input The host facts; see {@link NodeRuntimeInput}.
 * @returns The runtime, or a `CONFIG_INVALID` failure for an unusable configured one.
 */
export function resolveNodeRuntime(input: NodeRuntimeInput): Result<NodeRuntime, DebuggenError> {
  const paths = pathFor(input.platform);
  const configured = input.nodePath?.trim();
  if (configured !== undefined && configured !== '') {
    if (paths.isAbsolute(configured)) {
      return input.isExecutable(configured)
        ? ok(runtime(configured, false, 'configured', undefined))
        : err(unusableConfiguredRuntime('it is not an executable file'));
    }
    if (configured.includes('/') || configured.includes('\\')) {
      return err(unusableConfiguredRuntime('a relative path is ambiguous; give an absolute path'));
    }
    const found = findOnPath(configured, input.env, input.platform, input.isExecutable);
    return found === undefined
      ? err(unusableConfiguredRuntime('no executable of that name is on PATH'))
      : ok(runtime(found, false, 'configured', undefined));
  }

  const hostMajor = nodeMajorOf(input.versions.node);
  const electron = input.versions.electron;
  if (electron === undefined || electron.trim() === '') {
    return ok(runtime(input.execPath, false, 'host-node', hostMajor));
  }
  if (hostMajor !== undefined && hostMajor >= MIN_SERVICE_NODE_MAJOR) {
    return ok(runtime(input.execPath, true, 'host-electron', hostMajor));
  }
  const onPath = findOnPath('node', input.env, input.platform, input.isExecutable);
  if (onPath !== undefined) {
    return ok(runtime(onPath, false, 'path', undefined));
  }
  return ok(runtime(input.execPath, true, 'host-electron', hostMajor));
}

/** Builds a frozen {@link NodeRuntime}. */
function runtime(
  command: string,
  runAsNode: boolean,
  source: NodeRuntimeSource,
  nodeMajor: number | undefined,
): NodeRuntime {
  return Object.freeze({ command, runAsNode, source, nodeMajor });
}

/** The failure for a configured runtime that cannot be used. The path itself is not echoed. */
function unusableConfiguredRuntime(reason: string): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The Node.js runtime configured for the Debug Generator service cannot be used: ${reason}.`,
    { hint: NODE_RUNTIME_HINT, details: { reason: 'node-runtime' } },
  );
}

// ---------------------------------------------------------------------------
// The service address, provider and environment (pure)
// ---------------------------------------------------------------------------

/** Where the embedded service is told to listen: `DEBUGGEN_HOST` and `DEBUGGEN_PORT`. */
export interface ServiceListenAddress {
  /** The configured URL's origin, e.g. `http://127.0.0.1:43117`. */
  readonly origin: string;
  /** The interface to bind, without IPv6 brackets. */
  readonly host: string;
  /** The TCP port to bind. */
  readonly port: number;
}

/** An address in the IPv4 loopback block, `127.0.0.0/8`. */
const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * The "bad ports" of the WHATWG Fetch Standard's port-blocking rule: a
 * `fetch()` to one of them fails with `bad port` before any connection is
 * attempted. The extension reaches the service only through `fetch` — the
 * protocol `HttpClient` behind the health probe and every route — so a service
 * listening on one of these ports could never answer this window: the start
 * would end in the start-up timeout with a child nobody can talk to.
 *
 * The list matches the one Node 24's bundled undici enforces, which refuses
 * every port listed here (port `0` is not a bad port; the range check in
 * {@link parseLoopbackServiceUrl} already refuses it).
 */
const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/**
 * Derives the service's listen address from `debuggen.serviceUrl`, so the
 * spawned service binds exactly the address the health probe and the client
 * reach.
 *
 * Only a plain-HTTP loopback URL can name a service this module starts: the
 * service speaks HTTP on a loopback interface (its configuration refuses any
 * other bind, AAP §0.5.6). A URL without an explicit port means the scheme's
 * port, 80, which is what every client of that URL would connect to. A port
 * the Fetch Standard blocks ({@link FETCH_BLOCKED_PORTS}) is refused too:
 * whether the operating system would let the service bind it (a root account,
 * a container with `net.ipv4.ip_unprivileged_port_start=0`) or not, the
 * extension's own client could never reach it, so nothing is spawned for it.
 *
 * The rejected value is never echoed: a URL can carry credentials.
 *
 * @param serviceUrl The configured URL.
 * @returns The address, or a `CONFIG_INVALID` failure.
 */
export function parseServiceListenAddress(
  serviceUrl: string,
): Result<ServiceListenAddress, DebuggenError> {
  const address = parseLoopbackServiceUrl(serviceUrl);
  if (isOk(address) && FETCH_BLOCKED_PORTS.has(address.value.port)) {
    return err(
      invalidServiceUrl(
        'its port is one the Fetch standard blocks, so this extension could never reach a service listening there',
      ),
    );
  }
  return address;
}

/**
 * The plain-HTTP loopback address a URL names, without the reachability rule
 * {@link parseServiceListenAddress} adds: what a message may display as the
 * URL's origin, and what a running child's address is compared against.
 *
 * @param serviceUrl The configured URL.
 * @returns The address, or a `CONFIG_INVALID` failure.
 */
function parseLoopbackServiceUrl(serviceUrl: string): Result<ServiceListenAddress, DebuggenError> {
  let url: URL;
  try {
    url = new URL(serviceUrl.trim());
  } catch {
    return err(invalidServiceUrl('it is not a URL'));
  }
  if (url.protocol !== 'http:') {
    return err(invalidServiceUrl('the local service speaks plain http'));
  }
  if (url.username !== '' || url.password !== '') {
    return err(invalidServiceUrl('it must not carry credentials'));
  }
  const bracketed = url.hostname.startsWith('[') && url.hostname.endsWith(']');
  const host = bracketed ? url.hostname.slice(1, -1) : url.hostname;
  const loopback = host === 'localhost' || host === '::1' || IPV4_LOOPBACK.test(host);
  if (!loopback) {
    return err(
      invalidServiceUrl(
        'the embedded service can only listen on a loopback address of this machine',
      ),
    );
  }
  const port = url.port === '' ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return err(invalidServiceUrl('its port must be a whole number from 1 to 65535'));
  }
  return ok(Object.freeze({ origin: url.origin, host, port }));
}

/** The failure for a service URL this module cannot start a service for. */
function invalidServiceUrl(reason: string): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `debuggen.serviceUrl cannot be used to start the Debug Generator service: ${reason}.`,
    { hint: SERVICE_URL_HINT, details: { reason: 'service-url' } },
  );
}

/** Whether `value` is one of the providers the manifest enumerates. */
function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_SET.has(value);
}

/**
 * The `DEBUGGEN_PROVIDER` value to hand the child, by precedence:
 *
 * 1. `debuggen.provider` set **explicitly** by the developer (user, workspace
 *    or folder scope) — the setting's contract is that it "is forwarded as
 *    `DEBUGGEN_PROVIDER` when this extension starts the bundled service";
 * 2. an inherited, non-empty `DEBUGGEN_PROVIDER` in the editor's environment —
 *    left untouched (`undefined` is returned), which is how the extension-host
 *    suites' `DEBUGGEN_PROVIDER=deterministic` survives a manifest default;
 * 3. the manifest default of `debuggen.provider`.
 *
 * @param settings The settings snapshot.
 * @param inherited The editor's own `DEBUGGEN_PROVIDER`, if any.
 * @returns The value to set, `undefined` to keep the inherited one, or a
 * `CONFIG_INVALID` failure for an explicit value outside the enumeration.
 */
export function resolveProviderSetting(
  settings: Pick<ServiceProcessSettings, 'providerExplicit' | 'providerDefault'>,
  inherited: string | undefined,
): Result<ProviderId | undefined, DebuggenError> {
  const explicit = settings.providerExplicit;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return isProviderId(explicit)
      ? ok(explicit)
      : err(
          new DebuggenError(
            'CONFIG_INVALID',
            'debuggen.provider names a model provider the Debug Generator service does not know.',
            {
              hint: `Set debuggen.provider to one of: ${PROVIDER_IDS.join(', ')}.`,
              details: { reason: 'provider' },
            },
          ),
        );
  }
  if (inherited !== undefined && inherited.trim() !== '') {
    return ok(undefined);
  }
  return ok(isProviderId(settings.providerDefault) ? settings.providerDefault : undefined);
}

/** The inputs of {@link buildServiceEnvironment}. */
export interface ServiceEnvironmentInput {
  /** The parent environment; copied, never mutated. */
  readonly base: Readonly<Record<string, string | undefined>>;
  /** `DEBUGGEN_HOME`: the state directory `./auth` resolved, so both processes agree. */
  readonly debuggenHome: string;
  /** `DEBUGGEN_HOST` and `DEBUGGEN_PORT`. */
  readonly address: Pick<ServiceListenAddress, 'host' | 'port'>;
  /** `DEBUGGEN_PROMPTS_DIR`, when the entry has a prompt directory to name. */
  readonly promptsDir?: string | undefined;
  /** `DEBUGGEN_PROVIDER`, when it is to be set rather than inherited. */
  readonly provider?: ProviderId | undefined;
  /** Whether the runtime is Electron run as Node. */
  readonly runAsNode: boolean;
  /** The host platform; environment names are case-insensitive on Windows. */
  readonly platform: NodeJS.Platform;
}

/**
 * Assembles the child's environment: a copy of the parent's, with only the
 * variables the service reads (`apps/local-service/src/config.ts`) applied —
 * `DEBUGGEN_HOME`, `DEBUGGEN_HOST`, `DEBUGGEN_PORT`, `DEBUGGEN_PROMPTS_DIR`,
 * `DEBUGGEN_PROVIDER` — plus `ELECTRON_RUN_AS_NODE` for an Electron runtime
 * (removed for a real Node, so it does not leak into the processes the service
 * launches). `DEBUGGEN_TOKEN`, `DEBUGGEN_INGEST_URL` and `DEBUGGEN_PROJECT_ROOT`
 * are removed: they are minted by the service's own launcher for a target
 * project's dev server and are never the service's to hold.
 *
 * Built through `Object.fromEntries`, so an inherited variable named like an
 * object-prototype key becomes an own property instead of rewriting the
 * prototype. The result must never be logged: it carries the parent's
 * environment, provider credentials included.
 *
 * @param input See {@link ServiceEnvironmentInput}.
 * @returns A fresh environment object.
 */
export function buildServiceEnvironment(input: ServiceEnvironmentInput): Record<string, string> {
  const applied = new Map<string, string>([
    ['DEBUGGEN_HOME', input.debuggenHome],
    ['DEBUGGEN_HOST', input.address.host],
    ['DEBUGGEN_PORT', String(input.address.port)],
  ]);
  if (input.promptsDir !== undefined) {
    applied.set('DEBUGGEN_PROMPTS_DIR', input.promptsDir);
  }
  if (input.provider !== undefined) {
    applied.set('DEBUGGEN_PROVIDER', input.provider);
  }
  if (input.runAsNode) {
    applied.set(ELECTRON_RUN_AS_NODE, '1');
  }

  const fold = (name: string): string => (input.platform === 'win32' ? name.toUpperCase() : name);
  const replaced = new Set<string>(
    [...applied.keys(), ...FOREIGN_CREDENTIAL_VARIABLES, ELECTRON_RUN_AS_NODE].map(fold),
  );
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(input.base)) {
    if (value !== undefined && !replaced.has(fold(name))) {
      entries.push([name, value]);
    }
  }
  entries.push(...applied.entries());
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Output hygiene (pure)
// ---------------------------------------------------------------------------

/** A secret shorter than this is not replaced by value; it would match too much prose. */
const MIN_SECRET_LENGTH = 8;

/** Environment variable names whose values are treated as secrets in the child's output. */
const SECRET_VARIABLE_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;

/** `Bearer <credential>` / `Basic <credential>`. */
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]+/gi;

/**
 * A key-like name followed by `:` or `=` and a value of at least eight
 * characters: `"token":"…"`, `password=…`, `apiKey: …`. Short values (counts,
 * booleans) are left alone, and a value starting with a bracket — an array, or
 * a value already replaced by {@link REDACTION_MARKER} — is not matched.
 */
const KEY_VALUE_PATTERN =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential|cookie)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(["']?)([^\s"',;&}[\]]{8,})/gi;

/** Credentials inside a URL's authority: a user name and a password before the `@` and the host. */
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

/** A JOSE compact serialisation: three base64url segments, the first a JSON header. */
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Provider and platform credential prefixes followed by a token body. */
const PREFIXED_CREDENTIAL =
  /\b(?:sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-)[A-Za-z0-9_-]{16,}/g;

/** An AWS access key id. */
const ACCESS_KEY_ID = /\bAKIA[A-Z0-9]{16}\b/g;

/** A long run of base64url characters: a candidate credential when it mixes letter cases and digits. */
const DENSE_RUN = /[A-Za-z0-9_-]{32,}/g;

/**
 * Removes ANSI escape sequences and control characters (tab excepted), so
 * colouring cannot split a credential past the patterns, and a child cannot
 * rewrite what the output channel shows.
 */
function stripControlCharacters(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const next = text[index + 1];
      if (next === '[') {
        let end = index + 2;
        while (end < text.length) {
          const final = text.charCodeAt(end);
          if (final >= 0x40 && final <= 0x7e) {
            break;
          }
          end += 1;
        }
        index = end;
      } else if (next === ']') {
        let end = index + 2;
        while (end < text.length) {
          const current = text.charCodeAt(end);
          if (current === 0x07) {
            break;
          }
          if (current === 0x1b && text[end + 1] === '\\') {
            end += 1;
            break;
          }
          end += 1;
        }
        index = end;
      } else {
        index += 1;
      }
      continue;
    }
    if ((code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    result += text[index] ?? '';
  }
  return result;
}

/** Whether a dense run mixes lower case, upper case and digits — hex digests and words do not. */
function looksLikeCredential(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);
}

/**
 * The values of secret-named variables in an environment, for exact-value
 * scrubbing of the child's output. Only the values are collected; names and
 * values never leave the scrubber.
 *
 * @param env The environment handed to the child.
 * @returns The secret values of at least {@link MIN_SECRET_LENGTH} characters.
 */
export function secretValuesOf(env: Readonly<Record<string, string | undefined>>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      value.length >= MIN_SECRET_LENGTH &&
      SECRET_VARIABLE_NAME.test(name)
    ) {
      values.push(value);
    }
  }
  return values;
}

/**
 * Builds the scrubber every line of the child's output passes before it is
 * written to the output channel, kept for a failure message, or parsed:
 *
 * 1. the exact value of every secret passed in (the editor credential, the
 *    values of secret-named environment variables) is replaced — before and
 *    after control characters are stripped, so colouring cannot hide one;
 * 2. bearer/basic credentials, key-value credentials, credentials in URLs,
 *    JWTs, provider-key prefixes and access-key ids are replaced by pattern;
 * 3. any remaining run of 32 or more base64url characters that mixes letter
 *    cases and digits — the shape of a minted credential — is replaced;
 * 4. the line is bounded to {@link MAX_OUTPUT_LINE_LENGTH} characters.
 *
 * The service never prints its credentials; this is the belt to that brace
 * (AAP §0.5.2, §0.5.6), the same rule the service's launcher applies to the
 * dev servers it spawns.
 *
 * @param secrets Exact values to replace; values shorter than eight characters are ignored.
 * @returns A pure function from a raw line to a safe one.
 */
export function createOutputScrubber(secrets: Iterable<string>): (line: string) => string {
  const exact = [...new Set([...secrets].filter((value) => value.length >= MIN_SECRET_LENGTH))]
    // Longest first, so a secret containing another is replaced whole.
    .sort((left, right) => right.length - left.length);
  const hide = (text: string): string =>
    exact.reduce((current, secret) => current.replaceAll(secret, REDACTION_MARKER), text);

  return (line) => {
    const cleaned = hide(stripControlCharacters(hide(line)))
      .replace(AUTH_SCHEME_PATTERN, `$1$2${REDACTION_MARKER}`)
      .replace(URL_CREDENTIAL_PATTERN, `$1$2:${REDACTION_MARKER}@`)
      .replace(KEY_VALUE_PATTERN, `$1$2$3${REDACTION_MARKER}`)
      .replace(JWT_SHAPE, REDACTION_MARKER)
      .replace(PREFIXED_CREDENTIAL, REDACTION_MARKER)
      .replace(ACCESS_KEY_ID, REDACTION_MARKER)
      .replace(DENSE_RUN, (run) => (looksLikeCredential(run) ? REDACTION_MARKER : run))
      .trimEnd();
    return cleaned.length > MAX_OUTPUT_LINE_LENGTH
      ? `${cleaned.slice(0, MAX_OUTPUT_LINE_LENGTH)} …[truncated]`
      : cleaned;
  };
}

/**
 * Turns arbitrarily split output chunks into whole lines. Multi-byte UTF-8
 * sequences split across chunks are decoded correctly, `\r\n` and `\n` both end
 * a line, and an unterminated fragment longer than `maxPending` characters is
 * released as a line of its own, so a child that never prints a newline cannot
 * grow the buffer without bound.
 */
export class OutputLineSplitter {
  readonly #decoder = new StringDecoder('utf8');
  readonly #maxPending: number;
  #pending = '';

  /** @param maxPending The longest unterminated fragment kept; defaults to {@link MAX_PENDING_OUTPUT_CHARS}. */
  constructor(maxPending: number = MAX_PENDING_OUTPUT_CHARS) {
    this.#maxPending = Math.max(
      1,
      Math.trunc(numberOrDefault(maxPending, MAX_PENDING_OUTPUT_CHARS)),
    );
  }

  /**
   * Accepts one chunk.
   *
   * @param chunk Bytes or text from the stream.
   * @returns The lines the chunk completed, without their terminators.
   */
  push(chunk: Buffer | string): string[] {
    this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    const lines: string[] = [];
    let newline = this.#pending.indexOf('\n');
    while (newline !== -1) {
      const line = this.#pending.slice(0, newline);
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      this.#pending = this.#pending.slice(newline + 1);
      newline = this.#pending.indexOf('\n');
    }
    while (this.#pending.length > this.#maxPending) {
      lines.push(this.#pending.slice(0, this.#maxPending));
      this.#pending = this.#pending.slice(this.#maxPending);
    }
    return lines;
  }

  /**
   * Releases whatever is buffered, as the stream ended.
   *
   * @returns The final unterminated fragment as a line, or nothing.
   */
  flush(): string[] {
    const rest = this.#pending + this.#decoder.end();
    this.#pending = '';
    return rest === '' ? [] : [rest.endsWith('\r') ? rest.slice(0, -1) : rest];
  }
}

/**
 * A start-up failure the service reported on stderr, read back into the two
 * parts a surfaced error may carry: the closed-vocabulary code and the
 * service's own message.
 *
 * The service's `debuggen: hint: <hint>` line is deliberately **not** part of
 * it. A hint read back from a child's stderr can relay output the editor must
 * not put in a notification (CWE-532), so a surfaced failure always carries
 * {@link SERVICE_OUTPUT_HINT}, which points at the output channel where the
 * service's full report — its hint included — is visible.
 */
export interface ReportedStartupFailure {
  /** The service's error code, from the closed vocabulary. */
  readonly code: DebuggenErrorCode;
  /** The service's message. */
  readonly message: string;
}

/**
 * Finds the start-up failure the service printed before exiting. Its
 * `main.ts` writes one `debuggen: <CODE>: <message>` line and, when it has one,
 * a `debuggen: hint: <hint>` line; the last failure line wins. A hint line is
 * skipped — never read as a failure and never returned (see
 * {@link ReportedStartupFailure}). Lines are expected to be scrubbed already.
 *
 * @param lines The child's scrubbed stderr lines, oldest first.
 * @returns The code and message, or `undefined` when the child printed no
 * failure line with a known code and a non-empty message.
 *
 * @example
 * ```ts
 * parseStartupFailure([
 *   'debuggen: CONFIG_INVALID: DEBUGGEN_PORT must be an integer.',
 *   'debuggen: hint: Set DEBUGGEN_PORT to a free port.',
 * ]);
 * // → { code: 'CONFIG_INVALID', message: 'DEBUGGEN_PORT must be an integer.' }
 * ```
 */
export function parseStartupFailure(lines: readonly string[]): ReportedStartupFailure | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith(STARTUP_FAILURE_PREFIX) || line.startsWith(STARTUP_HINT_PREFIX)) {
      continue;
    }
    const rest = line.slice(STARTUP_FAILURE_PREFIX.length);
    const separator = rest.indexOf(': ');
    const code = separator === -1 ? '' : rest.slice(0, separator);
    const message = separator === -1 ? '' : rest.slice(separator + 2).trim();
    if (!isErrorCode(code) || message === '') {
      continue;
    }
    return Object.freeze({ code, message });
  }
  return undefined;
}

/** Whether `value` is a code of the closed vocabulary. */
function isErrorCode(value: string): value is DebuggenErrorCode {
  return ERROR_CODE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Default seams (read at construction or call time, never at module load)
// ---------------------------------------------------------------------------

/**
 * The error codes Node attaches to the child-process, stream, socket and
 * argument errors this module can meet that are not libuv system errors, plus
 * the DNS resolver's `ENOTFOUND`. The same finite list as `./client` keeps for
 * its own records, restated because this module does not import `./client`
 * (see the module overview).
 */
const NODE_ERROR_CODES = Object.freeze([
  'ABORT_ERR',
  'ENOTFOUND',
  'ERR_CHILD_PROCESS_IPC_REQUIRED',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_STATE',
  'ERR_INVALID_URL',
  'ERR_IPC_CHANNEL_CLOSED',
  'ERR_OUT_OF_RANGE',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_UNHANDLED_ERROR',
] as const);

/** The memo of {@link knownErrorCodes}, built on first use rather than at load. */
let knownErrorCodeSet: ReadonlySet<string> | undefined;

/**
 * Every error code this module copies from a caught value's `code` property:
 * the names of the running platform's libuv system errors (`ENOENT`,
 * `EACCES`, `ESRCH`, … — `util.getSystemErrorMap()`, the table Node itself
 * names system errors from) and {@link NODE_ERROR_CODES}. Finite on purpose: a
 * `code` property is a value its thrower chose, and a pattern would still
 * admit an invented, credential-shaped value into a log record, a failure's
 * details or a message. Should the platform table be unavailable, only the
 * listed codes remain.
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

/** Whether `value` is one of the {@link knownErrorCodes}. */
function isKnownErrorCode(value: unknown): value is string {
  return typeof value === 'string' && knownErrorCodes().has(value);
}

/**
 * The Node error code of a caught value — its `code` property when that is
 * one of the {@link knownErrorCodes} — or `undefined`; never its message and
 * never an unknown code. Never throws, including for a value whose getters or
 * proxy traps throw.
 */
function errnoCodeOf(value: unknown): string | undefined {
  try {
    if (typeof value === 'object' && value !== null && 'code' in value) {
      const code: unknown = value.code;
      return isKnownErrorCode(code) ? code : undefined;
    }
  } catch {
    // A hostile getter or trap: no code is known.
  }
  return undefined;
}

/** `fs.statSync`-backed {@link PathKind}. */
function statPathKind(target: string): PathKind {
  try {
    const stats = statSync(target, { throwIfNoEntry: false });
    if (stats === undefined) {
      return 'missing';
    }
    if (stats.isFile()) {
      return 'file';
    }
    return stats.isDirectory() ? 'directory' : 'other';
  } catch (cause) {
    return errnoCodeOf(cause) === 'ENOTDIR' ? 'missing' : 'other';
  }
}

/** Whether `target` is a file this account may execute. */
function isExecutableFile(target: string): boolean {
  try {
    accessSync(target, fsConstants.X_OK);
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * `setTimeout`-backed scheduling. Every timer is `unref`'d: none of them may
 * keep the extension host alive on its own.
 */
function scheduleWithTimers(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, Math.max(0, numberOrDefault(delayMs, 0)));
  handle.unref();
  return () => {
    clearTimeout(handle);
  };
}

/** `node:child_process`'s `spawn`, with the invariant options spelled out. */
function spawnWithNode(
  command: string,
  args: readonly string[],
  options: ServiceSpawnOptions,
): ChildProcessLike {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
}

/**
 * Reads the three settings this module needs through
 * `workspace.getConfiguration("debuggen")`, on every call, so a changed
 * setting takes effect without a reload.
 */
function readWorkspaceSettings(): ServiceProcessSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const autoStart = configuration.get<unknown>('autoStartService');
  const serviceUrl = configuration.get<unknown>('serviceUrl');
  const provider = configuration.inspect<unknown>('provider');
  return {
    // The manifest default is `true`; a value that is not a boolean is read as
    // "off", because an ambiguous wish is never a licence to spawn.
    autoStartService: autoStart === undefined ? true : autoStart === true,
    serviceUrl:
      typeof serviceUrl === 'string' && serviceUrl.trim() !== ''
        ? serviceUrl.trim()
        : DEFAULT_SERVICE_URL,
    providerExplicit:
      provider?.workspaceFolderValue ?? provider?.workspaceValue ?? provider?.globalValue,
    providerDefault: provider?.defaultValue,
  };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Every `details.reason` a failure built by this module carries, as a closed
 * vocabulary: the only reasons {@link describeError} copies into a log record.
 * A reason outside it — a failure some other layer built — is left out of the
 * record rather than trusted.
 */
export const SERVICE_FAILURE_REASONS = Object.freeze([
  'node-runtime',
  'service-url',
  'provider',
  'bundle-incomplete',
  'spawn-failed',
  'exited',
  'crashed',
  'restarts-exhausted',
  'stopped',
  'disposed',
  'external',
  'restart-pending',
  'failed',
  'auto-start-disabled',
  'service-url-changed',
  'slow-start',
  'unresponsive',
  'unexpected',
] as const);

/** One member of {@link SERVICE_FAILURE_REASONS}. */
export type ServiceFailureReason = (typeof SERVICE_FAILURE_REASONS)[number];

/** Whether `value` is one of the {@link SERVICE_FAILURE_REASONS}. */
function isServiceFailureReason(value: unknown): value is ServiceFailureReason {
  return SERVICE_FAILURE_REASONS.some((reason) => reason === value);
}

/**
 * The name of the output channel `src/extension.ts` creates for the host's own
 * log records — where the correlation reference of an unexpected failure is
 * found. Distinct from {@link SERVICE_OUTPUT_CHANNEL_NAME}, which holds the
 * child's output.
 */
const HOST_LOG_CHANNEL_NAME = 'Debug Generator';

/** How a child ended, in words, for a message. */
interface ChildExit {
  /** The exit code, when the process exited normally. */
  readonly code: number | null;
  /** The terminating signal, when a signal ended it. */
  readonly signal: string | null;
  /** The errno code of a spawn failure, when the process never ran. */
  readonly spawnError: string | undefined;
}

/** "with exit code 1", "after signal SIGKILL", "(spawn error ENOENT)". */
function describeExit(exit: ChildExit): string {
  if (exit.spawnError !== undefined) {
    return `(spawn error ${exit.spawnError})`;
  }
  if (exit.signal !== null) {
    return `after signal ${exit.signal}`;
  }
  return exit.code === null ? 'without an exit code' : `with exit code ${String(exit.code)}`;
}

/** The origin of a service URL for a message, never its credentials or path. */
function describeServiceUrl(serviceUrl: string): string {
  const address = parseLoopbackServiceUrl(serviceUrl);
  return isOk(address) ? address.value.origin : 'the configured debuggen.serviceUrl';
}

/**
 * The log fields of a configured service URL: its validated loopback origin —
 * scheme, host and port, with no userinfo, path, query or fragment — and
 * whether it was accepted. A refused URL is logged as `serviceUrlAccepted:
 * false` with no origin at all. The configured value itself is never logged:
 * `readWorkspaceSettings` only trims it, so a pasted `user:password@` or
 * `?token=` survives into it (AAP §0.5.2).
 */
function serviceUrlLogFields(serviceUrl: string): LogFields {
  const address = parseLoopbackServiceUrl(serviceUrl);
  return isOk(address)
    ? { serviceOrigin: address.value.origin, serviceUrlAccepted: true }
    : { serviceUrlAccepted: false };
}

/** Nothing answers and this module may not, or did not, start a service. */
function notRunningError(serviceUrl: string, reason: ServiceFailureReason): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The Debug Generator service is not running at ${describeServiceUrl(serviceUrl)}.`,
    { hint: START_COMMAND_HINT, details: { reason } },
  );
}

/** A required part of the bundle is absent. `part` is a fixed label, never a path. */
function incompleteBundleError(part: string): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The Debug Generator service bundled with this extension is incomplete: ${part} is missing.`,
    { hint: BUILD_EXTENSION_HINT, details: { reason: 'bundle-incomplete', part } },
  );
}

/** The runtime could not be started at all. */
function spawnFailedError(errno: string | undefined): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The Debug Generator service process could not be started${errno === undefined ? '' : ` (${errno})`}.`,
    { hint: NODE_RUNTIME_HINT, details: { reason: 'spawn-failed', errno: errno ?? 'unknown' } },
  );
}

/**
 * The child ended before it answered: its own report's code and message when
 * it printed one, else the exit. The hint is always {@link SERVICE_OUTPUT_HINT}
 * — never a hint read back from the child's stderr — so nothing the service
 * relayed from its output reaches a notification.
 */
function exitedBeforeHealthyError(exit: ChildExit, stderrTail: readonly string[]): DebuggenError {
  if (exit.spawnError !== undefined) {
    return spawnFailedError(exit.spawnError);
  }
  const details = { reason: 'exited', exitCode: exit.code, signal: exit.signal };
  const reported = parseStartupFailure(stderrTail);
  if (reported !== undefined) {
    return new DebuggenError(reported.code, reported.message, {
      hint: SERVICE_OUTPUT_HINT,
      details,
    });
  }
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The Debug Generator service exited ${describeExit(exit)} before it answered its health check.`,
    { hint: SERVICE_OUTPUT_HINT, details },
  );
}

/** A healthy child ended unexpectedly. */
function crashedError(exit: ChildExit): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The Debug Generator service stopped unexpectedly ${describeExit(exit)}.`,
    {
      hint: SERVICE_OUTPUT_HINT,
      details: { reason: 'crashed', exitCode: exit.code, signal: exit.signal },
    },
  );
}

/** The restart policy gave up. */
function gaveUpError(attempts: number, cause: DebuggenError | undefined): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The Debug Generator service kept stopping and was restarted ${String(attempts)} times; it will not be restarted again automatically.`,
    {
      hint: SERVICE_OUTPUT_HINT,
      details: { reason: 'restarts-exhausted', attempts },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * A child of ours that answers nothing within the budget — still `starting`,
 * or `unresponsive` after it had answered. Neither is killed for it.
 */
function slowStartError(timeoutMs: number, phase: 'starting' | 'unresponsive'): DebuggenError {
  const seconds = String(Math.round(timeoutMs / 1000));
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The Debug Generator service has not answered its health check within ${seconds} s.`,
    {
      hint:
        phase === 'starting'
          ? `It is still starting and is being watched; the "${SERVICE_OUTPUT_CHANNEL_NAME}" output shows its progress.`
          : `The process is still running; the "${SERVICE_OUTPUT_CHANNEL_NAME}" output shows what it is doing. Restart it with "Debug Generator: Start Local Service" if it stays unresponsive.`,
      details: { reason: phase === 'starting' ? 'slow-start' : 'unresponsive', timeoutMs },
    },
  );
}

/** A start that `stop()` or `dispose()` cancelled. */
function stoppedError(): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    'The Debug Generator service was stopped before it answered its health check.',
    { hint: START_COMMAND_HINT, details: { reason: 'stopped' } },
  );
}

/** Any lifecycle call after `dispose()`. */
function disposedError(): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    'The Debug Generator service manager has been disposed; no service is started.',
    { details: { reason: 'disposed' } },
  );
}

/** `restart()` for a service this module did not spawn. */
function externalRestartError(serviceUrl: string): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The Debug Generator service at ${describeServiceUrl(serviceUrl)} was not started by this window, so it cannot be restarted from here.`,
    {
      hint: 'Stop it where it was started — a terminal or another VS Code window — then run "Debug Generator: Start Local Service".',
      details: { reason: 'external' },
    },
  );
}

/**
 * `debuggen.serviceUrl` moved away from the address a live child of this
 * window listens on. The child is kept — never stopped or replaced for it —
 * because it may hold an active session whose instrumentation only it can
 * remove. Both origins are loopback origins with no credentials (the parse
 * refuses those), so naming them is safe.
 */
function serviceUrlMovedError(childOrigin: string, configuredOrigin: string): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `debuggen.serviceUrl now names ${configuredOrigin}, but the Debug Generator service this window started listens on ${childOrigin}.`,
    {
      hint: `It is kept running so an active session can still be ended and its instrumentation removed. Set debuggen.serviceUrl back to ${childOrigin} to keep using it, or run "Debug Generator: Start Local Service" and choose "Restart service" to move it — the restarted service restores every instrumented file when it starts.`,
      details: { reason: 'service-url-changed', childOrigin, configuredOrigin },
    },
  );
}

/**
 * An ensure attempt threw. The returned failure is surfaced to the developer
 * (a notification), so its message is a fixed sentence naming `ref` — the
 * correlation reference the matching log record carries — and never the
 * thrown text, which can quote a path, a URL or a credential. The code is the
 * thrown `DebuggenError`'s own when it is one, `INTERNAL` otherwise; the
 * original value stays reachable as `cause` for a debugger, and neither
 * `toPayload()` nor any log record here reads it.
 */
function unexpectedFailureError(cause: unknown, ref: string): DebuggenError {
  return new DebuggenError(
    DebuggenError.is(cause) ? cause.code : 'INTERNAL',
    `Checking or starting the Debug Generator service failed unexpectedly (reference ${ref}).`,
    {
      hint: `Open the "${HOST_LOG_CHANNEL_NAME}" output and look for reference ${ref}, then run "Debug Generator: Start Local Service".`,
      details: { reason: 'unexpected', ref },
      cause,
    },
  );
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

/** The entry a child is spawned from. */
interface ServiceEntry {
  readonly origin: ServiceEntryOrigin;
  /** Absolute path of the entry script — the only argument the child gets. */
  readonly main: string;
  /** The entry's own directory, the child's working directory. */
  readonly cwd: string;
  /** `DEBUGGEN_PROMPTS_DIR`, when the entry names one. */
  readonly promptsDir: string | undefined;
}

/**
 * Everything one spawn needs. `env` carries the parent environment and
 * `secrets` the values the scrubber replaces: neither is ever logged.
 */
interface LaunchPlan {
  readonly entry: ServiceEntry;
  readonly runtime: NodeRuntime;
  readonly address: ServiceListenAddress;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  /** Whether `auth.json` was unusable in a way the starting service repairs itself. */
  readonly credentialPendingRepair: boolean;
}

/** One spawned child and what is known about it. */
interface ManagedChild {
  readonly process: ChildProcessLike;
  readonly pid: number | undefined;
  readonly plan: LaunchPlan;
  /** Settles once, when the process exited or failed to spawn. */
  readonly exited: Promise<ChildExit>;
  /** Settles when both output streams ended (or immediately without streams). */
  readonly drained: Promise<void>;
  /** The scrubbed tail of stderr, oldest first. */
  readonly stderrTail: string[];
  exit: ChildExit | undefined;
  /** Set once this module decided to stop the child; its exit is then not a crash. */
  stopping: boolean;
  /**
   * Set when a stop released the child to finish accepted work on its own
   * ({@link StopOptions.release}); it is never signalled by this module again.
   */
  released: boolean;
  /** When the child first answered `/health`, in epoch milliseconds. */
  healthySince: number | undefined;
  /** The shared termination, once one began. */
  termination: Promise<void> | undefined;
}

/** How one launch attempt ended. */
type LaunchOutcome =
  | { readonly kind: 'healthy' }
  | { readonly kind: 'external' }
  | { readonly kind: 'slow'; readonly error: DebuggenError }
  | { readonly kind: 'aborted'; readonly error: DebuggenError }
  | {
      /** `debuggen.serviceUrl` stopped naming the child's address while it started; the child is kept. */
      readonly kind: 'moved';
      readonly error: DebuggenError;
    }
  | {
      readonly kind: 'failed';
      readonly error: DebuggenError;
      /** `true` when a child ran and exited; `false` when nothing could be spawned. */
      readonly exited: boolean;
    };

/**
 * How a health wait ended. `moved`: the configured service URL no longer
 * names the child's address, so an answer there would not be the child's.
 */
type HealthWait = 'healthy' | 'exited' | 'timeout' | 'aborted' | 'moved';

/** A signal that never aborts, for waits only a timer or a promise ends. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/** The snapshot fields a state change may patch. */
type StatusPatch = { -readonly [K in keyof ServiceStatus]?: ServiceStatus[K] };

/** The implementation behind {@link createServiceProcess}. */
class EmbeddedServiceProcess implements ServiceProcess {
  readonly #paths: EmbeddedPaths;
  readonly #workspaceService: WorkspaceServiceEntry | undefined;
  readonly #probe: ServiceHealthProbe;
  readonly #credential: ServiceCredentialPort;
  readonly #nodePath: string | undefined;
  readonly #logger: Logger;
  readonly #env: () => Readonly<Record<string, string | undefined>>;
  readonly #spawn: SpawnLike;
  readonly #readSettings: () => ServiceProcessSettings;
  readonly #createChannel: (name: string) => ServiceOutputChannel;
  readonly #now: () => number;
  readonly #schedule: ScheduleLike;
  readonly #pathKind: (target: string) => PathKind;
  readonly #isExecutable: (target: string) => boolean;
  readonly #execPath: string;
  readonly #versions: Readonly<{ node: string; electron?: string | undefined }>;
  readonly #platform: NodeJS.Platform;
  readonly #policy: RestartPolicy;
  readonly #startupTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #slowPollIntervalMs: number;
  readonly #probeTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #quiesceTimeoutMs: number;

  readonly #listeners = new Set<(status: ServiceStatus) => void>();
  readonly #criticalOperations = new Set<Promise<unknown>>();
  /**
   * Every `stop()` and `restart()` stop still running. While one is, it owns
   * the child's termination — its quiesce bound, grace window and escalation
   * decision — and `dispose()` does not start a second one beside it.
   */
  readonly #stopsInFlight = new Set<Promise<void>>();
  readonly #configSubscription: DisposableLike | undefined;

  #status: ServiceStatus;
  #child: ManagedChild | undefined;
  #ensureInFlight: Promise<Result<ServiceStatus, DebuggenError>> | undefined;
  #ensureInFlightUserInitiated = false;
  #startAbort: AbortController | undefined;
  #cancelRestartTimer: (() => void) | undefined;
  #restartAttempts = 0;
  #failureLatched = false;
  #stopRequested = false;
  /**
   * Incremented by every `stop()` and `restart()`. A restart scheduled after a
   * crash captures it and gives up when it changed: a stop that began after
   * the restart was planned always wins over it, even if a later explicit
   * start cleared {@link #stopRequested} in between.
   */
  #stopGeneration = 0;
  #disposed = false;
  #channel: ServiceOutputChannel | undefined;
  #channelDisposed = false;
  #retainedChars = 0;

  constructor(deps: ServiceProcessDeps) {
    this.#paths = deps.paths;
    this.#workspaceService = deps.workspaceService;
    this.#probe = deps.probe;
    this.#credential = deps.credential;
    this.#nodePath = deps.nodePath;
    this.#logger = (deps.logger ?? noopLogger).child({ subsystem: 'service-process' });
    const injectedEnv = deps.env;
    this.#env = injectedEnv === undefined ? () => process.env : () => injectedEnv;
    this.#spawn = deps.spawn ?? spawnWithNode;
    this.#readSettings = deps.readSettings ?? readWorkspaceSettings;
    this.#createChannel =
      deps.createOutputChannel ?? ((name) => vscode.window.createOutputChannel(name));
    this.#now = deps.now ?? nowEpochMs;
    this.#schedule = deps.schedule ?? scheduleWithTimers;
    this.#pathKind = deps.pathKind ?? statPathKind;
    this.#isExecutable = deps.isExecutable ?? isExecutableFile;
    this.#execPath = deps.execPath ?? process.execPath;
    this.#versions = deps.versions ?? process.versions;
    this.#platform = deps.platform ?? process.platform;
    this.#policy = deps.restartPolicy ?? DEFAULT_RESTART_POLICY;
    this.#startupTimeoutMs = positiveOr(deps.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.#pollIntervalMs = positiveOr(deps.healthPollIntervalMs, DEFAULT_HEALTH_POLL_INTERVAL_MS);
    this.#slowPollIntervalMs = positiveOr(
      deps.slowStartPollIntervalMs,
      SLOW_START_POLL_INTERVAL_MS,
    );
    this.#probeTimeoutMs = positiveOr(deps.healthProbeTimeoutMs, DEFAULT_HEALTH_PROBE_TIMEOUT_MS);
    this.#stopGraceMs = positiveOr(deps.stopGraceMs, DEFAULT_STOP_GRACE_MS);
    this.#quiesceTimeoutMs = positiveOr(deps.quiesceTimeoutMs, DEFAULT_QUIESCE_TIMEOUT_MS);

    this.#status = Object.freeze({
      state: 'idle',
      mode: undefined,
      pid: undefined,
      origin: undefined,
      runtime: undefined,
      serviceUrl: this.#settings().serviceUrl,
      restartAttempts: 0,
      settingsChanged: false,
      error: undefined,
      since: this.#now(),
    });

    const subscribe =
      deps.onDidChangeConfiguration ??
      ((listener: (event: ConfigurationChangeLike) => void) =>
        vscode.workspace.onDidChangeConfiguration(listener));
    let subscription: DisposableLike | undefined;
    try {
      subscription = subscribe((event) => {
        this.#onConfigurationChanged(event);
      });
    } catch (cause) {
      this.#logger.warn('could not subscribe to configuration changes', errorFields(cause));
    }
    this.#configSubscription = subscription;
  }

  get status(): ServiceStatus {
    return this.#status;
  }

  get outputChannel(): ServiceOutputChannel | undefined {
    return this.#channelDisposed ? undefined : this.#channel;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  ensureRunning(options: EnsureRunningOptions = {}): Promise<Result<ServiceStatus, DebuggenError>> {
    if (this.#disposed) {
      return Promise.resolve(err(disposedError()));
    }
    const userInitiated = options.userInitiated === true;
    if (userInitiated) {
      // The developer's explicit request clears a latched failure and a
      // requested stop, and starts a fresh restart series.
      this.#failureLatched = false;
      this.#stopRequested = false;
      this.#restartAttempts = 0;
    }
    const inFlight = this.#ensureInFlight;
    if (inFlight !== undefined) {
      if (!userInitiated || this.#ensureInFlightUserInitiated) {
        return inFlight;
      }
      // An automatic attempt is running; the explicit request gets a fresh one
      // should the automatic attempt not have produced a service.
      return inFlight.then((result) => (isOk(result) ? result : this.ensureRunning(options)));
    }
    return this.#track(() => this.#ensureRunningNow(userInitiated), userInitiated);
  }

  stop(options: StopOptions = {}): Promise<void> {
    this.#recordStopRequest();
    return this.#trackStop(this.#stopChild(options));
  }

  /**
   * Records the intent to stop — synchronously, before any quiesce begins — so
   * a child exit observed while the stop waits is never answered with a
   * restart, and a restart already planned or running gives up.
   */
  #recordStopRequest(): void {
    this.#stopRequested = true;
    this.#stopGeneration += 1;
  }

  /**
   * Registers a running stop in {@link #stopsInFlight} synchronously and
   * releases it once it settled, so `dispose()` — which VS Code calls right
   * after `deactivate()` returned its promise — sees the stop and leaves the
   * child's termination to it.
   */
  #trackStop(stopping: Promise<void>): Promise<void> {
    this.#stopsInFlight.add(stopping);
    const release = (): void => {
      this.#stopsInFlight.delete(stopping);
    };
    void stopping.then(release, release);
    return stopping;
  }

  /**
   * The body of {@link ServiceProcess.stop} and of the stop half of
   * {@link ServiceProcess.restart}; the caller records the stop request.
   * Never rejects.
   */
  async #stopChild(options: StopOptions): Promise<void> {
    try {
      this.#cancelPendingRestart();
      this.#startAbort?.abort();
      await this.#quiesce(options);
      // Again after the wait: the quiesce can last seconds, and anything that
      // was planned or started meanwhile belongs to the service being stopped.
      this.#cancelPendingRestart();
      this.#startAbort?.abort();
      const child = this.#child;
      if (child !== undefined && this.#shouldRelease(child, options.release)) {
        this.#releaseChild(child);
      } else if (child !== undefined) {
        await this.#terminate(
          child,
          positiveOr(options.graceMs, this.#stopGraceMs),
          options.escalate,
        );
      }
      if (
        this.#status.state === 'starting' ||
        this.#status.state === 'running' ||
        child !== undefined
      ) {
        this.#update({ state: 'stopped', mode: undefined, pid: undefined });
      }
    } catch (cause) {
      this.#logger.error('stopping the service failed unexpectedly', errorFields(cause));
    }
  }

  async restart(options: StopOptions = {}): Promise<Result<ServiceStatus, DebuggenError>> {
    if (this.#disposed) {
      return err(disposedError());
    }
    const serviceUrl = this.#settings().serviceUrl;
    // A child a stop released is no longer this window's to signal: like a
    // service another window started, it is restarted where it runs.
    const own = this.#child;
    const notOurs = own === undefined ? this.#status.state === 'external' : own.released;
    if (notOurs && (await this.#probeOnce())) {
      return err(externalRestartError(serviceUrl));
    }
    // Held while the old child stops, so no automatic attempt slips a child in
    // between; the user-initiated start below clears it.
    this.#recordStopRequest();
    await this.#trackStop(this.#stopChild(options));
    const pending = this.#ensureInFlight;
    if (pending !== undefined) {
      await pending;
    }
    if (this.#disposed) {
      return err(disposedError());
    }
    return this.ensureRunning({ userInitiated: true });
  }

  keepAliveFor<T>(operation: Promise<T>): Promise<T> {
    const tracked: Promise<unknown> = operation;
    this.#criticalOperations.add(tracked);
    const release = (): void => {
      this.#criticalOperations.delete(tracked);
    };
    void operation.then(release, release);
    return operation;
  }

  onDidChangeStatus(listener: (status: ServiceStatus) => void): DisposableLike {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  showOutput(preserveFocus = true): void {
    try {
      this.#ensureChannel()?.show(preserveFocus);
    } catch (cause) {
      this.#logger.warn('could not reveal the service output', errorFields(cause));
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    try {
      this.#cancelPendingRestart();
      this.#startAbort?.abort();
      this.#configSubscription?.dispose();
    } catch (cause) {
      this.#logger.warn('releasing the service manager failed', errorFields(cause));
    }

    const child = this.#child;
    if (child !== undefined && this.#stopsInFlight.size > 0) {
      // A `stop()` is still running — `deactivate()`'s, which VS Code follows
      // with this call at once. It owns the child's termination, with the
      // bounds and the escalation decision its caller chose; a second quiesce
      // and SIGTERM → SIGKILL sequence here would race it and could kill the
      // service in the middle of restoring files (AAP §0.5.1).
      this.#logger.debug('a stop is in flight; it keeps ownership of the service termination', {
        pid: child.pid,
      });
    } else if (child !== undefined) {
      // `dispose()` cannot await, but it still never signals the child ahead
      // of a registered end-of-session request (AAP §0.5.1): the quiesce and
      // the termination run on, bounded, after this returns.
      void this.#quiesce({})
        .then(() => this.#terminate(child, this.#stopGraceMs, true))
        .catch((cause: unknown) => {
          this.#logger.error('stopping the service on dispose failed', errorFields(cause));
        });
    }
    if (
      child !== undefined ||
      this.#status.state === 'starting' ||
      this.#status.state === 'running'
    ) {
      this.#update({ state: 'stopped', mode: undefined, pid: undefined });
    }
    this.#listeners.clear();

    try {
      this.#channel?.dispose();
    } catch (cause) {
      this.#logger.warn('disposing the service output channel failed', errorFields(cause));
    }
    this.#channel = undefined;
    this.#channelDisposed = true;
  }

  // -------------------------------------------------------------------------
  // Ensuring a service
  // -------------------------------------------------------------------------

  /**
   * Runs one ensure attempt as the shared in-flight attempt. The returned
   * promise never rejects: an unexpected throw becomes a failure with a fixed
   * message naming a fresh correlation reference, and the log record under
   * that reference carries the thrown value's code, class and errno only —
   * never its text, which the notification showing the failure would
   * otherwise repeat too.
   */
  #track(
    attempt: () => Promise<Result<ServiceStatus, DebuggenError>>,
    userInitiated: boolean,
  ): Promise<Result<ServiceStatus, DebuggenError>> {
    const running = (async (): Promise<Result<ServiceStatus, DebuggenError>> => {
      try {
        return await attempt();
      } catch (cause) {
        const ref = newMessageId();
        this.#logger.error('ensuring the service failed unexpectedly', {
          ref,
          ...errorFields(cause),
        });
        return err(unexpectedFailureError(cause, ref));
      }
    })();
    this.#ensureInFlight = running;
    this.#ensureInFlightUserInitiated = userInitiated;
    const release = (): void => {
      if (this.#ensureInFlight === running) {
        this.#ensureInFlight = undefined;
        this.#ensureInFlightUserInitiated = false;
      }
    };
    void running.then(release, release);
    return running;
  }

  /** The body of {@link ServiceProcess.ensureRunning}; see the interface for the sequence. */
  async #ensureRunningNow(userInitiated: boolean): Promise<Result<ServiceStatus, DebuggenError>> {
    const settings = this.#settings();
    this.#update({ serviceUrl: settings.serviceUrl });

    // 1. A child of ours is alive: it answers, it is still starting, or it was
    //    started for an address the setting no longer names (it is kept, and
    //    only `restart()` moves it).
    const own = this.#child;
    if (own !== undefined && own.exit === undefined && !own.stopping) {
      return this.#ensureOwnChild(own, settings);
    }

    // 2. A restart is already scheduled after a crash: an automatic caller
    //    leaves it to the policy; the developer's request runs it now.
    if (this.#cancelRestartTimer !== undefined) {
      if (!userInitiated) {
        return err(this.#status.error ?? notRunningError(settings.serviceUrl, 'restart-pending'));
      }
      this.#cancelPendingRestart();
    }

    // 3. Something answers: never spawn a second service.
    if (await this.#probeOnce()) {
      if (this.#disposed) {
        return err(disposedError());
      }
      this.#update({
        state: 'external',
        mode: 'external',
        pid: undefined,
        error: undefined,
        settingsChanged: false,
      });
      this.#logger.info(
        'a service is already answering; nothing was spawned',
        serviceUrlLogFields(this.#status.serviceUrl),
      );
      return ok(this.#status);
    }
    if (this.#disposed) {
      return err(disposedError());
    }

    // 4. A failure no automatic call should repeat (a configuration error, an
    //    exhausted restart series) stays latched until the developer acts or a
    //    relevant setting changes.
    if (this.#failureLatched && !userInitiated) {
      return err(this.#status.error ?? notRunningError(settings.serviceUrl, 'failed'));
    }
    if (this.#stopRequested && !userInitiated) {
      // `stop()` was asked for (a shutdown in progress, or a restart about to
      // start its own attempt): a dropped connection must not bring the
      // service straight back.
      return err(notRunningError(settings.serviceUrl, 'stopped'));
    }

    // 5. Never spawn against the developer's wish.
    if (!settings.autoStartService && !userInitiated) {
      const error = notRunningError(settings.serviceUrl, 'auto-start-disabled');
      this.#update({ state: 'idle', mode: undefined, pid: undefined, error });
      this.#logger.info(
        'the service is not running and auto-start is disabled',
        serviceUrlLogFields(this.#status.serviceUrl),
      );
      return err(error);
    }

    // 6. Start the embedded service.
    return this.#resultOf(await this.#launch(settings, 'initial'));
  }

  /**
   * {@link ServiceProcess.ensureRunning} while a child of ours is alive.
   *
   * The address comes first. The injected probe follows `debuggen.serviceUrl`
   * on its own (the client behind it moves its base URL as soon as the setting
   * changes), so once the setting names another origin a probe answer comes
   * from whatever listens *there*, never from this child. Such a child is
   * retained ({@link #retainMovedChild}) — not stopped, signalled or replaced:
   * it may be the only process that can still end an active session and
   * remove its instrumentation, and `restart()` is the developer's explicit
   * way to move it.
   */
  async #ensureOwnChild(
    child: ManagedChild,
    settings: ServiceProcessSettings,
  ): Promise<Result<ServiceStatus, DebuggenError>> {
    if (!this.#namesChild(child, settings.serviceUrl)) {
      return this.#retainMovedChild(child, settings.serviceUrl);
    }

    const answered = await this.#probeOnce();
    if (this.#disposed) {
      return err(disposedError());
    }
    if (!this.#namesChild(child)) {
      // The setting moved while the probe ran: the answer is not the child's.
      return this.#retainMovedChild(child, this.#settings().serviceUrl);
    }
    if (answered) {
      if (child.exit === undefined && !child.stopping) {
        this.#reportAnswering(child);
      }
      return ok(this.#status);
    }

    // Same address, no answer yet: it is starting (possibly slowly — start-up
    // reconciles modification records) or busy. It is waited for, never
    // killed: killing it could interrupt exactly the restore AAP §0.5.1
    // protects.
    const abort = this.#startAbort ?? new AbortController();
    const outcome = await this.#awaitHealthy(child, abort.signal, this.#startupTimeoutMs);
    switch (outcome) {
      case 'healthy':
        // Also restores `running` for a child that answered before and was
        // reported as moved or external until the URL was set back.
        this.#reportAnswering(child);
        return ok(this.#status);
      case 'timeout':
        return err(
          slowStartError(
            this.#startupTimeoutMs,
            child.healthySince === undefined ? 'starting' : 'unresponsive',
          ),
        );
      case 'aborted':
        return err(this.#disposed ? disposedError() : stoppedError());
      case 'exited':
        return err(this.#status.error ?? notRunningError(settings.serviceUrl, 'exited'));
      case 'moved':
        return this.#retainMovedChild(child, this.#settings().serviceUrl);
    }
  }

  /**
   * {@link ServiceProcess.ensureRunning} for a live child whose address
   * `serviceUrl` no longer names. Never stops, signals or replaces the child;
   * it classifies what the configured URL reaches instead:
   *
   * - an unusable URL — the `CONFIG_INVALID` parse failure;
   * - something answers there — a service this module did not start, used as
   *   `external` (the child stays supervised in the background, and
   *   `restart()` retires it);
   * - nothing answers — {@link serviceUrlMovedError}, with the status still
   *   describing the child (`running` or `starting`, its pid) so the developer
   *   is offered the restart that moves it.
   *
   * Every branch flags `settingsChanged`.
   */
  async #retainMovedChild(
    child: ManagedChild,
    serviceUrl: string,
  ): Promise<Result<ServiceStatus, DebuggenError>> {
    const childOrigin = child.plan.address.origin;
    const configured = parseLoopbackServiceUrl(serviceUrl);
    if (isErr(configured)) {
      this.#update({ error: configured.error, settingsChanged: true });
      this.#logger.warn(
        'debuggen.serviceUrl cannot name a service; the service this window started is kept running',
        { pid: child.pid, childOrigin },
      );
      return err(configured.error);
    }
    const configuredOrigin = configured.value.origin;

    const answered = await this.#probeOnce();
    if (this.#disposed) {
      return err(disposedError());
    }
    if (child.exit !== undefined || child.stopping) {
      // The child ended (or is being stopped) while the probe ran; its exit
      // handling owns the status now.
      return err(
        this.#status.error ?? notRunningError(serviceUrl, child.stopping ? 'stopped' : 'exited'),
      );
    }
    const current = this.#settings();
    if (current.serviceUrl !== serviceUrl) {
      // The setting changed again while the probe ran, so the answer describes
      // an address nobody asks about any more: classify the current one.
      return this.#ensureOwnChild(child, current);
    }

    if (answered) {
      this.#update({
        state: 'external',
        mode: 'external',
        pid: undefined,
        error: undefined,
        settingsChanged: true,
      });
      this.#logger.info(
        'another service answers at the new service URL; using it, and keeping the service this window started running',
        { childOrigin, configuredOrigin, pid: child.pid },
      );
      return ok(this.#status);
    }

    const error = serviceUrlMovedError(childOrigin, configuredOrigin);
    const healthy = child.healthySince !== undefined;
    this.#update({
      state: healthy ? 'running' : 'starting',
      mode: healthy ? 'embedded' : undefined,
      pid: child.pid,
      origin: child.plan.entry.origin,
      runtime: child.plan.runtime.source,
      error,
      settingsChanged: true,
    });
    this.#logger.warn(
      'the service URL changed; nothing answers there, and the service this window started is kept running until it is restarted',
      { childOrigin, configuredOrigin, pid: child.pid },
    );
    return err(error);
  }

  /**
   * Whether `serviceUrl` (by default the current `debuggen.serviceUrl`) names
   * the origin `child` listens on. The loopback parse, not the listen-address
   * one: a move to an unreachable (Fetch-blocked) port is still a move.
   */
  #namesChild(child: ManagedChild, serviceUrl: string = this.#settings().serviceUrl): boolean {
    const configured = parseLoopbackServiceUrl(serviceUrl);
    return isOk(configured) && configured.value.origin === child.plan.address.origin;
  }

  /**
   * A live child of ours answered at the configured URL: the first answer
   * marks it healthy; a later one restores `running` when the status says
   * otherwise — after the URL was set back to the child's address, say.
   */
  #reportAnswering(child: ManagedChild): void {
    if (child.healthySince === undefined) {
      this.#markHealthy(child);
      return;
    }
    this.#update({
      state: 'running',
      mode: 'embedded',
      pid: child.pid,
      origin: child.plan.entry.origin,
      runtime: child.plan.runtime.source,
      error: undefined,
    });
  }

  /**
   * A start whose child the configured URL stopped naming is no longer
   * watched for health: an answer at the new address would not be the child's.
   * Its exit, should it end before it ever answered, is still accounted for —
   * as the early exit it is — so the status never keeps describing a process
   * that is gone.
   */
  #releaseMovedStart(child: ManagedChild, kind: 'initial' | 'restart'): void {
    this.#logger.info(
      'the service URL changed while the service was starting; it is kept running',
      {
        pid: child.pid,
        childOrigin: child.plan.address.origin,
      },
    );
    void child.exited
      .then(async () => {
        // A child that answered later exits as a crash (`#onChildExit`); a
        // child already replaced is no longer the status's subject.
        if (child.healthySince === undefined && this.#child === undefined) {
          await this.#afterEarlyExit(child, kind);
        }
      })
      .catch((cause: unknown) => {
        this.#logger.error('handling the exit of a moved service failed', errorFields(cause));
      });
  }

  /** Maps a launch outcome to the result {@link ServiceProcess.ensureRunning} resolves with. */
  #resultOf(outcome: LaunchOutcome): Result<ServiceStatus, DebuggenError> {
    switch (outcome.kind) {
      case 'healthy':
      case 'external':
        return ok(this.#status);
      case 'slow':
      case 'aborted':
      case 'moved':
      case 'failed':
        return err(outcome.error);
    }
  }

  // -------------------------------------------------------------------------
  // Launching
  // -------------------------------------------------------------------------

  /**
   * One launch attempt: prepare, spawn, wait for health.
   *
   * `kind` decides what an early exit means: after an `initial` launch it is a
   * failure that is latched (a configuration error would only repeat); after a
   * `restart` the supervision policy counts it and may try again.
   */
  async #launch(
    settings: ServiceProcessSettings,
    kind: 'initial' | 'restart',
  ): Promise<LaunchOutcome> {
    const abort = new AbortController();
    this.#startAbort = abort;
    this.#update({
      state: 'starting',
      mode: undefined,
      pid: undefined,
      serviceUrl: settings.serviceUrl,
      restartAttempts: this.#restartAttempts,
      settingsChanged: false,
    });

    const prepared = await this.#prepareLaunch(settings, abort.signal);
    if (isErr(prepared)) {
      if (abort.signal.aborted || this.#disposed) {
        return this.#aborted();
      }
      this.#fail(prepared.error);
      return { kind: 'failed', error: prepared.error, exited: false };
    }
    if (abort.signal.aborted || this.#disposed) {
      return this.#aborted();
    }

    const spawned = this.#spawnChild(prepared.value);
    if (isErr(spawned)) {
      this.#fail(spawned.error);
      return { kind: 'failed', error: spawned.error, exited: false };
    }
    const child = spawned.value;
    this.#update({
      state: 'starting',
      pid: child.pid,
      origin: prepared.value.entry.origin,
      runtime: prepared.value.runtime.source,
    });

    const outcome = await this.#awaitHealthy(child, abort.signal, this.#startupTimeoutMs);
    switch (outcome) {
      case 'healthy':
        this.#markHealthy(child);
        return { kind: 'healthy' };
      case 'aborted':
        return this.#aborted();
      case 'timeout': {
        const error = slowStartError(this.#startupTimeoutMs, 'starting');
        this.#update({ error });
        this.#logger.warn('the service has not answered yet; it keeps being watched', {
          pid: child.pid,
          timeoutMs: this.#startupTimeoutMs,
        });
        this.#watchSlowStart(child, abort.signal, kind);
        return { kind: 'slow', error };
      }
      case 'exited':
        return this.#afterEarlyExit(child, kind);
      case 'moved': {
        const error = this.#movedStartError(child);
        this.#update({ error, settingsChanged: true });
        this.#releaseMovedStart(child, kind);
        return { kind: 'moved', error };
      }
    }
  }

  /**
   * The failure for a start whose child the configured URL stopped naming:
   * the URL's own parse failure when it is unusable, else
   * {@link serviceUrlMovedError}.
   */
  #movedStartError(child: ManagedChild): DebuggenError {
    const configured = parseLoopbackServiceUrl(this.#settings().serviceUrl);
    return isOk(configured)
      ? serviceUrlMovedError(child.plan.address.origin, configured.value.origin)
      : configured.error;
  }

  /** The outcome of a launch that `stop()` or `dispose()` cancelled. */
  #aborted(): LaunchOutcome {
    return { kind: 'aborted', error: this.#disposed ? disposedError() : stoppedError() };
  }

  /**
   * A child ended before it answered. If a service answers now anyway, another
   * process won the port (a second editor window, a terminal) and it is used as
   * `external`. Otherwise the child's own report becomes the failure.
   */
  async #afterEarlyExit(child: ManagedChild, kind: 'initial' | 'restart'): Promise<LaunchOutcome> {
    if (child.stopping || this.#disposed) {
      return this.#aborted();
    }
    // Let the pipes drain, so the service's final report is in the tail. A
    // process that never ran has nothing to drain.
    if (child.exit?.spawnError === undefined) {
      await this.#raceTimeout(child.drained, 1_000);
    }
    if (await this.#probeOnce()) {
      this.#restartAttempts = 0;
      this.#update({ state: 'external', mode: 'external', pid: undefined, error: undefined });
      this.#logger.info(
        'another service answered after the spawned one exited; using it',
        serviceUrlLogFields(this.#status.serviceUrl),
      );
      return { kind: 'external' };
    }
    const error = exitedBeforeHealthyError(
      child.exit ?? { code: null, signal: null, spawnError: undefined },
      child.stderrTail,
    );
    this.#logger.warn('the service exited before it answered', {
      pid: child.pid,
      ...describeError(error),
    });
    if (kind === 'restart') {
      this.#scheduleRestart(error, 0);
    } else {
      this.#fail(error);
    }
    return { kind: 'failed', error, exited: true };
  }

  /**
   * Everything a spawn needs, in the order that makes each failure precise:
   * the entry, the address, the provider, the state directory, the runtime —
   * then the editor credential, which is the only step with a side effect
   * (creating `auth.json`), so it runs last and only for a spawn that will
   * happen.
   */
  async #prepareLaunch(
    settings: ServiceProcessSettings,
    signal: AbortSignal,
  ): Promise<Result<LaunchPlan, DebuggenError>> {
    const entry = this.#selectEntry();
    if (isErr(entry)) {
      return entry;
    }
    const address = parseServiceListenAddress(settings.serviceUrl);
    if (isErr(address)) {
      return address;
    }
    const parentEnv = this.#env();
    const provider = resolveProviderSetting(
      settings,
      envValue(parentEnv, 'DEBUGGEN_PROVIDER', this.#platform),
    );
    if (isErr(provider)) {
      return provider;
    }
    const home = this.#credential.paths();
    if (isErr(home)) {
      return home;
    }
    const nodeRuntime = resolveNodeRuntime({
      nodePath: this.#nodePath,
      execPath: this.#execPath,
      versions: this.#versions,
      env: parentEnv,
      platform: this.#platform,
      isExecutable: this.#isExecutable,
    });
    if (isErr(nodeRuntime)) {
      return nodeRuntime;
    }
    if (
      nodeRuntime.value.source === 'host-electron' &&
      (nodeRuntime.value.nodeMajor ?? 0) < MIN_SERVICE_NODE_MAJOR
    ) {
      this.#logger.warn(
        'no Node.js runtime on PATH; running the service with the editor runtime, which is older than the service needs',
        { nodeMajor: nodeRuntime.value.nodeMajor, requiredMajor: MIN_SERVICE_NODE_MAJOR },
      );
    }
    const preload = this.#paths.telemetryPreload;
    if (preload !== undefined && this.#pathKind(preload) !== 'file') {
      this.#logger.warn(
        'the bundled telemetry preload is missing; server and database spans will be unavailable',
        { origin: entry.value.origin },
      );
    }

    // The editor credential exists before the service starts (AAP §0.5.6), so
    // the service adopts the token the editor already holds.
    let token: string | undefined;
    let credentialPendingRepair = false;
    const credential = await this.#ensureCredential();
    if (isOk(credential)) {
      token = credential.value;
    } else {
      const reason = editorCredentialFailureReason(credential.error);
      if (reason !== 'malformed' && reason !== 'exposed') {
        return credential;
      }
      // An unusable file the starting service discards and replaces itself.
      credentialPendingRepair = true;
      this.#logger.warn('auth.json is unusable; the service will replace it on start', { reason });
    }
    if (signal.aborted) {
      return err(stoppedError());
    }

    const env = buildServiceEnvironment({
      base: parentEnv,
      debuggenHome: home.value.debuggenHome,
      address: address.value,
      promptsDir: entry.value.promptsDir,
      provider: provider.value,
      runAsNode: nodeRuntime.value.runAsNode,
      platform: this.#platform,
    });
    const secrets = token === undefined ? secretValuesOf(env) : [token, ...secretValuesOf(env)];
    return ok({
      entry: entry.value,
      runtime: nodeRuntime.value,
      address: address.value,
      env,
      secrets,
      credentialPendingRepair,
    });
  }

  /** `./auth`'s `ensure()`, which never rejects by contract — and is held to it. */
  async #ensureCredential(): Promise<Result<string, DebuggenError>> {
    try {
      return await this.#credential.ensure();
    } catch (cause) {
      return err(DebuggenError.from(cause, 'INTERNAL'));
    }
  }

  /**
   * The entry to spawn: the bundled service when its entry exists — then the
   * whole bundle must be complete — else the workspace build, else a failure
   * that says to build the extension.
   */
  #selectEntry(): Result<ServiceEntry, DebuggenError> {
    const bundled = this.#paths.serviceMain;
    if (this.#pathKind(bundled) === 'file') {
      const directory = path.dirname(bundled);
      if (this.#pathKind(path.join(directory, 'package.json')) !== 'file') {
        // Without `{"type":"module"}` beside it, Node loads the ESM bundle as
        // CommonJS and the import statements fail to parse.
        return err(incompleteBundleError('the service package manifest'));
      }
      if (this.#pathKind(this.#paths.servicePromptsDir) !== 'directory') {
        return err(incompleteBundleError('the prompt directory'));
      }
      const schema = this.#paths.serviceSchema;
      if (schema !== undefined && this.#pathKind(schema) !== 'file') {
        return err(incompleteBundleError('the session store schema'));
      }
      return ok({
        origin: 'bundled',
        main: bundled,
        cwd: directory,
        promptsDir: this.#paths.servicePromptsDir,
      });
    }

    const workspace = this.#workspaceService;
    if (workspace !== undefined && this.#pathKind(workspace.serviceMain) === 'file') {
      const promptsDir = workspace.servicePromptsDir;
      if (promptsDir !== undefined && this.#pathKind(promptsDir) !== 'directory') {
        return err(incompleteBundleError('the workspace prompt directory'));
      }
      return ok({
        origin: 'workspace',
        main: workspace.serviceMain,
        cwd: path.dirname(workspace.serviceMain),
        promptsDir,
      });
    }
    return err(incompleteBundleError('the service entry'));
  }

  /**
   * Spawns the child — Node, never a shell; the entry path as the only
   * argument; no secret in argv — and wires its exit and output.
   */
  #spawnChild(plan: LaunchPlan): Result<ManagedChild, DebuggenError> {
    let spawned: ChildProcessLike;
    try {
      spawned = this.#spawn(plan.runtime.command, [plan.entry.main], {
        cwd: plan.entry.cwd,
        env: plan.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (cause) {
      const error = spawnFailedError(errnoCodeOf(cause));
      this.#logger.error('the service process could not be spawned', describeError(error));
      return err(error);
    }

    let resolveExit: (exit: ChildExit) => void = () => undefined;
    const exited = new Promise<ChildExit>((resolve) => {
      resolveExit = resolve;
    });
    const streams = [spawned.stdout, spawned.stderr].filter(
      (stream): stream is ChildOutputStream => stream !== null,
    );
    let openStreams = streams.length;
    let resolveDrained: () => void = () => undefined;
    const drained =
      openStreams === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            resolveDrained = resolve;
          });

    const child: ManagedChild = {
      process: spawned,
      pid: spawned.pid,
      plan,
      exited,
      drained,
      stderrTail: [],
      exit: undefined,
      stopping: false,
      released: false,
      healthySince: undefined,
      termination: undefined,
    };
    this.#child = child;

    const settle = (exit: ChildExit): void => {
      if (child.exit !== undefined) {
        return;
      }
      child.exit = exit;
      resolveExit(exit);
      this.#onChildExit(child, exit);
    };
    spawned.on('exit', (code, signal) => {
      settle({ code, signal, spawnError: undefined });
    });
    spawned.on('error', (error) => {
      const errno = errnoCodeOf(error);
      if (child.pid === undefined) {
        // The process never ran (ENOENT, EACCES …): no 'exit' will follow.
        settle({ code: null, signal: null, spawnError: errno ?? 'UNKNOWN' });
        return;
      }
      this.#logger.warn('the service process reported an error', { pid: child.pid, errno });
    });

    const scrub = createOutputScrubber(plan.secrets);
    const streamEnded = (): void => {
      openStreams -= 1;
      if (openStreams <= 0) {
        resolveDrained();
      }
    };
    this.#pipe(spawned.stdout, 'stdout', child, scrub, streamEnded);
    this.#pipe(spawned.stderr, 'stderr', child, scrub, streamEnded);

    this.#logger.info('spawned the service', {
      pid: child.pid,
      origin: plan.entry.origin,
      runtime: plan.runtime.source,
      host: plan.address.host,
      port: plan.address.port,
    });
    this.#write(
      `[Debug Generator] Starting the service (${plan.entry.origin} entry ${plan.entry.main}, ${describeRuntime(plan.runtime)}) on ${plan.address.origin}; pid ${child.pid === undefined ? 'unknown' : String(child.pid)}.`,
    );
    return ok(child);
  }

  /** Streams one of the child's pipes into the output channel, line by line, scrubbed. */
  #pipe(
    stream: ChildOutputStream | null,
    kind: 'stdout' | 'stderr',
    child: ManagedChild,
    scrub: (line: string) => string,
    ended: () => void,
  ): void {
    if (stream === null) {
      return;
    }
    const splitter = new OutputLineSplitter();
    const emit = (raw: string): void => {
      const line = scrub(raw);
      if (kind === 'stderr') {
        child.stderrTail.push(line);
        if (child.stderrTail.length > STDERR_TAIL_LINES) {
          child.stderrTail.splice(0, child.stderrTail.length - STDERR_TAIL_LINES);
        }
      }
      this.#write(kind === 'stderr' ? `[stderr] ${line}` : line);
    };
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      for (const line of splitter.flush()) {
        emit(line);
      }
      ended();
    };
    stream.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) {
        emit(line);
      }
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (error) => {
      this.#logger.warn('reading the service output failed', {
        stream: kind,
        errno: errnoCodeOf(error),
      });
      finish();
    });
  }

  /** The child ended. Stale children and deliberate stops are recorded only. */
  #onChildExit(child: ManagedChild, exit: ChildExit): void {
    if (this.#child === child) {
      this.#child = undefined;
    }
    this.#logger.info('the service process exited', {
      pid: child.pid,
      exitCode: exit.code,
      signal: exit.signal,
      spawnError: exit.spawnError,
      intentional: child.stopping,
    });
    this.#write(`[Debug Generator] The service process exited ${describeExit(exit)}.`);

    if (child.stopping || this.#disposed || child.healthySince === undefined) {
      // A deliberate stop is owned by `stop()`; a child that never answered is
      // owned by the launch that is still waiting for it.
      return;
    }
    const healthyForMs = Math.max(0, this.#now() - child.healthySince);
    this.#scheduleRestart(crashedError(exit), healthyForMs);
  }

  /** A child of ours answered `/health`. */
  #markHealthy(child: ManagedChild): void {
    child.healthySince = this.#now();
    this.#failureLatched = false;
    this.#update({
      state: 'running',
      mode: 'embedded',
      pid: child.pid,
      origin: child.plan.entry.origin,
      runtime: child.plan.runtime.source,
      error: undefined,
    });
    this.#logger.info('the service is answering', {
      pid: child.pid,
      restartAttempts: this.#restartAttempts,
    });
    if (child.plan.credentialPendingRepair) {
      void this.#awaitRepairedCredential();
    }
  }

  /**
   * `auth.json` was unusable before the spawn and the service replaces it at
   * start-up; a `/health` answer implies it has, so the store is asked to pick
   * the new file up. Only the outcome's reason is logged.
   */
  async #awaitRepairedCredential(): Promise<void> {
    try {
      const credential = await this.#credential.waitForCredential({
        timeoutMs: CREDENTIAL_SETTLE_TIMEOUT_MS,
      });
      if (isErr(credential)) {
        this.#logger.warn('the service did not leave a usable auth.json', {
          reason: editorCredentialFailureReason(credential.error),
        });
      }
    } catch (cause) {
      this.#logger.warn('reading the repaired auth.json failed', errorFields(cause));
    }
  }

  // -------------------------------------------------------------------------
  // Supervision
  // -------------------------------------------------------------------------

  /**
   * Applies the restart policy after a failure of a supervised child: a
   * crash of a healthy child (`healthyForMs` > 0 possible) or an early exit of
   * a restarted one. Restarts only while `debuggen.autoStartService` is on —
   * with it off the developer manages the process, and a crash is reported.
   */
  #scheduleRestart(error: DebuggenError, healthyForMs: number): void {
    if (this.#disposed) {
      return;
    }
    if (this.#stopRequested) {
      // `stop()` (or `restart()`) is waiting for its quiesce: the exit is the
      // end that stop was about to bring, so it is never answered with a
      // replacement the stop would not know about.
      this.#logger.info('the service exited while it was being stopped; it is not restarted', {
        ...describeError(error),
      });
      this.#update({ state: 'stopped', mode: undefined, pid: undefined });
      return;
    }
    if (!this.#settings().autoStartService) {
      this.#logger.warn('the service stopped and auto-start is disabled; not restarting', {
        ...describeError(error),
      });
      this.#fail(error);
      return;
    }
    const decision = planRestart(this.#policy, this.#restartAttempts, healthyForMs);
    if (decision.action === 'give-up') {
      const final = gaveUpError(decision.attempts, error);
      this.#logger.error('the service kept stopping; giving up', {
        attempts: decision.attempts,
        ...describeError(error),
      });
      this.#write(
        `[Debug Generator] The service kept stopping and was restarted ${String(decision.attempts)} times; it will not be restarted again automatically.`,
      );
      this.#fail(final);
      return;
    }
    this.#restartAttempts = decision.attempt;
    this.#update({
      state: 'starting',
      mode: undefined,
      pid: undefined,
      restartAttempts: decision.attempt,
      error,
    });
    this.#logger.warn('restarting the service', {
      attempt: decision.attempt,
      maxAttempts: this.#policy.maxAttempts,
      delayMs: decision.delayMs,
      ...describeError(error),
    });
    this.#write(
      `[Debug Generator] Restarting the service in ${String(Math.round(decision.delayMs / 100) / 10)} s (attempt ${String(decision.attempt)} of ${String(this.#policy.maxAttempts)}).`,
    );
    this.#cancelPendingRestart();
    const generation = this.#stopGeneration;
    this.#cancelRestartTimer = this.#schedule(() => {
      this.#cancelRestartTimer = undefined;
      if (
        this.#disposed ||
        this.#stopRequested ||
        generation !== this.#stopGeneration ||
        this.#ensureInFlight !== undefined
      ) {
        // Disposed, stopped since the restart was planned, or an ensure
        // attempt is already bringing a service up.
        return;
      }
      void this.#track(() => this.#restartNow(generation), false);
    }, decision.delayMs);
  }

  /**
   * The scheduled restart: reuse a service that answers by now, else launch
   * again — unless a stop began while the probe ran (`generation` is the stop
   * generation the restart was planned under).
   */
  async #restartNow(generation: number): Promise<Result<ServiceStatus, DebuggenError>> {
    const answered = await this.#probeOnce();
    if (this.#disposed) {
      return err(disposedError());
    }
    if (this.#stopRequested || generation !== this.#stopGeneration) {
      this.#logger.info('a stop was requested before the scheduled restart; not restarting');
      return err(stoppedError());
    }
    if (answered) {
      this.#restartAttempts = 0;
      this.#update({ state: 'external', mode: 'external', pid: undefined, error: undefined });
      this.#logger.info(
        'a service answered before the restart; using it',
        serviceUrlLogFields(this.#status.serviceUrl),
      );
      return ok(this.#status);
    }
    return this.#resultOf(await this.#launch(this.#settings(), 'restart'));
  }

  /**
   * Keeps watching a child that did not answer within the start-up budget,
   * at a slower cadence and without a deadline, until it answers, exits, or is
   * stopped. It is never killed for being slow (see the module overview).
   */
  #watchSlowStart(child: ManagedChild, signal: AbortSignal, kind: 'initial' | 'restart'): void {
    void (async () => {
      const outcome = await this.#awaitHealthy(
        child,
        signal,
        Number.POSITIVE_INFINITY,
        this.#slowPollIntervalMs,
      );
      if (outcome === 'healthy') {
        this.#markHealthy(child);
      } else if (outcome === 'exited') {
        await this.#afterEarlyExit(child, kind);
      } else if (outcome === 'moved') {
        // The watch ends: an answer at the new address would not be this
        // child's. The child is kept, and its exit is still accounted for.
        this.#update({ error: this.#movedStartError(child), settingsChanged: true });
        this.#releaseMovedStart(child, kind);
      }
    })().catch((cause: unknown) => {
      this.#logger.error('watching a slow service start failed', errorFields(cause));
    });
  }

  /** Cancels a scheduled restart, if one is pending. */
  #cancelPendingRestart(): void {
    const cancel = this.#cancelRestartTimer;
    this.#cancelRestartTimer = undefined;
    cancel?.();
  }

  /** Settles in `failed` and latches the failure against automatic retries. */
  #fail(error: DebuggenError): void {
    this.#failureLatched = true;
    this.#update({ state: 'failed', mode: undefined, pid: undefined, error });
  }

  // -------------------------------------------------------------------------
  // Health, waiting and stopping
  // -------------------------------------------------------------------------

  /**
   * Polls `/health` until the child answers, exits, the deadline passes or
   * `signal` aborts. An answer while the child has already exited is reported
   * as `exited`: the answering service is someone else's. So is an answer
   * once `debuggen.serviceUrl` stopped naming the child's address — the probe
   * follows the setting — which is reported as `moved`, checked before every
   * probe and again after a positive one.
   */
  async #awaitHealthy(
    child: ManagedChild,
    signal: AbortSignal,
    timeoutMs: number,
    intervalMs: number = this.#pollIntervalMs,
  ): Promise<HealthWait> {
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      if (signal.aborted || this.#disposed || child.stopping) {
        return 'aborted';
      }
      if (child.exit !== undefined) {
        return 'exited';
      }
      if (!this.#namesChild(child)) {
        return 'moved';
      }
      const healthy = await this.#probeOnce(signal);
      if (child.exit !== undefined) {
        return 'exited';
      }
      if (signal.aborted || this.#disposed || child.stopping) {
        return 'aborted';
      }
      if (healthy) {
        return this.#namesChild(child) ? 'healthy' : 'moved';
      }
      if (this.#now() >= deadline) {
        return 'timeout';
      }
      await this.#pause(intervalMs, signal, [child.exited]);
    }
  }

  /**
   * One liveness probe, bounded twice — by the timeout handed to the probe and
   * by a local backstop, in case an injected probe ignores it. Never rejects.
   */
  async #probeOnce(signal?: AbortSignal): Promise<boolean> {
    try {
      const probe = this.#probe.health({ timeoutMs: this.#probeTimeoutMs, signal });
      const result = await this.#raceTimeout(probe, this.#probeTimeoutMs + 500);
      return result !== undefined && isOk(result);
    } catch {
      return false;
    }
  }

  /** Resolves after `delayMs`, when `signal` aborts, or when any of `wake` settles. */
  #pause(
    delayMs: number,
    signal: AbortSignal,
    wake: readonly Promise<unknown>[] = [],
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let done = false;
      let cancelTimer: () => void = () => undefined;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        cancelTimer();
        signal.removeEventListener('abort', finish);
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });
      cancelTimer = this.#schedule(finish, delayMs);
      for (const promise of wake) {
        void promise.then(finish, finish);
      }
    });
  }

  /** `operation`'s value, or `undefined` when `timeoutMs` passes first. Never rejects on timeout. */
  async #raceTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let cancelTimer: () => void = () => undefined;
    const timeout = new Promise<undefined>((resolve) => {
      cancelTimer = this.#schedule(() => {
        resolve(undefined);
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      cancelTimer();
    }
  }

  /**
   * The quiesce step of `stop()` and `dispose()`: waits — bounded — for every
   * operation registered through `keepAliveFor`, the caller's `awaitInFlight`
   * and its `beforeStop` hook. Outcomes are counted, never logged in content.
   */
  async #quiesce(options: StopOptions): Promise<void> {
    const pending: Promise<unknown>[] = [...this.#criticalOperations];
    if (options.awaitInFlight !== undefined) {
      pending.push(options.awaitInFlight);
    }
    const hook = options.beforeStop;
    if (hook !== undefined) {
      pending.push(
        (async () => {
          try {
            await hook();
          } catch (cause) {
            this.#logger.warn('the before-stop hook failed; stopping anyway', errorFields(cause));
          }
        })(),
      );
    }
    if (pending.length === 0) {
      return;
    }
    const timeoutMs = positiveOr(options.quiesceTimeoutMs, this.#quiesceTimeoutMs);
    this.#logger.debug('waiting for in-flight operations before stopping the service', {
      pending: pending.length,
      timeoutMs,
    });
    const settled = await this.#raceTimeout(Promise.allSettled(pending), timeoutMs);
    if (settled === undefined) {
      this.#logger.warn(
        'in-flight operations did not settle within the quiesce window; stopping the service anyway',
        { pending: pending.length, timeoutMs },
      );
      return;
    }
    const rejected = settled.filter((outcome) => outcome.status === 'rejected').length;
    if (rejected > 0) {
      this.#logger.debug('in-flight operations settled before stopping', {
        settled: settled.length,
        rejected,
      });
    }
  }

  /**
   * Terminates one child this module spawned: `SIGTERM`, a grace window for the
   * service's own shutdown, then `SIGKILL` — unless `escalate` declines it, in
   * which case the child is left to finish the shutdown `SIGTERM` started (see
   * {@link StopOptions.escalate}). Shared by concurrent callers: the first
   * caller's grace window and escalation decision apply. A no-op for a child
   * that already exited, and for one a stop released
   * ({@link StopOptions.release}): that child is never signalled again.
   *
   * On Windows `kill()` cannot deliver a catchable signal and ends the process
   * at once; the journal-backed reconciliation at the next start is what keeps
   * that platform safe.
   */
  #terminate(
    child: ManagedChild,
    graceMs: number,
    escalate: StopOptions['escalate'],
  ): Promise<void> {
    child.stopping = true;
    if (child.released) {
      return Promise.resolve();
    }
    if (child.termination !== undefined) {
      return child.termination;
    }
    child.termination = (async () => {
      if (child.exit !== undefined) {
        return;
      }
      this.#logger.info('stopping the service', { pid: child.pid, graceMs });
      this.#signal(child, 'SIGTERM');
      if (await this.#waitForExit(child, graceMs)) {
        return;
      }
      if (!this.#shouldEscalate(escalate)) {
        this.#logger.warn(
          'the service did not exit within its grace window; leaving it to finish shutting down on its own',
          { pid: child.pid, graceMs },
        );
        this.#write(
          `[Debug Generator] The service did not stop within ${String(Math.round(graceMs / 1000))} s; it was left to finish shutting down on its own.`,
        );
        return;
      }
      this.#logger.warn('the service did not exit within its grace window; escalating to SIGKILL', {
        pid: child.pid,
        graceMs,
      });
      this.#write(
        `[Debug Generator] The service did not stop within ${String(Math.round(graceMs / 1000))} s; forcing it to stop.`,
      );
      this.#signal(child, 'SIGKILL');
      if (!(await this.#waitForExit(child, KILL_CONFIRM_TIMEOUT_MS))) {
        this.#logger.error('the service process did not report its exit after SIGKILL', {
          pid: child.pid,
        });
      }
    })();
    return child.termination;
  }

  /**
   * Reads a {@link StopOptions.escalate} decision when the grace window
   * expired: absent means `true`; a function is called now, and a throw
   * counts as `false` — the conservative answer, because declining `SIGKILL`
   * never loses a restore, while the journal reconciliation at the next start
   * covers whatever the service did not finish.
   */
  #shouldEscalate(escalate: StopOptions['escalate']): boolean {
    if (escalate === undefined || typeof escalate === 'boolean') {
      return escalate ?? true;
    }
    try {
      return escalate();
    } catch (cause) {
      this.#logger.warn(
        'deciding whether to force-stop the service failed; it is not force-stopped',
        errorFields(cause),
      );
      return false;
    }
  }

  /**
   * Reads a {@link StopOptions.release} decision when the quiesce ended. Only
   * a live child that no termination has signalled yet, and that the
   * configured service URL still names, can be released: the awaited request
   * went to that URL, so a child kept on a previous address is not carrying
   * it out. Absent means `false`; a function that throws counts as `true` —
   * the answer that never interrupts a restore — and the throw is logged.
   */
  #shouldRelease(child: ManagedChild, release: StopOptions['release']): boolean {
    if (child.exit !== undefined || child.termination !== undefined || child.released) {
      return false;
    }
    let wanted: boolean;
    if (release === undefined || typeof release === 'boolean') {
      wanted = release ?? false;
    } else {
      try {
        wanted = release();
      } catch (cause) {
        this.#logger.warn(
          'deciding whether to release the service failed; it is left running unsignalled',
          errorFields(cause),
        );
        wanted = true;
      }
    }
    if (!wanted) {
      return false;
    }
    if (!this.#namesChild(child)) {
      this.#logger.info(
        'the service this window started no longer listens where the awaited request went; stopping it instead of releasing it',
        { pid: child.pid, childOrigin: child.plan.address.origin },
      );
      return false;
    }
    return true;
  }

  /**
   * Releases a child to finish work it accepted: it is left running, never
   * signalled by this module again, and no longer supervised — its exit is
   * logged, never answered with a restart. See {@link StopOptions.release}.
   */
  #releaseChild(child: ManagedChild): void {
    child.stopping = true;
    child.released = true;
    this.#logger.warn(
      'the service is still carrying out an end-of-session request; it is left running, unsignalled, to restore the instrumented files',
      { pid: child.pid, childOrigin: child.plan.address.origin },
    );
    this.#write(
      '[Debug Generator] The service is still finishing a session end, so it was left running to restore every instrumented file; a later window uses it.',
    );
  }

  /** Whether the child exited within `timeoutMs`. */
  async #waitForExit(child: ManagedChild, timeoutMs: number): Promise<boolean> {
    if (child.exit !== undefined) {
      return true;
    }
    await this.#pause(timeoutMs, NEVER_ABORTED, [child.exited]);
    return child.exit !== undefined;
  }

  /** Sends a signal to a child of ours; a failure is logged, never thrown. */
  #signal(child: ManagedChild, signal: NodeJS.Signals): void {
    try {
      child.process.kill(signal);
    } catch (cause) {
      this.#logger.warn('signalling the service failed', {
        pid: child.pid,
        signal,
        ...errorFields(cause),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Settings, status and output
  // -------------------------------------------------------------------------

  /** The settings snapshot; a throwing reader yields the conservative defaults (no auto-start). */
  #settings(): ServiceProcessSettings {
    try {
      return this.#readSettings();
    } catch (cause) {
      this.#logger.warn(
        'reading the debuggen settings failed; auto-start is off',
        errorFields(cause),
      );
      return {
        autoStartService: false,
        serviceUrl: DEFAULT_SERVICE_URL,
        providerExplicit: undefined,
        providerDefault: undefined,
      };
    }
  }

  /**
   * A relevant setting changed: a latched failure may have been fixed, so the
   * next automatic `ensureRunning` may try again; a running child started
   * with the old service URL or provider is flagged, because applying the new
   * value takes a restart the developer chooses — an automatic restart could
   * cut a session's cleanup short.
   */
  #onConfigurationChanged(event: ConfigurationChangeLike): void {
    if (this.#disposed) {
      return;
    }
    const affects = (section: string): boolean => {
      try {
        return event.affectsConfiguration(section);
      } catch {
        return false;
      }
    };
    const changed = WATCHED_SETTINGS.filter(affects);
    if (changed.length === 0) {
      return;
    }
    this.#failureLatched = false;
    const settings = this.#settings();
    const child = this.#child;
    const needsRestart =
      child !== undefined && child.exit === undefined && RESTART_SETTINGS.some(affects);
    this.#update({
      serviceUrl: settings.serviceUrl,
      ...(needsRestart ? { settingsChanged: true } : {}),
    });
    if (needsRestart) {
      this.#logger.info(
        'a setting the running service was started with changed; restart it to apply',
        {
          settings: changed,
        },
      );
    }
  }

  /** Applies a patch to the snapshot and notifies listeners when anything changed. */
  #update(patch: StatusPatch): void {
    const previous = this.#status;
    const next: ServiceStatus = Object.freeze({
      ...previous,
      ...patch,
      since:
        patch.state !== undefined && patch.state !== previous.state ? this.#now() : previous.since,
    });
    const keys = Object.keys(next) as (keyof ServiceStatus)[];
    if (keys.every((key) => next[key] === previous[key])) {
      return;
    }
    this.#status = next;
    if (next.state !== previous.state) {
      this.#logger.debug('service process state changed', { from: previous.state, to: next.state });
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(next);
      } catch (cause) {
        this.#logger.warn('a service status listener threw', errorFields(cause));
      }
    }
  }

  /** The output channel, created on first use; `undefined` once disposed or if creation failed. */
  #ensureChannel(): ServiceOutputChannel | undefined {
    if (this.#channelDisposed) {
      return undefined;
    }
    if (this.#channel === undefined) {
      try {
        this.#channel = this.#createChannel(SERVICE_OUTPUT_CHANNEL_NAME);
      } catch (cause) {
        this.#logger.warn('could not create the service output channel', errorFields(cause));
        this.#channelDisposed = true;
        return undefined;
      }
    }
    return this.#channel;
  }

  /**
   * Appends one already-scrubbed line to the output channel, clearing the
   * channel when the retention budget is spent.
   */
  #write(line: string): void {
    if (this.#disposed) {
      return;
    }
    const channel = this.#ensureChannel();
    if (channel === undefined) {
      return;
    }
    try {
      if (this.#retainedChars + line.length + 1 > MAX_RETAINED_OUTPUT_CHARS) {
        channel.clear();
        const note = '[Debug Generator] Earlier service output was cleared to bound its size.';
        channel.appendLine(note);
        this.#retainedChars = note.length + 1;
      }
      channel.appendLine(line);
      this.#retainedChars += line.length + 1;
    } catch (cause) {
      this.#logger.warn('writing to the service output channel failed', errorFields(cause));
    }
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/** `value` when it is a finite number above zero, else `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The error classes a caught value is logged as: the ECMAScript native error
 * constructors, `DebuggenError`, and the two `DOMException` names an abort or
 * a timeout raises. The same closed vocabulary as `errorClassOf` in
 * `./client`, restated because this module does not import `./client` (see
 * the module overview); any other class is logged as `unlisted`, because an
 * application-defined `name` is free text.
 */
const LOGGED_ERROR_CLASSES = Object.freeze([
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

/**
 * Whether `value` names one of the running platform's signals
 * (`os.constants.signals`: `SIGTERM`, `SIGKILL`, …) — the finite vocabulary a
 * child's exit signal is logged from.
 */
function isKnownSignal(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(osConstants.signals, value);
}

/**
 * A caught value's class for a log record: a name from
 * {@link LOGGED_ERROR_CLASSES}, `unlisted` for any other `Error`, or the
 * `typeof` of a value that is not an `Error`. Never the name verbatim, the
 * message or the stack, and never throws — a getter or proxy trap that throws
 * while the value is classified yields `unlisted`.
 */
function thrownClassOf(value: unknown): string {
  try {
    if (DebuggenError.is(value)) {
      return 'DebuggenError';
    }
    if (!(value instanceof Error)) {
      return typeof value;
    }
    const name: unknown = value.name;
    return LOGGED_ERROR_CLASSES.find((listed) => listed === name) ?? 'unlisted';
  } catch {
    return 'unlisted';
  }
}

/**
 * Log fields for a caught value: its error code, its closed class and a known
 * Node error code ({@link errnoCodeOf}) — never its message, its stack, an
 * unknown `code` or any other property.
 */
function errorFields(cause: unknown): LogFields {
  const error = DebuggenError.from(cause, 'INTERNAL');
  const fields: LogFields = { errorCode: error.code, errorClass: thrownClassOf(cause) };
  const errno = errnoCodeOf(cause);
  return errno === undefined ? fields : { ...fields, errno };
}

/**
 * Log fields for a failure this module built, or read back from the child's
 * stderr: its error code, its `details.reason` when that is one of
 * {@link SERVICE_FAILURE_REASONS}, an integer exit code, a signal known to the
 * platform and a known Node error code. Never the message: an early exit's
 * message is the child's own stderr report (`parseStartupFailure`), which the
 * output channel already shows scrubbed and which can still quote a path, a
 * URL or a value the scrubber has no pattern for.
 */
function describeError(error: DebuggenError): LogFields {
  const fields: LogFields = { errorCode: error.code };
  const details = error.details;
  if (details === undefined) {
    return fields;
  }
  const { reason, exitCode, signal, errno } = details;
  if (isServiceFailureReason(reason)) {
    fields.reason = reason;
  }
  if (typeof exitCode === 'number' && Number.isInteger(exitCode)) {
    fields.exitCode = exitCode;
  }
  if (isKnownSignal(signal)) {
    fields.signal = signal;
  }
  if (isKnownErrorCode(errno)) {
    fields.errno = errno;
  }
  return fields;
}

/** "Electron run as Node (/path/to/code)", "Node on PATH (/usr/bin/node)", … */
function describeRuntime(nodeRuntime: NodeRuntime): string {
  switch (nodeRuntime.source) {
    case 'configured':
      return `configured Node ${nodeRuntime.command}`;
    case 'host-node':
      return `host Node ${nodeRuntime.command}`;
    case 'host-electron':
      return `editor runtime as Node ${nodeRuntime.command}`;
    case 'path':
      return `Node on PATH ${nodeRuntime.command}`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the manager of the embedded service for one editor window.
 *
 * Construction spawns nothing, probes nothing and creates no output channel;
 * it only subscribes to configuration changes. Push the result into
 * `context.subscriptions`.
 *
 * @example
 * ```ts
 * const serviceProcess = createServiceProcess({
 *   paths: {
 *     serviceMain: vscode.Uri.joinPath(context.extensionUri, 'dist', 'service', 'main.js').fsPath,
 *     servicePromptsDir: vscode.Uri.joinPath(context.extensionUri, 'dist', 'service', 'prompts').fsPath,
 *   },
 *   probe: http,            // the protocol HttpClient behind client.ts
 *   credential,             // createEditorCredentialStore(...)
 *   logger,
 * });
 * context.subscriptions.push(serviceProcess);
 * void serviceProcess.ensureRunning().then((result) => {
 *   state.setServiceReachable(isOk(result));
 * });
 * ```
 *
 * @param deps The embedded paths, the liveness probe, the credential store and
 * any seams to replace.
 * @returns A {@link ServiceProcess} whose asynchronous members never reject.
 */
export function createServiceProcess(deps: ServiceProcessDeps): ServiceProcess {
  return new EmbeddedServiceProcess(deps);
}
