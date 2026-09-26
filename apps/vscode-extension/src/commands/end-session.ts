/**
 * `debuggen.endSession` — ends the active session and reports its cleanup —
 * and {@link endBeforeReplacing}, the one way the editor lets go of a session.
 *
 * ## Contract
 *
 * One HTTP operation, `session.end` (`POST /sessions/:id/end`, body `{}`),
 * answered with `{ cleanup: CleanupStatus }` (AAP §0.4.2) once the service's
 * cleanup has run: every recorded file modification is restored from its
 * backup and every runtime hook is disabled (AAP §0.5.1). The answer is
 * recorded in the store at once through `ExtensionState.applySessionEnded`,
 * so the view shows the session ended even while the socket is down. The
 * service then broadcasts `cleanup.completed { sessionId, status, conflicts }`
 * and `session.updated`, which `src/extension.ts` routes into `src/state.ts`
 * and which supersede that answer with the conflicts and the service's own
 * timestamps. The command keeps no copy of server state.
 *
 * This is the developer-initiated half of the end-of-session guarantee;
 * `deactivate()` in `src/extension.ts` is the automatic half and owns the
 * shutdown ordering (end the sessions before stopping a spawned service). The
 * session work it runs lives here too, as {@link endSessionsForShutdown} (see
 * "Shutdown" below), so the suites can drive exactly what deactivation does.
 * Ending a session is the documented way to remove instrumentation, so it asks
 * for no confirmation.
 *
 * ## Ending before replacing
 *
 * `deactivate()` ends the active session and the sessions its creates in
 * flight produce — never one the store has already replaced — so the editor
 * must never replace a live active session in the store while its
 * instrumentation may still be installed. {@link endBeforeReplacing} is the
 * gate `debuggen.startSession` and `debuggen.reopenSession` pass before
 * adopting another session:
 *
 * ```text
 * no active session, or already ended with a settled cleanup ──▶ proceed
 * shutting down ──▶ stop, silently (the shutdown routine ends it)
 * owning endpoint unknown ──▶ one error notice ──▶ stop (nothing is relinquished)
 * otherwise ──▶ POST /sessions/:id/end at the session's owning endpoint
 *                 │ Err SESSION_NOT_FOUND (the owner's) ─▶ proceed (nothing remains)
 *                 │ Err (any other) ──▶ one failure notice ──▶ stop
 *                 │ Ok clean ──▶ applySessionEnded ─────▶ proceed
 *                 │ Ok partial | conflict ──▶ applySessionEnded + warning ("Open diff") ──▶ stop
 *                 │ Ok pending ──▶ applySessionEnded + warning (cleanup still running) ──▶ stop
 * ```
 *
 * ## The owning endpoint
 *
 * A session lives in the store of the service that created it, together with
 * its modification journal and its runtime hooks. `ExtensionState` therefore
 * adopts every session with the base URL its answering request was sent to
 * ({@link captureServiceEndpoint}), and every end — the replacement gate, the
 * `debuggen.endSession` command and the shutdown routine — is sent to that
 * endpoint through `ServiceClient.endSession(id, { endpoint })`, even after
 * `debuggen.serviceUrl` has been changed to another service. Only the owner's
 * `SESSION_NOT_FOUND` proves there is nothing left to clean up; another
 * service's would prove nothing. When the owner is unreachable or refuses, the
 * session stays active — so deactivation still targets it — and the one
 * failure notice names the owner and the two ways back to it: point
 * `debuggen.serviceUrl` at it again, or start that service.
 *
 * Stopping leaves the ended session in view with its verdict, so asking again
 * proceeds without a second request once the verdict is settled, and re-asks
 * the service while cleanup is still pending (the end is idempotent and
 * answers the stored verdict).
 *
 * ## Reading the reply
 *
 * The reply carries only the status:
 *
 * - `clean` — every modification was reverted.
 * - `pending` — cleanup is still running; `cleanup.completed` brings the result.
 * - `partial` — some files could not be restored; "Open diff" shows which.
 * - `conflict` — a file was edited while instrumented and was left untouched,
 *   its original preserved (AAP §0.5.5).
 *
 * For `partial` and `conflict` the files and their backups are not in the
 * reply, and `cleanup.completed` cannot reach a window whose socket is closed.
 * So, before the notice, the owning service is asked for the session's
 * authoritative record (`GET /sessions/:id`, whose `cleanup.conflicts[]`
 * carry each `file` and `backupPath`) and its modification journal
 * (`GET /sessions/:id/modifications`), and both are projected into the store
 * (`applySessionRecord`, `applyModificationJournal`). The notice then names
 * every conflicted file, one sentence each and at most
 * {@link MAX_CONFLICT_SENTENCES}: "‹file› was edited while instrumented. Debug
 * Generator will not overwrite it. Original saved at ‹backup path›." for a
 * file the developer changed, the service's own message for any other reason,
 * with "Open diff". When those details cannot be loaded, the notice falls back
 * to the status alone and "Open diff" reveals the modifications section. No
 * file name or path is ever invented here.
 *
 * When the socket is not `open` and no details were loaded, the notice says
 * the final state cannot be shown live until the connection is restored.
 *
 * ## Invariants
 *
 * - Preconditions, then exactly one request: no retry loop, no second call.
 * - A refused `session.end` is rendered once through `CommandUi.notifyFailure`
 *   with the service's hint, states that instrumentation may still be
 *   installed, and offers to try again. A failure is never presented as a clean
 *   cleanup, and nothing here throws for an expected condition.
 * - Privacy (AAP §0.5.2): the log carries the command id, the session id and
 *   the status value or error code only — never a file path, diff, backup path
 *   or question.
 * - No hardcoded behaviour (AAP §0.5.4): no application identifier, route path
 *   or question text appears here.
 *
 * ## Shutdown
 *
 * {@link endSessionsForShutdown} is deactivation's session work: it ends the
 * active session at its owning endpoint — the request issued synchronously,
 * so `deactivate()` can hand it to `ServiceProcess.keepAliveFor` before VS
 * Code disposes anything — then waits, bounded, for every `POST /sessions`
 * still in flight (`ExtensionState.trackSessionCreate`), and ends at its
 * owning endpoint every session those creates produced that nobody adopted.
 * In that same synchronous turn it registers its own completion with
 * `ServiceClient.keepConnectionsFor`: the service admits an editor's end only
 * while a live socket announces the project, and VS Code disposes the client
 * — which would close that socket — before any of the ends has left the
 * process. A create answered only after the wait elapsed is ended by
 * `debuggen.startSession` itself, at the endpoint it was sent to.
 *
 * ## Module graph
 *
 * `./start-session` and `./reopen-session` import {@link endBeforeReplacing}
 * and {@link captureServiceEndpoint} from here at runtime, and
 * `./start-session` also its {@link SESSION_CREATE_TIMEOUT_MS} budget; `src/extension.ts`
 * imports {@link endSessionsForShutdown}. This module imports only types from
 * `./index`, `../state` and `../service/client`, so the module graph stays
 * acyclic.
 *
 * @module
 */

