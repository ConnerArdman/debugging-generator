/**
 * The command registration barrel of the VS Code extension and the type
 * foundation of `src/commands/` (AAP §0.7.1 Group 3).
 *
 * ## What this file owns
 *
 * 1. **The id table.** {@link COMMAND_IDS} lists the twelve contributed command
 *    ids as literals, in the order of `contributes.commands` in
 *    `apps/vscode-extension/package.json`. The manifest declares no `onCommand`
 *    activation events (contributed commands activate the extension on their
 *    own since VS Code 1.74), so an id missing from the table is a command that
 *    fails outright when invoked from the Command Palette.
 * 2. **The injected contracts.** {@link CommandContext} is the one argument
 *    every command module receives: the six runtime objects `src/extension.ts`
 *    owns, the logger, and four ports — {@link CommandUi} (the only
 *    developer-facing message path), {@link CommandGuards} (the two shared
 *    preconditions), {@link CommandDiscovery} and {@link OpenSourcePort}. The
 *    ports have production defaults here and can be replaced by test doubles
 *    through {@link CommandDeps}.
 * 3. **Registration.** {@link registerCommands} builds the context, maps every
 *    id to its module's exported function and registers each one behind a
 *    wrapper that turns an unexpected throw into exactly one logged, rendered
 *    failure.
 *
 * ## What it deliberately does not do
 *
 * It performs no HTTP call and holds no copy of server state: commands validate
 * preconditions, run their operations through `ServiceClient` and let the
 * WebSocket broadcast update the store. Four commands also write a service
 * answer into the session-scoped fields of `src/state.ts`, exactly as the
 * service gave it: `debuggen.startSession` adopts the `POST /sessions` record
 * through a creation window, `debuggen.reopenSession` adopts the
 * `GET /sessions/:id` record, `debuggen.endSession` (with the shared
 * `endBeforeReplacing` gate the other two pass first) records the
 * `session.end` answer through `applySessionEnded` — followed, for a
 * `partial` or `conflict` verdict, by the owner's `GET /sessions/:id` record
 * and modification journal (`applySessionRecord`, `applyModificationJournal`),
 * so the conflicted files and their backups reach the view without the socket
 * — and `debuggen.showModifications` records the journal it fetches through
 * `applyModificationJournal`. That is what keeps the
 * editor tracking at most one live session, owned by the service endpoint that
 * answered it, which `deactivate()` ends there. Once `deactivate()` has begun a
 * shutdown, neither `debuggen.startSession` nor `debuggen.reopenSession`
 * creates or adopts anything, and a create already in flight is tracked in the
 * store's create ledger so the shutdown routine ends what it produced. It
 * renders no UI and imports no renderer package — this is the extension-host
 * project (Node + `vscode` types, no DOM).
 *
 * ## Module graph
 *
 * The twelve command modules import **types only** from this file; everything
 * they need at runtime arrives on {@link CommandContext}. The runtime edges
 * are therefore this barrel → each module, plus `./start-session` and
 * `./reopen-session` → `./end-session` for `endBeforeReplacing` and
 * `captureServiceEndpoint` (and, from `./start-session`, its
 * `SESSION_CREATE_TIMEOUT_MS` request budget);
 * `./end-session` imports nothing from either — so the folder stays acyclic.
 * From outside the folder, `src/extension.ts` imports
 * `endSessionsForShutdown` from `./end-session` directly: it is what
 * `deactivate()` runs, and it needs no {@link CommandContext}. Every other
 * runtime helper shared by the commands (message formatting, the guards)
 * lives behind the ports defined here.
 *
 * @example
 * ```ts
 * // In activate(), once the service client, process manager, credential
 * // store and both views exist:
 * registerCommands(context, {
 *   state,
 *   client,
 *   serviceProcess,
 *   credentials,
 *   sessionView,
 *   sessionsTree,
 *   logger,
 * });
 * ```
 */

import * as vscode from 'vscode';

import type { SessionRecord, SourceLocation } from '@debuggen/protocol';
import { DebuggenError, assertNever, isErr } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

import type { EditorCredentialStore } from '../service/auth';
import type { ServiceClient } from '../service/client';
import { normalizeDevServerUrl, probeDevServer, resolveProjectRoot } from '../service/discovery';
import type { ProjectRootInfo } from '../service/discovery';
import type { ServiceProcess } from '../service/process';
import { openSourceLocation } from '../source/open-location';
import type { OpenSourceContext, RevealOutcome } from '../source/open-location';
import type { ExtensionState } from '../state';
import type { SESSION_VIEW_ID, SessionViewProvider } from '../views/session-view-provider';
import type { SessionsTreeProvider } from '../views/sessions-tree';
import type { HostToWebviewMessageOf } from '../webview-messages';

