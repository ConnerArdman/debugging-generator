/**
 * `debuggen.startCapture` — opens a capture window on the active session
 * (AAP §0.4.2 `capture.start`, §0.7.3 `CaptureControls`).
 *
 * ## What the command does
 *
 * 1. **Preconditions.** A session must be active. The shared guard renders the
 *    single "No active session." notice itself, so an unmet guard is a plain
 *    early return here. A session the store has acknowledged as ended
 *    (`./capture-availability`) gets one informational notice saying it cannot
 *    capture again and how to start another session, and no request is sent.
 * 2. **One operation.** `POST /sessions/:id/capture/start` through
 *    `ServiceClient.startCapture` — addressed by operation id, never by a path
 *    written here. No retry, no second request.
 * 3. **The outcome.**
 *    - *Success* changes nothing locally. The service broadcasts
 *      `capture.started { sessionId, captureId }` to every client of the
 *      session, `src/extension.ts` folds it into `src/state.ts`, and that is
 *      what flips `CaptureControls` to "Capturing". The view already asks the
 *      developer to "Reproduce the issue now." from the real session state
 *      (`ProgressSteps`, `CaptureControls`), so no success notice is shown —
 *      repeating that copy as a toast would say the same thing twice.
 *    - *Ownership conflict* — the reason this module is more than a one-liner.
 *      AAP §0.4.2 allows at most one session to hold a capture on a project at
 *      a time; a start for a project another session is capturing is refused
 *      with `409 { owningSessionId }`. The protocol client parses that body
 *      with `captureStartConflictResponseSchema` and carries the id in
 *      `error.details.owningSessionId`; this module validates it with the same
 *      schema's field and renders one warning that **names the owning
 *      session**, with an action that reopens it.
 *    - *State refusal* — `409 SESSION_INVALID_STATE`: the session's state on
 *      the service does not allow a start (its own capture is already running,
 *      it is not armed yet, it moved on). The service scrubs the message to a
 *      code-level summary, so one warning is worded from the session status the
 *      store reads once the refusal arrived (`captureRefusalNotice`), with the
 *      next step — never the raw `status 409` failure text.
 *    - *Any other failure* is one error notice built from the typed failure,
 *      keeping the service-provided `hint` — which is where the relaunch command
 *      arrives when server-side signals are not ready (AAP §0.5.5 row 1).
 *
 * The title-bar action is greyed by the command's `enablement` clause
 * (`debuggen.captureCanStart`, kept by `bindCaptureContextKeys`) whenever the
 * session is not armed; the webview dispatches the command directly, which
 * `enablement` does not block, so every path above stays reachable.
 *
 * ## What it deliberately does not do
 *
 * - It never mutates the store, never estimates a capture counter and never
 *   presents a refused start as a running capture (AAP §0.5.4, §0.5.5).
 * - It never short-circuits on non-terminal cached state (`captureState`, a
 *   status other than `ended`): the service is the authority on whether this
 *   session may start a capture, and a stale projection can therefore never
 *   block a legitimate start. The single exception is an acknowledged end,
 *   which is terminal in the store (`ExtensionState.hasAcknowledgedEnd`) and in
 *   the service's state machine (`ended` has no outgoing edge), so skipping the
 *   request there can only spare a certain refusal.
 * - It never detects the conflict from message text or from a status number: the
 *   only signal is a schema-valid `owningSessionId` in the structured details.
 * - It logs one line with the command id only — never a token, a session
 *   question, a project path or a session id.
 *
 * ## Module graph
 *
 * Imports **types only** from `./index` (the barrel imports this module at
 * runtime), so the reopen command id is a literal checked against
 * {@link CommandId} rather than a value read from `COMMAND_IDS`. The
 * availability rules and the ended and refusal copy come from
 * `./capture-availability`, which imports nothing from this folder at runtime.
 *
 * @example
 * ```ts
 * // Registered by ./index as:
 * 'debuggen.startCapture': (...args) => startCapture(ctx, ...args),
 * ```
 */

import { captureStartConflictResponseSchema } from '@debuggen/protocol';
import type { SessionListItem } from '@debuggen/protocol';
import { DebuggenError, isErr } from '@debuggen/shared';

import {
  captureAvailabilityOf,
  captureRefusalNotice,
  endedSessionNotice,
  isCaptureStateRefusal,
} from './capture-availability';
import type { ActiveSessionRef, CommandContext, CommandId } from './index';

/** This command's id, as it appears in every log line the module writes. */
const START_CAPTURE_COMMAND = 'debuggen.startCapture' satisfies CommandId;

/**
 * The command the conflict notice's action runs. It takes the bare session id
 * as its argument, exactly as the Sessions tree invokes it.
 */
const REOPEN_SESSION_COMMAND = 'debuggen.reopenSession' satisfies CommandId;

/** The headline prefix of every failure other than the conflict and a state refusal. */
const FAILURE_PREFIX = 'Could not start capture';

/** The one action the conflict notice offers. */
const REOPEN_ACTION = 'Reopen that session';

/** What the developer can do about a conflict, shown as the notice's detail. */
const CONFLICT_DETAIL = 'Stop that capture, or reopen that session to continue there.';

/**
 * The longest question excerpt the conflict headline quotes, in code points,
 * including the trailing ellipsis. The notice must stay a one-line read; the
 * Sessions tree shows the full question.
 */
const MAX_OWNER_EXCERPT_LENGTH = 60;