import type { CleanupStatus, ModificationConflict } from '@debuggen/protocol';
import { DebuggenError, assertNever, err, isErr, isOk, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';

import type { ServiceClient } from '../service/client';
import type { CreatedSession, ExtensionState } from '../state';

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

/**
 * The `session.end` failure that means nothing is left to end: the service no
 * longer stores the session (retention purged it, or the store was reset), so
 * it holds no modification or hook for it either.
 */
const SESSION_GONE_CODE = 'SESSION_NOT_FOUND' satisfies DebuggenErrorCode;

/**
 * Why the active session is being ended before another one replaces it in the
 * store: a new question (`debuggen.startSession`, including the view's Retry of
 * an early stage) or a stored session being reopened (`debuggen.reopenSession`).
 */
export type ReplacementPurpose = 'start' | 'reopen';

/** The wording and log identity of one {@link ReplacementPurpose}. */
interface ReplacementWording {
  /** The command replacing the session, for log fields. */
  readonly command: CommandId;
  /** The `prefix` of the failure notice when `session.end` was refused. */
  readonly failurePrefix: string;
  /** What did not happen because the replacement stopped. */
  readonly notDone: string;
  /** How to proceed after a partial or conflicted cleanup. */
  readonly reviewThenRetry: string;
  /** How to proceed while cleanup is still running. */
  readonly retryWhenDone: string;
}

/** Every purpose's wording; exhaustive over {@link ReplacementPurpose}. */
const REPLACEMENT_WORDING: Readonly<Record<ReplacementPurpose, ReplacementWording>> = Object.freeze(
  {
    start: Object.freeze({
      command: 'debuggen.startSession',
      failurePrefix:
        'Could not end the current session, so the new session was not started and instrumentation may still be installed',
      notDone: 'The new question was not sent.',
      reviewThenRetry: `Review the modifications with "${OPEN_DIFF_ACTION}", then ask your question again.`,
      retryWhenDone: 'Ask your question again when cleanup completes.',
    }),
    reopen: Object.freeze({
      command: 'debuggen.reopenSession',
      failurePrefix:
        'Could not end the current session, so the other session was not opened and instrumentation may still be installed',
      notDone: 'The other session was not reopened.',
      reviewThenRetry: `Review the modifications with "${OPEN_DIFF_ACTION}", then reopen the session again.`,
      retryWhenDone: 'Reopen the session again when cleanup completes.',
    }),
  },
);

/** The setting that names the service new requests go to, as the developer sees it. */
const SERVICE_URL_SETTING = 'debuggen.serviceUrl';

/**
 * The bound on each of the two requests that load a settled `partial` or
 * `conflict` cleanup's details (see {@link loadCleanupDetails}); the notice
 * waits for them, so they must not stall it.
 */
const CLEANUP_DETAIL_TIMEOUT_MS = 3_000;

/**
 * How many conflicted files one notice spells out, one sentence each; the rest
 * are counted, and "Open diff" lists every one. A notification is a summary,
 * not the modifications list.
 */
export const MAX_CONFLICT_SENTENCES = 3;

/**
 * The conflict reason AAP §0.5.5 words as "‹file› was edited while
 * instrumented": the developer changed the file after Debug Generator
 * patched it. Every other reason — a missing file, an unreadable backup, a
 * failed verification, a forked record chain — is described by the service's
 * own `message`, which names the file and where its original is.
 */
const EDITED_WHILE_INSTRUMENTED = 'content-changed' satisfies ModificationConflict['reason'];

/**
 * Shown when the active session's owning endpoint is unknown. By construction
 * every adopted session has one (`ExtensionState.adoptSession` requires it), so
 * this is a guard: without the owner there is no service to ask, and asking the
 * current one could answer `SESSION_NOT_FOUND` for a session that is still
 * instrumented elsewhere — so nothing is relinquished.
 */
const UNKNOWN_OWNER_MESSAGE =
  'Debug Generator does not know which local service holds the current session, so it cannot end it.';

// ---------------------------------------------------------------------------
// The owning endpoint
// ---------------------------------------------------------------------------

/**
 * The service base URL a request about to be sent will reach — captured
 * synchronously, right before `POST /sessions` or `GET /sessions/:id` is sent,
 * so the session the answer names is adopted with the service that holds it
 * (`ExtensionState.activeSessionEndpoint`).
 *
 * @param ctx The command context.
 * @returns The client's canonical base URL, or the configuration refusal every
 *   request would answer with while `debuggen.serviceUrl` is unusable.
 *
 * @example
 * ```ts
 * const endpoint = captureServiceEndpoint(ctx);
 * if (isErr(endpoint)) return void (await ctx.ui.notifyFailure(endpoint.error));
 * const created = await ctx.client.createSession(request);
 * if (isOk(created)) creation.adopt(created.value, endpoint.value);
 * ```
 */
export function captureServiceEndpoint(ctx: CommandContext): Result<string, DebuggenError> {
  const endpoint = ctx.client.baseUrl;
  if (endpoint !== undefined) {
    return ok(endpoint);
  }
  return err(
    ctx.client.configurationError ??
      new DebuggenError(
        'CONFIG_INVALID',
        `The ${SERVICE_URL_SETTING} setting does not name a usable local service address.`,
        { hint: `Set ${SERVICE_URL_SETTING} to the address of the Debug Generator local service.` },
      ),
  );
}

/**
 * `error` as the developer must read it when the session's own service could
 * not end it.
 *
 * When the owner is still the service `debuggen.serviceUrl` names, the
 * service's own error and hint already say what to do. When the setting has
 * moved on, the hint is replaced by one that names the owning service and the
 * two ways back to it — ending the session anywhere else would end nothing.
 * The code and message are kept, so the failure is still reported as what it
 * was.
 *
 * @param error The failure the owning service's request produced.
 * @param owner The session's owning endpoint.
 * @param current The client's current base URL, `undefined` when refused.
 */
function ownerAwareFailure(
  error: DebuggenError,
  owner: string,
  current: string | undefined,
): DebuggenError {
  if (current === owner) {
    return error;
  }
  const now =
    current === undefined
      ? `${SERVICE_URL_SETTING} no longer names a usable address`
      : `${SERVICE_URL_SETTING} now points at ${current}`;
  return new DebuggenError(error.code, error.message, {
    hint: `This session belongs to the local service at ${owner}, but ${now}. Set ${SERVICE_URL_SETTING} back to ${owner}, or start the service at ${owner}, then try again.`,
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error,
  });
}

/**
 * The notice for an active session whose owning endpoint is unknown; see
 * {@link UNKNOWN_OWNER_MESSAGE}.
 *
 * @param notDone What did not happen because of it, when a replacement stopped.
 */
function unknownOwnerNotice(notDone: string | undefined): CommandNotice {
  return {
    level: 'error',
    message: UNKNOWN_OWNER_MESSAGE,
    detail: joinDetail(
      notDone,
      'Its instrumentation may still be installed. Restart the local service that holds it: on start it restores every file a session modified.',
    ),
  };
}

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
 * The sentence that tells the developer what happened to one conflicted file
 * and where its original is. A file edited while instrumented gets the
 * AAP §0.5.5 wording verbatim; any other reason gets the service's own
 * message, which names the file and the backup too.
 */
function conflictSentence(conflict: ModificationConflict): string {
  return conflict.reason === EDITED_WHILE_INSTRUMENTED
    ? `${conflict.file} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${conflict.backupPath}.`
    : conflict.message;
}

/**
 * The first conflict of every file, in the service's order: a follow-up can
 * layer several records onto one file, and the developer needs one sentence
 * per file, not per record.
 */
function oneConflictPerFile(
  conflicts: readonly ModificationConflict[],
): readonly ModificationConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    if (seen.has(conflict.file)) {
      return false;
    }
    seen.add(conflict.file);
    return true;
  });
}