import { endSession } from './end-session';
import { launchDevServer } from './launch-dev-server';
import { openSource } from './open-source';
import { pairChrome } from './pair-chrome';
import { purgeSessions } from './purge-sessions';
import { reopenSession } from './reopen-session';
import { rotateServiceToken } from './rotate-service-token';
import { showModifications } from './show-modifications';
import { startCapture } from './start-capture';
import { startService } from './start-service';
import { startSession } from './start-session';
import { stopCapture } from './stop-capture';

// ---------------------------------------------------------------------------
// Command ids
// ---------------------------------------------------------------------------

/**
 * Every contributed command id, in `package.json` `contributes.commands` order.
 *
 * Written as literals — never concatenated or templated — so a text search of
 * the repository finds each id. {@link registerCommands} registers in this
 * order, and `apps/vscode-extension/test/suite/commands.test.ts` asserts that
 * the registered set equals the manifest's set exactly.
 */
export const COMMAND_IDS = [
  'debuggen.startSession',
  'debuggen.startCapture',
  'debuggen.stopCapture',
  'debuggen.endSession',
  'debuggen.openSource',
  'debuggen.launchDevServer',
  'debuggen.showModifications',
  'debuggen.reopenSession',
  'debuggen.startService',
  'debuggen.pairChrome',
  'debuggen.rotateServiceToken',
  'debuggen.purgeSessions',
] as const;

/** One contributed command id. */
export type CommandId = (typeof COMMAND_IDS)[number];

/**
 * The shape VS Code invokes a command with. Callers may pass anything — a tree
 * item, a `SourceLocation` forwarded from the webview, an options object or
 * nothing at all — so every handler accepts `unknown` and validates.
 */
export type CommandHandler = (...args: readonly unknown[]) => Promise<void>;

/**
 * The command that reveals and focuses the `debuggen.session` webview view.
 *
 * VS Code auto-generates `<viewId>.focus` for every contributed view, so this
 * id is not in `contributes.commands` and is not registered here. It must stay
 * in sync with `SESSION_VIEW_ID` in `src/views/session-view-provider.ts`; the
 * template-literal annotation makes a rename of that view id a compile error on
 * this line. `start-session.ts` and `show-modifications.ts` reveal the view
 * through this constant.
 */
export const SESSION_VIEW_FOCUS_COMMAND: `${typeof SESSION_VIEW_ID}.focus` =
  'debuggen.session.focus';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The severity vocabulary of a developer-facing notice: exactly the `level`
 * union of the webview's `notice` message (`src/webview-messages.ts`).
 */
export type CommandNoticeLevel = HostToWebviewMessageOf<'notice'>['level'];

/** A notice rendered in the Debug Generator view and as a VS Code notification. */
export interface CommandNotice {
  /** Selects the notification variant and the view's notice styling. */
  readonly level: CommandNoticeLevel;
  /** The headline: what happened. */
  readonly message: string;
  /**
   * The actionable half — what to do next. Shown as the view notice's `hint`
   * and appended to the notification text.
   */
  readonly detail?: string | undefined;
  /**
   * Notification buttons. When present, the returned promise waits for the
   * developer's choice; when absent it resolves as soon as the notice is shown.
   */
  readonly actions?: readonly string[] | undefined;
}

/** Options of {@link CommandUi.notifyFailure}. */
export interface FailureNoticeOptions {
  /** What was being attempted, e.g. `Could not start a session`. */
  readonly prefix?: string | undefined;
  /** Notification buttons; see {@link CommandNotice.actions}. */
  readonly actions?: readonly string[] | undefined;
}

/** Options of {@link CommandUi.confirmDestructive}. */
export interface DestructiveConfirmation {
  /** The modal's headline. */
  readonly message: string;
  /** What will be lost, stated plainly. */
  readonly detail: string;
  /** The label of the one button that confirms. */
  readonly confirmLabel: string;
}

/**
 * The only developer-facing message path of the commands. Every failure a
 * command reports goes through {@link notifyFailure} exactly once, and appears
 * both in the Debug Generator view and as a VS Code notification.
 */
