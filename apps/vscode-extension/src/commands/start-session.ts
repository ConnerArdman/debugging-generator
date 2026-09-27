/**
 * `debuggen.startSession` — "Debug Generator: Start Debugging Session"
 * (AAP §0.4.2, §0.7.3, §0.8.1 slice 3).
 *
 * The command has two callers and one implementation:
 *
 * - **The Command Palette** passes no argument. The command reveals the
 *   Debug Generator view and moves focus to its question field, and that is
 *   the whole job: a session starts from a question, and the question is typed
 *   in the view's `QuestionForm`.
 * - **The view's `QuestionForm`** submits `askQuestion`, which
 *   `src/views/session-view-provider.ts` forwards to this command as
 *   `{ question }` (its "retry" of a failed early stage does the same with the
 *   session's own question). The command then starts a session on the
 *   workspace project with `session.create` — `POST /sessions`, body
 *   `{ projectRoot, question, devServerUrl? }`. The body never carries a
 *   `target`: the element the developer picks in DevTools is recorded by the
 *   service on the session the DevTools tab is bound to.
 *
 * ```text
 * requireWorkspaceProject ──▶ reveal + focus "question" ──▶ question? ──no──▶ done
 *                                                             │ yes
 *                     probe debuggen.devServerUrl (its URL kept only if it answered)
 *                                                             │
 *              another start/reopen in flight? ──yes──▶ one notice, done
 *                                                             │ no
 *                                          beginSessionCreation (window opens)
 *                                                             │
 *        endBeforeReplacing (POST /sessions/:id/end for a live active session)
 *                                                             │ false ──▶ stop; the
 *                                                             │           ended session
 *                                                             │ true      stays in view
 *                                  shutting down? ──yes──▶ stop, no create
 *                                                             │ no
 *               trackSessionCreate + createSession (POST /sessions), same turn
 *                                      │ Err ──▶ window abandoned, one failure notice,
 *                                      │         the previous session stays in view
 *                                      │ Ok  ──▶ window.adopt(created record): the new
 *                                      ▼         session is active from the HTTP answer,
 *                                                with every frame that beat it replayed
 * ```
 *
 * ## The dev-server URL
 *
 * A session is created with the project's dev-server URL, probed or launched
 * (AAP §0.2.3). A dev server the service launched is known to the service; one
 * the developer started themselves is known only here, through the
 * `debuggen.devServerUrl` setting. So the command probes that setting once,
 * just before the request, and forwards the URL as `devServerUrl` **only when
 * something answered** — the service then verifies it again on loopback before
 * recording it. An unset, unusable or silent setting forwards nothing and
 * leaves the service to use a dev server it launched, or to answer with its
 * instruction to start or launch one.
 *
 * ## Why the previous session is ended first
 *
 * `deactivate()` in `src/extension.ts` ends the active session and the
 * sessions its creates in flight produce — never one the store has already
 * replaced — so replacing a live session in the store without ending it would
 * orphan its patches and hooks (AAP §0.5.1). A new question, and the view's
 * Retry of a failed early stage, is an explicit start-over, and ending a
 * session is the documented no-confirmation way to remove instrumentation, so
 * the previous session is ended without a modal: {@link endBeforeReplacing}
 * sends `session.end`, awaits the settled cleanup and stops the start, with
 * one notice, whenever the verdict leaves anything for the developer to see.
 *
 * ## Why the created record is applied here
 *
 * The HTTP answer is the service's authoritative `SessionRecord`, and a socket
 * that is closed or reconnecting would otherwise leave a real, possibly
 * instrumented session without capture, end or deactivation control. The
 * record is therefore adopted the moment it arrives. `POST /sessions` starts
 * the pipeline before it answers, so `session.created` and the first
 * `session.progress` rows can arrive first; the creation window holds them and
 * replays them on adoption, and later pushes reconcile by id and `updatedAt`.
 *
 * ## What the command deliberately does not do
 *
 * - **It never reads the question.** The text is trimmed, checked for being
 *   present at all, and forwarded as data to the service's first pipeline
 *   stage. Nothing here compares, matches or branches on its wording
 *   (AAP §0.5.4), and nothing logs it.
 * - **It holds no copy of server state.** Everything it learns — the end
 *   verdict, the created record — goes straight into `ExtensionState`, the
 *   host's single store, through the mutators named after those answers.
 * - **It creates nothing once shutdown began.** The gate is checked before the
 *   previous session is ended, after, and in the turn the request is sent; a
 *   create already in flight is tracked, so the shutdown routine waits for it
 *   and ends what it created.
 * - **It makes one create request and never retries.** Reconnection and
 *   backoff belong to the reconnecting WebSocket client; an HTTP failure is
 *   reported once, with the service's hint, and the developer decides what to
 *   do.
 * - **It never throws for an expected condition.** Every `ServiceClient`
 *   operation resolves to a `Result`; an unmet precondition has already been
 *   explained by its guard. The registration wrapper in `./index` only exists
 *   for the unexpected.
 *
 * @module
 */