/**
 * One sentence per file, at most {@link MAX_CONFLICT_SENTENCES}, followed by a
 * count of the files not spelled out.
 */
function conflictSentences(files: readonly ModificationConflict[]): string {
  const sentences = files.slice(0, MAX_CONFLICT_SENTENCES).map(conflictSentence);
  const rest = files.length - sentences.length;
  if (rest === 1) {
    sentences.push(`1 more file was left untouched; "${OPEN_DIFF_ACTION}" lists it.`);
  } else if (rest > 1) {
    sentences.push(
      `${String(rest)} more files were left untouched; "${OPEN_DIFF_ACTION}" lists every one.`,
    );
  }
  return sentences.join(' ');
}

/**
 * The single notice for a `partial` or `conflict` `session.end` once its
 * details were loaded: the conflicted files by name with their backup paths
 * (AAP §0.5.5). The store holds the final record by then, so nothing is said
 * about live updates.
 *
 * @param files The conflicts, one per file; never empty.
 */
function detailedEndNotice(files: readonly ModificationConflict[]): CommandNotice {
  const [only] = files;
  if (files.length === 1 && only !== undefined) {
    return {
      level: 'warning',
      message: conflictSentence(only),
      detail: 'Open the diff to see the modification and the original.',
      actions: [OPEN_DIFF_ACTION],
    };
  }
  return {
    level: 'warning',
    message: `Session ended, but ${String(files.length)} files were left untouched. Debug Generator will not overwrite them.`,
    detail: joinDetail(conflictSentences(files), 'Open the diff to see each modification.'),
    actions: [OPEN_DIFF_ACTION],
  };
}

