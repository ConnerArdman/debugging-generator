/**
 * `debuggen.showModifications` — reveals the Debug Generator view's file
 * modifications section, records the first page of the active session's
 * modification journal in the store and reports how many records the journal
 * holds (AAP §0.4.2, §0.5.1, §0.7.3).
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
 *    the route, the credential and the response schema — sent to the session's
 *    owning endpoint (`ExtensionState.activeSessionEndpoint`), which is where
 *    the journal lives even after `debuggen.serviceUrl` has changed. It asks
 *    for the service's default window: one page, which the service bounds to
 *    `MODIFICATIONS_PAGE_DEFAULT_LIMIT` records and
 *    `MODIFICATIONS_PAGE_DIFF_BUDGET` (6 MiB) of UTF-8 diff text, however large
 *    the journal's diffs are.
 * 4. **Into the store** — the page's records are projected through
 *    `ExtensionState.applyModificationJournal`, so the section just revealed
 *    lists them with their status, diff and backup path even while no
 *    `session.updated` can reach this window (the socket is closed).
 * 5. **One notice** — the failure with the service's hint, that no file was
 *    patched, or how many records the journal holds: its `total`, never the
 *    page's length.
 *
 * ## Why one page
 *
 * The records normally reach the view without this command: `ModificationsList`
 * and `DiffView` render the journal from the whole records that reach the host
 * through `session.updated` (`applySessionRecord`) and `instrumentation.ready`
 * (`applyInstrumentationReady`). This read is the fallback for a window no
 * broadcast reaches, and the journal's size is the page's `total`, so the
 * command never walks further pages: one bounded page is all it transfers.
 *
 * ## What it deliberately does not do
 *
 * - **It keeps no copy and forges no frame.** The journal is written into the
 *   store through the one mutator declared for exactly this answer, whose
 *   merge rules keep it append-only, in applied order, and never let an answer
 *   move a record's status back. It is not re-shaped into a `session.updated`
 *   or `instrumentation.ready` payload — the latter also replaces the
 *   runtime-hook list and clears an instrumentation failure — and nothing is
 *   held here, so the view has a single source of truth.
 * - **It renders nothing.** File names, status badges, diffs and the preserved
 *   original's backup path are `ModificationsList`'s and `DiffView`'s to show.
 * - **It logs no content.** A diff carries the developer's own source and a
 *   record names their files and the backup directory; the command reads
 *   neither, and its only log line carries the journal's total.
 * - **It never presents a failure as an empty journal.** A failed request is
 *   reported as a failure, and the view keeps the list the last broadcast
 *   provided.
 *
 * Arguments VS Code passes — from a notification action, a tree item or an
 * `executeCommand` caller — are ignored: the command always acts on the active
 * session, so no caller can point it at a session the developer is not viewing.
 */

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

/** Where a non-empty journal's records are shown, and what each row carries. */
const JOURNAL_LISTED_DETAIL =
  'Each one is listed under File modifications with its status and the exact diff that was applied.';

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

/**
 * The one notice that reports a successfully loaded journal page: that the
 * journal is empty, or how many records it holds as the page's `total` reports
 * it — the whole journal's length, never the number of records this one page
 * carries. A follow-up can layer a second record onto a file an earlier plan
 * version already instrumented, so the number is of modifications, not of
 * distinct files.
 *
 * @example
 * ```ts
 * describeJournal(3).message; // '3 file modifications are recorded for this session.'
 * ```
 *
 * @param total The journal's `total`, as the page reported it.
 * @returns The informational notice to show.
 */
function describeJournal(total: number): CommandNotice {
  if (total === 0) {
    return NO_MODIFICATIONS_NOTICE;
  }
  const message =
    total === 1
      ? '1 file modification is recorded for this session.'
      : `${String(total)} file modifications are recorded for this session.`;
  return { level: 'info', message, detail: JOURNAL_LISTED_DETAIL };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Runs `debuggen.showModifications`: reveals the modifications section, fetches
 * the active session's journal once from its owning service, records it in the
 * store and reports the outcome in exactly one notice. Expected failures are
 * rendered and the promise still resolves; only a genuinely unexpected throw
 * reaches the barrel's wrapper.
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

  // The journal lives in the service that owns the session, which is not
  // necessarily the one `debuggen.serviceUrl` names now.
  const page = await ctx.client.getModifications(active.sessionId, undefined, {
    endpoint: ctx.state.activeSessionEndpoint,
  });
  if (isErr(page)) {
    await ctx.ui.notifyFailure(page.error, { prefix: LOAD_FAILURE_PREFIX });
    return;
  }

  // Into the store, so the section the view just revealed lists it even when
  // no `session.updated` can reach this window.
  const projected = ctx.state.applyModificationJournal(active.sessionId, page.value.modifications);
  ctx.logger.debug('Modifications refreshed', {
    command: COMMAND_ID,
    count: page.value.total,
    listed: page.value.modifications.length,
    projected,
  });
  await ctx.ui.notify(describeJournal(page.value.total));
}
