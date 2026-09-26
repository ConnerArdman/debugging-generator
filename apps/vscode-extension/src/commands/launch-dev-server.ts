/**
 * `debuggen.launchDevServer` — "Debug Generator: Launch Dev Server".
 *
 * Server, route-handler and database spans exist only inside a dev-server
 * process that runs with the telemetry preload, so the service launches (or
 * reuses) the target project's dev server with that preload attached and a
 * `server-agent` credential scoped to the project (AAP §0.1.1, §0.7.1 Group 2,
 * §0.5.6). This command is the editor's trigger for that launch:
 *
 * 1. **Precondition** — the workspace project to debug
 *    (`ctx.guards.requireWorkspaceProject()`, which renders its own message).
 * 2. **One probe** — the configured `debuggen.devServerUrl`, read lazily by
 *    `src/service/discovery.ts` in the project folder's scope. When a dev
 *    server already answers there, the developer is told so and asked whether
 *    to launch with tracing; dismissing ends the command without a request.
 *    A probe that could not run (setting unset or unusable) is not a stop: the
 *    service's own detection is authoritative, so the command proceeds.
 * 3. **One HTTP operation** — `devServer.launch` (`POST /dev-server/launch`,
 *    AAP §0.4.2) with `{ projectRoot, sessionId?, devServerUrl? }`.
 *    `devServerUrl` is the configured address whenever the probe could read
 *    it: the service's detection probes it before spawning anything, so a dev
 *    server already answering there is reused when the service launched it and
 *    refused with the exact relaunch command otherwise — never duplicated on
 *    another port. `command` is deliberately
 *    omitted: the service's `dev-server/detect.ts` reads the target's package
 *    manager and dev script, so this command never prompts for, assembles or
 *    displays a command line. `sessionId` is the editor's active session when
 *    it belongs to this project and has not ended: the launched dev server is
 *    then tied to that session and stopped, with its credential revoked, when
 *    the session ends (AAP §0.7.1 Group 2). Without an active session the
 *    launch starts the developer's own dev server, which keeps serving after
 *    any session ends until it is stopped.
 * 4. **Render the result** — one notice either way. A failure goes through
 *    `ctx.ui.notifyFailure` untouched, because the service carries the exact
 *    relaunch command for a dev server running without the preload in its
 *    error (AAP §0.5.5); this module never composes or paraphrases that copy.
 *    A success names the URL and process id and offers to open the URL.
 *
 * ## What this module deliberately does not do
 *
 * - **No spawning, no environment.** The service's launcher (and, on the
 *   command line, `scripts/dev-instrumented.mjs`) owns the child process, the
 *   `NODE_OPTIONS` preload flag and the minted credential. Nothing here reads,
 *   logs or displays `DEBUGGEN_TOKEN`, `DEBUGGEN_INGEST_URL`, a child's
 *   environment or the absolute project path.
 * - **No polling, no retry.** The service waits for the child to answer and
 *   reports its own readiness failure; a failed launch is reported once and the
 *   developer decides what to do next.
 * - **No store mutation.** The dev-server URL belongs to the `SessionRecord`
 *   the service owns and reaches the view through `session.updated`.
 * - **No target-specific knowledge.** Every URL comes from the setting, the
 *   probe or the service response (AAP §0.5.4).
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';

import type { DevServerLaunchRequest, DevServerLaunchResponse } from '@debuggen/protocol';
import { DebuggenError, isErr, isOk } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import type { DevServerProbe } from '../service/discovery';

import type { CommandContext, CommandId, CommandNotice } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This command's id; `satisfies` ties it to the registration table in `./index`. */
const COMMAND_ID = 'debuggen.launchDevServer' satisfies CommandId;

/** The action that confirms a launch when a dev server already answers. */
const LAUNCH_WITH_TRACING_ACTION = 'Launch with Tracing';

/** The action that opens the launched dev server in the default browser. */
const OPEN_IN_BROWSER_ACTION = 'Open in Browser';

/** What was being attempted, as the headline of a failed launch. */
const LAUNCH_FAILURE_PREFIX = 'Could not launch the dev server';

/** What was being attempted, as the headline of a failed browser hand-off. */
const OPEN_FAILURE_PREFIX = 'Could not open the dev server in a browser';

/** The status-bar progress text shown while the service launches the dev server. */
const LAUNCH_PROGRESS_TITLE = 'Debug Generator: launching the dev server with tracing';

/**
 * Upper bound on the launch request, in milliseconds.
 *
 * The service waits up to 60 s for a spawned dev server to answer (its
 * launcher's readiness bound) and then reports a failure of its own, which
 * says what went wrong far better than a client-side timeout can. This bound
 * sits well above that plus detection and a first compile, so only a stalled
 * service ever reaches it — and it also overrides any shorter default timeout
 * the service client may have been constructed with.
 */