export interface CommandUi {
  /**
   * Posts `notice` to the view and shows the matching
   * `showInformationMessage` / `showWarningMessage` / `showErrorMessage`.
   *
   * @returns The chosen action, or `undefined` when the notice was dismissed
   *   or offered no actions.
   */
  notify(notice: CommandNotice): Promise<string | undefined>;
  /**
   * Renders a failure as one error notice, never as success (AAP §0.5.5):
   * `prefix: error.message` as the headline (the message alone without a
   * prefix) and `error.hint`, when set, as the detail. The service's error
   * payload is `{ code, message, ref? }`, so recovery text it writes, such as
   * the dev-server relaunch command, arrives in `error.message`; `hint` is set
   * on this side, by the protocol `HttpClient` from a refusal's code and status
   * or by the local module that failed. A capture 409's owner
   * (`error.details.owningSessionId`) is the calling command's to read, and
   * cleanup backup paths arrive in `cleanup.conflicts[]`, not in an error.
   * Never includes `error.details`, a stack, a credential or a URL query string.
   */
  notifyFailure(error: DebuggenError, options?: FailureNoticeOptions): Promise<string | undefined>;
  /**
   * Asks for confirmation in a modal warning.
   *
   * @returns `true` only when the developer chose exactly `confirmLabel`.
   */
  confirmDestructive(options: DestructiveConfirmation): Promise<boolean>;
  /** Shows a single-selection quick pick. */
  pick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions,
  ): Promise<T | undefined>;
  /**
   * Runs a VS Code command. Called only with constants:
   * {@link SESSION_VIEW_FOCUS_COMMAND}, a view reveal derived from
   * `SESSIONS_VIEW_ID`, or a {@link CommandId}.
   */
  executeCommand<T = unknown>(command: string, ...args: readonly unknown[]): Promise<T>;
}

/** The session a command acts on, as returned by {@link CommandGuards.requireActiveSession}. */
export interface ActiveSessionRef {
  /** The active session's id; always non-empty. */
  readonly sessionId: string;
  /** The session record, when the store has received it. */
  readonly session: SessionRecord | undefined;
}

/**
 * The two preconditions shared by several commands. Each renders its own
 * message and returns `undefined` when unmet — it never throws — so a caller's
 * guard is a two-line early return:
 *
 * ```ts
 * const active = ctx.guards.requireActiveSession();
 * if (!active) return;
 * ```
 */
export interface CommandGuards {
  /** The active session, or `undefined` after telling the developer how to start one. */
  requireActiveSession(): ActiveSessionRef | undefined;
  /** The workspace project to debug, or `undefined` after explaining what is missing. */
  requireWorkspaceProject(): ProjectRootInfo | undefined;
}

/**
 * A structural port over `src/service/discovery.ts`, typed from the functions
 * themselves so the signatures cannot drift; the extension-host test suite
 * substitutes a double through {@link CommandDeps.discovery}.
 */
export interface CommandDiscovery {
  readonly resolveProjectRoot: typeof resolveProjectRoot;
  readonly probeDevServer: typeof probeDevServer;
  readonly normalizeDevServerUrl: typeof normalizeDevServerUrl;
}

/**
 * The session-scoped source opener. The default delegates to
 * `openSourceLocation`, which re-validates the location against the given
 * project root and returns every refusal as a typed `Err`. Reporting that
 * `Err` is the caller's job: `debuggen.openSource` renders it once through
 * {@link CommandUi.notifyFailure}, so the default keeps the opener's own
 * warning notification silent rather than doubling every refusal.
 */
export interface OpenSourcePort {
  open(
    location: SourceLocation,
    context: OpenSourceContext,
  ): Promise<Result<RevealOutcome, DebuggenError>>;
}

// ---------------------------------------------------------------------------
// Dependencies and context
// ---------------------------------------------------------------------------

/** The runtime objects `src/extension.ts` constructs and owns. */
export interface CommandServices {
  /** The single host cache of view state; commands read it and never copy it. */
  readonly state: ExtensionState;
  /** Every HTTP operation and the WebSocket connection to the local service. */
  readonly client: ServiceClient;
  /** The embedded local-service process manager. */
  readonly serviceProcess: ServiceProcess;
  /** The editor credential; its token is never logged or displayed. */
  readonly credentials: EditorCredentialStore;
  /** The `debuggen.session` webview view — the only sender of host→webview messages. */
  readonly sessionView: SessionViewProvider;
  /** The `debuggen.sessions` tree of stored sessions. */
  readonly sessionsTree: SessionsTreeProvider;
  /** Message-first logger; fields never carry message bodies or credentials. */
  readonly logger: Logger;
}

