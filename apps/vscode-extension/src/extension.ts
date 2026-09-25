/**
 * The activation entry point of the `debuggen.debug-generator` VS Code
 * extension (AAP §0.7.1 Group 3): the bundle entry `esbuild.mjs` compiles to
 * `dist/extension.js`, the manifest's `main`.
 *
 * This file is a **registry**, not a feature. It constructs the runtime once
 * per window, wires every collaborator to the others, routes each inbound
 * service frame to exactly one `ExtensionState` mutator, and guarantees the
 * end-of-session cleanup on shutdown. It holds no pipeline behaviour, no HTTP
 * route knowledge beyond the operation names `ServiceClient` exposes, no panel
 * logic and no copy of server state.
 *
 * ```text
 * activate(context)                                   (synchronous)
 *   ├─ OutputChannel "Debug Generator" + Logger        (log sink)
 *   ├─ settings snapshot                                (debuggen.*)
 *   ├─ ExtensionState                                   (the one host store)
 *   ├─ EditorCredentialStore                            ($DEBUGGEN_HOME/auth.json)
 *   ├─ project root                                     (discovery)
 *   ├─ ServiceClient                                    (ws + HTTP, lazy token)
 *   ├─ ServiceProcess                                   (embedded service child)
 *   ├─ debuggen.session webview · debuggen.sessions tree
 *   ├─ registerCommands (all twelve ids)
 *   ├─ registerDebuggenUriHandler
 *   ├─ inbound subscription table · transport · configuration · project root
 *   └─ void startup()                                   (never awaited)
 *
 * deactivate()                                        (asynchronous)
 *   1. POST /sessions/:id/end for the active session   (bounded, awaited)
 *   2. stop the service child this extension spawned   (only after 1 settled)
 *   3. close the WebSocket client
 * ```
 *
 * ## Why activation is synchronous
 *
 * `activationEvents` is exactly `["onUri", "onView:debuggen.session"]`;
 * contributed commands activate the extension on their own (VS Code ≥ 1.74),
 * but they only *run* if `activate` registered them. A `vscode://` URI that
 * woke the extension is delivered right after activation returns, so the URI
 * handler must be registered by then too. Everything that talks to the
 * service — the health probe, spawning the child, opening the socket — is
 * therefore started with `void startup()` and never awaited: a slow or absent
 * service still leaves a rendered view and working commands (AAP §0.5.5).
 *
 * ## Why deactivation is ordered
 *
 * AAP §0.5.1 lists VS Code deactivation among the three moments cleanup runs.
 * The extension host calls `deactivate()` and then disposes
 * `context.subscriptions` synchronously, before the promise settles. The end
 * request is therefore issued — and registered with
 * `ServiceProcess.keepAliveFor`, which holds off the child's termination —
 * before the first `await`, and the child is stopped only after the request
 * settled. The service also reconciles every outstanding modification record
 * on its next start; that is a safety net, not a substitute.
 *
 * ## What never happens here
 *
 * No credential reaches a log line, a notification or the output channel
 * (AAP §0.5.2, §0.5.6); no session data is written into the workspace (it
 * lives under `$DEBUGGEN_HOME`, owned by the service); nothing branches on the
 * question's wording or names a target application (AAP §0.5.4); and no
 * renderer package is imported — the host project has Node and `vscode` types
 * only (AAP §0.2.2).
 *
 * @module
 */

import * as vscode from 'vscode';
import { WebSocket } from 'ws';