import type { SessionCreateRequest } from '@debuggen/protocol';
import { DebuggenError, isErr } from '@debuggen/shared';
import type { DebuggenErrorCode } from '@debuggen/shared';

import type { ProjectRootInfo } from '../service/discovery';
import type { SessionCreationWindow } from '../state';
import type { HostToWebviewMessageOf } from '../webview-messages';

import {
  SESSION_CREATE_TIMEOUT_MS,
  captureServiceEndpoint,
  endBeforeReplacing,
} from './end-session';
import type { CommandContext, CommandId, CommandNotice, SESSION_VIEW_FOCUS_COMMAND } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This command's id, for log fields. */
const COMMAND_ID = 'debuggen.startSession' satisfies CommandId;

/**
 * The command that reveals and focuses the `debuggen.session` view.
 *
 * The barrel's {@link SESSION_VIEW_FOCUS_COMMAND} is imported as a *type* only:
 * the barrel imports every command module at runtime, so a runtime import back
 * into it would close a cycle. The annotation makes this literal a compile
 * error the moment it disagrees with the barrel's constant (and, through it,
 * with `SESSION_VIEW_ID`).
 */
const SESSION_VIEW_FOCUS: typeof SESSION_VIEW_FOCUS_COMMAND = 'debuggen.session.focus';

/** The view section the question field lives in, from the webview message vocabulary. */
const QUESTION_SECTION = 'question' satisfies HostToWebviewMessageOf<'focus'>['section'];

/** The headline prefix of a `session.create` failure. */
const CREATE_FAILURE_PREFIX = 'Could not start a session';

/**
 * The failure code of a `session.create` that got no answer — it timed out,
 * was cancelled or lost its connection. The request may have reached the
 * service, which stores the session before it answers, so unlike a refusal it
 * does not prove that no session exists.
 */
const UNANSWERED_CREATE_CODE = 'TRANSPORT_DISCONNECTED' satisfies DebuggenErrorCode;

/** The command that lists the stored sessions and reopens one. */
const REOPEN_SESSION_COMMAND = 'debuggen.reopenSession' satisfies CommandId;

/** The action on an unanswered create's notice that runs {@link REOPEN_SESSION_COMMAND}. */
const REOPEN_SESSION_ACTION = 'Reopen Session';

/**
 * The hint shown for an unanswered create: where a session the service may
 * have created anyway can be found and ended, so its instrumentation is not
 * left behind unnoticed.
 */
const UNANSWERED_CREATE_HINT =
  'The service may still have started the session. If it appears under "Reopen Session", reopen it and end it to remove its instrumentation.';

/**
 * Shown when VS Code could not reveal the view on the palette path, where
 * revealing it is the command's entire purpose.
 */
const REVEAL_FAILED_MESSAGE = 'Could not open the Debug Generator view.';
const REVEAL_FAILED_DETAIL =
  'Open it from the Debug Generator icon in the Activity Bar, then ask your question there.';