/**
 * What `src/extension.ts` passes to {@link registerCommands}. The four ports are
 * optional so activation can build the runtime without knowing this folder's
 * internals; each one left out gets its production default.
 */
export interface CommandDeps extends CommandServices {
  readonly ui?: CommandUi | undefined;
  readonly guards?: CommandGuards | undefined;
  readonly discovery?: CommandDiscovery | undefined;
  readonly openSource?: OpenSourcePort | undefined;
}

/**
 * The resolved context every command module's exported function takes as its
 * first parameter: {@link CommandServices} plus all four ports.
 */
export interface CommandContext extends CommandServices {
  readonly ui: CommandUi;
  readonly guards: CommandGuards;
  readonly discovery: CommandDiscovery;
  readonly openSource: OpenSourcePort;
}

// ---------------------------------------------------------------------------
// Default ports
// ---------------------------------------------------------------------------

/**
 * Upper bound on each displayed text part. Error messages can embed large
 * validation dumps; a notification is not the place to read them (the Output
 * channel carries the log).
 */
const MAX_DISPLAY_TEXT_LENGTH = 500;

/** `scheme://authority/path` followed by a query or fragment; group 1 keeps the base. */
const URL_WITH_QUERY = /\b((?:https?|wss?):\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;

/** An `Authorization: Bearer …` value that leaked into an error message. */
const BEARER_VALUE = /\bBearer\s+\S+/gi;

/**
 * Prepares text for display: strips URL query strings and fragments, masks a
 * bearer value, collapses whitespace and bounds the length (AAP §0.5.2, §0.5.6).
 * Returns `undefined` for empty input so an empty hint is never rendered.
 */
function toDisplayText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const cleaned = text
    .replace(URL_WITH_QUERY, '$1')
    .replace(BEARER_VALUE, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') {
    return undefined;
  }
  return cleaned.length > MAX_DISPLAY_TEXT_LENGTH
    ? `${cleaned.slice(0, MAX_DISPLAY_TEXT_LENGTH - 1).trimEnd()}…`
    : cleaned;
}

/** Shows the notification variant that matches `level`. */
function showNotification(
  level: CommandNoticeLevel,
  text: string,
  actions: readonly string[],
): Thenable<string | undefined> {
  switch (level) {
    case 'info':
      return vscode.window.showInformationMessage(text, ...actions);
    case 'warning':
      return vscode.window.showWarningMessage(text, ...actions);
    case 'error':
      return vscode.window.showErrorMessage(text, ...actions);
    default:
      return assertNever(level, 'Unknown notice level');
  }
}

/**
 * The production {@link CommandUi} over `vscode.window`, `vscode.commands` and
 * the session view.
 */
function createCommandUi(deps: Pick<CommandServices, 'sessionView' | 'logger'>): CommandUi {
  const { sessionView, logger } = deps;

  const notify = async (notice: CommandNotice): Promise<string | undefined> => {
    const message =
      toDisplayText(notice.message) ?? 'Debug Generator could not complete the action.';
    const detail = toDisplayText(notice.detail);

    try {
      sessionView.postNotice({ level: notice.level, message, hint: detail });
    } catch (error) {
      // The notification below still reaches the developer.
      logger.debug('Notice not posted to the view', {
        level: notice.level,
        code: DebuggenError.from(error).code,
      });
    }

    const text = detail === undefined ? message : `${message} ${detail}`;
    const actions = notice.actions ?? [];
    const shown = Promise.resolve(showNotification(notice.level, text, actions));
    if (actions.length === 0) {
      // A notification resolves only when it is dismissed; with nothing to
      // choose, waiting for that would hold the calling command (and the view
      // control that dispatched it) open for no reason.
      shown.catch((error: unknown) => {
        logger.debug('Notification could not be shown', {
          level: notice.level,
          code: DebuggenError.from(error).code,
        });
      });
      return undefined;
    }
    try {
      return await shown;
    } catch (error) {
      logger.debug('Notification could not be shown', {
        level: notice.level,
        code: DebuggenError.from(error).code,
      });
      return undefined;
    }
  };

  return {
    notify,

    notifyFailure: (error, options) => {
      const prefix = options?.prefix?.trim().replace(/[\s:]+$/, '');
      const headline =
        prefix === undefined || prefix === '' ? error.message : `${prefix}: ${error.message}`;
      return notify({
        level: 'error',
        message: headline,
        detail: error.hint,
        actions: options?.actions,
      });
    },

    confirmDestructive: async ({ message, detail, confirmLabel }) => {
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        confirmLabel,
      );
      return choice === confirmLabel;
    },

    pick: async <T extends vscode.QuickPickItem>(
      items: readonly T[],
      options: vscode.QuickPickOptions,
    ): Promise<T | undefined> => {
      return await vscode.window.showQuickPick(items, { ...options, canPickMany: false });
    },

    executeCommand: async <T = unknown>(
      command: string,
      ...args: readonly unknown[]
    ): Promise<T> => {
      return await vscode.commands.executeCommand<T>(command, ...args);
    },
  };
}