import type {
  ConnectionState,
  MessageByType,
  SessionRecord,
  WsStateChangeDetail,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import { DebuggenError, createConsoleLogger, isErr, isOk } from '@debuggen/shared';
import type { LogFields, LogRecord, Logger } from '@debuggen/shared';

import { registerCommands } from './commands';
import type { CommandId } from './commands';
import { createEditorCredentialStore } from './service/auth';
import type { EditorCredentialStore } from './service/auth';
import { createServiceClient } from './service/client';
import type { ServiceClient } from './service/client';
import { readDevServerUrlSetting, resolveProjectRoot } from './service/discovery';
import { createServiceProcess, isServiceReachable } from './service/process';
import type {
  EmbeddedPaths,
  ServiceProcess,
  ServiceStatus,
  WorkspaceServiceEntry,
} from './service/process';
import { disposeSourceRevealResources, openSourceLocation } from './source/open-location';
import { ExtensionState } from './state';
import { registerDebuggenUriHandler } from './uri-handler';
import {
  SESSION_VIEW_ID,
  SESSION_VIEW_REGISTRATION_OPTIONS,
  SessionViewProvider,
} from './views/session-view-provider';
import type { SessionViewNotice } from './views/session-view-provider';
import { SESSIONS_VIEW_ID, SessionsTreeProvider } from './views/sessions-tree';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The host's output channel; the service child writes to its own channel. */
const OUTPUT_CHANNEL_NAME = 'Debug Generator';

/** The logger name recorded on every host record. */
const LOGGER_NAME = 'extension';

/** The configuration section of every `debuggen.*` setting. */
const CONFIGURATION_SECTION = 'debuggen';

/**
 * The four contributed settings, spelled as `affectsConfiguration` takes them.
 * Their defaults live in `package.json` `contributes.configuration` only.
 */
const SETTING = Object.freeze({
  serviceUrl: `${CONFIGURATION_SECTION}.serviceUrl`,
  autoStartService: `${CONFIGURATION_SECTION}.autoStartService`,
  devServerUrl: `${CONFIGURATION_SECTION}.devServerUrl`,
  provider: `${CONFIGURATION_SECTION}.provider`,
});

/**
 * The embedded artefacts inside the installed extension, relative to
 * `context.extensionUri` — `esbuild.mjs`'s `LAYOUT`. `.vscodeignore` keeps
 * `dist/service/**` and `dist/telemetry/**`, so every one of these survives
 * packaging, and `test/suite/packaged-vsix.test.ts` asserts they resolve from
 * an installed VSIX. They are always joined onto `context.extensionUri`, never
 * derived from `__dirname`, `process.cwd()` or a workspace path, because the
 * installed location is the only one guaranteed to exist.
 */
const EMBEDDED_LAYOUT = Object.freeze({
  serviceMain: ['dist', 'service', 'main.js'],
  servicePromptsDir: ['dist', 'service', 'prompts'],
  serviceSchema: ['dist', 'service', 'store', 'schema.sql'],
  telemetryPreload: ['dist', 'telemetry', 'node', 'register.mjs'],
} satisfies Record<keyof EmbeddedPaths, readonly string[]>);

/**
 * The workspace build of the service beside this extension in the monorepo
 * checkout (`apps/local-service`), used only in development mode and only
 * when the bundled entry is absent (AAP §0.7.1 Group 3: "or the workspace
 * build during development").
 */
const WORKSPACE_SERVICE_LAYOUT = Object.freeze({
  serviceMain: ['..', 'local-service', 'dist', 'main.js'],
  servicePromptsDir: ['..', 'local-service', 'prompts'],
});

/**
 * The bound on the end-of-session request `deactivate()` sends. The extension
 * host gives the whole shutdown roughly five seconds, and the request has to
 * leave room for stopping the child afterwards.
 */
const DEACTIVATE_END_SESSION_TIMEOUT_MS = 4_000;

/** How long `deactivate()` lets the settled service quiesce before signalling it. */
const DEACTIVATE_QUIESCE_TIMEOUT_MS = 500;

/** The grace window between `SIGTERM` and `SIGKILL` when `deactivate()` stops the child. */
const DEACTIVATE_STOP_GRACE_MS = 1_000;

/** The bound on the informational health read after the service answered. */
const HEALTH_READ_TIMEOUT_MS = 2_000;

/** The bound on a session lookup the `source.open` route needs. */
const SESSION_LOOKUP_TIMEOUT_MS = 3_000;

/** The upper bound of one displayed text part built from a service payload. */
const MAX_DISPLAY_TEXT_LENGTH = 500;

/** The upper bound of one serialised log-fields suffix in the output channel. */
const MAX_LOG_FIELDS_LENGTH = 4_000;

/** The command a refused credential is repaired with (AAP §0.5.6). */
const ROTATE_SERVICE_TOKEN_COMMAND = 'debuggen.rotateServiceToken' satisfies CommandId;

/** The command that starts the embedded service by the developer's request. */
const START_SERVICE_COMMAND = 'debuggen.startService' satisfies CommandId;

/** The fallback-panel banner copy of AAP §0.5.5. */
const FALLBACK_PANEL_NOTICE =
  'Generated panel failed validation; showing a fallback view built from captured data.';

/** A run of whitespace, collapsed to one space for display. */
const WHITESPACE_RUN = /\s+/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `debuggen.*` settings the host reads, as one snapshot. */
interface ExtensionSettings {
  /** `debuggen.serviceUrl`, trimmed; empty when unset or not a string. */
  readonly serviceUrl: string;
  /** `debuggen.autoStartService`; anything but `false` reads as the manifest default `true`. */
  readonly autoStartService: boolean;
  /** `debuggen.provider`, trimmed; empty when unset or not a string. */
  readonly provider: string;
}

/** Why the host asked for a service to answer. */
type EnsureTrigger = 'activation' | 'connection-lost' | 'settings-changed';

/**
 * Everything `activate` builds, kept in one module-scoped handle because
 * `deactivate()` receives no context. Each disposable member is also owned by
 * `context.subscriptions`.
 */
interface ExtensionRuntime {
  readonly logger: Logger;
  readonly state: ExtensionState;
  readonly credentials: EditorCredentialStore;
  readonly client: ServiceClient;
  readonly serviceProcess: ServiceProcess;
  readonly sessionView: SessionViewProvider;
  readonly sessionsTree: SessionsTreeProvider;
  /** Set when `deactivate()` begins; every asynchronous continuation checks it. */
  disposed: boolean;
  /** The socket state last reported, to detect a lost connection. */
  connection: ConnectionState;
}

/** The runtime of the current activation; `undefined` before `activate` and after `deactivate`. */
let runtime: ExtensionRuntime | undefined;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Serialises a record's fields for the output channel: bounded, cycle-safe and
 * total — a `bigint`, a function or an `Error` never makes a log call throw.
 * Fields carry codes, ids and shapes by the logging contract, never payloads
 * or credentials; this function only makes them printable.
 */
function formatLogFields(fields: LogFields): string {
  if (Object.keys(fields).length === 0) {
    return '';
  }
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text = JSON.stringify(fields, (_key, value: unknown): unknown => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
      }
      if (value instanceof Error) {
        return { name: value.name, code: DebuggenError.from(value).code };
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[circular]';
        }
        seen.add(value);
      }
      return value;
    });
  } catch {
    return ' [unserialisable fields]';
  }
  if (text.length > MAX_LOG_FIELDS_LENGTH) {
    text = `${text.slice(0, MAX_LOG_FIELDS_LENGTH - 1)}…`;
  }
  return ` ${text}`;
}

/**
 * The `LogSink` that routes structured records into the host's
 * `LogOutputChannel`. The channel applies its own level (the editor's
 * "Developer: Set Log Level…" for this channel), so the logger itself emits
 * everything and the developer controls the threshold where VS Code expects
 * it. A sink failure — a channel disposed during shutdown — is swallowed,
 * because a log line must never become an exception in product code.
 */
function createOutputChannelSink(channel: vscode.LogOutputChannel): (record: LogRecord) => void {
  return (record: LogRecord): void => {
    const line = `${record.message}${formatLogFields(record.fields)}`;
    try {
      switch (record.level) {
        case 'trace':
          channel.trace(line);
          return;
        case 'debug':
          channel.debug(line);
          return;
        case 'info':
          channel.info(line);
          return;
        case 'warn':
          channel.warn(line);
          return;
        case 'error':
        case 'fatal':
          channel.error(line);
          return;
      }
    } catch {
      // The channel is gone (window shutting down); nothing is left to tell.
    }
  };
}