/** Runs of whitespace and control characters (`Cc`), collapsed to one space. */
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]+/gu;

/**
 * The session that holds the project's capture, when `error` is the
 * capture-ownership conflict of AAP §0.4.2.
 *
 * The protocol client copies the validated `owningSessionId` of the `409` body
 * into `error.details`; it is validated again here with the conflict schema's
 * own field so the value rendered and passed to the reopen command is exactly a
 * protocol identifier. Any other failure — a plain `409` for this session's own
 * capture, a readiness refusal, a transport error — carries no such field and
 * yields `undefined`.
 *
 * @param error The typed failure of `capture.start`.
 * @returns The owning session's id, or `undefined` when this is not an
 *   ownership conflict.
 */
function conflictOwnerOf(error: DebuggenError): string | undefined {
  const parsed = captureStartConflictResponseSchema.shape.owningSessionId.safeParse(
    error.details?.owningSessionId,
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * A question as a bounded, single-line excerpt: whitespace and control
 * characters collapsed, trimmed, and cut on a code-point boundary with an
 * ellipsis when it is longer than {@link MAX_OWNER_EXCERPT_LENGTH}.
 *
 * The question is displayed only — nothing here inspects what it says.
 *
 * @param question A session's question, as typed.
 * @returns The excerpt; empty when nothing printable remains.
 */
function questionExcerpt(question: string): string {
  const collapsed = question.replace(WHITESPACE_OR_CONTROL, ' ').trim();
  const points = Array.from(collapsed);
  if (points.length <= MAX_OWNER_EXCERPT_LENGTH) {
    return collapsed;
  }
  return `${points
    .slice(0, MAX_OWNER_EXCERPT_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * How the conflict headline names the owning session: always its id, followed
 * by its question excerpt when the host's session list already holds that
 * session. The list is read, never refreshed — a session the host does not know
 * (or that the listed page left out) is named by its id alone.
 *
 * @param ownerId The owning session's id.
 * @param sessions The host's cached session list rows; only `id` and
 *   `question` are read.
 * @returns The parenthesised label's content.
 */
function ownerLabel(
  ownerId: string,
  sessions: readonly Pick<SessionListItem, 'id' | 'question'>[],
): string {
  const listed = sessions.find((session) => session.id === ownerId);
  if (listed === undefined) {
    return ownerId;
  }
  const excerpt = questionExcerpt(listed.question);
  return excerpt === '' ? ownerId : `${ownerId}, “${excerpt}”`;
}

/**
 * Renders the ownership conflict as one warning and, when the developer
 * chooses to, reopens the owning session.
 *
 * The reopen command reports its own outcome; only a failure to run it at all
 * is rendered here, once, as the failure it is.
 *
 * @param ctx The command context.
 * @param ownerId The session that holds the project's capture.
 */
async function renderConflict(ctx: CommandContext, ownerId: string): Promise<void> {
  const choice = await ctx.ui.notify({
    level: 'warning',
    message: `Another session (${ownerLabel(ownerId, ctx.state.sessionList)}) is already capturing this project.`,
    detail: CONFLICT_DETAIL,
    actions: [REOPEN_ACTION],
  });
  if (choice !== REOPEN_ACTION) {
    return;
  }
  try {
    await ctx.ui.executeCommand(REOPEN_SESSION_COMMAND, ownerId);
  } catch (thrown) {
    await ctx.ui.notifyFailure(DebuggenError.from(thrown), {
      prefix: `Could not reopen session ${ownerId}`,
    });
  }
}

/**
 * `debuggen.startCapture`: asks the local service to open a capture window on
 * the active session.
 *
 * Resolves once the outcome has been rendered; it never rejects for an
 * expected failure, and it renders exactly one message per failure. On success
 * it renders nothing: the `capture.started` broadcast updates the view. For a
 * session the store knows has ended it sends nothing and renders the one
 * ended-session notice.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param _args Whatever VS Code invoked the command with. The command acts on
 *   the active session only, so the arguments are accepted and ignored.
 */
export async function startCapture(
  ctx: CommandContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the registration contract forwards VS Code's invocation arguments; this command acts on the active session only
  ..._args: readonly unknown[]
): Promise<void> {
  const active: ActiveSessionRef | undefined = ctx.guards.requireActiveSession();
  if (!active) {
    return;
  }

  // `ended` is terminal in the store and on the service, so this is the one
  // cached fact that may stop the request (see the module overview).
  if (captureAvailabilityOf(ctx.state, active.sessionId).ended) {
    ctx.logger.info('Capture start skipped: the session has ended', {
      command: START_CAPTURE_COMMAND,
    });
    await ctx.ui.notify(endedSessionNotice('start'));
    return;
  }

  ctx.logger.info('Capture start requested', { command: START_CAPTURE_COMMAND });
  const started = await ctx.client.startCapture(active.sessionId);
  if (!isErr(started)) {
    return;
  }

  const ownerId = conflictOwnerOf(started.error);
  if (ownerId !== undefined && ownerId !== active.sessionId) {
    await renderConflict(ctx, ownerId);
    return;
  }

  if (isCaptureStateRefusal(started.error)) {
    // Worded from the store as it reads now: the refusal is often the first
    // sign that the session moved on, and its frames may have arrived meanwhile.
    await ctx.ui.notify(
      captureRefusalNotice('start', captureAvailabilityOf(ctx.state, active.sessionId)),
    );
    return;
  }

  await ctx.ui.notifyFailure(started.error, { prefix: FAILURE_PREFIX });
}
