/**
 * `debuggen.startService` — "Debug Generator: Start Local Service".
 *
 * The developer's explicit request for a running local service (AAP §0.7.1
 * Group 3). It is the start action every "Service not running" state offers —
 * the Sessions tree's offline row, the webview `StatusBar`, the recovery hint of
 * every `src/service/process.ts` failure — so it must work from a cold start:
 * it needs no active session, no workspace folder and no credential (the probe
 * it confirms with, `GET /health`, is auth-exempt).
 *
 * ## What it does
 *
 * 1. Delegates to {@link ServiceProcess.ensureRunning} with
 *    `userInitiated: true`: the process manager probes first, spawns the
 *    embedded service only when nothing answers, and — because the developer
 *    asked — does so even with `debuggen.autoStartService` off and after a
 *    latched failure. It is the only module allowed to spawn a child; this
 *    command adds no spawning, polling or retry of its own.
 * 2. Confirms the result with one `GET /health` through
 *    {@link ServiceClient.health} (the route resolved by operation id in the
 *    protocol's route table), so "running" is reported only once the endpoint
 *    the views depend on has answered.
 * 3. On success records the reachability, asks the WebSocket to connect
 *    (idempotent; the protocol client's reconnect curve is the only retry
 *    loop), refreshes the Sessions tree so the offline row gives way to the
 *    stored sessions, and shows one informational notice with the service
 *    version and origin.
 *
 * Every failure becomes exactly one error notice through
 * `CommandUi.notifyFailure`, which appends the failure's own `hint` — the
 * process manager's concrete remedy (a missing bundle, no usable Node runtime,
 * the output channel to read) — rather than copy invented here, and offers the
 * service output. Nothing throws and no failure is presented as success
 * (AAP §0.5.5).
 *
 * ## Restarting, only when the process manager says it is the remedy
 *
 * Two conditions leave a running child that `ensureRunning` cannot fix, and
 * `src/service/process.ts` names a developer-chosen restart as the remedy for
 * both: a child of this window that answered before but has stopped answering
 * (its failure hint points back at this command), and a child started with a
 * `debuggen.serviceUrl` or `debuggen.provider` value that has changed since
 * (`ServiceStatus.settingsChanged`). In exactly those cases the notice offers a
 * "Restart service" action. Choosing it calls {@link ServiceProcess.restart}
 * once — after a modal confirmation when a session is live, because the
 * restarted service reconciles every modification record on start, which
 * restores the instrumented files and so removes that session's instrumentation
 * (AAP §0.5.1) — and the restart's own outcome is reported without offering a
 * further restart, so the flow is bounded.
 *
 * ## Module conventions
 *
 * Extension-host code: ESM authoring with extensionless relative imports,
 * bundled to CommonJS by `esbuild.mjs`, no top-level `await`, Node and `vscode`
 * types only. Everything needed at runtime arrives on {@link CommandContext};
 * `./index` is imported for types only, which keeps `src/commands/` acyclic.
 * The only log record is the request itself — never a credential, the content
 * of `auth.json` or a spawned process's environment (AAP §0.5.2, §0.5.6).
 *
 * @packageDocumentation
 */

import { PROTOCOL_VERSION, isCompatibleProtocolVersion } from '@debuggen/protocol';
import type { HealthResponse } from '@debuggen/protocol';
import { isErr } from '@debuggen/shared';
import type { DebuggenError } from '@debuggen/shared';

import type { ServiceClient } from '../service/client';
import type { ServiceMode, ServiceProcess } from '../service/process';

import type { CommandContext, CommandId } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This module's command id, checked against the barrel's id table at compile time. */
const COMMAND_ID = 'debuggen.startService' satisfies CommandId;

/** The notification action that reveals the service output channel. */
const SHOW_OUTPUT_ACTION = 'Show output';

/** The notification action (and confirmation button) that restarts this window's service. */
const RESTART_SERVICE_ACTION = 'Restart service';

/** Failure headline prefix when {@link ServiceProcess.ensureRunning} produced no service. */
const START_FAILED_PREFIX = 'Could not start the Debug Generator service';

/** Failure headline prefix when a service was reported running but `GET /health` did not answer. */
const HEALTH_FAILED_PREFIX =
  'The Debug Generator service process is up, but its health endpoint did not answer';

