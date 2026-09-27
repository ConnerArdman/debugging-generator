/**
 * `debuggen.rotateServiceToken` — "Debug Generator: Rotate Service Token".
 *
 * ## What rotation is (AAP §0.5.6)
 *
 * The local service authenticates three kinds of client, each with a
 * role-bound credential stored only as a SHA-256 hash: the editor (its token in
 * `$DEBUGGEN_HOME/auth.json`, mode `0600`), each paired Chrome DevTools panel
 * and each dev server the service launched with the telemetry preload. Rotation
 * revokes all of them at once: every credential row and every outstanding
 * pairing code is deleted, a new editor credential is minted and `auth.json` is
 * regenerated, and every open socket is closed with code 4401 — so paired
 * Chrome extensions must pair again and launched dev servers must be
 * relaunched.
 *
 * The service performs all of it behind the protocol's `credentials.rotate`
 * operation (`POST /credentials/rotate`, editor credential only), which this
 * command reaches through `ServiceClient.rotateCredentials` — by operation id,
 * never a hand-written path.
 *
 * ## The flow
 *
 * 1. **Confirm first.** One modal ({@link ROTATE_SERVICE_TOKEN_CONFIRMATION})
 *    states what is lost before anything is sent. Dismissing it ends the
 *    command silently: no request, no notice.
 * 2. **Exactly one request.** `rotateCredentials()` is called once and never
 *    retried here; the client's own single re-read on `UNAUTHORIZED` is the
 *    only repeat that can happen, and only when `auth.json` already holds a
 *    different token.
 * 3. **Re-read the credential on every outcome.** The cached editor token is
 *    dropped and `auth.json` read again whether or not the reply was a
 *    success, because a failure *after* the service's commit ("Credentials
 *    were rotated, but …") can also have rewritten the file. The socket needs
 *    nothing from this command: the service publishes `auth.json` before it
 *    closes the sockets, and the client's 4401 handling re-reads the file and
 *    reconnects with the new token by itself.
 * 4. **One message per outcome.**
 *    - Failure: one error notice, `ROTATE_SERVICE_TOKEN_FAILURE_PREFIX` plus
 *      the service's own message and hint. The service's message says whether
 *      the rotation was applied ("Credentials were not rotated; every existing
 *      credential is still valid." before its commit, "Credentials were
 *      rotated, but …" with a restart hint after it), so this command states
 *      on its own that nothing changed only for a refused credential (below),
 *      whose refusal precedes the rotation handler. A credential re-read that
 *      failed too is logged, not shown a second time.
 *      Because a committed rotation can still end in an error, and the error
 *      carries no structured "rotated" flag, every failure is treated as
 *      possibly applied unless the client's structured facts prove it was not
 *      (see {@link provablyNotApplied}): the pairing code on display is cleared
 *      and the notice offers "Pair Chrome". A request that provably never left
 *      keeps the code and offers nothing, since nothing changed.
 *    - Refused credential: an `UNAUTHORIZED` reply (it carries an HTTP status)
 *      is the service's access boundary refusing the editor credential before
 *      the rotation handler runs, so nothing was rotated. It keeps the pairing
 *      code, offers no "Pair Chrome", and is reported in this command's own
 *      words, because rotation needs a credential the service accepts: the
 *      remedy is restarting the service, which re-issues the editor credential
 *      in `auth.json` as it starts. A child of this window is offered
 *      "Restart service", which runs `./start-service.ts`'s restart flow; any
 *      other service is to be restarted where it was started.
 *    - Success: the pairing code on display is cleared (the service deleted
 *      every outstanding code), then one warning notice with the service's
 *      tally and the two follow-ups — "Pair Chrome" (`debuggen.pairChrome`)
 *      and, when the window holds a project a dev server can be launched for,
 *      "Relaunch Dev Server". A failed re-read of the new credential is named
 *      in that notice's detail.
 * 5. **Relaunch means stop, then launch.** The service's launcher answers a
 *    launch for a project whose child still runs with that same child, which
 *    still holds the revoked credential. "Relaunch Dev Server" therefore asks
 *    the service to stop the dev server it launched (`devServer.stop`, which
 *    answers once the child has exited) and only then runs
 *    `debuggen.launchDevServer`, which spawns a fresh child with a new
 *    credential. When the service launched none for the project, the developer
 *    is told to restart theirs the way it was started, and offered
 *    "Launch Dev Server".
 *
 * ## What the command never does
 *
 * - It never writes or deletes `$DEBUGGEN_HOME/auth.json` and never mints or
 *   hashes a credential: the service owns that file, and `../service/auth.ts`
 *   is the only reader in the extension.
 * - It never opens, closes or reconnects a socket itself: reconnection belongs
 *   to the protocol's `ReconnectingWsClient` inside `../service/client.ts`. The
 *   restart flow it hands a refused credential to resumes the socket through
 *   `ServiceClient.connect()` once the restarted service answers.
 * - It never signals a process: the service stops the dev server it launched,
 *   and only through `devServer.stop`, keyed by project, never by pid. A
 *   restart the developer chooses for a refused credential is the process
 *   manager's own `ServiceProcess.restart`.
 * - It never logs or displays a credential, a credential hash or the content of
 *   `auth.json` (AAP §0.5.2): log records carry the command id, error codes,
 *   the service's two counts and flags — never a project path.
 * - It never throws for an expected condition. Every failure is a
 *   `DebuggenError` rendered once through `CommandUi`, so the registration
 *   wrapper in `./index.ts` never sees it.
 *
 * ## Module conventions
 *
 * Authored as ESM with extensionless relative specifiers and bundled to
 * CommonJS by `esbuild.mjs`; no top-level `await`; Node and `vscode` types
 * only. Like every command module it imports **types only** from `./index`.
 * Its one runtime edge inside the folder is `./start-service`, for the restart
 * a refused credential is offered; that module imports types only from
 * `./index` too, so the folder stays acyclic.
 *
 * @example
 * ```ts
 * // src/commands/index.ts maps the id to this function:
 * 'debuggen.rotateServiceToken': (...args) => rotateServiceToken(ctx, ...args),
 * ```
 *
 * @packageDocumentation
 */