/**
 * Rewrites service-supplied text as one bounded display line: control
 * characters become spaces, whitespace runs collapse, the ends are trimmed and
 * an over-long text is clipped with an ellipsis.
 */
function toDisplayText(text: string): string {
  let spaced = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    spaced += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  const line = spaced.replace(WHITESPACE_RUN, ' ').trim();
  return line.length <= MAX_DISPLAY_TEXT_LENGTH
    ? line
    : `${line.slice(0, MAX_DISPLAY_TEXT_LENGTH - 1).trimEnd()}…`;
}

/** Reads the three settings the host itself uses, afresh. Never throws. */
function readSettings(): ExtensionSettings {
  try {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const serviceUrl = configuration.get<unknown>('serviceUrl');
    const autoStartService = configuration.get<unknown>('autoStartService');
    const provider = configuration.get<unknown>('provider');
    return {
      serviceUrl: typeof serviceUrl === 'string' ? serviceUrl.trim() : '',
      autoStartService: autoStartService !== false,
      provider: typeof provider === 'string' ? provider.trim() : '',
    };
  } catch {
    return { serviceUrl: '', autoStartService: false, provider: '' };
  }
}

/**
 * Resolves the embedded artefacts from `context.extensionUri` as absolute
 * filesystem paths. The service child is spawned from `serviceMain` with
 * `DEBUGGEN_PROMPTS_DIR` set to `servicePromptsDir`; the schema and the
 * preload are checked by the process manager so an incomplete bundle is a
 * clear failure, and the service's dev-server launcher finds the preload
 * beside its own bundle.
 */
function resolveEmbeddedPaths(extensionUri: vscode.Uri): EmbeddedPaths {
  const at = (segments: readonly string[]): string =>
    vscode.Uri.joinPath(extensionUri, ...segments).fsPath;
  return Object.freeze({
    serviceMain: at(EMBEDDED_LAYOUT.serviceMain),
    servicePromptsDir: at(EMBEDDED_LAYOUT.servicePromptsDir),
    serviceSchema: at(EMBEDDED_LAYOUT.serviceSchema),
    telemetryPreload: at(EMBEDDED_LAYOUT.telemetryPreload),
  });
}

/**
 * The workspace build of the service, offered to the process manager only
 * when the extension runs from a checkout in development mode (F5). The
 * bundled entry still wins whenever it exists.
 */
function resolveWorkspaceService(
  context: vscode.ExtensionContext,
): WorkspaceServiceEntry | undefined {
  if (context.extensionMode !== vscode.ExtensionMode.Development) {
    return undefined;
  }
  const at = (segments: readonly string[]): string =>
    vscode.Uri.joinPath(context.extensionUri, ...segments).fsPath;
  return Object.freeze({
    serviceMain: at(WORKSPACE_SERVICE_LAYOUT.serviceMain),
    servicePromptsDir: at(WORKSPACE_SERVICE_LAYOUT.servicePromptsDir),
  });
}

/** Whether a session still owns instrumentation the service may have to remove. */
function isSessionOpen(session: SessionRecord | undefined): session is SessionRecord {
  return session !== undefined && session.status !== 'ended';
}

// ---------------------------------------------------------------------------
// Developer-facing messages
// ---------------------------------------------------------------------------

/**
 * Shows a VS Code notification without holding the caller: the returned
 * promise settles when the developer picks an action or dismisses it, and it
 * never rejects.
 */
async function showNotification(
  logger: Logger,
  notice: SessionViewNotice,
  actions: readonly string[] = [],
): Promise<string | undefined> {
  const text = notice.hint ? `${notice.message} ${notice.hint}` : notice.message;
  try {
    switch (notice.level) {
      case 'error':
        return await vscode.window.showErrorMessage(text, ...actions);
      case 'warning':
        return await vscode.window.showWarningMessage(text, ...actions);
      case 'info':
        return await vscode.window.showInformationMessage(text, ...actions);
    }
  } catch (error) {
    logger.debug('Notification could not be shown', {
      level: notice.level,
      code: DebuggenError.from(error).code,
    });
    return undefined;
  }
}

/**
 * Surfaces one notice exactly once: in the Debug Generator view when it is
 * resolved, otherwise as a notification.
 *
 * @param alreadyRendered `true` when the view already renders the same fact
 *   from `ExtensionState` (a stage failure, for instance), so a resolved view
 *   receives no duplicate and only a closed view falls back to a notification.
 */
function surface(rt: ExtensionRuntime, notice: SessionViewNotice, alreadyRendered = false): void {
  if (rt.disposed) {
    return;
  }
  if (rt.sessionView.isResolved) {
    if (!alreadyRendered) {
      rt.sessionView.postNotice(notice);
    }
    return;
  }
  void showNotification(rt.logger, notice);
}

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

/**
 * Activates the extension: builds the runtime, registers both views, all
 * twelve commands and the URI handler, wires the inbound subscription table,
 * and starts the service connection in the background.
 *
 * Synchronous by design (see the module documentation): nothing here waits on
 * the service. Every disposable is pushed into `context.subscriptions` as it
 * is created; should a step throw, everything this activation pushed —
 * including what `registerCommands` and `registerDebuggenUriHandler` pushed
 * themselves — is disposed, newest first, before the error propagates, so a
 * failed activation leaves no registration, listener or channel behind.
 *
 * @param context The extension context VS Code activates with.
 */