/** Shown when a command needs a session and none is active. */
const NO_ACTIVE_SESSION_NOTICE: CommandNotice = Object.freeze({
  level: 'warning',
  message: 'No active session.',
  detail: 'Ask a question in the Debug Generator view to start one.',
});

/** Shown when a command needs a project and the window has no workspace folder. */
const NO_WORKSPACE_FOLDER_NOTICE: CommandNotice = Object.freeze({
  level: 'warning',
  message: 'Open the project you want to debug as a workspace folder, then start a session.',
});

/** What the default guards need: the store, the logger and two resolved ports. */
type GuardDeps = Pick<CommandServices, 'state' | 'logger'> &
  Pick<CommandContext, 'ui' | 'discovery'>;

/** The production {@link CommandGuards}. */
function createCommandGuards(deps: GuardDeps): CommandGuards {
  const { state, logger, ui, discovery } = deps;
  return {
    requireActiveSession: () => {
      const sessionId = state.activeSessionId;
      if (sessionId === undefined || sessionId === '') {
        void ui.notify(NO_ACTIVE_SESSION_NOTICE);
        return undefined;
      }
      return { sessionId, session: state.activeSession };
    },

    requireWorkspaceProject: () => {
      const folders = vscode.workspace.workspaceFolders;
      if (folders === undefined || folders.length === 0) {
        void ui.notify(NO_WORKSPACE_FOLDER_NOTICE);
        return undefined;
      }
      const resolved = discovery.resolveProjectRoot({ logger });
      if (isErr(resolved)) {
        void ui.notifyFailure(resolved.error, {
          prefix: 'Could not determine the project to debug',
        });
        return undefined;
      }
      return resolved.value;
    },
  };
}

/** The production {@link CommandDiscovery}: the functions of `src/service/discovery.ts`. */
const DEFAULT_DISCOVERY: CommandDiscovery = Object.freeze({
  resolveProjectRoot,
  probeDevServer,
  normalizeDevServerUrl,
});

/**
 * Discards `openSourceLocation`'s own warning notification. The command that
 * uses this port reports the returned `Err` through {@link CommandUi}, which
 * reaches the Debug Generator view as well as a notification; letting the
 * opener show its toast too would give the developer two messages for one
 * refusal.
 */
function silenceOpenerWarning(): void {
  // Intentionally empty: see above. The refusal is still returned as an `Err`.
}

/**
 * The production {@link OpenSourcePort}: the session-scoped
 * `openSourceLocation`, with its warning left to the caller.
 */
const DEFAULT_OPEN_SOURCE: OpenSourcePort = Object.freeze({
  open: (location: SourceLocation, context: OpenSourceContext) =>
    openSourceLocation(location, context, { showWarning: silenceOpenerWarning }),
});

/**
 * Resolves the ports in dependency order — `ui` → `discovery` → `guards`
 * (which closes over both) → `openSource` — and freezes the result.
 */
