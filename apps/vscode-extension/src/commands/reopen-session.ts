/**
 * `debuggen.reopenSession` — brings a stored debugging session back into the
 * Debug Generator view (AAP §0.4.2 "Session persistence", §0.7.3, §0.8.1
 * slice 2 "reopen after restart").
 *
 * ## The whole command
 *
 * ```text
 * argument (Sessions tree row / inline action)   ─┐
 *                                                  ├─▶ session id
 * Command Palette ─▶ quick pick of stored sessions ─┘        │
 *                                        shutting down? ─────┼─yes─▶ done, nothing sent
 *                         another start/reopen in flight? ───┼─yes─▶ one notice, done
 *                                                            │ no
 *                             beginSessionCreation ─▶ GET /sessions/:id ──Err──▶ one notice
 *                                                            │
 *                  a different, live session is active? ─────┼─yes─▶ "End and Reopen"?
 *                                                            │         │ declined ─▶ done,
 *                                                            │         │   nothing changed
 *                                                            │ ◀───────┘ accepted
 *                         endBeforeReplacing (POST /sessions/:id/end) ──false──▶ stop
 *                                                            │ true
 *                               window.adopt(authoritative record + held frames)
 *                                                            │
 *                                                            ▼
 *                                          reveal the `debuggen.session` view
 * ```
 *
 * The service answers `GET /sessions/:id` and then replays `session.updated`
 * and the latest `panel.generated` to every connected client, so the DevTools
 * panel re-renders the stored panel and this editor receives the panel summary
 * the record itself cannot carry. That replay belongs to the service
 * (`apps/local-service/src/sessions/reopen.ts`); this module performs none of
 * it and sends nothing over the socket. The creation window is opened before
 * the request, so a replayed frame that arrives while the previous session is
 * still being ended is held and applied on adoption rather than dropped.
 *
 * ## Why the session in view is ended first
 *
 * `deactivate()` in `src/extension.ts` ends the active session (and the
 * sessions its creates in flight produce), never one the store has already
 * replaced, so switching the view to another session while the current one is
 * live would orphan its patches and hooks (AAP §0.5.1). Unlike a new question,
 * reopening is not a start-over the developer asked for, so a live session is
 * ended only after a confirmation that says what ending does; declining leaves
 * everything as it was. {@link endBeforeReplacing} then sends `session.end`,
 * awaits the settled cleanup, and stops the reopen, with one notice, whenever
 * the verdict leaves anything for the developer to see. A session that has
 * already ended is replaced without asking. Reopening the session already in
 * view ends and resets nothing: its record is merged.
 *
 * ## Why this command writes session-scoped state
 *
 * The value adopted is the service's own authoritative record, merged under
 * the same rules as a `session.updated` push, so the replay that follows is
 * idempotent with it. Adopting it here is what makes the view repopulate even
 * while the socket is still reconnecting.
 *
 * ## Invariants
 *
 * - **Thin.** Resolve the id, one `GET /sessions/:id`, end the session in view
 *   when it must go, adopt, reveal. The only other request is the single
 *   `GET /sessions` refresh of the empty-list palette path, issued through the
 *   Sessions tree's single-flight loader.
 * - **Ids are resolved, never made.** An id comes from the invoking argument
 *   or from a stored session the developer picked; nothing is constructed,
 *   guessed or derived from the question.
 * - **One message per outcome, never a throw.** Every expected failure is a
 *   typed `Err` rendered once through `CommandUi.notifyFailure`, which shows
 *   the service's hint; a cancelled pick is silent; a failure is never shown
 *   as a reopened session.
 * - **Nothing sensitive is logged.** The success record names the command only
 *   — never the question, the project path or the stored analysis.
 * - **No hardcoded behaviour (AAP §0.5.4).** Quick-pick rows come from the
 *   Sessions tree's display helpers, which normalise whitespace and never
 *   inspect what a question means.
 *
 * ## Module conventions
 *
 * Extension-host code: ESM authoring with extensionless relative imports,
 * bundled to CommonJS by `esbuild.mjs` (no top-level `await`), Node and
 * `vscode` types only. `vscode` is imported for its types alone, and `./index`
 * — which imports this module at runtime — for types alone, keeping the
 * folder's module graph acyclic; the one runtime edge within the folder is to
 * `./end-session`, which imports nothing from here.
 *
 * @example
 * ```ts
 * // Registered by `registerCommands` in `./index`:
 * 'debuggen.reopenSession': (...args) => reopenSession(ctx, ...args),
 *
 * // A Sessions tree row invokes it with the bare id:
 * item.command = { command: 'debuggen.reopenSession', title: 'Reopen Session', arguments: [id] };
 * ```
 *
 * @packageDocumentation
 */