export function activate(context: vscode.ExtensionContext): void {
  const baseline = context.subscriptions.length;
  const own = <T extends vscode.Disposable>(disposable: T): T => {
    context.subscriptions.push(disposable);
    return disposable;
  };
  const ownUnsubscribe = (unsubscribe: () => void): void => {
    own(new vscode.Disposable(unsubscribe));
  };

  // 1. Output channel and logger. Every host module logs through this one
  //    logger; the channel is a LogOutputChannel so its level is the editor's.
  const channel = own(vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true }));
  const logger = createConsoleLogger({
    level: 'trace',
    name: LOGGER_NAME,
    sink: createOutputChannelSink(channel),
  });

  try {
    // 2. Configuration snapshot.
    const settings = readSettings();

    // 3. The single host store both views read.
    const state = own(
      new ExtensionState({ serviceUrl: settings.serviceUrl, provider: settings.provider }),
    );

    // 4. The editor credential. Nothing is read here: the client reads
    //    `$DEBUGGEN_HOME/auth.json` lazily on its first request, and the
    //    process manager creates it (0600) before spawning the service. The
    //    editor runs as the service's user, so it never pairs (AAP §0.5.6).
    const credentials = own(
      createEditorCredentialStore({ logger: logger.child({ component: 'credential' }) }),
    );

    // 5. The project this window debugs, announced in `client.hello`.
    const projectRoot = resolveProjectRoot({ logger: logger.child({ component: 'discovery' }) });
    if (isErr(projectRoot)) {
      logger.info('No project folder to announce yet', { code: projectRoot.error.code });
    }

    // 6. The service client. Built before the process manager because the
    //    manager's liveness probe *is* the client's auth-exempt `GET /health`.
    const client = own(
      createServiceClient({
        credential: credentials,
        projectRoot: isOk(projectRoot) ? projectRoot.value.projectRoot : undefined,
        logger: logger.child({ component: 'service-client' }),
        webSocketConstructor: WebSocket,
      }),
    );

    // 7. The embedded service child, from the artefacts inside the install.
    const serviceProcess = own(
      createServiceProcess({
        paths: resolveEmbeddedPaths(context.extensionUri),
        workspaceService: resolveWorkspaceService(context),
        probe: { health: (options) => client.health(options) },
        credential: credentials,
        logger: logger.child({ component: 'service-process' }),
      }),
    );

    // 8. Views, under the ids `package.json` contributes.
    const sessionView = own(
      new SessionViewProvider({
        extensionUri: context.extensionUri,
        state,
        client,
        logger,
      }),
    );
    own(
      vscode.window.registerWebviewViewProvider(
        SESSION_VIEW_ID,
        sessionView,
        SESSION_VIEW_REGISTRATION_OPTIONS,
      ),
    );
    const sessionsTree = own(new SessionsTreeProvider({ state, client, logger }));
    own(vscode.window.createTreeView(SESSIONS_VIEW_ID, { treeDataProvider: sessionsTree }));

    const rt: ExtensionRuntime = {
      logger,
      state,
      credentials,
      client,
      serviceProcess,
      sessionView,
      sessionsTree,
      disposed: false,
      connection: client.state,
    };

    // 9. Commands: the barrel owns the id → handler table.
    registerCommands(context, {
      state,
      client,
      serviceProcess,
      credentials,
      sessionView,
      sessionsTree,
      logger,
    });

    // 10. The `vscode://debuggen.debug-generator/open` fallback (registers itself).
    registerDebuggenUriHandler(context, { logger: logger.child({ component: 'uri-handler' }) });

    // 11. Reactivity.
    for (const unsubscribe of subscribeInbound(rt)) {
      ownUnsubscribe(unsubscribe);
    }
    for (const disposable of wireTransport(rt)) {
      own(disposable);
    }
    own(wireConfiguration(rt));
    for (const disposable of wireProjectRoot(rt)) {
      own(disposable);
    }
    own(new vscode.Disposable(disposeSourceRevealResources));

    const devServerUrl = readDevServerUrlSetting();
    if (isErr(devServerUrl)) {
      logger.warn('debuggen.devServerUrl is not usable', { code: devServerUrl.error.code });
    }

    runtime = rt;
    logger.info('Debug Generator activated', {
      serviceUrl: client.baseUrl ?? settings.serviceUrl,
      autoStartService: settings.autoStartService,
    });

    // Never awaited: activation must not wait on the service (AAP §0.5.5).
    void startup(rt).catch((error: unknown) => {
      logger.error('Service start-up failed unexpectedly', {
        code: DebuggenError.from(error).code,
      });
    });
  } catch (error) {
    logger.error('Activation failed', { code: DebuggenError.from(error).code });
    runtime = undefined;
    const pushed = context.subscriptions.splice(baseline);
    for (const disposable of pushed.reverse()) {
      try {
        disposable.dispose();
      } catch {
        // Best effort: the remaining disposables still get their turn.
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The inbound subscription table (AAP §0.4.2)
// ---------------------------------------------------------------------------

/**
 * Routes every frame the service pushes to the editor into exactly one
 * `ExtensionState` mutator (or, for `source.open`, into the editor itself).
 * The store coalesces bursts — `session.progress` above all — onto the
 * microtask queue, so nothing is throttled here. Mutators ignore frames of a
 * session other than the active one; this table does not filter again.
 *
 * | Frame                   | Destination                                       |
 * | ----------------------- | ------------------------------------------------- |
 * | `session.created`       | `applySessionRecord(payload.session)`             |
 * | `session.updated`       | `applySessionRecord(payload.session)`             |
 * | `session.progress`      | `applyProgress(payload)`                          |
 * | `session.bound`         | logged; the record's `boundTab` arrives on `session.updated` |
 * | `target.selected`       | `applyTargetSelected(payload)`                    |
 * | `instrumentation.plan`  | `applyInstrumentationPlan(payload)`               |
 * | `instrumentation.ready` | `applyInstrumentationReady(payload)` + degradation notice |
 * | `instrumentation.failed`| `applyInstrumentationFailed(payload)` + its hint  |
 * | `capture.started`       | `applyCaptureStarted(payload)`                    |
 * | `capture.stopped`       | `applyCaptureStopped(payload)`                    |
 * | `analysis.completed`    | `applyAnalysis(payload.analysis)`                 |
 * | `panel.generated`       | `applyPanelGenerated(payload)` + fallback banner  |
 * | `cleanup.completed`     | `applyCleanupCompleted(payload)`                  |
 * | `source.open`           | `openSourceLocation(payload.location, session root)` |
 * | `error`                 | logged at `warn` + one notice                     |
 *
 * @returns The unsubscribe function of every row.
 */
function subscribeInbound(rt: ExtensionRuntime): Array<() => void> {
  const { client, state, logger } = rt;
  return [
    client.on('session.created', (message) => {
      state.applySessionRecord(message.payload.session);
    }),
    client.on('session.updated', (message) => {
      state.applySessionRecord(message.payload.session);
    }),
    client.on('session.progress', (message) => {
      state.applyProgress(message.payload);
    }),
    client.on('session.bound', (message) => {
      logger.debug('Tab binding changed', {
        sessionId: message.payload.sessionId,
        tabId: message.payload.tabId,
        reason: message.payload.reason,
      });
    }),
    client.on('target.selected', (message) => {
      state.applyTargetSelected(message.payload);
    }),
    client.on('instrumentation.plan', (message) => {
      state.applyInstrumentationPlan(message.payload);
    }),
    client.on('instrumentation.ready', (message) => {
      state.applyInstrumentationReady(message.payload);
      announceDegradedSignals(rt, message.payload);
    }),
    client.on('instrumentation.failed', (message) => {
      state.applyInstrumentationFailed(message.payload);
      announceInstrumentationFailure(rt, message.payload);
    }),
    client.on('capture.started', (message) => {
      state.applyCaptureStarted(message.payload);
    }),
    client.on('capture.stopped', (message) => {
      state.applyCaptureStopped(message.payload);
    }),
    client.on('analysis.completed', (message) => {
      state.applyAnalysis(message.payload.analysis);
    }),
    client.on('panel.generated', (message) => {
      state.applyPanelGenerated(message.payload);
      announcePanel(rt, message.payload);
    }),
    client.on('cleanup.completed', (message) => {
      state.applyCleanupCompleted(message.payload);
    }),
    client.on('source.open', (message) => {
      void openSourceFromService(rt, message.payload).catch((error: unknown) => {
        logger.error('Opening a source location failed unexpectedly', {
          code: DebuggenError.from(error).code,
        });
      });
    }),
    client.on('error', (message) => {
      announceServiceError(rt, message);
    }),
  ];
}

/** Whether a frame concerns the session the developer is looking at. */
function concernsActiveSession(rt: ExtensionRuntime, sessionId: string | undefined): boolean {
  const active = rt.state.activeSessionId;
  return active !== undefined && active === sessionId;
}

/**
 * `instrumentation.ready` with unavailable signals: the AAP §0.5.5 sentence,
 * "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›.",
 * built from the payload alone — the signals and reasons the installer
 * reported and the runtime hooks and patched files it actually enabled.
 */
function announceDegradedSignals(
  rt: ExtensionRuntime,
  payload: MessageByType<'instrumentation.ready'>['payload'],
): void {
  if (payload.unavailable.length === 0 || !concernsActiveSession(rt, payload.sessionId)) {
    return;
  }
  const missing = payload.unavailable
    .map(
      (entry) => `Could not enable ${toDisplayText(entry.signal)}: ${toDisplayText(entry.reason)}.`,
    )
    .join(' ');
  const enabled = payload.runtimeHooks.map(toDisplayText).filter((hook) => hook !== '');
  const patchedFiles = new Set(payload.applied.map((record) => record.file)).size;
  if (patchedFiles > 0) {
    enabled.push(`function timing in ${patchedFiles} file${patchedFiles === 1 ? '' : 's'}`);
  }
  const continuing = enabled.length > 0 ? enabled.join(', ') : 'no other signals';
  const hints = [
    ...new Set(
      payload.unavailable
        .map((entry) => (entry.hint === undefined ? '' : toDisplayText(entry.hint)))
        .filter((hint) => hint !== ''),
    ),
  ];
  rt.logger.warn('Instrumentation is partially available', {
    sessionId: payload.sessionId,
    unavailable: payload.unavailable.map((entry) => entry.signal),
  });
  surface(rt, {
    level: 'warning',
    message: toDisplayText(`${missing} Continuing with: ${continuing}.`),
    hint: hints.length > 0 ? hints.join(' ') : undefined,
  });
}

/**
 * `instrumentation.failed`: the error with its hint — for a dev server
 * started without the preload, the exact relaunch command. The view already
 * renders the failure from the store with a retry action, so it only
 * reaches the developer as a notification when the view is closed.
 */
function announceInstrumentationFailure(
  rt: ExtensionRuntime,
  payload: MessageByType<'instrumentation.failed'>['payload'],
): void {
  if (!concernsActiveSession(rt, payload.sessionId)) {
    return;
  }
  rt.logger.warn('Instrumentation failed', {
    sessionId: payload.sessionId,
    code: payload.error.code,
  });
  surface(
    rt,
    {
      level: 'error',
      message: toDisplayText(`Instrumentation failed: ${payload.error.message}`),
      hint: payload.error.hint === undefined ? undefined : toDisplayText(payload.error.hint),
    },
    true,
  );
}

/**
 * `panel.generated`: the panel is rendered in Chrome DevTools, so the editor
 * says where to look. A fallback panel is announced as exactly that — never
 * as a clean result (AAP §0.5.5).
 */
function announcePanel(
  rt: ExtensionRuntime,
  payload: MessageByType<'panel.generated'>['payload'],
): void {
  if (!concernsActiveSession(rt, payload.sessionId)) {
    return;
  }
  const fallback = payload.panel.meta?.fallback === true;
  rt.logger.info('Panel generated', {
    sessionId: payload.sessionId,
    panelId: payload.panelId,
    panelVersion: payload.panel.panelVersion,
    fallback,
  });
  surface(
    rt,
    fallback
      ? { level: 'warning', message: FALLBACK_PANEL_NOTICE }
      : {
          level: 'info',
          message: toDisplayText(
            `Panel "${payload.panel.title}" is ready in the Debug Generator panel of Chrome DevTools.`,
          ),
        },
  );
}

/**
 * The service's `error` frame: logged by code and reference, and shown once.
 * An error about a session other than the one in view is logged only.
 */
function announceServiceError(rt: ExtensionRuntime, message: MessageByType<'error'>): void {
  const { code, ref } = message.payload;
  rt.logger.warn('The service reported an error', {
    code,
    ref,
    sessionId: message.sessionId,
  });
  if (message.sessionId !== undefined && !concernsActiveSession(rt, message.sessionId)) {
    return;
  }
  surface(rt, {
    level: 'error',
    message: toDisplayText(`Debug Generator service: ${message.payload.message}`),
  });
}

/**
 * `source.open` — the editor end of DevTools → service → editor. The location
 * is validated against the project root of the session *record* (never a root
 * carried by the frame) inside `openSourceLocation`, which also reports any
 * refusal to the developer itself.
 */
async function openSourceFromService(
  rt: ExtensionRuntime,
  payload: MessageByType<'source.open'>['payload'],
): Promise<void> {
  const projectRoot = await projectRootOfSession(rt, payload.sessionId);
  if (rt.disposed) {
    return;
  }
  if (projectRoot === undefined) {
    rt.logger.warn('Source location refused: the session is unknown', {
      sessionId: payload.sessionId,
    });
    surface(rt, {
      level: 'warning',
      message: 'Could not open the source location: its session is not known to this window.',
    });
    return;
  }
  const opened = await openSourceLocation(
    payload.location,
    { projectRoot },
    { logger: rt.logger.child({ component: 'open-source' }) },
  );
  if (isErr(opened)) {
    rt.logger.info('Source location not opened', {
      sessionId: payload.sessionId,
      code: opened.error.code,
    });
  }
}

/**
 * The stored project root of a session: the active record, then the Sessions
 * list, then the service's own `GET /sessions/:id`.
 */
async function projectRootOfSession(
  rt: ExtensionRuntime,
  sessionId: string,
): Promise<string | undefined> {
  const active = rt.state.activeSession;
  if (active?.id === sessionId) {
    return active.projectRoot;
  }
  const listed = rt.state.sessionList.find((session) => session.id === sessionId);
  if (listed !== undefined) {
    return listed.projectRoot;
  }
  const fetched = await rt.client.getSession(sessionId, { timeoutMs: SESSION_LOOKUP_TIMEOUT_MS });
  if (isErr(fetched)) {
    rt.logger.info('Session lookup failed', { sessionId, code: fetched.error.code });
    return undefined;
  }
  return fetched.value.projectRoot;
}

// ---------------------------------------------------------------------------
// Transport, configuration and project-root reactivity
// ---------------------------------------------------------------------------

/**
 * Wires the socket's state and the process manager's status into the store.
 *
 * - Every socket transition becomes `setConnectionStatus`, the vocabulary the
 *   status bar and the DevTools pill share. Re-opening after a gap resyncs
 *   what pushes may have missed: the Sessions list and the active record.
 * - Losing an open connection asks the process manager, automatically, to
 *   make a service answer again — it respects `debuggen.autoStartService` and
 *   a stop requested during shutdown. The socket's own backoff keeps retrying
 *   meanwhile; no second retry loop is layered on top.
 * - A refused credential (close code 4401 after the client re-read
 *   `auth.json` and found nothing newer) is terminal until the developer
 *   acts, so it is one notification with the two remedies (AAP §0.5.6).
 * - A service that became reachable — our child or someone else's — is
 *   connected to at once; `connect()` is idempotent.
 */
function wireTransport(rt: ExtensionRuntime): vscode.Disposable[] {
  const { client, state, serviceProcess, logger } = rt;
  state.setConnectionStatus(client.state);

  const onState = (connection: ConnectionState, detail?: WsStateChangeDetail): void => {
    if (rt.disposed) {
      return;
    }
    const previous = rt.connection;
    rt.connection = connection;
    state.setConnectionStatus(connection);
    logger.debug('Service connection state', {
      state: connection,
      code: detail?.code,
      attempt: detail?.attempt,
      delayMs: detail?.delayMs,
    });
    if (connection === 'open') {
      state.setServiceReachable(true);
      if (previous !== 'open') {
        void resync(rt);
      }
      return;
    }
    if (previous === 'open') {
      logger.info('Service connection lost', { state: connection, code: detail?.code });
      void ensureService(rt, 'connection-lost');
    }
  };

  const onUnauthorized = (detail: WsUnauthorizedDetail): void => {
    if (rt.disposed) {
      return;
    }
    logger.warn('The service refused the editor credential', { code: detail.code });
    void promptForCredentialRepair(rt);
  };

  const onStatus = (status: ServiceStatus): void => {
    if (rt.disposed) {
      return;
    }
    const reachable = isServiceReachable(status);
    logger.debug('Service process status', {
      state: status.state,
      mode: status.mode,
      restartAttempts: status.restartAttempts,
      code: status.error?.code,
    });
    if (reachable) {
      state.setServiceReachable(true);
      client.connect();
    } else if (rt.connection !== 'open') {
      state.setServiceReachable(false);
    }
  };

  const unsubscribeState = client.onStateChange(onState);
  const unsubscribeUnauthorized = client.onUnauthorized(onUnauthorized);
  return [
    new vscode.Disposable(unsubscribeState),
    new vscode.Disposable(unsubscribeUnauthorized),
    serviceProcess.onDidChangeStatus(onStatus),
  ];
}

/**
 * After a (re)connection: refresh the Sessions tree and re-read the active
 * session's record, which the store merges without regressing any fact a
 * push already established.
 */
async function resync(rt: ExtensionRuntime): Promise<void> {
  try {
    await rt.sessionsTree.refresh();
    const sessionId = rt.state.activeSessionId;
    if (rt.disposed || sessionId === undefined) {
      return;
    }
    const record = await rt.client.getSession(sessionId, { timeoutMs: SESSION_LOOKUP_TIMEOUT_MS });
    if (rt.disposed) {
      return;
    }
    if (isOk(record)) {
      rt.state.applySessionRecord(record.value);
    } else {
      rt.logger.info('Active session could not be re-read', {
        sessionId,
        code: record.error.code,
      });
    }
  } catch (error) {
    rt.logger.warn('Resynchronising after reconnect failed', {
      code: DebuggenError.from(error).code,
    });
  }
}

/**
 * The refused-credential notification. "Retry" re-reads `auth.json` and
 * resumes the socket; "Rotate Service Token" runs the (confirmed) command.
 * No token or file content is ever part of the message.
 */
async function promptForCredentialRepair(rt: ExtensionRuntime): Promise<void> {
  const retry = 'Retry';
  const rotate = 'Rotate Service Token';
  const choice = await showNotification(
    rt.logger,
    {
      level: 'warning',
      message: 'The Debug Generator service refused this editor’s credential.',
      hint: 'Retry after restarting the service, or rotate the service token.',
    },
    [retry, rotate],
  );
  if (rt.disposed || choice === undefined) {
    return;
  }
  if (choice === retry) {
    const refreshed = await rt.credentials.refresh();
    if (rt.disposed) {
      return;
    }
    if (isErr(refreshed)) {
      rt.logger.warn('The editor credential could not be re-read', {
        code: refreshed.error.code,
      });
      surface(rt, {
        level: 'error',
        message: toDisplayText(`Could not read the editor credential: ${refreshed.error.message}`),
        hint: refreshed.error.hint === undefined ? undefined : toDisplayText(refreshed.error.hint),
      });
      return;
    }
    rt.client.connect();
    return;
  }
  try {
    await vscode.commands.executeCommand(ROTATE_SERVICE_TOKEN_COMMAND);
  } catch (error) {
    rt.logger.warn('Rotating the service token could not be started', {
      code: DebuggenError.from(error).code,
    });
  }
}

/**
 * Settings reactivity, filtered with `affectsConfiguration`:
 *
 * - `debuggen.serviceUrl` → the store's URL and the client's base URL (a
 *   no-op when the client's own watcher already applied it), then one
 *   automatic ensure against the new address;
 * - `debuggen.provider` → the store's provider;
 * - `debuggen.devServerUrl` → validated at once, so an unusable value is
 *   reported when it is typed rather than when a session needs it;
 * - `debuggen.autoStartService` turned on while nothing answers → one
 *   automatic ensure.
 */
function wireConfiguration(rt: ExtensionRuntime): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (rt.disposed || !event.affectsConfiguration(CONFIGURATION_SECTION)) {
      return;
    }
    const settings = readSettings();
    let ensure = false;

    if (event.affectsConfiguration(SETTING.serviceUrl)) {
      rt.state.setServiceUrl(settings.serviceUrl);
      rt.client.setBaseUrl(settings.serviceUrl);
      rt.logger.info('Service URL changed', {
        serviceUrl: rt.client.baseUrl,
        code: rt.client.configurationError?.code,
      });
      ensure = true;
    }
    if (event.affectsConfiguration(SETTING.provider)) {
      rt.state.setProvider(settings.provider);
      rt.logger.info('Model provider setting changed', { provider: settings.provider });
    }
    if (event.affectsConfiguration(SETTING.devServerUrl)) {
      const devServerUrl = readDevServerUrlSetting();
      if (isErr(devServerUrl)) {
        rt.logger.warn('debuggen.devServerUrl is not usable', { code: devServerUrl.error.code });
        surface(rt, {
          level: 'warning',
          message: toDisplayText(devServerUrl.error.message),
          hint:
            devServerUrl.error.hint === undefined
              ? undefined
              : toDisplayText(devServerUrl.error.hint),
        });
      } else {
        rt.logger.info('Dev server URL setting changed', {
          configured: devServerUrl.value !== undefined,
        });
      }
    }
    if (
      event.affectsConfiguration(SETTING.autoStartService) &&
      settings.autoStartService &&
      !rt.state.serviceReachable
    ) {
      ensure = true;
    }
    if (ensure) {
      void ensureService(rt, 'settings-changed');
    }
  });
}