function createCommandContext(deps: CommandDeps): CommandContext {
  const services: CommandServices = {
    state: deps.state,
    client: deps.client,
    serviceProcess: deps.serviceProcess,
    credentials: deps.credentials,
    sessionView: deps.sessionView,
    sessionsTree: deps.sessionsTree,
    logger: deps.logger,
  };
  const ui = deps.ui ?? createCommandUi(services);
  const discovery = deps.discovery ?? DEFAULT_DISCOVERY;
  const guards =
    deps.guards ??
    createCommandGuards({ state: services.state, logger: services.logger, ui, discovery });
  const openSource = deps.openSource ?? DEFAULT_OPEN_SOURCE;
  return Object.freeze({ ...services, ui, guards, discovery, openSource });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * The human name of each command in a failure headline — the `title` of its
 * `contributes.commands` entry.
 */
const COMMAND_TITLES: Readonly<Record<CommandId, string>> = Object.freeze({
  'debuggen.startSession': 'Start Debugging Session',
  'debuggen.startCapture': 'Start Capture',
  'debuggen.stopCapture': 'Stop Capture',
  'debuggen.endSession': 'End Session',
  'debuggen.openSource': 'Open Source Location',
  'debuggen.launchDevServer': 'Launch Dev Server',
  'debuggen.showModifications': 'Show File Modifications',
  'debuggen.reopenSession': 'Reopen Session',
  'debuggen.startService': 'Start Local Service',
  'debuggen.pairChrome': 'Pair Chrome DevTools Panel',
  'debuggen.rotateServiceToken': 'Rotate Service Token',
  'debuggen.purgeSessions': 'Purge Stored Sessions',
});

/**
 * Runs a command so that nothing escapes to VS Code's generic error toast.
 *
 * A command reports its own expected failures through {@link CommandUi} and
 * then returns normally, so only a genuinely unexpected throw reaches the
 * catch: it is logged by code (never by message body, credential, pairing code
 * or file content) and rendered once. The wrapper resolves rather than
 * rethrowing, because a rejection would make callers such as the session view
 * report the same failure a second time.
 */
function wrapHandler(id: CommandId, run: CommandHandler, ctx: CommandContext): CommandHandler {
  return async (...args: readonly unknown[]): Promise<void> => {
    try {
      await run(...args);
    } catch (thrown) {
      const error = DebuggenError.from(thrown);
      ctx.logger.warn('Command failed', { command: id, code: error.code });
      try {
        await ctx.ui.notifyFailure(error, { prefix: `${COMMAND_TITLES[id]} failed` });
      } catch (reportError) {
        ctx.logger.error('Command failure could not be reported', {
          command: id,
          code: DebuggenError.from(reportError).code,
        });
      }
    }
  };
}

/**
 * Maps every command id to its module's exported function.
 *
 * LOCKSTEP: this map, {@link COMMAND_IDS}, {@link COMMAND_TITLES} and
 * `contributes.commands` in `apps/vscode-extension/package.json` must change
 * together. `Record<CommandId, …>` makes a missing or extra id a compile error
 * here; `apps/vscode-extension/test/suite/commands.test.ts` compares the ids
 * registered at runtime with the manifest.
 */
function createHandlers(ctx: CommandContext): Readonly<Record<CommandId, CommandHandler>> {
  const handlers: Record<CommandId, CommandHandler> = {
    'debuggen.startSession': (...args) => startSession(ctx, ...args),
    'debuggen.startCapture': (...args) => startCapture(ctx, ...args),
    'debuggen.stopCapture': (...args) => stopCapture(ctx, ...args),
    'debuggen.endSession': (...args) => endSession(ctx, ...args),
    'debuggen.openSource': (...args) => openSource(ctx, ...args),
    'debuggen.launchDevServer': (...args) => launchDevServer(ctx, ...args),
    'debuggen.showModifications': (...args) => showModifications(ctx, ...args),
    'debuggen.reopenSession': (...args) => reopenSession(ctx, ...args),
    'debuggen.startService': (...args) => startService(ctx, ...args),
    'debuggen.pairChrome': (...args) => pairChrome(ctx, ...args),
    'debuggen.rotateServiceToken': (...args) => rotateServiceToken(ctx, ...args),
    'debuggen.purgeSessions': (...args) => purgeSessions(ctx, ...args),
  };
  return Object.freeze(handlers);
}

/**
 * Registers all twelve commands and adds each disposable to
 * `context.subscriptions`.
 *
 * Call exactly once per activation: VS Code throws when an id is registered a
 * second time. Registration follows {@link COMMAND_IDS}, so it happens in
 * manifest order.
 *
 * @param context The activating extension's context; owns the disposables.
 * @param deps The runtime objects plus any port overrides.
 */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const ctx = createCommandContext(deps);
  const handlers = createHandlers(ctx);
  for (const id of COMMAND_IDS) {
    const handler: CommandHandler = handlers[id];
    context.subscriptions.push(vscode.commands.registerCommand(id, wrapHandler(id, handler, ctx)));
  }
}