import type * as vscode from 'vscode';

import type { SessionRecord } from '@debuggen/protocol';
import { DebuggenError, isErr } from '@debuggen/shared';

import { formatSessionLabel, summarizeSession } from '../views/sessions-tree';
import type { SessionListItem } from '../views/sessions-tree';

import { captureServiceEndpoint, endBeforeReplacing } from './end-session';
import type {
  CommandContext,
  CommandId,
  CommandNotice,
  DestructiveConfirmation,
  SESSION_VIEW_FOCUS_COMMAND,
} from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This command's id, as `registerCommands` registers it; the `command` field of every log record. */
const COMMAND_ID = 'debuggen.reopenSession' satisfies CommandId;

/**
 * The generated focus command of the `debuggen.session` webview view.
 *
 * `./index` owns the runtime constant but imports this module at runtime, so
 * the value is restated here and typed by the barrel's constant: a rename of
 * the view id makes this literal a compile error rather than a silent miss.
 */
const SESSION_VIEW_FOCUS: typeof SESSION_VIEW_FOCUS_COMMAND = 'debuggen.session.focus';

/** The headline prefix of every reopen failure; the service's message follows it. */
const REOPEN_FAILURE_PREFIX = 'Could not reopen that session';

/** The headline prefix when the stored sessions cannot be listed for the quick pick. */
const LIST_FAILURE_PREFIX = 'Could not list the stored sessions';

/** The quick pick's title and placeholder. */
const PICK_OPTIONS: vscode.QuickPickOptions = Object.freeze({
  title: 'Reopen Session',
  placeHolder: 'Select a stored debugging session to reopen',
  matchOnDetail: true,
});

/** Marks the session already shown in the view, so picking it again is not a surprise. */
const ACTIVE_SESSION_DESCRIPTION = 'Current session';

/** Shown when the service answered and holds no stored session. */
const NO_STORED_SESSIONS_NOTICE: CommandNotice = Object.freeze({
  level: 'info',
  message: 'No stored sessions yet.',
  detail: 'Ask a question in the Debug Generator view to start one.',
});

/**
 * Shown instead of {@link NO_STORED_SESSIONS_NOTICE} when the list is empty
 * because the service could not be reached, so an outage is never presented
 * as an empty store.
 */
const SERVICE_UNREACHABLE_NOTICE: CommandNotice = Object.freeze({
  level: 'warning',
  message: 'Stored sessions could not be listed because the local service is not running.',
  detail: 'Run “Debug Generator: Start Local Service”, then reopen the session again.',
});

/**
 * Shown after a successful reopen while the WebSocket is not open: the view
 * already holds the record, but the service's replay — the latest panel, here
 * and in DevTools — reaches this editor only over that connection.
 */
const CONNECTION_PENDING_NOTICE: CommandNotice = Object.freeze({
  level: 'warning',
  message: 'Session reopened, but the connection to the local service is not open.',
  detail:
    'The stored panel re-renders here and in the DevTools panel once the connection is restored.',
});

/**
 * Asked before a live session in view is ended so that another can be
 * reopened. It states what ending does and what it keeps.
 */
const END_AND_REOPEN_CONFIRMATION: DestructiveConfirmation = Object.freeze({
  message: 'End the current session and reopen the selected one?',
  detail:
    'The current session is still live. Reopening another session ends it first, which removes its instrumentation and restores the files it modified. Its data stays stored, so you can reopen it later.',
  confirmLabel: 'End and Reopen',
});

/**
 * Shown when a start or reopen is already replacing the active session: a
 * second one in flight could adopt a session the first has not ended, so it is
 * refused rather than queued.
 */
