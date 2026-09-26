/**
 * `debuggen.purgeSessions` — **Debug Generator: Purge Stored Sessions**.
 *
 * The on-demand face of the local service's retention sweep
 * (`apps/local-service/src/store/retention.ts`, AAP §0.4.2 "Session
 * persistence"): sessions whose last activity is older than
 * `DEBUGGEN_RETENTION_DAYS` (30 days by default, AAP §0.3.4) are deleted with
 * everything scoped to them — progress, plans, the modification journal,
 * captures and their telemetry, panels, analyses, follow-ups, the tab binding —
 * and with their backup directories; code-index caches of projects not opened
 * inside the same window go too, and so do backup files no journal row
 * references once they are older than the seven-day grace. A session whose
 * journal still holds an unresolved conflict is kept, together with its
 * backups, until the developer resolves it (AAP §0.5.1). All of it lives under
 * `$DEBUGGEN_HOME`, outside every project, so the sweep never touches a
 * working tree.
 *
 * The service runs that sweep as it starts and, through the protocol's
 * `session.purge` operation (`POST /sessions/purge`, editor credential only),
 * whenever this command asks — reached through `ServiceClient.purgeSessions`
 * by operation id, never a hand-written path. The window is the service's
 * configuration; the request body is `{}` and cannot shorten it.
 *
 * ## The flow
 *
 * 1. **Confirm first.** One modal ({@link PURGE_SESSIONS_CONFIRMATION}) states
 *    the policy before anything is deleted. Dismissing it ends the command
 *    silently: no request, no notice.
 * 2. **Exactly one request**, never retried here.
 * 3. **One message per outcome.**
 *    - Failure: one error notice, {@link PURGE_FAILURE_PREFIX} plus the
 *      service's own message and hint. The command does not claim on its own
 *      that nothing was deleted: a request that timed out may have been
 *      served.
 *    - Success: one notice built only from the report's counts — what went,
 *      the sessions a conflict kept (by id, a handful at most, with how many
 *      more exist) and how many items the sweep had to step over. A report
 *      with skipped items is a `warning`, because it is not a complete purge;
 *      otherwise it is `info`. "Nothing to purge: no session is older than
 *      the retention window." is said only when every deletion count, the
 *      kept total and the issue count are all zero: a skipped item can be an
 *      aged session the sweep could not examine, so a sweep that only skipped
 *      items says that instead.
 * 4. **Refresh the Sessions tree on every outcome.** The tree lists what the
 *    service stores, and a failed reply (a timeout mid-sweep) can hide
 *    deletions as well as a successful one reports them. A refresh failure
 *    renders as the tree's own failure row, never as a second notice, and is
 *    logged here.
 *
 * ## Invariants
 *
 * - **Never a deletion outside the service.** No filesystem access, no
 *   retention arithmetic and no second copy of the sweep's rules: duplicating
 *   them here would put a second, weaker implementation of "never destroy the
 *   only copy of a developer's original file" beside the hardened one.
 * - **No session state is reset.** Only aged sessions are purged and the
 *   active session is by definition recent, so the store's session fields are
 *   left alone; the tree refresh reconciles the list.
 * - **Never a throw** for an expected condition. Every outcome is rendered
 *   here; the registration wrapper in `./index.ts` is only the last line of
 *   defence against the unexpected.
 * - **Privacy.** The single log record carries the command id and either the
 *   report's counts or the error code — never a session id, a session
 *   question, a project path, a backup path or telemetry content. Session ids
 *   appear only in the notice, where they tell the developer which sessions
 *   were kept.
 * - **Import boundary.** `@debuggen/shared`, protocol types, and types from
 *   `./index` only; this module imports nothing at runtime from the barrel,
 *   which keeps the command folder acyclic.
 *
 * @example
 * ```ts
 * // src/commands/index.ts maps the id to this function:
 * 'debuggen.purgeSessions': (...args) => purgeSessions(ctx, ...args),
 * ```
 */

import type { SessionPurgeResponse } from '@debuggen/protocol';
import { DebuggenError, isErr } from '@debuggen/shared';

import type { CommandContext, CommandId, CommandNotice, DestructiveConfirmation } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This module's command id, checked against the contributed id table. */
const COMMAND_ID = 'debuggen.purgeSessions' satisfies CommandId;

/** What was being attempted: the prefix of the one failure headline. */
export const PURGE_FAILURE_PREFIX = 'Could not purge stored sessions';

/**
 * The most retained session ids the notice names. The service lists up to
 * `SESSION_PURGE_MAX_REPORTED_SESSIONS`; a notification is not the place to
 * read a hundred ids, so the rest are counted instead.
 */
export const MAX_LISTED_RETAINED_SESSIONS = 5;

/**
 * The modal shown before the request. The window is named by its
 * configuration variable, with the documented default given as a default —
 * the service's configured value governs, and this module never behaves as if
 * it were fixed.
 */