const LAUNCH_REQUEST_TIMEOUT_MS = 120_000;

/** Why the preload matters, stated once for the "already running" notice. */
const TRACING_REQUIREMENT_SENTENCE =
  'Server, route-handler and database spans are captured only from a dev server that runs with the Debug Generator preload.';

/**
 * What "Launch with Tracing" does, stated without promising an outcome: whether
 * the service reuses a preloaded server, starts one, or reports what stands in
 * the way is the service's reply to render, never copy this module invents.
 */
const LAUNCH_WITH_TRACING_SENTENCE = `Choose "${LAUNCH_WITH_TRACING_ACTION}" to ask the Debug Generator service to run this project's dev server with the preload attached; its reply says whether it could.`;

/** What a successful launch enables. */
const LAUNCHED_DETAIL_SENTENCE =
  'Server, route-handler and database spans will be captured from it during the next capture.';

/**
 * The lifetime of a dev server launched for the active session. Conditional on
 * purpose: the response does not say whether the service started a child for
 * the session or reused one the developer launched earlier, which keeps
 * running.
 */
const SESSION_LIFETIME_SENTENCE =
  'A dev server started for the current debugging session stops when that session ends; one that was already running keeps running.';

/** The lifetime of a dev server launched with no active session. */
const DEVELOPER_LIFETIME_SENTENCE =
  'It keeps running after debugging sessions end, until you stop it or the Debug Generator service stops.';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Runs `debuggen.launchDevServer`: asks the local service to make sure the
 * workspace project's dev server runs with the telemetry preload attached.
 *
 * Never throws for an expected condition and renders exactly one message per
 * outcome: the guard's own message when no project is open, the "already
 * running" prompt when the configured dev server answers (dismissing it ends
 * the command silently), the service's failure — with its hint, which carries
 * the exact relaunch command — or the success notice.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param args Whatever VS Code passed. This command takes no arguments, so they
 *   are ignored, neither read nor logged.
 *
 * @example
 * ```ts
 * // Registered by ./index as:
 * 'debuggen.launchDevServer': (...args) => launchDevServer(ctx, ...args),
 * ```
 */
export async function launchDevServer(
  ctx: CommandContext,
  ...args: readonly unknown[]
): Promise<void> {
  // The registration signature forwards whatever VS Code passes; this command
  // takes no arguments, so they are deliberately discarded.
  void args;

  const project = ctx.guards.requireWorkspaceProject();
  if (!project) {
    return;
  }

  ctx.logger.info('Dev server launch requested', { command: COMMAND_ID });

  const probe = await ctx.discovery.probeDevServer({
    scope: project.folderUri,
    logger: ctx.logger,
  });

  if (isOk(probe) && probe.value.running) {
    const confirmed = await confirmLaunchOverRunningServer(ctx, probe.value);
    if (!confirmed) {
      return;
    }
  }

  const sessionId = owningSessionIdFor(ctx, project.projectRoot);
  const configuredUrl = isOk(probe) ? probe.value.url : undefined;
  const launched = await requestLaunch(ctx, project.projectRoot, sessionId, configuredUrl);
  if (isErr(launched)) {
    await ctx.ui.notifyFailure(launched.error, { prefix: LAUNCH_FAILURE_PREFIX });
    return;
  }

  await reportLaunched(ctx, launched.value, unusableSettingOf(probe), sessionId !== undefined);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Tells the developer a dev server already answers at the configured URL and
 * asks whether to launch with tracing.
 *
 * The probe answers only "does anything answer HTTP here?"; whether that
 * server carries the preload is the service's call, so the notice states the
 * requirement and leaves the concrete relaunch command to the service's reply.
 *
 * @param ctx The command context.
 * @param probe The probe that found a running dev server.
 * @returns `true` only when the developer chose {@link LAUNCH_WITH_TRACING_ACTION}.
 */
async function confirmLaunchOverRunningServer(
  ctx: CommandContext,
  probe: DevServerProbe,
): Promise<boolean> {
  const choice = await ctx.ui.notify({
    level: 'info',
    message: `A dev server already answers at ${probe.url}.`,
    detail: `${TRACING_REQUIREMENT_SENTENCE} ${LAUNCH_WITH_TRACING_SENTENCE}`,
    actions: [LAUNCH_WITH_TRACING_ACTION],
  });
  return choice === LAUNCH_WITH_TRACING_ACTION;
}

/**
 * The session a launch for `projectRoot` is tied to: the editor's active
 * session, when it is of this very project and has not ended. Anything else —
 * no active session, one of another workspace folder, an ended one — launches
 * the developer's own dev server, which no session end stops.
 *
 * @param ctx The command context.
 * @param projectRoot The normalised project root the guard resolved.
 * @returns The session id to send, or `undefined`.
 */
function owningSessionIdFor(ctx: CommandContext, projectRoot: string): string | undefined {
  const session = ctx.state.activeSession;
  if (session === undefined || session.status === 'ended' || session.projectRoot !== projectRoot) {
    return undefined;
  }
  return session.id;
}

/**
 * The one HTTP operation of this command: `devServer.launch` with the project
 * root and, when there is one, the session the dev server belongs to and the
 * configured address — shown as a status-bar progress indicator while the
 * service detects, spawns and waits for the dev server.
 *
 * @param ctx The command context.
 * @param projectRoot The normalised project root the guard resolved.
 * @param sessionId The active session of this project, when there is one.
 * @param devServerUrl The configured `debuggen.devServerUrl`, as the probe
 *   normalised it, when the probe could read it.
 * @returns The service's answer, as the client reports it.
 */
async function requestLaunch(
  ctx: CommandContext,
  projectRoot: string,
  sessionId: string | undefined,
  devServerUrl: string | undefined,
): Promise<Result<DevServerLaunchResponse, DebuggenError>> {
  const request: DevServerLaunchRequest = {
    projectRoot,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(devServerUrl === undefined ? {} : { devServerUrl }),
  };
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: LAUNCH_PROGRESS_TITLE },
    () => ctx.client.launchDevServer(request, { timeoutMs: LAUNCH_REQUEST_TIMEOUT_MS }),
  );
}

