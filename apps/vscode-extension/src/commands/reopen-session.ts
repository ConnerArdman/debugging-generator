/**
 * `debuggen.reopenSession` — brings a stored debugging session back into the
 * Debug Generator view (AAP §0.4.2 "Session persistence", §0.7.3, §0.8.1
 * slice 2 "reopen after restart").
 *
 * ## The whole command
 *
 * ```text
 * argument (Sessions tree row / inline action)   ─┐
 *                                                  ├─▶ session id ─▶ GET /sessions/:id
 * Command Palette ─▶ quick pick of stored sessions ─┘        │
 *                                                            ▼
 *                         ExtensionState: reset (if another session was active)
 *                                         + applySessionRecord(authoritative record)
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
 * it and sends nothing over the socket.
 *
 * ## Why this command writes session-scoped state
 *
 * Every other command in this folder leaves the session-scoped fields of
 * `ExtensionState` to the WebSocket broadcast. Reopening is the exception the
 * requirements name: the value applied is the service's own authoritative
 * record, applied exactly as a `session.updated` push would apply it, so the
 * replay that follows is idempotent with it. Applying it here is what makes
 * the view repopulate even while the socket is still reconnecting.
 *
 * ## Invariants
 *
 * - **Thin.** Resolve the id, one `GET /sessions/:id`, apply, reveal. The only
 *   other request is the single `GET /sessions` refresh of the empty-list
 *   palette path, issued through the Sessions tree's single-flight loader.
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
 * folder's module graph acyclic.
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

import type { CommandContext, CommandId, CommandNotice, SESSION_VIEW_FOCUS_COMMAND } from './index';

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
 * The record is fetched with one `GET /sessions/:id`. On failure — a session
 * purged by retention, an unreachable service — exactly one explanation is
 * shown and the view is left untouched. On success, a different active
 * session is cleared first so none of its progress, modifications, analysis or
 * panel lingers, the record is applied as one coalesced change, and the view
 * is revealed.
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

  const loaded = await ctx.client.getSession(sessionId);
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

  applyReopenedRecord(ctx, record);
  await revealSessionView(ctx);

  if (ctx.client.state !== 'open') {
    await ctx.ui.notify(CONNECTION_PENDING_NOTICE);
  }

  ctx.logger.info('Session reopened', { command: COMMAND_ID });
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
 * Makes `record` the session in view, as one coalesced store change.
 *
 * `applySessionRecord` adopts a record as the active session only when no
 * session is active or it is the active one, so a different active session is
 * reset first — which also clears its progress rows, modifications, analysis
 * and panel summary. Reopening the session already in view resets nothing; a
 * stored record older than the one held is ignored by the store itself.
 */
function applyReopenedRecord(ctx: CommandContext, record: SessionRecord): void {
  const { state } = ctx;
  state.batch(() => {
    const activeSessionId = state.activeSessionId;
    if (activeSessionId !== undefined && activeSessionId !== record.id) {
      state.resetSession();
    }
    state.applySessionRecord(record);
  });
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