export const PURGE_SESSIONS_CONFIRMATION: DestructiveConfirmation = Object.freeze({
  message: 'Purge stored Debug Generator sessions?',
  detail:
    'Sessions inactive for longer than the retention window (DEBUGGEN_RETENTION_DAYS, 30 days by default) are deleted ' +
    'with their telemetry, panels, analyses and backups. Stale code-index caches and orphan backups older than 7 days are removed. ' +
    'Sessions holding an unresolved conflict backup are kept. Everything purged lives under $DEBUGGEN_HOME, never in your project.',
  confirmLabel: 'Purge sessions',
});

/** Formats counts for display, for example `1,234`. */
const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

/** `1 panel`, `2 panels`, `1,234 panels`. */
function quantity(count: number, singular: string, plural: string): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? singular : plural}`;
}

/** `a`, `a and b`, `a, b and c`. */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/**
 * The non-zero tallies among `entries`, each as a quantity phrase, in order.
 *
 * @param entries `[count, singular, plural]` triples.
 */
function nonZero(entries: readonly (readonly [number, string, string])[]): string[] {
  return entries
    .filter(([count]) => count > 0)
    .map(([count, singular, plural]) => quantity(count, singular, plural));
}

/**
 * What deleted sessions held, as `[count, singular, plural]` triples in
 * display order: their telemetry, panels, analyses, journal records and
 * backup directories.
 *
 * @param report The service's purge report.
 */
function heldTallies(report: SessionPurgeResponse): readonly (readonly [number, string, string])[] {
  return [
    [report.telemetryEventsDeleted, 'telemetry event', 'telemetry events'],
    [report.panelsDeleted, 'panel', 'panels'],
    [report.analysesDeleted, 'analysis', 'analyses'],
    [report.modificationsDeleted, 'modification record', 'modification records'],
    [report.backupDirsDeleted, 'backup directory', 'backup directories'],
  ];
}

/**
 * Whether the sweep's only outcome was items it stepped over: nothing deleted
 * by any rule, nothing kept for a conflict, and at least one issue. A skipped
 * item can be an aged session the sweep could not examine (an open
 * modification record, a failed candidate scan), so such a report must never
 * read as "nothing is old enough".
 *
 * @param report The service's purge report.
 */
function onlySkipped(report: SessionPurgeResponse): boolean {
  const deletions = [
    report.sessionsDeleted,
    report.telemetryEventsDeleted,
    report.panelsDeleted,
    report.analysesDeleted,
    report.modificationsDeleted,
    report.backupDirsDeleted,
    report.orphanBackupsDeleted,
    report.indexCachesDeleted,
  ];
  return (
    report.issueCount > 0 &&
    report.sessionsRetainedForConflictsTotal === 0 &&
    deletions.every((count) => count === 0)
  );
}

/**
 * The headline of a sweep that only skipped items. It states the count and
 * where the items are named, and claims nothing about the sessions' age.
 *
 * @param issueCount The report's non-zero issue count.
 */
function skippedOnlyHeadline(issueCount: number): string {
  const items = quantity(issueCount, 'item', 'items');
  const pronoun = issueCount === 1 ? 'it' : 'them';
  return `No sessions were purged: the sweep skipped ${items} it could not examine; the Debug Generator service log lists ${pronoun}.`;
}

/**
 * The headline: what the sweep deleted, from the report's counts alone.
 *
 * Deleted sessions come first with what they held; the housekeeping rules —
 * index caches, orphan backups, and, when no session went, backup directories
 * and any other rows removed — follow. With nothing removed the headline says
 * so, and "no session is older than the retention window" is claimed only by
 * a sweep that kept nothing for a conflict and skipped nothing.
 *
 * @param report The service's purge report.
 */
function purgeHeadline(report: SessionPurgeResponse): string {
  const housekeeping = nonZero([
    [report.indexCachesDeleted, 'index cache', 'index caches'],
    [report.orphanBackupsDeleted, 'orphan backup', 'orphan backups'],
    // Deleted sessions account for what they held; without one, a removed
    // directory is one the orphan rule left empty, and any other removed row
    // is still counted rather than hidden behind "nothing to purge".
    ...(report.sessionsDeleted === 0 ? heldTallies(report) : []),
  ]);
  const removed = housekeeping.length === 0 ? '' : `; removed ${joinList(housekeeping)}`;

  if (report.sessionsDeleted > 0) {
    const held = nonZero(heldTallies(report));
    const sessions = quantity(report.sessionsDeleted, 'session', 'sessions');
    const contents = held.length === 0 ? '' : ` (${held.join(', ')})`;
    return `Purged ${sessions}${contents}${removed}.`;
  }

  // A kept session is aged by definition, and a skipped item may be one.
  const agedMayRemain = report.sessionsRetainedForConflictsTotal > 0 || report.issueCount > 0;
  if (housekeeping.length > 0) {
    return `${agedMayRemain ? 'No session was purged' : 'No session is older than the retention window'}${removed}.`;
  }
  if (report.sessionsRetainedForConflictsTotal > 0) {
    return 'Nothing was purged.';
  }
  if (onlySkipped(report)) {
    return skippedOnlyHeadline(report.issueCount);
  }
  return 'Nothing to purge: no session is older than the retention window.';
}

/**
 * The sentence naming the sessions a conflict kept, or `undefined` when none
 * was. At most {@link MAX_LISTED_RETAINED_SESSIONS} ids are named; the rest —
 * whether the service listed them or truncated its own list — are counted from
 * the report's total.
 *
 * @param report The service's purge report.
 */
function retainedSentence(report: SessionPurgeResponse): string | undefined {
  const total = report.sessionsRetainedForConflictsTotal;
  if (total === 0) {
    return undefined;
  }
  const named = report.sessionsRetainedForConflicts.slice(0, MAX_LISTED_RETAINED_SESSIONS);
  const more = total - named.length;
  const ids =
    named.length === 0
      ? ''
      : `: ${named.join(', ')}${more > 0 ? `, and ${COUNT_FORMAT.format(more)} more` : ''}`;
  const kept =
    total === 1 ? '1 session was kept' : `${COUNT_FORMAT.format(total)} sessions were kept`;
  return `${kept} because a file conflict is unresolved${ids}. Their backups stay until the conflict is resolved.`;
}

/**
 * The sentence counting the items the sweep stepped over, or `undefined`.
 * Their detail stays in the service log, which is where the notice points.
 *
 * @param report The service's purge report.
 */
function issuesSentence(report: SessionPurgeResponse): string | undefined {
  const count = report.issueCount;
  if (count === 0) {
    return undefined;
  }
  return count === 1
    ? '1 item could not be purged and was skipped; the service log names it.'
    : `${COUNT_FORMAT.format(count)} items could not be purged and were skipped; the service log names them.`;
}

/**
 * The single success notice, built only from the report.
 *
 * @param report The service's purge report.
 */
function purgedNotice(report: SessionPurgeResponse): CommandNotice {
  // A sweep that only skipped items already counts them in its headline.
  const issues = onlySkipped(report) ? undefined : issuesSentence(report);
  const detail = [retainedSentence(report), issues]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  return {
    level: report.issueCount > 0 ? 'warning' : 'info',
    message: purgeHeadline(report),
    detail: detail === '' ? undefined : detail,
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Re-lists the stored sessions. `SessionsTreeProvider.refresh` renders its own
 * failure as a tree row and does not throw by contract; the `catch` keeps this
 * command from rejecting even if it did, and records the fact by code only.
 *
 * @param ctx The resolved command context.
 */
async function refreshSessionsTree(ctx: CommandContext): Promise<void> {
  try {
    await ctx.sessionsTree.refresh();
  } catch (thrown) {
    ctx.logger.warn('The Sessions tree could not be refreshed after a purge', {
      command: COMMAND_ID,
      code: DebuggenError.from(thrown).code,
    });
  }
}

/**
 * Runs `debuggen.purgeSessions`.
 *
 * Asks for confirmation, runs the service's retention sweep with one
 * `session.purge` request, reports the outcome once — the service's failure,
 * or a notice built from the sweep's counts — and refreshes the Sessions tree.
 * Resolves once the tree has been refreshed; it never rejects for an expected
 * condition.
 *
 * @param ctx The resolved command context.
 * @param args Whatever VS Code passed — nothing from the Command Palette, a
 *   tree node from a view menu. The command takes no argument, so none is read.
 */
export async function purgeSessions(
  ctx: CommandContext,
  ...args: readonly unknown[]
): Promise<void> {
  // The registration signature forwards every argument; the purge reads none.
  void args;

  if (!(await ctx.ui.confirmDestructive(PURGE_SESSIONS_CONFIRMATION))) {
    ctx.logger.debug('Retention purge cancelled', { command: COMMAND_ID });
    return;
  }

  const purged = await ctx.client.purgeSessions();
  if (isErr(purged)) {
    ctx.logger.warn('Retention purge failed', { command: COMMAND_ID, code: purged.error.code });
    await ctx.ui.notifyFailure(purged.error, { prefix: PURGE_FAILURE_PREFIX });
    await refreshSessionsTree(ctx);
    return;
  }

  const report = purged.value;
  // Counts only: the retained session ids stay out of the log.
  ctx.logger.warn('Retention purge completed', {
    command: COMMAND_ID,
    cutoff: report.cutoff,
    sessionsDeleted: report.sessionsDeleted,
    telemetryEventsDeleted: report.telemetryEventsDeleted,
    panelsDeleted: report.panelsDeleted,
    analysesDeleted: report.analysesDeleted,
    modificationsDeleted: report.modificationsDeleted,
    backupDirsDeleted: report.backupDirsDeleted,
    orphanBackupsDeleted: report.orphanBackupsDeleted,
    indexCachesDeleted: report.indexCachesDeleted,
    sessionsRetainedForConflictsTotal: report.sessionsRetainedForConflictsTotal,
    issueCount: report.issueCount,
    durationMs: report.durationMs,
  });

  await ctx.ui.notify(purgedNotice(report));
  await refreshSessionsTree(ctx);
}