/**
 * The warning that stops a replacement after a `partial` or `conflict`
 * cleanup whose details were loaded; see {@link detailedEndNotice}.
 *
 * @param files The conflicts, one per file; never empty.
 * @param wording The replacing command's wording.
 */
function detailedUnsettledNotice(
  files: readonly ModificationConflict[],
  wording: ReplacementWording,
): CommandNotice {
  const [only] = files;
  if (files.length === 1 && only !== undefined) {
    return {
      level: 'warning',
      message: `The previous session ended. ${conflictSentence(only)}`,
      detail: joinDetail(wording.notDone, wording.reviewThenRetry),
      actions: [OPEN_DIFF_ACTION],
    };
  }
  return {
    level: 'warning',
    message: `The previous session ended, but ${String(files.length)} files were left untouched. Debug Generator will not overwrite them.`,
    detail: joinDetail(conflictSentences(files), wording.notDone, wording.reviewThenRetry),
    actions: [OPEN_DIFF_ACTION],
  };
}

/**
 * Runs `request`, turning a throw or a rejection into an `Err`, so one failed
 * request never hides the other's answer.
 */
async function settledRequest<T>(
  request: () => Promise<Result<T, DebuggenError>>,
): Promise<Result<T, DebuggenError>> {
  try {
    return await request();
  } catch (thrown) {
    return err(DebuggenError.from(thrown));
  }
}

/**
 * Loads, from the session's owning service, what a `partial` or `conflict`
 * answer to `session.end` does not carry — the authoritative record, whose
 * `cleanup.conflicts[]` name each file and its backup, and the modification
 * journal — and projects both into the store, so the view shows them even
 * though no `cleanup.completed` or `session.updated` can reach a window whose
 * socket is closed.
 *
 * The two requests run concurrently, each bounded by
 * {@link CLEANUP_DETAIL_TIMEOUT_MS}. A journal that cannot be loaded only
 * leaves the view's list as it was; a record that cannot be loaded, or that
 * names no conflict, yields `undefined`, and the caller keeps its status-only
 * wording. Logs carry codes and counts only — never a file or backup path.
 *
 * @param ctx The command context.
 * @param sessionId The session `session.end` answered for.
 * @param owner The session's owning endpoint, where both requests go.
 * @param command The command on whose behalf the details are loaded, for logs.
 * @returns The conflicts the store now holds, one per file, or `undefined`.
 */
