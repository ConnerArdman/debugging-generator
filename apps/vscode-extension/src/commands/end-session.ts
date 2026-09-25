/**
 * `debuggen.endSession` — ends the active session and reports its cleanup.
 *
 * ## Contract
 *
 * One HTTP operation, `session.end` (`POST /sessions/:id/end`, body `{}`),
 * answered with `{ cleanup: CleanupStatus }` (AAP §0.4.2). Ending the session
 * runs the service's cleanup: every recorded file modification is restored
 * from its backup and every runtime hook is disabled (AAP §0.5.1). The service
 * then broadcasts `cleanup.completed { sessionId, status, conflicts }`, which
 * `src/extension.ts` routes into `src/state.ts`, so the view's cleanup section
 * keeps showing the status and each conflict after this command returns. This
 * command never mutates the store and keeps no copy of server state.
 *
 * This is the developer-initiated half of the end-of-session guarantee;
 * `deactivate()` in `src/extension.ts` is the automatic half and owns the
 * shutdown ordering (end the session before stopping a spawned service), which
 * is not repeated here. Ending a session is the documented way to remove
 * instrumentation, so it asks for no confirmation.
 *
 * ## Reading the reply
 *
 * The reply carries only the status, so every notice is built from it alone:
 *
 * - `clean` — every modification was reverted.
 * - `pending` — cleanup is still running; `cleanup.completed` brings the result.
 * - `partial` — some files could not be restored; "Open diff" shows which.
 * - `conflict` — a file was edited while instrumented and was left untouched,
 *   its original preserved (AAP §0.5.5). The file names and backup paths are
 *   not in this reply, so "Open diff" reveals the modifications section, where
 *   each record's diff and backup path are shown. None is invented here.
 *
 * When the socket is not `open`, `cleanup.completed` cannot reach this window,
 * so the notice says the final state cannot be shown live until the connection
 * is restored.
 *
 * ## Invariants
 *
 * - Preconditions, then exactly one request: no retry loop, no second call.
 * - A refused `session.end` is rendered once through `CommandUi.notifyFailure`
 *   with the service's hint, states that instrumentation may still be
 *   installed, and offers to try again. A failure is never presented as a clean
 *   cleanup, and nothing here throws for an expected condition.
 * - Privacy (AAP §0.5.2): the log carries the command id and the status value
 *   only — never a file path, diff or backup path.
 * - No hardcoded behaviour (AAP §0.5.4): no application identifier, route path
 *   or question text appears here.
 *
 * @module
 */

import type { CleanupStatus } from '@debuggen/protocol';
import { DebuggenError, assertNever, isErr } from '@debuggen/shared';

import type { CommandContext, CommandId, CommandNotice } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This command's id, checked against the contributed-command vocabulary. */
const END_SESSION_COMMAND = 'debuggen.endSession' satisfies CommandId;

/**
 * The command the "Open diff" action runs: it reveals the modifications
 * section, where each `ModificationRecord.diff` and its backup path are shown.
 */
const SHOW_MODIFICATIONS_COMMAND = 'debuggen.showModifications' satisfies CommandId;

/** The action offered with a partial or conflicted cleanup (AAP §0.5.5). */
const OPEN_DIFF_ACTION = 'Open diff';

/** The action offered when `session.end` was refused. */
const TRY_AGAIN_ACTION = 'Try again';

/**
 * The `prefix` of the one failure notice a refused `session.end` produces. It
 * states the consequence: cleanup did not run, so the project may still carry
 * instrumentation.
 */
const END_FAILURE_PREFIX = 'Could not end the session, so instrumentation may still be installed';

/** The `prefix` used when a follow-up action cannot be dispatched. */
const ACTION_FAILURE_PREFIX = 'Could not run the requested action';

/** Appended to any notice raised while the service socket is not `open`. */
const LIVE_UPDATES_UNAVAILABLE_DETAIL =
  'The final cleanup state cannot be shown live until the connection to the local service is restored.';

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** Joins the optional parts of a notice's detail, or `undefined` when none. */
function joinDetail(...parts: readonly (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part !== '');
  return present.length === 0 ? undefined : present.join(' ');
}

/**
 * The single notice for a successful `session.end`.
 *
 * @param status The cleanup status the service answered.
 * @param live Whether the service socket is `open`, so `cleanup.completed`
 *   will reach the view.
 */
function noticeFor(status: CleanupStatus, live: boolean): CommandNotice {
  const liveDetail = live ? undefined : LIVE_UPDATES_UNAVAILABLE_DETAIL;
  switch (status) {
    case 'clean':
      return {
        level: live ? 'info' : 'warning',
        message: 'Session ended. Every file modification was reverted.',
        detail: liveDetail,
      };
    case 'pending':
      return {
        level: live ? 'info' : 'warning',
        message: 'Session ended. Cleanup is still running.',
        detail: joinDetail(
          'The Debug Generator view shows the result when cleanup completes.',
          liveDetail,
        ),
      };
    case 'partial':
      return {
        level: 'warning',
        message: 'Session ended, but some files could not be restored.',
        detail: joinDetail(
          'Their originals are preserved; open the diff to see each modification.',
          liveDetail,
        ),
        actions: [OPEN_DIFF_ACTION],
      };
    case 'conflict':
      return {
        level: 'warning',
        message:
          'A file was edited while instrumented. Debug Generator will not overwrite it; the original is preserved.',
        detail: joinDetail(
          'Open the diff to see each modification and where its original is saved.',
          liveDetail,
        ),
        actions: [OPEN_DIFF_ACTION],
      };
    default:
      return assertNever(status, 'Unhandled cleanup status');
  }
}

/**
 * Runs a follow-up command. The target command reports its own failures, so
 * only a failure to dispatch it is reported here, once.
 */
async function runFollowUp(ctx: CommandContext, command: CommandId): Promise<void> {
  try {
    await ctx.ui.executeCommand(command);
  } catch (error) {
    await ctx.ui.notifyFailure(DebuggenError.from(error), { prefix: ACTION_FAILURE_PREFIX });
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `debuggen.endSession`: ends the active session, which removes its
 * instrumentation, and reports the cleanup status the service answered.
 *
 * Resolves after the developer has answered or dismissed any notice that
 * offers an action. It never rejects for an expected condition.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param args Whatever VS Code invoked the command with, such as a view or
 *   menu context. The command takes no arguments and ignores them. The session
 *   to end is always the active session.
 */
export async function endSession(ctx: CommandContext, ...args: readonly unknown[]): Promise<void> {
  void args;

  const active = ctx.guards.requireActiveSession();
  if (!active) {
    return;
  }

  ctx.logger.info('Session end requested', { command: END_SESSION_COMMAND });
  const ended = await ctx.client.endSession(active.sessionId);
  if (isErr(ended)) {
    const choice = await ctx.ui.notifyFailure(ended.error, {
      prefix: END_FAILURE_PREFIX,
      actions: [TRY_AGAIN_ACTION],
    });
    if (choice === TRY_AGAIN_ACTION) {
      await runFollowUp(ctx, END_SESSION_COMMAND);
    }
    return;
  }

  const status = ended.value.cleanup;
  ctx.logger.info('Session ended', { command: END_SESSION_COMMAND, cleanup: status });

  const notice = noticeFor(status, ctx.client.state === 'open');
  const choice = await ctx.ui.notify(notice);
  if (choice === OPEN_DIFF_ACTION) {
    await runFollowUp(ctx, SHOW_MODIFICATIONS_COMMAND);
  }
}
