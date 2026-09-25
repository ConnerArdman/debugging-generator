/**
 * `debuggen.showModifications` — reveals the Debug Generator view's file
 * modifications section and re-reads the active session's modification journal
 * from the service (AAP §0.4.2, §0.5.1, §0.7.3).
 *
 * ## Why the command exists
 *
 * Every file the tool patches is journaled before it is written — both hashes,
 * the backup path, the unified diff and a status of `pending`, `applied`,
 * `reverted`, `conflict` or `failed` — and the developer must be able to see
 * that journal at any moment of the session and after it (AAP §0.5.1). The
 * view's `ModificationsList` renders it, one row per record with a `DiffView`;
 * this command is how the developer gets there from the Command Palette, and it
 * is the "Open diff" destination that the conflict notice points at when a file
 * was edited while instrumented (AAP §0.5.5).
 *
 * ## Sequence
 *
 * 1. **Precondition** — an active session. The guard explains how to start one
 *    when there is none, so the command simply returns.
 * 2. **Reveal and focus** — the `debuggen.session` view is revealed and asked
 *    to move focus to its modifications section *before* the request, so the
 *    section is on screen while the answer is in flight.
 * 3. **One HTTP operation** — `modifications.list`
 *    (`GET /sessions/:id/modifications`) through `ServiceClient`, which owns
 *    the route, the credential and the response schema.
 * 4. **One notice** — the failure with the service's hint, that no file was
 *    patched, or how many records the journal holds.
 *
 * ## What it deliberately does not do
 *
 * - **It does not write the store.** `src/state.ts` declares no mutator that
 *   accepts a modification list. The journal reaches the view through
 *   `session.updated` (`applySessionRecord`) and `instrumentation.ready`
 *   (`applyInstrumentationReady`), whose merge rules keep it append-only and in
 *   applied order. Re-shaping the HTTP answer into either payload would forge
 *   a broadcast — `instrumentation.ready` also replaces the runtime-hook list
 *   and clears an instrumentation failure — and a private copy here would give
 *   the view a second source of truth. The fetched journal is therefore
 *   reported, never stored.
 * - **It renders nothing.** File names, status badges, diffs and the preserved
 *   original's backup path are `ModificationsList`'s and `DiffView`'s to show.
 * - **It logs no content.** A diff carries the developer's own source and a
 *   record names their files and the backup directory, so the only log line is
 *   a count.
 * - **It never presents a failure as an empty journal.** A failed request is
 *   reported as a failure, and the view keeps the list the last broadcast
 *   provided.
 *
 * Arguments VS Code passes — from a notification action, a tree item or an
 * `executeCommand` caller — are ignored: the command always acts on the active
 * session, so no caller can point it at a session the developer is not viewing.
 */

import type { ModificationRecord } from '@debuggen/protocol';
import { isErr } from '@debuggen/shared';

import type { FocusSection } from '../views/session-view-provider';

import type { CommandContext, CommandId, CommandNotice, SESSION_VIEW_FOCUS_COMMAND } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This command's id, typed against `COMMAND_IDS`; used only as a log field. */
const COMMAND_ID: CommandId = 'debuggen.showModifications';

/**
 * The auto-generated command that reveals and focuses the `debuggen.session`
 * webview view.
 *
 * The barrel imports this module at runtime, so importing its
 * `SESSION_VIEW_FOCUS_COMMAND` value back would close an import cycle; the
 * command modules import types only from `./index`. The annotation keeps this
 * literal in lockstep with the barrel's constant: renaming the view id changes
 * that constant's type and makes this line a compile error.
 */
const REVEAL_SESSION_VIEW: typeof SESSION_VIEW_FOCUS_COMMAND = 'debuggen.session.focus';

/** The view section this command lands on, from the `focus` message vocabulary. */
const MODIFICATIONS_SECTION: FocusSection = 'modifications';

/** What the failure headline says was being attempted. */
const LOAD_FAILURE_PREFIX = 'Could not load file modifications';

/**
 * Shown when the journal is empty. An empty journal is a positive signal worth
 * stating: runtime hooks are the default, and a source file is patched only to
 * time a named function the plan selected (AAP §0.5.1).
 */
const NO_MODIFICATIONS_NOTICE: CommandNotice = Object.freeze({
  level: 'info',
  message: 'No files were modified for this session.',
  detail:
    'Debug Generator patches a source file only to time a named function; every other signal comes from runtime hooks.',
});

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

/**
 * The one notice that reports a successfully fetched journal: that it is
 * empty, or how many records it holds. A follow-up can layer a second record
 * onto a file an earlier plan version already instrumented, so the count is of
 * modifications, not of distinct files. No file name, status or diff is read.
 *
 * @param records The journal as `GET /sessions/:id/modifications` returned it.
 * @returns The informational notice to show.
 */
function describeJournal(records: readonly ModificationRecord[]): CommandNotice {
  const count = records.length;
  if (count === 0) {
    return NO_MODIFICATIONS_NOTICE;
  }
  return {
    level: 'info',
    message:
      count === 1
        ? '1 file modification is recorded for this session.'
        : `${String(count)} file modifications are recorded for this session.`,
    detail:
      'Each one is listed under File modifications with its status and the exact diff that was applied.',
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Runs `debuggen.showModifications`: reveals the modifications section, fetches
 * the active session's journal once and reports the outcome in exactly one
 * notice. Expected failures are rendered and the promise still resolves; only a
 * genuinely unexpected throw reaches the barrel's wrapper.
 *
 * @param ctx The command context `registerCommands` resolved.
 * @param args Whatever the invoker passed; ignored (see the module notes).
 */
export async function showModifications(
  ctx: CommandContext,
  ...args: readonly unknown[]
): Promise<void> {
  // Deliberately discarded: the command acts on the active session only, so no
  // invoker-supplied value can redirect it. The rest parameter exists because
  // the barrel forwards every handler's arguments unchanged.
  void args;

  const active = ctx.guards.requireActiveSession();
  if (active === undefined) {
    return;
  }

  await ctx.ui.executeCommand(REVEAL_SESSION_VIEW);
  ctx.sessionView.postFocus(MODIFICATIONS_SECTION);

  const records = await ctx.client.getModifications(active.sessionId);
  if (isErr(records)) {
    await ctx.ui.notifyFailure(records.error, { prefix: LOAD_FAILURE_PREFIX });
    return;
  }

  ctx.logger.debug('Modifications refreshed', {
    command: COMMAND_ID,
    count: records.value.length,
  });
  await ctx.ui.notify(describeJournal(records.value));
}