import type { CredentialsRotateResponse, DevServerStopResponse } from '@debuggen/protocol';
import { DebuggenError, err, isErr, isOk, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import type { CommandContext, CommandId, CommandNotice, DestructiveConfirmation } from './index';
import { RESTART_SERVICE_ACTION, restartServiceOnRequest } from './start-service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * This module's command id. The `satisfies` clause ties the literal to the
 * contributed vocabulary of `./index`, so a rename there is a compile error
 * here rather than a log field naming a command that no longer exists.
 */
const COMMAND_ID = 'debuggen.rotateServiceToken' satisfies CommandId;

/** The command the "Pair Chrome" action runs. */
const PAIR_CHROME_COMMAND = 'debuggen.pairChrome' satisfies CommandId;

/**
 * The command that launches a fresh dev server: run by "Relaunch Dev Server"
 * once the service has stopped the old one, and by "Launch Dev Server".
 */
const LAUNCH_DEV_SERVER_COMMAND = 'debuggen.launchDevServer' satisfies CommandId;

/**
 * What was being attempted, prefixed to the failure headline by
 * `CommandUi.notifyFailure` ("Could not rotate the service token: …").
 */
export const ROTATE_SERVICE_TOKEN_FAILURE_PREFIX = 'Could not rotate the service token';

/** Prefixed to the headline when a follow-up command cannot be dispatched at all. */
const ACTION_FAILURE_PREFIX = 'Could not run the requested action';

/**
 * The failure message of a rotation the service refused at its access
 * boundary, after {@link ROTATE_SERVICE_TOKEN_FAILURE_PREFIX}. The refusal
 * precedes the rotation handler, so the sentence can state the outcome.
 */
export const CREDENTIAL_REFUSED_MESSAGE =
  'The service refused this editor’s credential, so nothing was rotated.';

/**
 * The button that starts a new Chrome pairing: on the success notice, and on
 * the failure notice of a rotation that may have been applied — never on a
 * rotation the service refused at its access boundary, which left every
 * pairing code valid.
 */
export const PAIR_CHROME_ACTION = 'Pair Chrome';

/**
 * The success notice's button that stops the dev server the service launched
 * for the project and launches a fresh one (see {@link relaunchDevServer}).
 */
export const RELAUNCH_DEV_SERVER_ACTION = 'Relaunch Dev Server';

/**
 * The button of the "Debug Generator did not launch it" notice: asks the
 * service to launch the project's dev server with a new credential.
 */
export const LAUNCH_DEV_SERVER_ACTION = 'Launch Dev Server';

/** Prefixed to the headline when the relaunch cannot tell which project to act on. */
export const RELAUNCH_PROJECT_FAILURE_PREFIX = 'Could not determine the project to relaunch';

/** Prefixed to the headline when the service could not stop the dev server it launched. */
export const STOP_DEV_SERVER_FAILURE_PREFIX = 'Could not stop the launched dev server';

/**
 * Upper bound on the `devServer.stop` request of a relaunch, in milliseconds.
 *
 * The service answers only once the child is gone: `SIGTERM`, a grace period
 * (5 s by default), then `SIGKILL` and a short confirmation, and the child's
 * credential revoked. This bound sits well above that, so only a stalled
 * service reaches it, and it also overrides any shorter default timeout the
 * service client may have been constructed with.
 */
const STOP_DEV_SERVER_TIMEOUT_MS = 30_000;

/**
 * The modal shown before the request. Its detail names every consequence the
 * service's rotation has, so confirming it is an informed choice; the file is
 * named by its variable-relative location because the state directory is the
 * developer's configuration, not a fixed path.
 */
export const ROTATE_SERVICE_TOKEN_CONFIRMATION: DestructiveConfirmation = Object.freeze({
  message: 'Rotate the Debug Generator service token?',
  detail:
    'Every stored credential is deleted and $DEBUGGEN_HOME/auth.json is regenerated with a new editor credential. ' +
    'Every open connection to the local service is closed (code 4401), and the credentials of dev servers it launched stop working: ' +
    'Chrome must be paired again and launched dev servers must be relaunched.',
  confirmLabel: 'Rotate token',
});

/** Formats counts for display, for example `1,234`. */
const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `1 credential`, `2 credentials`, `1,234 credentials`. */
function quantity(count: number, singular: string, plural: string): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? singular : plural}`;
}

/**
 * The system error code of a TCP connection nothing accepted. Node's `fetch`
 * rejects with a `TypeError` whose `cause` carries it, and the protocol client
 * keeps that rejection as the `cause` of its `TRANSPORT_DISCONNECTED` failure.
 */
const CONNECTION_REFUSED_ERRNO = 'ECONNREFUSED';

/**
 * How many `cause` links {@link causeChainHasCode} follows. The protocol
 * client's chain for a refused connection is four links deep; the bound only
 * keeps a cyclic chain from looping.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * The client failures that are raised before any request is sent: a refused
 * service URL setting (or a runtime without `fetch`), and a missing editor
 * credential. Without an HTTP status they cannot have come from the service.
 */
const UNSENT_FAILURE_CODES: ReadonlySet<DebuggenError['code']> = new Set<DebuggenError['code']>([
  'CONFIG_INVALID',
  'UNAUTHORIZED',
]);

/**
 * Whether `error` or any error in its `cause` chain carries `code`.
 *
 * @param error The failure to inspect.
 * @param code The system error code to look for.
 */
function causeChainHasCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }
    if ('code' in current && current.code === code) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Whether a failed `credentials.rotate` request is the service's access
 * boundary refusing the editor credential: `UNAUTHORIZED` with an HTTP status
 * (`401`, or `403` for a role `credentials.rotate` does not grant). The auth
 * middleware and the route's revocation fence answer it before the rotation
 * handler runs, so the rotation was not applied; and because rotation itself
 * requires a credential the service accepts, repeating it cannot help — only
 * a restart, which re-issues the editor credential in `auth.json`, can.
 *
 * An `UNAUTHORIZED` without a status is the client's own refusal before
 * sending (no credential to present) and is not this.
 *
 * @param error The rotation's failure.
 */
function refusedAtAccessBoundary(error: DebuggenError): boolean {
  return error.code === 'UNAUTHORIZED' && error.details?.['status'] !== undefined;
}

/**
 * Whether a failed `credentials.rotate` request provably was not applied, so
 * a pairing code on display is still redeemable.
 *
 * The service can commit a rotation (every credential and every pairing code
 * deleted) and still answer with an error, and its error body carries no
 * structured "rotated" flag. So the answer is built only from the structured
 * facts the protocol client attaches, never from message prose:
 *
 * - an `UNAUTHORIZED` reply is a refusal at the access boundary, answered
 *   before the rotation handler runs ({@link refusedAtAccessBoundary});
 * - any other failure with `details.status` is an HTTP reply from the
 *   rotation handler or after it — a post-commit failure arrives exactly that
 *   way — so it counts as possibly applied;
 * - {@link UNSENT_FAILURE_CODES} without a status are the client's own
 *   refusals before its transport is invoked;
 * - a `TRANSPORT_DISCONNECTED` that no timeout or abort ended and whose cause
 *   chain holds `ECONNREFUSED` is a connection no listener accepted.
 *
 * Everything else — a timeout, a connection dropped mid-exchange, a reply
 * body that could not be read — can follow a committed rotation, and counts
 * as possibly applied.
 *
 * @param error The rotation's failure.
 */
function provablyNotApplied(error: DebuggenError): boolean {
  if (refusedAtAccessBoundary(error)) {
    return true;
  }
  if (error.details?.['status'] !== undefined) {
    return false;
  }
  if (UNSENT_FAILURE_CODES.has(error.code)) {
    return true;
  }
  return (
    error.code === 'TRANSPORT_DISCONNECTED' &&
    error.details?.['cancelled'] === undefined &&
    causeChainHasCode(error, CONNECTION_REFUSED_ERRNO)
  );
}

/**
 * Clears the pairing code on display, in the store and in the view. The
 * service deletes every outstanding code together with the credentials, so a
 * code still shown after a rotation could no longer be redeemed.
 *
 * @param ctx The resolved command context.
 */
function clearPairingDisplay(ctx: CommandContext): void {
  ctx.state.clearPairing();
  ctx.sessionView.postPairing();
}

/**
 * Drops the cached editor token and reads `auth.json` again.
 *
 * Called after every reply, successful or not, because a failure after the
 * service's commit can have rewritten the file too. `refresh()` resolves to a
 * `Result` and never rejects by contract; the `catch` keeps that promise for
 * this command even if a store broke it. A failure is logged here by code and
 * returned for the caller to decide whether it belongs in a notice.
 *
 * @param ctx The resolved command context.
 * @param rotated Whether the service reported the rotation as applied, recorded
 *   in the log line so the two situations can be told apart.
 * @returns `undefined` once the credential was read, otherwise the failure.
 */
async function reloadEditorCredential(
  ctx: CommandContext,
  rotated: boolean,
): Promise<DebuggenError | undefined> {
  let failure: DebuggenError | undefined;
  try {
    ctx.credentials.invalidate();
    const refreshed = await ctx.credentials.refresh();
    failure = isErr(refreshed) ? refreshed.error : undefined;
  } catch (thrown) {
    failure = DebuggenError.from(thrown);
  }
  if (failure !== undefined) {
    // Facts only: the command, the outcome and the error code — never the
    // file's content or a token.
    ctx.logger.warn('The editor credential could not be read again after rotation', {
      command: COMMAND_ID,
      rotated,
      code: failure.code,
    });
  }
  return failure;
}

/**
 * Whether this window holds a project `debuggen.launchDevServer` can act on —
 * the same resolution that command's workspace guard performs, without its
 * notice. The extension keeps no record of which dev servers the service
 * launched, so this is the reliable signal that relaunching is possible here.
 * A resolver that throws answers "no": the action would only fail.
 *
 * @param ctx The resolved command context.
 */
function canRelaunchDevServer(ctx: CommandContext): boolean {
  try {
    return isOk(ctx.discovery.resolveProjectRoot({ logger: ctx.logger }));
  } catch (thrown) {
    ctx.logger.debug('The workspace project could not be resolved', {
      command: COMMAND_ID,
      code: DebuggenError.from(thrown).code,
    });
    return false;
  }
}

/**
 * The single success notice: the service's tally, what the developer has to
 * redo, and — when the new credential could not be read back — that fact as
 * well. It never contains a credential.
 *
 * @param tally What the service revoked.
 * @param reloadFailure Why re-reading `auth.json` failed, if it did.
 * @param offerRelaunch Whether "Relaunch Dev Server" is offered.
 */
function rotatedNotice(
  tally: CredentialsRotateResponse,
  reloadFailure: DebuggenError | undefined,
  offerRelaunch: boolean,
): CommandNotice {
  const revoked = quantity(tally.credentialsDeleted, 'credential', 'credentials');
  const closed = quantity(tally.socketsClosed, 'connection', 'connections');
  const reloadDetail =
    reloadFailure === undefined
      ? undefined
      : `The editor could not read its new credential yet (${reloadFailure.message}); it reads auth.json again on its next request.`;
  return {
    level: 'warning',
    message: `Service token rotated: ${revoked} revoked, ${closed} closed.`,
    detail: [
      'Pair Chrome again to reconnect the DevTools panel, and relaunch any dev server Debug Generator launched so it receives a new credential.',
      reloadDetail,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' '),
    actions: offerRelaunch
      ? [PAIR_CHROME_ACTION, RELAUNCH_DEV_SERVER_ACTION]
      : [PAIR_CHROME_ACTION],
  };
}

/**
 * Runs a follow-up command. The target command reports its own failures, so
 * only a failure to dispatch it is reported here, once.
 *
 * @param ctx The resolved command context.
 * @param command The follow-up's id.
 */
async function runFollowUp(ctx: CommandContext, command: CommandId): Promise<void> {
  try {
    await ctx.ui.executeCommand(command);
  } catch (thrown) {
    await ctx.ui.notifyFailure(DebuggenError.from(thrown), { prefix: ACTION_FAILURE_PREFIX });
  }
}

// ---------------------------------------------------------------------------
// A rotation refused at the access boundary
// ---------------------------------------------------------------------------

/**
 * The failure this command reports for a rotation the service refused at its
 * access boundary ({@link refusedAtAccessBoundary}), in place of the service's
 * refusal, which the original keeps as `cause`. The hint names the one remedy
 * that works — a restart, after which `auth.json` holds a credential the
 * service accepts — as the button when this window owns the service, and as
 * where to restart it otherwise. It never contains a credential.
 *
 * @param refusal The service's `UNAUTHORIZED` reply.
 * @param restartable Whether this window's own child answers, so
 *   {@link RESTART_SERVICE_ACTION} is offered.
 */
function credentialRefusedFailure(refusal: DebuggenError, restartable: boolean): DebuggenError {
  return new DebuggenError('UNAUTHORIZED', CREDENTIAL_REFUSED_MESSAGE, {
    hint: restartable
      ? `Rotation needs a credential the service accepts. Choose "${RESTART_SERVICE_ACTION}" so the service re-issues the editor credential in auth.json as it starts, then rotate again.`
      : 'Rotation needs a credential the service accepts. Restart the service where it was started — a terminal or another VS Code window — so it re-issues the editor credential in auth.json, then rotate again.',
    details: { status: refusal.details?.['status'] },
    cause: refusal,
  });
}

/**
 * Reports a rotation the service refused at its access boundary: one failure
 * notice with this command's prefix and {@link credentialRefusedFailure}'s
 * words. Nothing was rotated, so the pairing code stays and no "Pair Chrome"
 * is offered. A child of this window (`running`) is offered
 * {@link RESTART_SERVICE_ACTION}, which runs `./start-service.ts`'s restart
 * flow — its confirmation while a session is live, the restart and its own
 * outcome notice. `ServiceProcess.restart` refuses any other service, so none
 * is offered for one.
 *
 * @param ctx The resolved command context.
 * @param refusal The service's `UNAUTHORIZED` reply.
 */
async function reportRefusedCredential(ctx: CommandContext, refusal: DebuggenError): Promise<void> {
  const restartable = ctx.serviceProcess.status.state === 'running';
  const choice = await ctx.ui.notifyFailure(credentialRefusedFailure(refusal, restartable), {
    prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
    ...(restartable ? { actions: [RESTART_SERVICE_ACTION] } : {}),
  });
  if (restartable && choice === RESTART_SERVICE_ACTION) {
    await restartServiceOnRequest(ctx);
  }
}

// ---------------------------------------------------------------------------
// Relaunching the launched dev server
// ---------------------------------------------------------------------------

/** The project a relaunch acts on: the service's spelling of its root, and its display name. */
interface RelaunchProject {
  /** The normalised project root, exactly as `devServer.stop` and `devServer.launch` expect it. */
  readonly projectRoot: string;
  /** The workspace folder's display name; never a path. */
  readonly name: string;
}

/**
 * Resolves the project "Relaunch Dev Server" acts on — the selection
 * `debuggen.launchDevServer` makes too, so the stop and the launch that
 * follows name the same project. It is resolved again when the button is
 * chosen rather than reused from when the notice was built, because the
 * window's folders and its active editor can change while the notice waits.
 * A resolver that throws is reported like one that returns a failure.
 *
 * @param ctx The resolved command context.
 */
function resolveRelaunchProject(ctx: CommandContext): Result<RelaunchProject, DebuggenError> {
  try {
    const resolved = ctx.discovery.resolveProjectRoot({ logger: ctx.logger });
    if (isErr(resolved)) {
      return resolved;
    }
    const { projectRoot, name } = resolved.value;
    return ok({ projectRoot, name });
  } catch (thrown) {
    return err(DebuggenError.from(thrown));
  }
}

/**
 * `devServer.stop` for one project. The client resolves every outcome as a
 * `Result` by contract; the `catch` keeps that promise for this command even
 * if a client broke it.
 *
 * @param ctx The resolved command context.
 * @param projectRoot The resolved project root.
 */
async function stopLaunchedDevServer(
  ctx: CommandContext,
  projectRoot: string,
): Promise<Result<DevServerStopResponse, DebuggenError>> {
  try {
    return await ctx.client.stopDevServer(
      { projectRoot },
      { timeoutMs: STOP_DEV_SERVER_TIMEOUT_MS },
    );
  } catch (thrown) {
    return err(DebuggenError.from(thrown));
  }
}

/**
 * The notice for a project the service launched no dev server for. A dev
 * server the developer started some other way with the preload holds the
 * credential the rotation revoked until it is restarted, and only whoever
 * started it can restart it — so the notice says so without naming a command
 * line (the product knows none for a server it did not start), and offers to
 * let Debug Generator launch one instead.
 *
 * @param projectName The workspace folder's display name.
 */
function notLaunchedNotice(projectName: string): CommandNotice {
  return {
    level: 'info',
    message: `Debug Generator did not launch the dev server for ${projectName}.`,
    detail:
      'If one is running with the Debug Generator preload, restart it the way it was started so it receives a new credential, ' +
      `or choose "${LAUNCH_DEV_SERVER_ACTION}" to have Debug Generator launch it.`,
    actions: [LAUNCH_DEV_SERVER_ACTION],
  };
}

/**
 * "Relaunch Dev Server": replaces the dev server the service launched for the
 * project with a fresh one that holds a new `server-agent` credential
 * (AAP §0.5.6: launched dev servers must be relaunched after a rotation).
 *
 * `debuggen.launchDevServer` alone cannot do this: the service's launcher
 * answers a launch for a project whose child is still running with that very
 * child — its pid and its environment, including the credential the rotation
 * just revoked. So the service is first asked to stop the child it launched
 * (`devServer.stop`, which answers only once the child has exited and its
 * credential is revoked), and only then is the launch command run: it probes,
 * finds nothing running, and the service spawns a new child with a new
 * credential.
 *
 * One message per outcome:
 * - the project cannot be resolved: one failure, and nothing is sent;
 * - the stop fails: one failure, and no launch — launching now would hand back
 *   the child that still holds the revoked credential;
 * - `stopped: true`: the launch command runs and reports its own outcome;
 * - `stopped: false`: the service launched no dev server for this project, so
 *   one information notice says it has to be restarted the way it was started,
 *   and "Launch Dev Server" runs the launch command only when chosen.
 *
 * @param ctx The resolved command context.
 */
async function relaunchDevServer(ctx: CommandContext): Promise<void> {
  const project = resolveRelaunchProject(ctx);
  if (isErr(project)) {
    ctx.logger.warn('The project to relaunch a dev server for could not be resolved', {
      command: COMMAND_ID,
      code: project.error.code,
    });
    await ctx.ui.notifyFailure(project.error, { prefix: RELAUNCH_PROJECT_FAILURE_PREFIX });
    return;
  }

  const stopped = await stopLaunchedDevServer(ctx, project.value.projectRoot);
  if (isErr(stopped)) {
    ctx.logger.warn('The launched dev server could not be stopped for a relaunch', {
      command: COMMAND_ID,
      code: stopped.error.code,
    });
    await ctx.ui.notifyFailure(stopped.error, { prefix: STOP_DEV_SERVER_FAILURE_PREFIX });
    return;
  }

  // The flag only: the project root is a path and stays out of the log.
  ctx.logger.info('The launched dev server was stopped for a relaunch', {
    command: COMMAND_ID,
    stopped: stopped.value.stopped,
  });
  if (stopped.value.stopped) {
    await runFollowUp(ctx, LAUNCH_DEV_SERVER_COMMAND);
    return;
  }

  const choice = await ctx.ui.notify(notLaunchedNotice(project.value.name));
  if (choice === LAUNCH_DEV_SERVER_ACTION) {
    await runFollowUp(ctx, LAUNCH_DEV_SERVER_COMMAND);
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Runs `debuggen.rotateServiceToken`.
 *
 * Asks for confirmation, then rotates every service credential with one
 * `credentials.rotate` request, re-reads the editor credential, and reports the
 * outcome once — a failure with the service's own message (offering "Pair
 * Chrome", with the pairing code cleared, whenever the rotation may have been
 * applied); for an editor credential the service refused, a failure in this
 * command's words that keeps the pairing code and offers "Restart service"
 * when this window runs the service; or a warning that names what was revoked
 * and offers "Pair Chrome" and, when a project is open, "Relaunch Dev
 * Server". Resolves after the developer has answered or dismissed that notice
 * and any follow-up it chose has run; it never rejects for an expected
 * condition.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param args Whatever VS Code invoked the command with. The command takes no
 *   argument; any given is ignored and never inspected.
 */
export async function rotateServiceToken(
  ctx: CommandContext,
  ...args: readonly unknown[]
): Promise<void> {
  // The registration signature forwards every argument; rotation reads none.
  void args;

  if (!(await ctx.ui.confirmDestructive(ROTATE_SERVICE_TOKEN_CONFIRMATION))) {
    ctx.logger.debug('Service token rotation cancelled', { command: COMMAND_ID });
    return;
  }

  const rotated = await ctx.client.rotateCredentials();
  const reloadFailure = await reloadEditorCredential(ctx, isOk(rotated));

  if (isErr(rotated)) {
    // Unless the failure provably left the rotation unapplied, it may have
    // been applied before the failure, taking every pairing code with it: the
    // code on display is cleared and re-pairing is offered.
    const possiblyApplied = !provablyNotApplied(rotated.error);
    ctx.logger.warn('Service token rotation failed', {
      command: COMMAND_ID,
      code: rotated.error.code,
      pairingCleared: possiblyApplied,
    });
    if (refusedAtAccessBoundary(rotated.error)) {
      await reportRefusedCredential(ctx, rotated.error);
      return;
    }
    if (possiblyApplied) {
      clearPairingDisplay(ctx);
    }
    const choice = await ctx.ui.notifyFailure(rotated.error, {
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      ...(possiblyApplied ? { actions: [PAIR_CHROME_ACTION] } : {}),
    });
    if (possiblyApplied && choice === PAIR_CHROME_ACTION) {
      await runFollowUp(ctx, PAIR_CHROME_COMMAND);
    }
    return;
  }

  // The service deleted every outstanding pairing code with the credentials.
  clearPairingDisplay(ctx);

  const { credentialsDeleted, socketsClosed } = rotated.value;
  ctx.logger.warn('Service credentials rotated', {
    command: COMMAND_ID,
    credentialsDeleted,
    socketsClosed,
  });

  const offerRelaunch = canRelaunchDevServer(ctx);
  const choice = await ctx.ui.notify(rotatedNotice(rotated.value, reloadFailure, offerRelaunch));
  if (choice === PAIR_CHROME_ACTION) {
    await runFollowUp(ctx, PAIR_CHROME_COMMAND);
  } else if (offerRelaunch && choice === RELAUNCH_DEV_SERVER_ACTION) {
    await relaunchDevServer(ctx);
  }
}
