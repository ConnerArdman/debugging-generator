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
 *   `{ projectRoot, question, target? }`.
 *
 * ```text
 * requireWorkspaceProject ──▶ reveal + focus "question" ──▶ question? ──no──▶ done
 *                                                             │ yes
 *                         resetSession ──▶ createSession (POST /sessions)
 *                                             │ Err ──▶ one failure notice
 *                                             │ Ok  ──▶ the WebSocket broadcast
 *                                             ▼          fills the view
 * ```
 *
 * ## What the command deliberately does not do
 *
 * - **It never reads the question.** The text is trimmed, checked for being
 *   present at all, and forwarded as data to the service's first pipeline
 *   stage. Nothing here compares, matches or branches on its wording
 *   (AAP §0.5.4), and nothing logs it.
 * - **It holds no copy of server state.** On success the created
 *   `SessionRecord` is not applied here: the service broadcasts
 *   `session.created`, `session.updated` and `session.progress`, and
 *   `src/extension.ts` folds those into `ExtensionState`, which is what makes
 *   the view's `ProgressSteps` rows live. The single store mutation this
 *   command makes is {@link ExtensionState.resetSession}, *before* the request,
 *   so the previous session's rows are gone while the new session's first
 *   frames arrive — and so a broadcast that lands while the request is still
 *   in flight is never wiped afterwards.
 * - **It makes one request and never retries.** Reconnection and backoff
 *   belong to the reconnecting WebSocket client; an HTTP failure is reported
 *   once, with the service's hint, and the developer decides what to do.
 * - **It never throws for an expected condition.** Every `ServiceClient`
 *   operation resolves to a `Result`; an unmet precondition has already been
 *   explained by its guard. The registration wrapper in `./index` only exists
 *   for the unexpected.
 *
 * @module
 */

import type { SessionCreateRequest } from '@debuggen/protocol';
import { DebuggenError, isErr } from '@debuggen/shared';

import type { ExtensionState } from '../state';
import type { HostToWebviewMessageOf } from '../webview-messages';

import type { CommandContext, CommandId, SESSION_VIEW_FOCUS_COMMAND } from './index';

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
 * Builds the `session.create` body.
 *
 * `target` is included only when the store holds a selected element — the one
 * the developer picked in the DevTools panel — and is otherwise omitted rather
 * than sent as `undefined`: an absent key is how the body says "no target", in
 * which case the service uses the bound tab's current URL (AAP §0.2.3).
 *
 * @param projectRoot The workspace project, in the product's POSIX spelling.
 * @param question The trimmed, non-empty question, forwarded unread.
 * @param state The host store, read after its reset (see {@link startSession}).
 * @returns The request body.
 */
function buildCreateRequest(
  projectRoot: string,
  question: string,
  state: ExtensionState,
): SessionCreateRequest {
  const target = state.target;
  return {
    projectRoot,
    question,
    ...(target === undefined ? {} : { target }),
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
 * 4. Resets the session-scoped view state. The reset precedes the request so
 *    that nothing from the previous session is on screen while the new one's
 *    first `session.progress` arrives, and so that a `session.created` pushed
 *    while the request is in flight is kept. It also drops the previous
 *    session's own target while keeping an element selected with no session
 *    active, which is exactly the target the new question is about.
 * 5. Sends `session.create` once. A failure becomes one error notice carrying
 *    the service's hint; it is never presented as a started session.
 * 6. On success, applies nothing: the broadcast fills the store. When the
 *    WebSocket is not open, says so, because the session would otherwise look
 *    stalled.
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

  ctx.state.resetSession();
  ctx.logger.info('Session requested', { command: COMMAND_ID });

  const created = await ctx.client.createSession(
    buildCreateRequest(project.projectRoot, question, ctx.state),
  );
  if (isErr(created)) {
    ctx.logger.warn('Session could not be started', {
      command: COMMAND_ID,
      code: created.error.code,
    });
    await ctx.ui.notifyFailure(created.error, { prefix: CREATE_FAILURE_PREFIX });
    return;
  }

  ctx.logger.info('Session started', { command: COMMAND_ID, sessionId: created.value.id });

  if (ctx.client.state !== 'open') {
    await ctx.ui.notify({
      level: 'info',
      message: LIVE_UPDATES_UNAVAILABLE_MESSAGE,
      detail: LIVE_UPDATES_UNAVAILABLE_DETAIL,
    });
  }
}