/**
 * Renders a successful launch: the URL, the process id and what the launch
 * enables, plus the reason the configured URL was not probed when the setting
 * was unusable. Offers {@link OPEN_IN_BROWSER_ACTION} only for a URL the
 * product's own dev-server URL gate accepts (loopback `http:`/`https:`), and
 * displays that normalised form, which carries no query or fragment.
 *
 * @param ctx The command context.
 * @param launched The service's validated launch response.
 * @param unusableSetting The probe's refusal of an unusable setting, if any.
 * @param forSession Whether the launch was tied to the active session.
 */
async function reportLaunched(
  ctx: CommandContext,
  launched: DevServerLaunchResponse,
  unusableSetting: DebuggenError | undefined,
  forSession: boolean,
): Promise<void> {
  const normalized = ctx.discovery.normalizeDevServerUrl(launched.devServerUrl);
  const openableUrl = isOk(normalized) ? normalized.value : undefined;
  const shownUrl = openableUrl ?? launched.devServerUrl;

  const lifetime = forSession ? SESSION_LIFETIME_SENTENCE : DEVELOPER_LIFETIME_SENTENCE;
  const detail =
    unusableSetting === undefined
      ? `${LAUNCHED_DETAIL_SENTENCE} ${lifetime}`
      : `${LAUNCHED_DETAIL_SENTENCE} ${lifetime} debuggen.devServerUrl was not probed: ${unusableSetting.message}`;

  const notice: CommandNotice = {
    level: 'info',
    message: `The dev server runs at ${shownUrl} (pid ${String(launched.pid)}) with the Debug Generator preload.`,
    detail,
    actions: openableUrl === undefined ? undefined : [OPEN_IN_BROWSER_ACTION],
  };

  const choice = await ctx.ui.notify(notice);
  if (choice === OPEN_IN_BROWSER_ACTION && openableUrl !== undefined) {
    await openInBrowser(ctx, openableUrl);
  }
}

/**
 * Hands the launched dev server's URL to the default browser.
 *
 * `openExternal` resolving `false` means the editor or the developer declined,
 * which needs no message; a rejection is a failure and is reported once.
 *
 * @param ctx The command context.
 * @param url A normalised loopback dev-server URL.
 */
async function openInBrowser(ctx: CommandContext, url: string): Promise<void> {
  try {
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  } catch (error) {
    await ctx.ui.notifyFailure(DebuggenError.from(error), { prefix: OPEN_FAILURE_PREFIX });
  }
}

/**
 * The probe's refusal of a `debuggen.devServerUrl` value the developer set but
 * the product cannot use (`CONFIG_INVALID`: malformed, not loopback, embedded
 * credentials, unreadable). It is worth a sentence in the success notice, since
 * the developer configured it deliberately. An unset setting
 * (`DEV_SERVER_UNAVAILABLE`) is the documented "let the service detect or
 * launch it" state and an internal probe fault says nothing actionable, so
 * neither is mentioned.
 *
 * @param probe The probe outcome.
 * @returns The refusal worth reporting, or `undefined`.
 */
function unusableSettingOf(
  probe: Result<DevServerProbe, DebuggenError>,
): DebuggenError | undefined {
  return isErr(probe) && probe.error.code === 'CONFIG_INVALID' ? probe.error : undefined;
}