/**
 * Keeps the project root announced in `client.hello` equal to the one the
 * commands act on. The service scopes the editor credential to the announced
 * folder (AAP §0.5.6) and routes a session's frames by it, so:
 *
 * - while a session is open, its record's project root is announced — the
 *   frames of the session in view keep arriving even if focus moves to a file
 *   of another folder in a multi-root workspace;
 * - otherwise the root `resolveProjectRoot` selects (the active editor's
 *   folder, else the first folder) is announced, which is exactly the root
 *   `debuggen.startSession` will send.
 *
 * `setProjectRoot` is a no-op for an unchanged value, so re-evaluating on
 * every store change costs one comparison.
 */
function wireProjectRoot(rt: ExtensionRuntime): vscode.Disposable[] {
  const announce = (): void => {
    if (rt.disposed) {
      return;
    }
    const session = rt.state.activeSession;
    if (isSessionOpen(session)) {
      rt.client.setProjectRoot(session.projectRoot);
      return;
    }
    const resolved = resolveProjectRoot();
    rt.client.setProjectRoot(isOk(resolved) ? resolved.value.projectRoot : undefined);
  };
  return [
    rt.state.onDidChange(announce),
    vscode.window.onDidChangeActiveTextEditor(announce),
    vscode.workspace.onDidChangeWorkspaceFolders(announce),
  ];
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

/**
 * The asynchronous half of activation, never awaited by `activate`.
 *
 * `ServiceProcess.ensureRunning()` probes the auth-exempt `GET /health`
 * first; when nothing answers and `debuggen.autoStartService` allows it, it
 * ensures the editor credential, spawns the embedded service and polls its
 * health with its own bounded schedule. Once a service answers, its version
 * is logged and the WebSocket is opened — the protocol client's backoff owns
 * recovery from then on.
 */
async function startup(rt: ExtensionRuntime): Promise<void> {
  const reachable = await ensureService(rt, 'activation');
  if (!reachable || rt.disposed) {
    return;
  }
  const health = await rt.client.health({ timeoutMs: HEALTH_READ_TIMEOUT_MS });
  if (rt.disposed) {
    return;
  }
  // The health body is `{ version, protocolVersion, pairingAvailable }` and
  // names no model provider, so the store keeps the configured
  // `debuggen.provider` until a session record reports the one in use.
  if (isOk(health)) {
    rt.logger.info('Service answered', {
      serviceUrl: rt.client.baseUrl,
      version: health.value.version,
      protocolVersion: health.value.protocolVersion,
      pairingAvailable: health.value.pairingAvailable,
    });
  } else {
    rt.logger.info('Service health could not be read', { code: health.error.code });
  }
}

/**
 * Asks the process manager, automatically, for a service that answers and
 * records the outcome in the store. "Service not running" is a rendered state
 * (`serviceReachable: false` with a closed connection, which the view shows
 * with the start command), never a thrown error (AAP §0.5.5). Only a failure
 * the developer did not choose — auto-start on, yet no service — is also
 * announced, once, with the output channel and a retry at hand.
 *
 * @returns Whether a service answers.
 */
async function ensureService(rt: ExtensionRuntime, trigger: EnsureTrigger): Promise<boolean> {
  const result = await rt.serviceProcess.ensureRunning();
  if (rt.disposed) {
    return false;
  }
  if (isOk(result)) {
    rt.state.setServiceReachable(true);
    rt.logger.info('Service reachable', {
      trigger,
      state: result.value.state,
      mode: result.value.mode,
    });
    rt.client.connect();
    return true;
  }

  const error = result.error;
  if (rt.connection !== 'open') {
    rt.state.setServiceReachable(false);
  }
  const autoStart = readSettings().autoStartService;
  rt.logger.info('Service not reachable', {
    trigger,
    code: error.code,
    autoStartService: autoStart,
  });
  if (trigger === 'activation' && autoStart) {
    void announceStartFailure(rt, error);
  }
  return false;
}

/** The one notification for a service auto-start that produced no service. */
async function announceStartFailure(rt: ExtensionRuntime, error: DebuggenError): Promise<void> {
  const showOutput = 'Show Output';
  const retry = 'Retry';
  const choice = await showNotification(
    rt.logger,
    {
      level: 'warning',
      message: toDisplayText(`The Debug Generator service did not start: ${error.message}`),
      hint: error.hint === undefined ? undefined : toDisplayText(error.hint),
    },
    [retry, showOutput],
  );
  if (rt.disposed) {
    return;
  }
  if (choice === showOutput) {
    rt.serviceProcess.showOutput(false);
  } else if (choice === retry) {
    try {
      await vscode.commands.executeCommand(START_SERVICE_COMMAND);
    } catch (commandError) {
      rt.logger.warn('Starting the service could not be retried', {
        code: DebuggenError.from(commandError).code,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// deactivate
// ---------------------------------------------------------------------------

/**
 * Deactivates the extension and upholds the end-of-session cleanup guarantee
 * (AAP §0.5.1): the active session is ended — the service restores every
 * instrumented file — before the service child this extension spawned is
 * stopped. VS Code awaits the returned promise within its own budget, which is
 * why this is asynchronous while `activate` is not. Never throws.
 */
export async function deactivate(): Promise<void> {
  const rt = runtime;
  runtime = undefined;
  if (rt === undefined) {
    return;
  }
  rt.disposed = true;

  try {
    // 1. End the active session. Issued and registered with the process
    //    manager synchronously, before the first `await`: the extension host
    //    disposes `context.subscriptions` — the process manager included —
    //    right after this function returns its promise, and the manager's
    //    disposal waits for registered operations before it signals the child.
    const ending = endActiveSession(rt);
    if (ending !== undefined) {
      await ending;
    }

    // 2. Only now stop the child this extension spawned (a service someone
    //    else runs is never touched). Reversing steps 1 and 2 would kill the
    //    service mid-cleanup and leave patched files in the developer's
    //    working tree; the service's start-up reconciliation of modification
    //    records would repair them next time, but that is a safety net, not a
    //    substitute for ending the session here.
    await rt.serviceProcess.stop({
      awaitInFlight: ending,
      quiesceTimeoutMs: DEACTIVATE_QUIESCE_TIMEOUT_MS,
      graceMs: DEACTIVATE_STOP_GRACE_MS,
    });
  } catch (error) {
    rt.logger.error('Deactivation cleanup failed unexpectedly', {
      code: DebuggenError.from(error).code,
    });
  } finally {
    // 3. Close the socket. `context.subscriptions` (VS Code disposes those)
    //    owns the client too; its `dispose()` is idempotent, so closing it
    //    here keeps the order right whatever order the editor disposes in.
    try {
      rt.client.dispose();
    } catch (error) {
      rt.logger.warn('Closing the service connection failed', {
        code: DebuggenError.from(error).code,
      });
    }
    rt.logger.info('Debug Generator deactivated');
  }
}

/**
 * Sends `POST /sessions/:id/end` for the active session when it is still
 * open, bounded by {@link DEACTIVATE_END_SESSION_TIMEOUT_MS}, and registers it
 * with the process manager so the child outlives it.
 *
 * @returns The request, resolving once it settled (never rejecting), or
 *   `undefined` when no open session exists.
 */
function endActiveSession(rt: ExtensionRuntime): Promise<void> | undefined {
  const session = rt.state.activeSession;
  if (!isSessionOpen(session)) {
    return undefined;
  }
  const sessionId = session.id;
  rt.logger.info('Ending the active session before shutdown', { sessionId });
  const request = rt.client
    .endSession(sessionId, { timeoutMs: DEACTIVATE_END_SESSION_TIMEOUT_MS })
    .then(
      (ended) => {
        if (isOk(ended)) {
          rt.logger.info('Session ended on shutdown', {
            sessionId,
            cleanup: ended.value.cleanup,
          });
        } else {
          rt.logger.warn('Session could not be ended on shutdown', {
            sessionId,
            code: ended.error.code,
          });
        }
      },
      (error: unknown) => {
        rt.logger.warn('Session could not be ended on shutdown', {
          sessionId,
          code: DebuggenError.from(error).code,
        });
      },
    );
  return rt.serviceProcess.keepAliveFor(request);
}