/**
 * Shown after a successful `session.create` while the WebSocket is not open:
 * the session exists, but its progress, plan and panel arrive only as pushed
 * frames, so a closed socket would otherwise look like a stalled session.
 */
const LIVE_UPDATES_UNAVAILABLE_MESSAGE =
  'Session started, but live updates are unavailable until the connection to the local service is restored.';
const LIVE_UPDATES_UNAVAILABLE_DETAIL =
  'Progress appears here as soon as Debug Generator reconnects. If the service has stopped, run "Debug Generator: Start Local Service".';

/**
 * Shown when a start or reopen is already replacing the active session: a
 * second one in flight could adopt a session the first has not ended, so it is
 * refused rather than queued.
 */
const REPLACEMENT_IN_FLIGHT_NOTICE: CommandNotice = Object.freeze({
  level: 'info',
  message: 'A debugging session is already being started or reopened.',
  detail: 'Wait for it to appear in the Debug Generator view, then ask your question again.',
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * The arguments `debuggen.startSession` understands.
 *
 * VS Code hands a command whatever its caller passed, so this is the shape the
 * first argument is parsed into rather than a type the caller is trusted to
 * honour. The session view passes `{ question }`; a programmatic caller may
 * also pass the question as a bare string; the Command Palette passes nothing.
 */
export interface StartSessionArgs {
  /** The developer's question, untrimmed and unread; absent on the palette path. */
  readonly question?: string;
}

/**
 * Parses the command's first argument.
 *
 * Accepts a `{ question: string }` object (the view's `askQuestion` forward)
 * or a bare string. Anything else — nothing, a tree item, an object whose
 * `question` is not a string — yields no question, which makes the invocation
 * the palette path. The value's content is never examined.
 *
 * @param raw The first argument VS Code passed, untrusted.
 * @returns The recognised arguments; `{}` when there is no question.
 */
function parseStartSessionArgs(raw: unknown): StartSessionArgs {
  if (typeof raw === 'string') {
    return { question: raw };
  }
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const candidate: unknown = (raw as { readonly question?: unknown }).question;
  return typeof candidate === 'string' ? { question: candidate } : {};
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Reveals the Debug Generator view and asks it to focus the question field.
 *
 * A reveal that throws is logged by code and reported as `false`; the focus
 * request is still posted, because the view may already be showing (the
 * `QuestionForm` path) and posting to an unresolved view is a harmless no-op.
 *
 * @param ctx The command context.
 * @returns Whether VS Code revealed the view.
 */
async function revealQuestionField(ctx: CommandContext): Promise<boolean> {
  let revealed = true;
  try {
    await ctx.ui.executeCommand(SESSION_VIEW_FOCUS);
  } catch (error) {
    revealed = false;
    ctx.logger.warn('Session view could not be revealed', {
      command: COMMAND_ID,
      code: DebuggenError.from(error).code,
    });
  }
  ctx.sessionView.postFocus(QUESTION_SECTION);
  return revealed;
}

/**
 * The URL of the developer's own dev server, when `debuggen.devServerUrl` names
 * one that answers right now.
 *
 * One bounded probe through the command context's discovery port — the same
 * probe `debuggen.launchDevServer` uses. Every outcome other than an answer
 * yields `undefined`: an unset setting is the documented "let the service find
 * or launch it" state, an unusable one is reported by the launch command where
 * it matters, and a silent one would only be refused by the service.
 *
 * @param ctx The command context.
 * @param scope The project folder whose resource-scoped setting is read.
 * @returns The probed URL (origin and path only), or `undefined`.
 */
async function answeringDevServerUrl(
  ctx: CommandContext,
  scope: ProjectRootInfo['folderUri'],
): Promise<string | undefined> {
  const probe = await ctx.discovery.probeDevServer({ scope, logger: ctx.logger });
  if (isErr(probe)) {
    ctx.logger.debug('No configured dev-server URL to forward', {
      command: COMMAND_ID,
      code: probe.error.code,
    });
    return undefined;
  }
  if (!probe.value.running) {
    ctx.logger.debug('The configured dev server did not answer; no URL is forwarded', {
      command: COMMAND_ID,
    });
    return undefined;
  }
  return probe.value.url;
}

/**
 * Builds the `session.create` body.
 *
 * The editor never sends `target`. The element picked in DevTools is recorded
 * by the service on the session the DevTools tab is bound to, and reaches the
 * editor as that session's record `target`; a new session never inherits the
 * previous session's target. Without one, the service's first stage starts
 * from the bound tab's current URL.
 * `devServerUrl` is present only when the configured dev server answered the
 * probe, and is otherwise omitted rather than sent as `undefined`.
 *
 * @param projectRoot The workspace project, in the product's POSIX spelling.
 * @param question The trimmed, non-empty question, forwarded unread.
 * @param devServerUrl The configured dev server's URL, when it answered.
 * @returns The request body.
 */
function buildCreateRequest(
  projectRoot: string,
  question: string,
  devServerUrl: string | undefined,
): SessionCreateRequest {
  return {
    projectRoot,
    question,
    ...(devServerUrl === undefined ? {} : { devServerUrl }),
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Runs `debuggen.startSession`.
 *
 * 1. Requires a workspace project; without one the guard has already told the
 *    developer what to open, and the command stops.
 * 2. Reveals the view and focuses its question field — always.
 * 3. Stops when there is no question (the palette path).
 * 4. Probes `debuggen.devServerUrl` once; its URL is forwarded only when
 *    something answered (see the module overview). The probe runs first, so
 *    the previous session stays on screen while it does and nothing is
 *    awaited between the gates below and the request.
 * 5. Refuses, silently, once the extension is shutting down
 *    (`ExtensionState.isShuttingDown`), and, with one notice, while
 *    another start or reopen is replacing the active session
 *    (`ExtensionState.sessionCreationPending`); two replacements in
 *    flight could adopt a session the other has not ended.
 * 6. Opens the creation window synchronously, before anything is awaited, so
 *    the check in step 5 is race-free and no frame of the new session is lost.
 * 7. Ends the active session through {@link endBeforeReplacing} and stops when
 *    it says so; the ended session and its verdict stay in view. Checks the
 *    shutdown gate again afterwards.
 * 8. Registers the create with `ExtensionState.trackSessionCreate` and
 *    sends `session.create` once, in the same turn, with a
 *    {@link SESSION_CREATE_TIMEOUT_MS} budget. A failure abandons the window
 *    and becomes one error notice carrying the service's hint; it is never
 *    presented as a started session, and the previous session stays in view.
 *    A create that got no answer may still have produced a session, so its
 *    notice offers "Reopen Session" to find and end it.
 * 9. On success, adopts the answered record — the new session is active from
 *    the HTTP answer alone, with every held frame of it replayed — and, when
 *    the WebSocket is not open, says that live updates are unavailable.
 *
 * The window is abandoned, and the ticket settled, on every path that does
 * not adopt. When `deactivate()` begins a shutdown while the create is in
 * flight, the window closes, so the answered session cannot be adopted: the
 * ticket hands it to the shutdown routine (`endSessionsForShutdown`), which
 * waits for the answer and ends the session at its owning endpoint before the
 * service is stopped. Only when no routine takes it over — the store was
 * disposed without a shutdown, or the routine stopped waiting — does the
 * command end the session itself.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param args Whatever VS Code passed; see {@link StartSessionArgs}.
 */
export async function startSession(
  ctx: CommandContext,
  ...args: readonly unknown[]
): Promise<void> {
  const project = ctx.guards.requireWorkspaceProject();
  if (!project) {
    return;
  }

  const revealed = await revealQuestionField(ctx);

  const question = parseStartSessionArgs(args[0]).question?.trim();
  if (!question) {
    if (!revealed) {
      await ctx.ui.notify({
        level: 'error',
        message: REVEAL_FAILED_MESSAGE,
        detail: REVEAL_FAILED_DETAIL,
      });
    }
    return;
  }

  // A start after shutdown began does nothing — not even the probe below.
  if (ctx.state.isShuttingDown) {
    logShutdownRefusal(ctx, 'before-replacing');
    return;
  }

  // Probed before the gates below and the creation window, which nothing may
  // be awaited across, so the previous session stays on screen while the
  // probe runs; the gates are then read again, after it.
  const devServerUrl = await answeringDevServerUrl(ctx, project.folderUri);

  if (ctx.state.isShuttingDown) {
    logShutdownRefusal(ctx, 'before-replacing');
    return;
  }
  if (ctx.state.sessionCreationPending) {
    ctx.logger.info('Session start refused while another replacement is in flight', {
      command: COMMAND_ID,
    });
    await ctx.ui.notify(REPLACEMENT_IN_FLIGHT_NOTICE);
    return;
  }

  const creation = ctx.state.beginSessionCreation();
  try {
    if (!(await endBeforeReplacing(ctx, 'start'))) {
      return;
    }
    // Shutdown closes every creation window, so either test catches a
    // `deactivate()` that ran while the previous session was being ended. From
    // here to the request being sent, nothing is awaited: the gate cannot close
    // between this check and the ticket below.
    if (ctx.state.isShuttingDown || !creation.isOpen) {
      logShutdownRefusal(ctx, 'after-replacing');
      return;
    }

    // The service that answers is the one the new session lives in, so its
    // address is captured now, before the request is sent: a
    // `debuggen.serviceUrl` change while the request is in flight must not
    // re-home the session.
    const captured = captureServiceEndpoint(ctx);
    if (isErr(captured)) {
      creation.abandon();
      await ctx.ui.notifyFailure(captured.error, { prefix: CREATE_FAILURE_PREFIX });
      return;
    }
    const endpoint = captured.value;

    ctx.logger.info('Session requested', {
      command: COMMAND_ID,
      devServerUrlForwarded: devServerUrl !== undefined,
    });
    // Registered in the same turn the request is sent, so a `deactivate()`
    // that runs while it is unanswered waits for it and ends what it creates.
    const ticket = ctx.state.trackSessionCreate(endpoint);
    try {
      const created = await ctx.client.createSession(
        buildCreateRequest(project.projectRoot, question, devServerUrl),
        { timeoutMs: SESSION_CREATE_TIMEOUT_MS },
      );
      if (isErr(created)) {
        ticket.none();
        creation.abandon();
        ctx.logger.warn('Session could not be started', {
          command: COMMAND_ID,
          code: created.error.code,
        });
        await reportCreateFailure(ctx, created.error);
        return;
      }

      const sessionId = created.value.id;
      if (!creation.isOpen) {
        // Shutdown began, or the store was disposed, while the request was in
        // flight: nothing will adopt the session.
        if (ticket.orphaned(sessionId)) {
          ctx.logger.info('Session created during shutdown was handed to the shutdown routine', {
            command: COMMAND_ID,
            sessionId,
          });
          return;
        }
        await endUntrackedSession(ctx, sessionId, endpoint);
        return;
      }
      creation.adopt(created.value, endpoint);
      ticket.adopted(sessionId);
      reportAdoption(ctx, creation, sessionId);
    } finally {
      // A no-op once settled; settles the ticket on every other exit, a throw
      // included, so shutdown never waits on a request that is over.
      ticket.none();
    }

    if (ctx.client.state !== 'open') {
      await ctx.ui.notify({
        level: 'info',
        message: LIVE_UPDATES_UNAVAILABLE_MESSAGE,
        detail: LIVE_UPDATES_UNAVAILABLE_DETAIL,
      });
    }
  } finally {
    // A no-op once adopted; closes the window on every other exit, a throw
    // included, so no frame is held past this command.
    creation.abandon();
  }
}

/**
 * Reports a failed `session.create` with one notice carrying the service's
 * hint. A create that got no answer ({@link UNANSWERED_CREATE_CODE}) may still
 * have produced a session, so its notice says so and offers
 * {@link REOPEN_SESSION_ACTION}, which lists the stored sessions: the
 * developer can reopen that session and end it, and nothing it installed is
 * left behind unseen.
 *
 * @param ctx The command context.
 * @param error The create's failure.
 */
async function reportCreateFailure(ctx: CommandContext, error: DebuggenError): Promise<void> {
  if (error.code !== UNANSWERED_CREATE_CODE) {
    await ctx.ui.notifyFailure(error, { prefix: CREATE_FAILURE_PREFIX });
    return;
  }
  const unanswered = new DebuggenError(error.code, error.message, {
    hint:
      error.hint === undefined ? UNANSWERED_CREATE_HINT : `${error.hint} ${UNANSWERED_CREATE_HINT}`,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
  const choice = await ctx.ui.notifyFailure(unanswered, {
    prefix: CREATE_FAILURE_PREFIX,
    actions: [REOPEN_SESSION_ACTION],
  });
  if (choice !== REOPEN_SESSION_ACTION) {
    return;
  }
  try {
    await ctx.ui.executeCommand(REOPEN_SESSION_COMMAND);
  } catch (thrown) {
    ctx.logger.warn('Reopen Session could not be started after an unanswered create', {
      command: COMMAND_ID,
      code: DebuggenError.from(thrown).code,
    });
  }
}

/**
 * Logs that a start was refused because the extension is shutting down. No
 * notice is shown: the window is closing, and `deactivate()` owns what is
 * left.
 *
 * @param ctx The command context.
 * @param point Where the gate closed: before the previous session was ended,
 *   or after.
 */
function logShutdownRefusal(
  ctx: CommandContext,
  point: 'before-replacing' | 'after-replacing',
): void {
  ctx.logger.info('Session start refused because the extension is shutting down', {
    command: COMMAND_ID,
    point,
  });
}

/**
 * Logs an adopted session, and any frames its creation window had to drop.
 *
 * @param ctx The command context.
 * @param creation The window that adopted the session.
 * @param sessionId The adopted session.
 */
function reportAdoption(
  ctx: CommandContext,
  creation: SessionCreationWindow,
  sessionId: string,
): void {
  if (creation.droppedFrames > 0) {
    ctx.logger.warn('Frames held while the session was created exceeded the bound', {
      command: COMMAND_ID,
      sessionId,
      dropped: creation.droppedFrames,
    });
  }
  ctx.logger.info('Session started', { command: COMMAND_ID, sessionId });
}

/**
 * Ends a session the service created that nothing adopted and no shutdown
 * routine took over: the store was disposed without `deactivate()` having
 * begun a shutdown, or the shutdown routine had already stopped waiting for
 * creates in flight (`SessionCreateTicket.orphaned` answered `false`).
 *
 * Nothing else knows the session exists, so it would otherwise keep whatever
 * its pipeline installs. One best-effort `session.end` to the service that
 * created it; the outcome is logged by status or code only, and no notice is
 * shown to a window that is closing.
 *
 * @param ctx The command context.
 * @param sessionId The session the service just created.
 * @param endpoint The service that created it: the endpoint captured before
 *   `POST /sessions` was sent.
 */
async function endUntrackedSession(
  ctx: CommandContext,
  sessionId: string,
  endpoint: string,
): Promise<void> {
  ctx.logger.warn('Session created while the extension was shutting down; ending it', {
    command: COMMAND_ID,
    sessionId,
  });
  const ended = await ctx.client.endSession(sessionId, { endpoint });
  if (isErr(ended)) {
    ctx.logger.warn('Session created during shutdown could not be ended', {
      command: COMMAND_ID,
      sessionId,
      code: ended.error.code,
    });
    return;
  }
  ctx.logger.info('Session created during shutdown was ended', {
    command: COMMAND_ID,
    sessionId,
    cleanup: ended.value.cleanup,
  });
}
