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
 * ## What the running service offers
 *
 * The sweep belongs to the service, and the service owns every rule it
 * applies: containment under `$DEBUGGEN_HOME` re-asserted before each
 * deletion, `lstat` with no link following, the orphan grace window and the
 * conflict exemption. An extension may therefore reach it only through an
 * operation the protocol declares. The service's HTTP surface — `HTTP_ROUTES`
 * and `HTTP_OPERATIONS` in `@debuggen/protocol` — declares no purge or
 * retention operation: the sweep runs on every service start
 * (`apps/local-service/src/main.ts`, before the service accepts a client) and
 * has no HTTP route. `ServiceClient.request` (`../service/client`) can reach
 * only declared operations, and a hand-written path, method or `fetch` would be
 * exactly the second, unvalidated definition of the HTTP surface that AAP
 * §0.2.3 forbids.
 *
 * So this command performs no request and deletes nothing. It answers with one
 * typed {@link DebuggenError} (`NOT_IMPLEMENTED`, the code for "a path
 * deliberately not built"), rendered once through `CommandUi.notifyFailure`
 * (`./index`): the headline says the purge did not happen and nothing was
 * deleted, and the hint states the retention policy the service already
 * applies at each start, including the conflict exemption — the fact a
 * developer needs before deleting anything by hand.
 *
 * ## Invariants
 *
 * - **Never a deletion outside the service.** No filesystem access, no
 *   retention arithmetic and no second copy of the sweep's rules: duplicating
 *   them here would put a second, weaker implementation of "never destroy the
 *   only copy of a developer's original file" beside the hardened one.
 * - **No destructive confirmation for a deletion that cannot happen.** The
 *   folder's destructive-command rule — `confirmDestructive` before the request
 *   — guards the request; with no request to guard, a modal asking the
 *   developer to approve a purge would misrepresent what the command does and
 *   turn one outcome into two interactions.
 * - **One outcome, one message, never presented as success.** A failure never
 *   reads as a completed purge, and the Sessions tree is not refreshed, because
 *   nothing it lists has changed.
 * - **Never a throw.** Every outcome is rendered here; the registration
 *   wrapper in `./index.ts` is only the last line of defence against the
 *   unexpected.
 * - **Privacy.** The single log record carries the command id, the error code
 *   and how many arguments the invocation passed — never an argument's value,
 *   a session question, a project path, a backup path or telemetry content.
 * - **Import boundary.** `@debuggen/shared` and types from `./index` only; this
 *   module imports nothing at runtime from the barrel, which keeps the command
 *   folder acyclic.
 *
 * @example
 * ```ts
 * // src/commands/index.ts maps the id to this function:
 * 'debuggen.purgeSessions': (...args) => purgeSessions(ctx, ...args),
 * ```
 */

import { DebuggenError } from '@debuggen/shared';

import type { CommandContext, CommandId } from './index';

/** This module's command id, checked against the contributed id table. */
const COMMAND_ID = 'debuggen.purgeSessions' satisfies CommandId;

/** What was being attempted: the prefix of the one failure headline. */
export const PURGE_FAILURE_PREFIX = 'Could not purge stored sessions';

/**
 * The failure headline's body. Says both that the purge did not run and that
 * nothing was deleted, so the notice can never be read as a partial purge.
 */
const PURGE_UNAVAILABLE_MESSAGE =
  'the running local service offers no on-demand purge, so nothing was deleted.';

/**
 * The actionable half: the retention policy the service applies on its own,
 * stated as the sweep enforces it (`retention.ts` and the rules its suite
 * pins). The window is named by its configuration variable, with the
 * documented default given as a default — the service's configured value
 * governs, and this module never behaves as if it were fixed.
 */
const PURGE_UNAVAILABLE_HINT =
  'The service already purges each time it starts: sessions inactive for longer than ' +
  'DEBUGGEN_RETENTION_DAYS (30 days by default) are deleted with their telemetry, panels, ' +
  'analyses and backup directories, stale code-index caches are removed, and unreferenced ' +
  'backups go after 7 days. Backups belonging to an unresolved conflict are kept until you ' +
  'resolve it. Everything affected lives under $DEBUGGEN_HOME, never in your project.';

/**
 * The typed failure this command reports: the protocol declares no purge
 * operation, so the purge cannot be requested.
 *
 * `details` carries the command id only — nothing a log or a notification
 * must not show.
 *
 * @returns A new `NOT_IMPLEMENTED` error with the developer-facing hint.
 */
export function purgeUnavailableError(): DebuggenError {
  return new DebuggenError('NOT_IMPLEMENTED', PURGE_UNAVAILABLE_MESSAGE, {
    hint: PURGE_UNAVAILABLE_HINT,
    details: { command: COMMAND_ID },
  });
}

/**
 * Runs `debuggen.purgeSessions`.
 *
 * Logs the request once at `warn` — a purge request is an operator-relevant
 * event whether or not it can be served — and renders the one outcome through
 * `ctx.ui.notifyFailure`. No HTTP request, no filesystem access, no
 * state mutation and no tree refresh: nothing stored has changed.
 *
 * @param ctx The resolved command context.
 * @param args Whatever VS Code passed — nothing from the Command Palette, a
 *   tree node from a view menu. The command takes no argument, so no value is
 *   read; only how many arrived is logged, which tells an unexpected caller
 *   apart without recording what it sent.
 */
export async function purgeSessions(
  ctx: CommandContext,
  ...args: readonly unknown[]
): Promise<void> {
  const unavailable = purgeUnavailableError();
  ctx.logger.warn('Retention purge requested', {
    command: COMMAND_ID,
    code: unavailable.code,
    argumentCount: args.length,
  });
  await ctx.ui.notifyFailure(unavailable, { prefix: PURGE_FAILURE_PREFIX });
}
