/**
 * `debuggen.showModifications` — reveals the Debug Generator view's file
 * modifications section, reads the active session's whole modification
 * journal into the store and reports how many records it holds.
 *
 * ## Why the command exists
 *
 * Every file the tool patches is journaled before it is written — both hashes,
 * the backup path, the unified diff and a status of `pending`, `applied`,
 * `reverted`, `conflict` or `failed` — and the developer must be able to see
 * that journal at any moment of the session and after it (AAP §0.5.1). The
 * view's `ModificationsList` renders it, one row per record with a `DiffView`;
 * this command is how the developer gets there from the Command Palette, the
 * "Open diff" destination the conflict notice points at when a file was edited
 * while instrumented, and what the view's "Load all modifications" control runs
 * (the `loadModifications` request). Records normally reach the view through
 * `session.updated` and `instrumentation.ready`; this read completes the list
 * when no broadcast reaches the window or the view knows records are missing.
 *
 * ## Sequence
 *
 * 1. **Precondition** — an active session. The guard explains how to start one
 *    when there is none, so the command simply returns.
 * 2. **Reveal and focus** — the `debuggen.session` view is revealed and asked
 *    to move focus to its modifications section *before* the request, so the
 *    section is on screen while the answer is in flight.
 * 3. **The journal, page by page** — `modifications.list`
 *    (`GET /sessions/:id/modifications`) through `readModificationJournal`,
 *    which walks the pages along `nextOffset` at the session's owning endpoint
 *    (`ExtensionState.activeSessionEndpoint`), where the journal lives even
 *    after `debuggen.serviceUrl` has changed. The service bounds each page by
 *    count and by `MODIFICATIONS_PAGE_DIFF_BUDGET` (6 MiB) of UTF-8 diff text,
 *    so a journal with large diffs spans several pages; an ordinary one is a
 *    single request.
 * 4. **Into the store, once** — every gathered record and the journal's
 *    `total` go through `ExtensionState.applyModificationJournal` after the
 *    last page: that merge puts the answer's records first, so applying page
 *    by page would reorder the list. The section just revealed then lists each
 *    record with its status, diff and backup path, and compares its length
 *    with `total`.
 * 5. **One notice** — the failure with the service's hint when the first page
 *    failed; otherwise it compares the records the view now lists with the
 *    largest count known for the session (the store keeps the largest `total`
 *    any read reported, because the journal only grows and two reads can
 *    finish in either order). All listed: that no file was patched, or how
 *    many records the journal holds, never a page's length. Some missing: a
 *    warning stating how many of that count are listed, why when a failure
 *    ended this read, and that running the command again, or "Load all
 *    modifications", loads the rest.
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
 *   neither, and its only log line carries counts — the journal's total, the
 *   records listed, the pages read — whether the walk completed, and the
 *   failure's code.
 * - **It never presents a failure as an empty journal, nor part of a journal
 *   as all of it.** A failed first page is reported as a failure, and the view
 *   keeps the list the last broadcast provided; a walk that stopped early
 *   records what it loaded and is reported as incomplete.
 *
 * Arguments VS Code passes — from a notification action, a tree item or an
 * `executeCommand` caller — are ignored: the command always acts on the active
 * session, so no caller can point it at a session the developer is not viewing.
 */

import { isErr } from '@debuggen/shared';

import { readModificationJournal } from '../service/client';
import type { ModificationJournalRead } from '../service/client';
import type { FocusSection } from '../views/session-view-provider';

import type { CommandContext, CommandId, CommandNotice, SESSION_VIEW_FOCUS_COMMAND } from './index';

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

/** How the rest of a journal whose read stopped early is loaded. */
const LOAD_REST_DETAIL =
  'Run "Debug Generator: Show File Modifications" again, or choose "Load all modifications" under File modifications, to load the rest.';