const REPLACEMENT_IN_FLIGHT_NOTICE: CommandNotice = Object.freeze({
  level: 'info',
  message: 'A debugging session is already being started or reopened.',
  detail: 'Wait for it to appear in the Debug Generator view, then reopen the session again.',
});

/** Control characters: never part of a session id (the protocol's id schema refuses them). */
const CONTROL_CHARACTER = /\p{Cc}/u;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One quick-pick row; the id travels on the item rather than being parsed back out of the label. */
interface SessionPickItem extends vscode.QuickPickItem {
  /** The stored session's id, exactly as the service listed it. */
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Reopens a stored session in the Debug Generator view.
 *
 * With a usable argument — the bare id a Sessions tree row passes, or the
 * session node the inline tree action passes — that session is reopened
 * directly. Otherwise (the Command Palette, or an argument that names no
 * session) the developer picks from the stored sessions; cancelling the pick
 * ends the command silently.
 *
 * Once the extension is shutting down (`ExtensionState.isShuttingDown`) the
 * command refuses silently — before the request, after it, and after the
 * session in view was ended — so nothing is adopted that `deactivate()` would
 * not end. While another start or reopen is replacing the active session, the
 * command refuses with one notice. Otherwise it opens a creation window and fetches the
 * record with one `GET /sessions/:id`. On failure — a session purged by
 * retention, an unreachable service — exactly one explanation is shown and the
 * view is left untouched. On success, a different session still live in view
 * is ended first, after the developer confirms (see the module documentation);
 * declining, or a cleanup that leaves something to review, stops the reopen
 * with the view as it was or showing the ended session's verdict. The record
 * is then adopted as one coalesced change — none of the previous session's
 * progress, modifications, analysis or panel lingers — and the view is
 * revealed.
 *
 * @param ctx The resolved command context.
 * @param args What VS Code invoked the command with; only `args[0]` is read.
 */
export async function reopenSession(
  ctx: CommandContext,
  ...args: readonly unknown[]
): Promise<void> {
  const sessionId = sessionIdFromArgument(args[0]) ?? (await pickStoredSession(ctx));
  if (sessionId === undefined) {
    return;
  }

  if (ctx.state.isShuttingDown) {
    logShutdownRefusal(ctx, 'before-request');
    return;
  }
  if (ctx.state.sessionCreationPending) {
    ctx.logger.info('Session reopen refused while another replacement is in flight', {
      command: COMMAND_ID,
    });
    await ctx.ui.notify(REPLACEMENT_IN_FLIGHT_NOTICE);
    return;
  }

  const reopening = ctx.state.beginSessionCreation();
  try {
    // The service that answers holds the session, so its address is captured
    // before the request is sent and becomes the reopened session's owning
    // endpoint: a `debuggen.serviceUrl` change mid-request must not re-home it.
    const captured = captureServiceEndpoint(ctx);
    if (isErr(captured)) {
      await ctx.ui.notifyFailure(captured.error, { prefix: REOPEN_FAILURE_PREFIX });
      return;
    }
    const endpoint = captured.value;

    const loaded = await ctx.client.getSession(sessionId, { endpoint });
    if (isErr(loaded)) {
      await ctx.ui.notifyFailure(loaded.error, { prefix: REOPEN_FAILURE_PREFIX });
      return;
    }

    const record = loaded.value;
    if (record.id !== sessionId) {
      // A contract breach, not an expected outcome: applying it would show a
      // session the developer did not ask for.
      await ctx.ui.notifyFailure(
        new DebuggenError(
          'PROTOCOL_INVALID_MESSAGE',
          'The local service answered with a different session than the one requested.',
          { hint: 'Refresh the Sessions view and select the session again.' },
        ),
        { prefix: REOPEN_FAILURE_PREFIX },
      );
      return;
    }

    // Shutdown closes every window: a `deactivate()` that ran while the record
    // was being fetched stops the reopen before it asks anything.
    if (ctx.state.isShuttingDown || !reopening.isOpen) {
      logShutdownRefusal(ctx, 'after-request');
      return;
    }
    if (!(await endActiveBeforeReopening(ctx, record))) {
      return;
    }
    if (ctx.state.isShuttingDown || !reopening.isOpen) {
      logShutdownRefusal(ctx, 'after-replacing');
      return;
    }
    reopening.adopt(record, endpoint);
  } finally {
    // A no-op once adopted; closes the window on every other exit.
    reopening.abandon();
  }

  await revealSessionView(ctx);

  if (ctx.client.state !== 'open') {
    await ctx.ui.notify(CONNECTION_PENDING_NOTICE);
  }

  ctx.logger.info('Session reopened', { command: COMMAND_ID });
}

/**
 * Logs that a reopen was refused because the extension is shutting down. No
 * notice is shown: the window is closing, and `deactivate()` owns what is
 * left.
 *
 * @param ctx The command context.
 * @param point Where the gate closed: before `GET /sessions/:id`, after it, or
 *   after the session in view was ended.
 */
function logShutdownRefusal(
  ctx: CommandContext,
  point: 'before-request' | 'after-request' | 'after-replacing',
): void {
  ctx.logger.info('Session reopen refused because the extension is shutting down', {
    command: COMMAND_ID,
    point,
  });
}

// ---------------------------------------------------------------------------
// Resolving the session id
// ---------------------------------------------------------------------------

/**
 * The session id an invoking argument carries, or `undefined` when it carries
 * none — which sends the command to the quick pick rather than to a guess.
 *
 * Accepted shapes, and nothing else:
 *
 * - a bare id string — a Sessions tree row's click (`arguments: [id]`);
 * - an object with a top-level `sessionId` — the tree's `SessionNode`, which
 *   the inline `view/item/context` action passes;
 * - an object whose `session` carries an `id` — the same node read through
 *   its record.
 *
 * A tree item's own `id` is deliberately not read: it is a view key
 * (`session:‹id›`), not a session id.
 */
function sessionIdFromArgument(argument: unknown): string | undefined {
  if (typeof argument === 'string') {
    return asSessionId(argument);
  }
  if (typeof argument !== 'object' || argument === null) {
    return undefined;
  }
  if ('sessionId' in argument) {
    const direct = asSessionId(argument.sessionId);
    if (direct !== undefined) {
      return direct;
    }
  }
  if ('session' in argument) {
    const { session } = argument;
    if (typeof session === 'object' && session !== null && 'id' in session) {
      return asSessionId(session.id);
    }
  }
  return undefined;
}

/**
 * `value` when it has the shape of a session id: a non-blank string with no
 * surrounding whitespace and no control characters. The value is never
 * trimmed or repaired — an id that needs repair is not an id this editor was
 * given by the service. Whether it names a stored session is the service's
 * answer, not this check's.
 */
function asSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  if (value.trim() !== value || CONTROL_CHARACTER.test(value)) {
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The palette path
// ---------------------------------------------------------------------------

/**
 * Lets the developer choose a stored session.
 *
 * Reads the list the Sessions tree already loaded into `ExtensionState`; when
 * it is empty (the tree was never shown, or the store really is empty) it asks
 * the tree to refresh once — the tree's single-flight `GET /sessions`, which
 * writes the answer back through `setSessionList` — and reads it again.
 *
 * @returns The picked session's id, or `undefined` when there is nothing to
 *   pick (after one explanatory notice) or the developer cancelled (silently).
 */
async function pickStoredSession(ctx: CommandContext): Promise<string | undefined> {
  let sessions: readonly SessionListItem[] = ctx.state.sessionList;
  if (sessions.length === 0) {
    await ctx.sessionsTree.refresh();
    sessions = ctx.state.sessionList;
  }

  if (sessions.length === 0) {
    await explainEmptyList(ctx);
    return undefined;
  }

  const items = toSessionPickItems(sessions, ctx.state.activeSessionId);
  const picked = await ctx.ui.pick(items, PICK_OPTIONS);
  return picked?.sessionId;
}

/**
 * Shows the one notice for an empty list, choosing the true reason: a refused
 * service URL (its own error and hint), a service that is not running, or a
 * store with no sessions in it.
 *
 * The Sessions tree keeps the failure of its refresh to itself, so the reason
 * is read from the two signals the host publishes: the client's configuration
 * error, and the service's reachability together with the socket state. Both
 * must say "down" before an outage is claimed.
 */
async function explainEmptyList(ctx: CommandContext): Promise<void> {
  const refused = ctx.client.configurationError;
  if (refused !== undefined) {
    await ctx.ui.notifyFailure(refused, { prefix: LIST_FAILURE_PREFIX });
    return;
  }
  if (!ctx.state.serviceReachable && ctx.client.state !== 'open') {
    await ctx.ui.notify(SERVICE_UNREACHABLE_NOTICE);
    return;
  }
  await ctx.ui.notify(NO_STORED_SESSIONS_NOTICE);
}

/**
 * The quick-pick rows for the stored sessions: most recently updated first,
 * one row per id.
 *
 * The label is the Sessions tree's own session label, and the detail its
 * single-line summary (project, status, last update) — the multi-line
 * tooltip text would not render on a quick-pick row. `matchOnDetail` lets the
 * developer filter by project name as well as by question.
 */
function toSessionPickItems(
  sessions: readonly SessionListItem[],
  activeSessionId: string | undefined,
): SessionPickItem[] {
  const newestById = new Map<string, SessionListItem>();
  for (const session of sessions) {
    const held = newestById.get(session.id);
    if (held === undefined || compareForPick(session, held) < 0) {
      newestById.set(session.id, session);
    }
  }

  return [...newestById.values()].sort(compareForPick).map((session): SessionPickItem => ({
    label: formatSessionLabel(session.question),
    ...(session.id === activeSessionId ? { description: ACTIVE_SESSION_DESCRIPTION } : {}),
    detail: summarizeSession(session),
    sessionId: session.id,
  }));
}

/**
 * Orders rows `updatedAt` descending, then `createdAt` descending, then `id`
 * ascending, so the list never reshuffles between invocations. A timestamp
 * that is not finite sorts after every real one.
 */
function compareForPick(a: SessionListItem, b: SessionListItem): number {
  return (
    compareTimestampsDescending(a.updatedAt, b.updatedAt) ||
    compareTimestampsDescending(a.createdAt, b.createdAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Descending order of two epoch-millisecond timestamps; non-finite values last. */
function compareTimestampsDescending(a: number, b: number): number {
  const left = Number.isFinite(a) ? a : Number.NEGATIVE_INFINITY;
  const right = Number.isFinite(b) ? b : Number.NEGATIVE_INFINITY;
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Applying and revealing
// ---------------------------------------------------------------------------

/**
 * Ends the session in view before `record` replaces it, and says whether the
 * reopen may proceed.
 *
 * Nothing is ended when no session is active or `record` is the session in
 * view (its record is merged; nothing is reset). A different session that is
 * still live is ended only after the developer confirms; declining returns
 * `false` silently, with nothing changed. The end itself — and every notice a
 * refused or unsettled end produces — is {@link endBeforeReplacing}'s, which
 * also lets an already-ended session with a settled verdict go without a
 * request.
 *
 * @param ctx The command context.
 * @param record The authoritative record of the session being reopened.
 * @returns `true` when the store may adopt `record`.
 */
async function endActiveBeforeReopening(
  ctx: CommandContext,
  record: SessionRecord,
): Promise<boolean> {
  const active = ctx.state.activeSession;
  if (active === undefined || active.id === record.id) {
    return true;
  }
  if (active.status !== 'ended') {
    const confirmed = await ctx.ui.confirmDestructive(END_AND_REOPEN_CONFIRMATION);
    if (!confirmed) {
      ctx.logger.info('Session reopen declined; the current session stays live', {
        command: COMMAND_ID,
        sessionId: active.id,
      });
      return false;
    }
  }
  return endBeforeReplacing(ctx, 'reopen');
}

/**
 * Reveals the Debug Generator view on the reopened session.
 *
 * The session is already applied when this runs, so a view that cannot be
 * focused is not a failed reopen: it is logged by code for diagnosis and the
 * command carries on rather than reporting the reopen as failed.
 */
async function revealSessionView(ctx: CommandContext): Promise<void> {
  try {
    await ctx.ui.executeCommand(SESSION_VIEW_FOCUS);
  } catch (error) {
    ctx.logger.debug('Session view could not be revealed', {
      command: COMMAND_ID,
      code: DebuggenError.from(error).code,
    });
  }
}