async function loadCleanupDetails(
  ctx: CommandContext,
  sessionId: string,
  owner: string,
  command: CommandId,
): Promise<readonly ModificationConflict[] | undefined> {
  const call = { endpoint: owner, timeoutMs: CLEANUP_DETAIL_TIMEOUT_MS };
  const [record, journal] = await Promise.all([
    settledRequest(() => ctx.client.getSession(sessionId, call)),
    settledRequest(() => ctx.client.getModifications(sessionId, undefined, call)),
  ]);

  let conflicts: readonly ModificationConflict[] = [];
  if (isErr(record)) {
    ctx.logger.warn('Cleanup details could not be loaded', {
      command,
      sessionId,
      code: record.error.code,
    });
  } else if (record.value.id !== sessionId) {
    ctx.logger.warn('Cleanup details named a different session and were ignored', {
      command,
      sessionId,
      code: 'PROTOCOL_INVALID_MESSAGE' satisfies DebuggenErrorCode,
    });
  } else {
    ctx.state.applySessionRecord(record.value);
    conflicts =
      ctx.state.activeSessionId === sessionId
        ? ctx.state.cleanup.conflicts
        : record.value.cleanup.conflicts;
  }

  if (isErr(journal)) {
    ctx.logger.warn('Modification journal could not be loaded', {
      command,
      sessionId,
      code: journal.error.code,
    });
  } else {
    ctx.state.applyModificationJournal(sessionId, journal.value.modifications);
  }

  const files = oneConflictPerFile(conflicts);
  if (isOk(record) && record.value.id === sessionId) {
    ctx.logger.info('Cleanup details loaded', {
      command,
      sessionId,
      conflicts: files.length,
      modifications: isErr(journal) ? 'unavailable' : journal.value.total,
    });
  }
  return files.length === 0 ? undefined : files;
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

/**
 * The warning shown when the session being replaced ended with a verdict that
 * stops the replacement: files left for the developer to review, or cleanup
 * still running.
 */
function unsettledNotice(
  status: Exclude<CleanupStatus, 'clean'>,
  wording: ReplacementWording,
): CommandNotice {
  switch (status) {
    case 'pending':
      return {
        level: 'warning',
        message: 'The previous session ended, but its cleanup is still running.',
        detail: joinDetail(wording.notDone, wording.retryWhenDone),
      };
    case 'partial':
      return {
        level: 'warning',
        message:
          'The previous session ended, but some files could not be restored and were left untouched; their originals are preserved.',
        detail: joinDetail(wording.notDone, wording.reviewThenRetry),
        actions: [OPEN_DIFF_ACTION],
      };
    case 'conflict':
      return {
        level: 'warning',
        message:
          'The previous session ended, but a file edited while instrumented was left untouched; its original is preserved.',
        detail: joinDetail(wording.notDone, wording.reviewThenRetry),
        actions: [OPEN_DIFF_ACTION],
      };
    default:
      return assertNever(status, 'Unhandled cleanup status');
  }
}

// ---------------------------------------------------------------------------
// Ending before replacing
// ---------------------------------------------------------------------------

/**
 * Ends the active session before another session replaces it in the store,
 * and says whether the replacement may proceed.
 *
 * The editor tracks at most one live session and `deactivate()` ends that one
 * (and only the creates in flight besides), so a session may leave the store
 * only after the service has answered
 * `session.end` for it with a settled, clean cleanup — or after the developer,
 * told of a partial, conflicted or unfinished cleanup, asks again. See the
 * module documentation for the decision table. Every answer the service gives
 * is recorded through `ExtensionState.applySessionEnded`, so the ended session
 * and its verdict stay in view when the replacement stops.
 *
 * At most one request is sent, and every stop is explained by exactly one
 * notice — except once the extension is shutting down, when nothing is sent
 * or shown and the answer is `false`: the shutdown routine ends the active
 * session, and nothing may replace it. The function never throws for an
 * expected condition.
 *
 * @param ctx The command context of the replacing command.
 * @param purpose Which command is replacing the session, for wording and logs.
 * @returns `true` when nothing of the active session remains to clean up and
 *   the caller may adopt another session; `false` when the caller must stop
 *   with the active session left in view.
 *
 * @example
 * ```ts
 * if (!(await endBeforeReplacing(ctx, 'start'))) {
 *   return;
 * }
 * ```
 */
export async function endBeforeReplacing(
  ctx: CommandContext,
  purpose: ReplacementPurpose,
): Promise<boolean> {
  const active = ctx.state.activeSession;
  if (active === undefined) {
    return true;
  }
  if (active.status === 'ended' && ctx.state.cleanup.status !== 'pending') {
    // Already ended with a settled verdict, which is on screen already.
    return true;
  }

  const wording = REPLACEMENT_WORDING[purpose];
  const sessionId = active.id;
  if (ctx.state.isShuttingDown) {
    // The shutdown routine ends the active session; nothing may replace it now.
    ctx.logger.info('Current session not replaced because the extension is shutting down', {
      command: wording.command,
      sessionId,
    });
    return false;
  }
  const owner = ctx.state.activeSessionEndpoint;
  if (owner === undefined) {
    ctx.logger.warn('Current session has no known owning service, so it was not replaced', {
      command: wording.command,
      sessionId,
    });
    await ctx.ui.notify(unknownOwnerNotice(wording.notDone));
    return false;
  }
  ctx.logger.info('Ending the current session before replacing it', {
    command: wording.command,
    sessionId,
    endpoint: owner,
  });

  // Sent to the service that owns the session, whatever `debuggen.serviceUrl`
  // names now: only that service can remove the session's instrumentation,
  // and only its `SESSION_NOT_FOUND` proves there is nothing left to remove.
  const ended = await ctx.client.endSession(sessionId, { endpoint: owner });
  if (isErr(ended)) {
    const code = ended.error.code;
    if (code === SESSION_GONE_CODE) {
      ctx.logger.info('Current session is no longer stored by its owning service', {
        command: wording.command,
        sessionId,
        endpoint: owner,
        code,
      });
      return true;
    }
    ctx.logger.warn('Current session could not be ended, so it was not replaced', {
      command: wording.command,
      sessionId,
      endpoint: owner,
      code,
    });
    await ctx.ui.notifyFailure(ownerAwareFailure(ended.error, owner, ctx.client.baseUrl), {
      prefix: wording.failurePrefix,
    });
    return false;
  }

  const status = ended.value.cleanup;
  ctx.state.applySessionEnded(sessionId, ended.value);
  ctx.logger.info('Current session ended before replacing it', {
    command: wording.command,
    sessionId,
    cleanup: status,
  });
  if (status === 'clean') {
    return true;
  }

  // The answer names a status only: the files left untouched, and where their
  // originals are, come from the owner's record and journal.
  const files =
    status === 'pending'
      ? undefined
      : await loadCleanupDetails(ctx, sessionId, owner, wording.command);
  const notice =
    files === undefined
      ? unsettledNotice(status, wording)
      : detailedUnsettledNotice(files, wording);
  const choice = await ctx.ui.notify(notice);
  if (choice === OPEN_DIFF_ACTION) {
    await runFollowUp(ctx, SHOW_MODIFICATIONS_COMMAND);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `debuggen.endSession`: ends the active session, which removes its
 * instrumentation, records the answer in the store and reports the cleanup
 * status the service answered.
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
  const owner = ctx.state.activeSessionEndpoint;
  if (owner === undefined) {
    ctx.logger.warn('Session has no known owning service, so it was not ended', {
      command: END_SESSION_COMMAND,
      sessionId: active.sessionId,
    });
    await ctx.ui.notify(unknownOwnerNotice(undefined));
    return;
  }

  ctx.logger.info('Session end requested', {
    command: END_SESSION_COMMAND,
    sessionId: active.sessionId,
    endpoint: owner,
  });
  const ended = await ctx.client.endSession(active.sessionId, { endpoint: owner });
  if (isErr(ended)) {
    const choice = await ctx.ui.notifyFailure(
      ownerAwareFailure(ended.error, owner, ctx.client.baseUrl),
      { prefix: END_FAILURE_PREFIX, actions: [TRY_AGAIN_ACTION] },
    );
    if (choice === TRY_AGAIN_ACTION) {
      await runFollowUp(ctx, END_SESSION_COMMAND);
    }
    return;
  }

  const status = ended.value.cleanup;
  ctx.state.applySessionEnded(active.sessionId, ended.value);
  ctx.logger.info('Session ended', {
    command: END_SESSION_COMMAND,
    sessionId: active.sessionId,
    cleanup: status,
  });

  const files =
    status === 'partial' || status === 'conflict'
      ? await loadCleanupDetails(ctx, active.sessionId, owner, END_SESSION_COMMAND)
      : undefined;
  const notice =
    files === undefined ? noticeFor(status, ctx.client.state === 'open') : detailedEndNotice(files);
  const choice = await ctx.ui.notify(notice);
  if (choice === OPEN_DIFF_ACTION) {
    await runFollowUp(ctx, SHOW_MODIFICATIONS_COMMAND);
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * The budget of one `POST /sessions`, in milliseconds, which
 * `debuggen.startSession` passes as the request's `timeoutMs`.
 *
 * It only keeps a stalled service from holding the command forever, and it is
 * deliberately generous. The service stores the record and starts the
 * pipeline in the same turn it answers, so a first stage that keeps the
 * service's event loop busy — indexing a large project — can delay the answer
 * by seconds. A budget shorter than that would report a failure for a session
 * the service did create, and a session the editor does not know about is
 * one nothing ends. It is therefore independent of the shutdown routine's
 * wait ({@link DEFAULT_SHUTDOWN_TIMEOUTS}`.createSettleMs`): a create still
 * unanswered when that wait elapses is ended by the start command itself once
 * it answers.
 */
export const SESSION_CREATE_TIMEOUT_MS = 30_000;

/** The bounds {@link endSessionsForShutdown} works within, in milliseconds. */
export interface ShutdownTimeouts {
  /** The bound on the active session's `session.end`. */
  readonly activeEndMs: number;
  /**
   * How long to wait for the creates in flight to settle. A create that
   * answers later is ended by `debuggen.startSession` at its endpoint (its
   * ticket's `orphaned` answers `false` once this routine has claimed the
   * hand-overs).
   */
  readonly createSettleMs: number;
  /** The bound on the `session.end` of each session a create produced during shutdown. */
  readonly createdEndMs: number;
}

/**
 * The production bounds of {@link endSessionsForShutdown}.
 *
 * The extension host gives `deactivate()` five seconds before it exits, and
 * stopping the spawned service needs part of that: `deactivate()` carves
 * every step from its `DEACTIVATE_BUDGET_MS` (4.5 s), of which the active
 * session's end — `DEACTIVATE_END_SESSION_TIMEOUT_MS` in `src/extension.ts`,
 * which is `activeEndMs` — takes three seconds. The active session's end
 * and the wait for creates run concurrently, and
 * `createSettleMs + createdEndMs` equals `activeEndMs`, so the routine as a
 * whole never outlasts the active session's own bound. A local service
 * answers a create well inside `createSettleMs` unless its event loop is
 * busy; a create answered after the wait is ended by the start command
 * itself, and a service stopped before that answer restores every file its
 * pipeline patched when it next starts (its journal reconciliation). A bound
 * only limits how long the editor waits for an answer: once received, an end
 * runs to completion in the service regardless.
 */
export const DEFAULT_SHUTDOWN_TIMEOUTS: ShutdownTimeouts = Object.freeze({
  activeEndMs: 3_000,
  createSettleMs: 2_250,
  createdEndMs: 750,
});

/** The members of the host store {@link endSessionsForShutdown} reads and writes. */
export type ShutdownState = Pick<
  ExtensionState,
  | 'beginShutdown'
  | 'activeSession'
  | 'activeSessionEndpoint'
  | 'sessionCreatesInFlight'
  | 'claimOrphanedSessions'
  | 'hasAcknowledgedEnd'
  | 'applySessionEnded'
>;

/**
 * What {@link endSessionsForShutdown} needs — every member injectable, so the
 * extension-host suites can run the real routine against a scripted client.
 */
export interface ShutdownDeps {
  /** The host store: the active session, its owner, and the create ledger. */
  readonly state: ShutdownState;
  /**
   * The service client. Only `session.end` is sent, each to its owning
   * endpoint; `keepConnectionsFor` holds its sockets open until every end
   * settled, because the service admits an editor's end only while a live
   * socket announces the session's project (AAP §0.5.6).
   */
  readonly client: Pick<ServiceClient, 'endSession' | 'keepConnectionsFor'>;
  /** Receives one record per request and a summary; never a path or a question. */
  readonly logger: Logger;
  /** Overrides of {@link DEFAULT_SHUTDOWN_TIMEOUTS}. */
  readonly timeouts?: Partial<ShutdownTimeouts> | undefined;
}

/** Why the shutdown routine ended a session. */
export type ShutdownEndOrigin = 'active' | 'created';

/** The outcome of one `session.end` the shutdown routine sent. */
export interface ShutdownEndOutcome {
  /** The session that was ended. */
  readonly sessionId: string;
  /** The service the end was sent to: the session's owning endpoint. */
  readonly endpoint: string;
  /**
   * `active` for the session the editor tracked; `created` for a session a
   * create in flight produced after shutdown began, which nobody adopted.
   */
  readonly origin: ShutdownEndOrigin;
  /** The cleanup verdict, when the service answered. */
  readonly cleanup?: CleanupStatus;
  /** The failure code, when it did not. */
  readonly code?: DebuggenErrorCode;
  /**
   * `true` when the failure is this side's own timeout: the service does not
   * abandon an end when its client stops waiting, so it may still be
   * restoring the files, and the child must not be signalled.
   */
  readonly timedOut?: true;
}

/** What {@link endSessionsForShutdown} did. */
export interface ShutdownReport {
  /** Every end the routine sent, the active session's first. */
  readonly ended: readonly ShutdownEndOutcome[];
  /** Creates still unanswered when the wait elapsed; their sessions, if any, were not ended here. */
  readonly unsettledCreates: number;
  /** Open sessions that could not be ended because their owning endpoint is unknown. */
  readonly unowned: readonly string[];
}

/**
 * {@link DEFAULT_SHUTDOWN_TIMEOUTS} with every usable override applied; an
 * override that is not a finite, non-negative number keeps the default, so a
 * malformed bound can neither skip a wait nor make one unbounded.
 */
function resolveShutdownTimeouts(
  overrides: Partial<ShutdownTimeouts> | undefined,
): ShutdownTimeouts {
  const pick = (key: keyof ShutdownTimeouts): number => {
    const value = overrides?.[key];
    return value !== undefined && Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_SHUTDOWN_TIMEOUTS[key];
  };
  return {
    activeEndMs: pick('activeEndMs'),
    createSettleMs: pick('createSettleMs'),
    createdEndMs: pick('createdEndMs'),
  };
}

/**
 * Whether `operation` settles within `timeoutMs`; never rejects.
 */
async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      elapsed,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one `session.end` to `endpoint` and records the answer. The request is
 * issued synchronously — before this function's first `await` — which is what
 * lets `deactivate()` register it before VS Code disposes anything. Never
 * rejects.
 */
async function endForShutdown(
  deps: ShutdownDeps,
  session: CreatedSession,
  origin: ShutdownEndOrigin,
  timeoutMs: number,
): Promise<ShutdownEndOutcome> {
  const { client, state, logger } = deps;
  const { sessionId, endpoint } = session;
  logger.info('Ending a session before shutdown', { sessionId, endpoint, origin });
  try {
    const ended = await client.endSession(sessionId, { endpoint, timeoutMs });
    if (isErr(ended)) {
      logger.warn('Session could not be ended on shutdown', {
        sessionId,
        endpoint,
        origin,
        code: ended.error.code,
      });
      return Object.freeze({
        sessionId,
        endpoint,
        origin,
        code: ended.error.code,
        // The protocol client's cancellation failure names its source.
        ...(ended.error.details?.cancelled === 'timeout' ? { timedOut: true as const } : {}),
      });
    }
    // Inert once the editor has disposed the store; recorded while it has not.
    state.applySessionEnded(sessionId, ended.value);
    logger.info('Session ended on shutdown', {
      sessionId,
      endpoint,
      origin,
      cleanup: ended.value.cleanup,
    });
    return Object.freeze({ sessionId, endpoint, origin, cleanup: ended.value.cleanup });
  } catch (thrown) {
    const code = DebuggenError.from(thrown).code;
    logger.warn('Session could not be ended on shutdown', { sessionId, endpoint, origin, code });
    return Object.freeze({ sessionId, endpoint, origin, code });
  }
}

/**
 * Ends, at its owning endpoint, every session this editor is responsible for
 * when the extension shuts down — the automatic half of the end-of-session
 * guarantee (AAP §0.5.1). This is "actual deactivation": `deactivate()` in
 * `src/extension.ts` runs exactly this routine, and a test that calls it runs
 * exactly what deactivation runs.
 *
 * 1. Closes the gate ({@link ExtensionState.beginShutdown}, idempotent, so
 *    calling it here too is harmless): from now on nothing is created,
 *    reopened or adopted.
 * 2. **Synchronously**, before the returned promise exists, sends `session.end`
 *    for the active session when it is still open, to its owning endpoint,
 *    bounded by `activeEndMs`, and registers the routine's own completion
 *    with `ServiceClient.keepConnectionsFor`, so the client's sockets keep
 *    announcing the project — without which the service refuses the end
 *    `PATH_OUTSIDE_PROJECT` — until every end below settled, even the ones
 *    sent seconds later for sessions created during shutdown. `deactivate()`
 *    registers the returned promise with `ServiceProcess.keepAliveFor` in the
 *    same turn, so the service child outlives the requests too, although VS
 *    Code disposes the store, the client and the process manager as soon as
 *    `deactivate()` returns its promise.
 * 3. Waits, bounded by `createSettleMs`, for every `POST /sessions` in
 *    flight to settle. A create answered after the gate closed cannot be
 *    adopted, so its ticket hands the created session over; one answered only
 *    after the wait elapsed is ended by the start command that sent it.
 * 4. Ends, at its owning endpoint and bounded by `createdEndMs`, every session
 *    handed over that is not already ended — not the one ended in step 2 and
 *    not one the store acknowledged as ended. No session becomes active after
 *    step 1, so the active session of step 2 is the only adopted one.
 * 5. Resolves, once every end has an answer or its bound elapsed, with a
 *    report of which sessions were ended with which verdict or failure code.
 *
 * Never throws and never rejects; an unexpected failure is logged by code and
 * reported as what was done up to it.
 *
 * @param deps The store, the client, the logger and optional bounds.
 * @returns The report; see {@link ShutdownReport}.
 *
 * @example
 * ```ts
 * // In deactivate(), before the first await:
 * state.beginShutdown();
 * const ending = serviceProcess.keepAliveFor(endSessionsForShutdown({ state, client, logger }));
 * await ending;
 * await serviceProcess.stop({ awaitInFlight: ending });
 * ```
 */
export function endSessionsForShutdown(deps: ShutdownDeps): Promise<ShutdownReport> {
  const { state, logger } = deps;
  const timeouts = resolveShutdownTimeouts(deps.timeouts);
  const requests: Promise<ShutdownEndOutcome>[] = [];
  const claimed = new Set<string>();
  const unowned: string[] = [];
  try {
    state.beginShutdown();
    const active = state.activeSession;
    if (active !== undefined && active.status !== 'ended') {
      const endpoint = state.activeSessionEndpoint;
      if (endpoint === undefined) {
        unowned.push(active.id);
        logger.warn('The active session has no known owning service; it was not ended', {
          sessionId: active.id,
        });
      } else {
        claimed.add(active.id);
        requests.push(
          endForShutdown(deps, { sessionId: active.id, endpoint }, 'active', timeouts.activeEndMs),
        );
      }
    }
  } catch (thrown) {
    logger.error('Ending the active session on shutdown failed unexpectedly', {
      code: DebuggenError.from(thrown).code,
    });
  }
  return holdConnectionsUntil(deps, finishShutdown(deps, timeouts, requests, claimed, unowned));
}

/**
 * Registers `finished` with the client's `keepConnectionsFor` — in the
 * caller's synchronous turn, before VS Code can dispose the client — and
 * returns what the client returns, the same promise. A client that fails to
 * register is logged and the routine carries on unheld: its ends are still
 * sent, and the service's start-up reconciliation remains the safety net.
 */
function holdConnectionsUntil(
  deps: ShutdownDeps,
  finished: Promise<ShutdownReport>,
): Promise<ShutdownReport> {
  try {
    return deps.client.keepConnectionsFor(finished);
  } catch (thrown) {
    deps.logger.error('The service connections could not be held for the shutdown ends', {
      code: DebuggenError.from(thrown).code,
    });
    return finished;
  }
}

/**
 * Steps 3 to 5 of {@link endSessionsForShutdown}: the bounded wait for creates
 * in flight, the ends of the sessions they handed over, and the report.
 */
async function finishShutdown(
  deps: ShutdownDeps,
  timeouts: ShutdownTimeouts,
  requests: Promise<ShutdownEndOutcome>[],
  claimed: Set<string>,
  unowned: readonly string[],
): Promise<ShutdownReport> {
  const { state, logger } = deps;
  let unsettledCreates = 0;
  try {
    const inFlight = state.sessionCreatesInFlight;
    if (inFlight.length > 0) {
      logger.info('Waiting for session creates in flight before shutdown', {
        pending: inFlight.length,
        timeoutMs: timeouts.createSettleMs,
      });
      if (!(await settlesWithin(Promise.all(inFlight), timeouts.createSettleMs))) {
        unsettledCreates = state.sessionCreatesInFlight.length;
        logger.warn('Session creates were still unanswered when shutdown stopped waiting', {
          pending: unsettledCreates,
        });
      }
    }
    for (const created of state.claimOrphanedSessions()) {
      if (claimed.has(created.sessionId) || state.hasAcknowledgedEnd(created.sessionId)) {
        continue;
      }
      claimed.add(created.sessionId);
      requests.push(endForShutdown(deps, created, 'created', timeouts.createdEndMs));
    }
  } catch (thrown) {
    logger.error('Ending the sessions created during shutdown failed unexpectedly', {
      code: DebuggenError.from(thrown).code,
    });
  }
  const ended = await Promise.all(requests);
  logger.info('Sessions ended before shutdown', {
    ended: ended.length,
    failed: ended.filter((outcome) => outcome.code !== undefined).length,
    unsettledCreates,
    unowned: unowned.length,
  });
  return Object.freeze({
    ended: Object.freeze(ended),
    unsettledCreates,
    unowned: Object.freeze([...unowned]),
  });
}