/**
 * The one notice that reports a journal read to its end: that the journal is
 * empty, or how many records it holds as its `total` reports it — the whole
 * journal's length, never the number of records one page carried. A follow-up
 * can layer a second record onto a file an earlier plan version already
 * instrumented, so the number is of modifications, not of distinct files.
 *
 * @example
 * ```ts
 * describeJournal(3).message; // '3 file modifications are recorded for this session.'
 * ```
 *
 * @param total The journal's `total`, as the last page reported it.
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

/**
 * `text` trimmed and ending in sentence punctuation, or `undefined` when blank,
 * so a failure message the transport words without a full stop joins the
 * sentences around it.
 */
function asSentence(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed === '') {
    return undefined;
  }
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The one notice that reports a journal the view still lists only in part:
 * how many of the journal's records the list holds, why the read stopped when
 * a failure ended it (its message and hint), and how to load the rest. The
 * records that were loaded are in the store, so the list shows them together
 * with the shortfall.
 *
 * @example
 * ```ts
 * describeIncompleteJournal(2, 5, read.failure).message; // 'Loaded 2 of 5 file modifications recorded for this session.'
 * ```
 *
 * @param listed How many records the list now holds.
 * @param total The largest count of the journal known for the session.
 * @param failure What ended the read early, when a failure did.
 * @returns The warning to show.
 */
function describeIncompleteJournal(
  listed: number,
  total: number,
  failure: ModificationJournalRead['failure'],
): CommandNotice {
  const noun = total === 1 ? 'file modification' : 'file modifications';
  const message = `Loaded ${String(listed)} of ${String(total)} ${noun} recorded for this session.`;
  const detail = [asSentence(failure?.message), asSentence(failure?.hint)]
    .filter((part): part is string => part !== undefined)
    .concat(LOAD_REST_DETAIL)
    .join(' ');
  return { level: 'warning', message, detail };
}

/**
 * Runs `debuggen.showModifications`: reveals the modifications section, reads
 * the active session's journal page by page from its owning service, records
 * every gathered record and the journal's total in the store in one call and
 * reports the outcome in exactly one notice. Expected failures are rendered and
 * the promise still resolves; only a genuinely unexpected throw reaches the
 * barrel's wrapper.
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
  const read = await readModificationJournal(ctx.client, active.sessionId, {
    endpoint: ctx.state.activeSessionEndpoint,
  });
  if (isErr(read)) {
    await ctx.ui.notifyFailure(read.error, { prefix: LOAD_FAILURE_PREFIX });
    return;
  }

  // Into the store once, after the last page, so the section the view just
  // revealed lists every gathered record in journal order next to the total.
  const journal = read.value;
  const projected = ctx.state.applyModificationJournal(
    active.sessionId,
    journal.modifications,
    journal.total,
  );

  // The notice states what the view now lists against the largest count known
  // for the session, not this read's alone: two reads can overlap and finish
  // in either order, so a read that completed can still predate records a
  // newer read counted (the journal only grows), and pushes may have
  // delivered records this read did not list. For a session no longer in view
  // the store keeps nothing of the answer, so the read speaks for itself.
  const listed = projected ? ctx.state.modifications.length : journal.modifications.length;
  const counted = projected
    ? Math.max(journal.total, ctx.state.modificationsTotal ?? 0, listed)
    : journal.total;
  const complete = projected ? listed >= counted : journal.complete;
  const counts = {
    command: COMMAND_ID,
    count: counted,
    listed,
    loaded: journal.modifications.length,
    pages: journal.pages,
    complete,
    projected,
  };
  if (complete) {
    ctx.logger.debug('Modifications refreshed', counts);
    await ctx.ui.notify(describeJournal(counted));
    return;
  }
  ctx.logger.warn('Modification journal read stopped before its end', {
    ...counts,
    ...(journal.failure === undefined ? {} : { code: journal.failure.code }),
  });
  await ctx.ui.notify(describeIncompleteJournal(listed, counted, journal.failure));
}