/** Failure headline prefix when {@link ServiceProcess.restart} produced no service. */
const RESTART_FAILED_PREFIX = 'Could not restart the Debug Generator service';

/** Why a running service is offered a restart after a successful start request. */
const SETTINGS_CHANGED_DETAIL =
  'A setting it was started with (debuggen.serviceUrl or debuggen.provider) has changed since; restart the service to apply it.';

/** The confirmation shown before a restart while a session is live. */
const RESTART_WITH_LIVE_SESSION = Object.freeze({
  message: 'Restart the Debug Generator service while a session is active?',
  detail:
    'On start the service restores every file it instrumented, so the active session loses its instrumentation, and any dev server it launched is stopped. End the session first to finish it cleanly.',
  confirmLabel: RESTART_SERVICE_ACTION,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How the service that now answers came about, which selects the success wording. */
type StartOutcome = 'started' | 'already-running' | 'restarted';

/** Options shared by the confirmation and failure reporters. */
interface FlowOptions {
  /**
   * Whether a failure or a changed setting may offer {@link RESTART_SERVICE_ACTION}.
   * `false` on the restart path itself, which bounds the flow to one restart.
   */
  readonly allowRestart: boolean;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Makes sure the local service answers, then connects to it and refreshes the
 * views that depend on it.
 *
 * Registered by `registerCommands` in `./index` as `debuggen.startService`.
 * Resolves after the developer-facing notice was shown (or, when it offers an
 * action, after the developer chose or dismissed it); never rejects for an
 * expected condition.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param _args Whatever VS Code invokes the command with — nothing from the
 *   Command Palette, the tree node from the Sessions view. Ignored: starting
 *   the service takes no argument.
 */
export async function startService(
  ctx: CommandContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest parameter is the barrel's `(ctx, ...args)` calling contract, shared by all twelve command modules; this command takes no argument, so it is deliberately unread.
  ..._args: readonly unknown[]
): Promise<void> {
  ctx.logger.info('Service start requested', { command: COMMAND_ID });

  // Read before the lifecycle call so the notice can tell "already running"
  // from "started" for a child of this window: the same live child answers
  // both before and after (a child replaced for a new address has a new pid).
  const before = ctx.serviceProcess.status;

  const started = await ctx.serviceProcess.ensureRunning({ userInitiated: true });
  if (isErr(started)) {
    await reportFailure(ctx, started.error, START_FAILED_PREFIX, { allowRestart: true });
    return;
  }

  const sameChild =
    before.state === 'running' && before.pid !== undefined && started.value.pid === before.pid;
  await confirmReachable(ctx, sameChild ? 'already-running' : 'started', { allowRestart: true });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Confirms a service the process manager reported as answering with one
 * `GET /health`, then records reachability, connects, refreshes the Sessions
 * tree and shows the one outcome notice.
 */
async function confirmReachable(
  ctx: CommandContext,
  outcome: StartOutcome,
  options: FlowOptions,
): Promise<void> {
  const health = await ctx.client.health();
  if (isErr(health)) {
    await reportFailure(ctx, health.error, HEALTH_FAILED_PREFIX, options);
    return;
  }

  // A fact the probe just established; the write is idempotent, so a status
  // subscription in `src/extension.ts` reporting the same value is harmless.
  ctx.state.setServiceReachable(true);

  const status = ctx.serviceProcess.status;
  const origin = displayOrigin(ctx.client, ctx.serviceProcess);

  if (!isCompatibleProtocolVersion(health.value.protocolVersion)) {
    // A service that answers but speaks another major version would refuse
    // this window's handshake; say so instead of reporting it as usable.
    await ctx.sessionsTree.refresh();
    await ctx.ui.notify({
      level: 'warning',
      message: `The Debug Generator service at ${origin} speaks protocol ${health.value.protocolVersion}, which this extension (protocol ${PROTOCOL_VERSION}) cannot use.`,
      detail:
        status.mode === 'external'
          ? 'Stop that service where it was started — a terminal or another VS Code window — or update it to match this extension, then run "Debug Generator: Start Local Service" again.'
          : 'Rebuild or reinstall the extension so the extension and its bundled service match, then run "Debug Generator: Start Local Service" again.',
    });
    return;
  }

  // Idempotent while connecting or open; resumes a socket the protocol client
  // stopped retrying after a refused credential. Never a second retry loop.
  ctx.client.connect();
  await ctx.sessionsTree.refresh();

  const offerRestart = options.allowRestart && status.state === 'running' && status.settingsChanged;
  const choice = await ctx.ui.notify({
    level: 'info',
    message: describeRunning(outcome, status.mode, health.value, origin),
    detail: offerRestart ? SETTINGS_CHANGED_DETAIL : undefined,
    actions: offerRestart ? [RESTART_SERVICE_ACTION] : undefined,
  });
  if (choice === RESTART_SERVICE_ACTION) {
    await restartService(ctx);
  }
}

/**
 * Renders one failure through `CommandUi.notifyFailure` (which appends
 * the failure's own hint) and acts on the developer's choice.
 *
 * {@link RESTART_SERVICE_ACTION} is offered only for a child of this window
 * that is still alive — state `running` after a failed request means it
 * answered before and has stopped answering. A child that is still `starting`
 * is never offered one: its start-up reconciles instrumentation records before
 * it listens, and interrupting that is what AAP §0.5.1 guards against.
 */
async function reportFailure(
  ctx: CommandContext,
  error: DebuggenError,
  prefix: string,
  options: FlowOptions,
): Promise<void> {
  const restartable = options.allowRestart && ctx.serviceProcess.status.state === 'running';
  const choice = await ctx.ui.notifyFailure(error, {
    prefix,
    actions: restartable ? [SHOW_OUTPUT_ACTION, RESTART_SERVICE_ACTION] : [SHOW_OUTPUT_ACTION],
  });
  if (choice === SHOW_OUTPUT_ACTION) {
    ctx.serviceProcess.showOutput();
  } else if (choice === RESTART_SERVICE_ACTION) {
    await restartService(ctx);
  }
}

/**
 * The developer chose {@link RESTART_SERVICE_ACTION}: confirm when a session is
 * live, restart once and report that outcome without offering another restart.
 */
async function restartService(ctx: CommandContext): Promise<void> {
  if (hasLiveSession(ctx) && !(await ctx.ui.confirmDestructive(RESTART_WITH_LIVE_SESSION))) {
    return;
  }
  const restarted = await ctx.serviceProcess.restart();
  if (isErr(restarted)) {
    await reportFailure(ctx, restarted.error, RESTART_FAILED_PREFIX, { allowRestart: false });
    return;
  }
  await confirmReachable(ctx, 'restarted', { allowRestart: false });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether a session is active and not yet ended. A known id whose record has
 * not arrived counts as live: the confirmation errs on the side of asking.
 */
function hasLiveSession(ctx: Pick<CommandContext, 'state'>): boolean {
  const sessionId = ctx.state.activeSessionId;
  if (sessionId === undefined || sessionId === '') {
    return false;
  }
  return ctx.state.activeSession?.status !== 'ended';
}

/**
 * The service origin for a notice: the client's validated canonical origin,
 * or — when the configured URL was refused — the URL the status refers to.
 * Neither carries a credential; `CommandUi` strips any query string besides.
 */
function displayOrigin(
  client: Pick<ServiceClient, 'baseUrl'>,
  serviceProcess: Pick<ServiceProcess, 'status'>,
): string {
  return client.baseUrl ?? serviceProcess.status.serviceUrl;
}

/**
 * The headline of the success notice.
 *
 * @param outcome How the answering service came about.
 * @param mode Who owns it; `external` means another window, a terminal or a
 *   test harness started it and nothing was spawned here.
 * @param health The confirmed `GET /health` body.
 * @param origin The origin the service answers at.
 */
function describeRunning(
  outcome: StartOutcome,
  mode: ServiceMode | undefined,
  health: Pick<HealthResponse, 'version'>,
  origin: string,
): string {
  const service = `Debug Generator service ${health.version}`;
  if (mode === 'external') {
    return `A ${service} is already answering at ${origin}; nothing new was started.`;
  }
  switch (outcome) {
    case 'already-running':
      return `The ${service} is already running at ${origin}.`;
    case 'restarted':
      return `Restarted the ${service} at ${origin}.`;
    case 'started':
      return `Started the ${service} at ${origin}.`;
  }
}
