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
 * deactivate()                                 (asynchronous, ≤ DEACTIVATE_BUDGET_MS)
 *   0. state.beginShutdown()                            (no create/reopen/adopt after)
 *   1. endSessionsForShutdown: the active session's end at its owning
 *      endpoint, the creates in flight, the sessions they created
 *                                                       (bounded, keepAliveFor)
 *   2. stop the service child this extension spawned   (issued with 1; acts only
 *      after 1 settled or its bound: still in progress → left running unsignalled;
 *      refused → SIGTERM only; concluded → SIGTERM, then SIGKILL after the grace)
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
 * The extension host calls `deactivate()`, disposes `context.subscriptions`
 * synchronously before the promise settles, and terminates itself about five
 * seconds later. So the shutdown gate is closed first, everything is issued
 * before the first `await`, and it all fits one budget,
 * {@link DEACTIVATE_BUDGET_MS}: the shutdown routine's end requests —
 * registered with `ServiceProcess.keepAliveFor`, which holds off the child's
 * termination — and the stop that waits for them, which
 * `ServiceProcess.dispose` then leaves in charge of the child. A
 * `POST /sessions` still in flight is waited for (bounded) and the session it
 * created ended too. The child is acted on only after the ends settled or
 * their bound passed, and never in a way that interrupts a restore: the
 * service keeps serving an end request after its client went away — it waits
 * for a cancelled install to settle, then restores the files — so an end
 * still in progress leaves the child running, unsignalled, to finish it (a
 * later window uses that service); a refused end gets `SIGTERM` only; and
 * `SIGKILL` follows the grace window only when every end concluded (see
 * `stopServiceForShutdown`). The service also reconciles every outstanding
 * modification record on its next start; that is a safety net, not a
 * substitute.
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

import { MESSAGE_TYPE, PROVIDER_IDS } from '@debuggen/protocol';
import type {
  ConnectionState,
  MessageByType,
  ProviderId,
  ServiceOriginRule,
  SessionRecord,
  WsStateChangeDetail,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import { DebuggenError, createConsoleLogger, isErr, isOk } from '@debuggen/shared';
import type { LogFields, LogRecord, Logger } from '@debuggen/shared';

import { registerCommands } from './commands';
import type { CommandId, DestructiveConfirmation } from './commands';
import { DEFAULT_SHUTDOWN_TIMEOUTS, endSessionsForShutdown } from './commands/end-session';
import type { ShutdownReport } from './commands/end-session';
import {
  RESTART_SERVICE_ACTION,
  RESTART_WITH_LIVE_SESSION,
  hasLiveSession,
} from './commands/start-service';
import { createEditorCredentialStore } from './service/auth';
import type { EditorCredentialStore } from './service/auth';
import {
  DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
  EDITOR_OPERATION_TIMEOUTS_MS,
  createServiceClient,
  errorClassOf,
} from './service/client';
import type { ServiceClient } from './service/client';
import { readDevServerUrlSetting, resolveProjectRoot } from './service/discovery';
import { createServiceProcess, isServiceReachable } from './service/process';
import type {
  EmbeddedPaths,
  ServiceProcess,
  ServiceStatus,
  WorkspaceServiceEntry,
} from './service/process';
import {
  disposeSourceRevealResources,
  forwardedSourcePin,
  openSourceLocation,
  sourceResultFor,
} from './source/open-location';
import type { ForwardedSourceOpenOutcome } from './source/open-location';
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
 * packaging, and `test/suite/packaged-vsix.test.ts` activates an installed
 * VSIX and asserts its service runs from them. They are always joined onto
 * `context.extensionUri`, never derived from `__dirname`, `process.cwd()` or a
 * workspace path, because the installed location is the only one guaranteed
 * to exist.
 */
const EMBEDDED_LAYOUT = Object.freeze({
  serviceMain: ['dist', 'service', 'main.js'],
  servicePromptsDir: ['dist', 'service', 'prompts'],
  telemetryPreload: ['dist', 'telemetry', 'node', 'register.mjs'],
  // No `serviceSchema`: the store DDL is inlined into the service bundle, so no file exists to name.
} satisfies Record<Exclude<keyof EmbeddedPaths, 'serviceSchema'>, readonly string[]>);

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
 * The one budget every step of `deactivate()` is carved from, in milliseconds.
 *
 * VS Code terminates the extension host about five seconds after it began
 * deactivating extensions, and cancels `globalState` writes made meanwhile, so
 * nothing `deactivate()` starts may be counted on after that. The budget stays
 * inside that window with room for the editor's own teardown; the three
 * constants below are derived from it, so the steps can never add up to more.
 */
export const DEACTIVATE_BUDGET_MS = 4_500;

/**
 * The bound on the end-of-session request `deactivate()` sends for the active
 * session — the shutdown routine's `activeEndMs`, three seconds, within which
 * it also waits for the creates in flight and ends what they created. The service
 * restores every instrumented file while it handles the request, and it keeps
 * handling it after this bound passes and the editor goes away (it first waits
 * for a cancelled install to settle); a service this window started is then
 * left running, unsignalled, until that restore is done — see
 * {@link stopServiceForShutdown}.
 */
export const DEACTIVATE_END_SESSION_TIMEOUT_MS = DEFAULT_SHUTDOWN_TIMEOUTS.activeEndMs;

/**
 * How long `deactivate()`'s stop waits for the end request before it decides
 * what to do with the child: the request's own bound plus a margin for its
 * settlement to reach the process manager.
 */
export const DEACTIVATE_QUIESCE_TIMEOUT_MS = DEACTIVATE_END_SESSION_TIMEOUT_MS + 250;

/**
 * The grace window between `SIGTERM` and a `SIGKILL` when `deactivate()`
 * stops the child — the rest of {@link DEACTIVATE_BUDGET_MS}. `SIGKILL` is sent
 * only when the end request concluded (or there was no session to end); see
 * {@link stopServiceForShutdown}.
 */
export const DEACTIVATE_STOP_GRACE_MS = DEACTIVATE_BUDGET_MS - DEACTIVATE_QUIESCE_TIMEOUT_MS;

/** The bound on the informational health read after the service answered. */
const HEALTH_READ_TIMEOUT_MS = 2_000;

/** The bound on a session lookup the `source.open` route needs. */
const SESSION_LOOKUP_TIMEOUT_MS = 3_000;

/** The upper bound of one displayed text part built from a service payload. */
const MAX_DISPLAY_TEXT_LENGTH = 500;

/** The upper bound of one serialised log-fields suffix in the output channel. */
const MAX_LOG_FIELDS_LENGTH = 4_000;

/**
 * The command the credential repair offers once a restarted service re-issued
 * the editor credential and `auth.json` was read back. Never
 * offered while the credential is refused: `credentials.rotate` itself
 * requires an editor credential the service accepts.
 */
const ROTATE_SERVICE_TOKEN_COMMAND = 'debuggen.rotateServiceToken' satisfies CommandId;

/** The refused-credential prompt's action that reads `auth.json` again and reconnects. */
const RETRY_CREDENTIAL_ACTION = 'Retry';

/** The post-restart notice's action, which runs {@link ROTATE_SERVICE_TOKEN_COMMAND}. */
const ROTATE_SERVICE_TOKEN_ACTION = 'Rotate Service Token';

/** The refused-credential prompt's headline; it never carries a token or file content. */
const CREDENTIAL_REFUSED_MESSAGE = 'The Debug Generator service refused this editor’s credential.';

/** The command that starts the embedded service by the developer's request. */
const START_SERVICE_COMMAND = 'debuggen.startService' satisfies CommandId;

/** The fallback-panel banner copy of AAP §0.5.5. */
const FALLBACK_PANEL_NOTICE =
  'Generated panel failed validation; showing a fallback view built from captured data.';

/** A run of whitespace, collapsed to one space for display. */
const WHITESPACE_RUN = /\s+/g;

/**
 * Every {@link ServiceOriginRule} a refused `debuggen.serviceUrl` may name,
 * as a lookup table. `satisfies Record<ServiceOriginRule, true>` keeps it in
 * step with the protocol's type in both directions: a rule the protocol adds
 * is a compile error here until it is listed, and a key the protocol does not
 * define is refused as an excess property. {@link describeServiceUrl} logs a
 * refusal's rule only when it is one of these keys, so the log carries a fixed
 * vocabulary whatever a `details` bag happens to hold.
 */
const SERVICE_ORIGIN_RULES = Object.freeze({
  empty: true,
  unparseable: true,
  userinfo: true,
  scheme: true,
  host: true,
  'not-loopback': true,
  path: true,
  'query-or-fragment': true,
} satisfies Record<ServiceOriginRule, true>);

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
 * How a `debuggen.provider` value is written to the output channel: the id
 * itself when it is one of {@link PROVIDER_IDS}, `unset` when the snapshot
 * holds nothing, otherwise `invalid` — never the configured text.
 */
type ProviderSettingClass = ProviderId | 'unset' | 'invalid';

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
 *
 * It is also the backstop for that contract where an error slips into a
 * record: an `Error` (or a `DebuggenError` built in another realm, which is
 * not `instanceof Error` here) is printed as its closed class from
 * `errorClassOf` and its error code only.
 * Its message, its stack and a `name` outside the closed vocabulary never
 * reach the channel, which redacts nothing (AAP §0.5.2).
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
      if (value instanceof Error || DebuggenError.is(value)) {
        return { errorClass: errorClassOf(value), code: DebuggenError.from(value).code };
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
 * `DEBUGGEN_PROMPTS_DIR` set to `servicePromptsDir`; the preload is checked by
 * the process manager so an incomplete bundle is a clear failure, and the
 * service's dev-server launcher finds the preload beside its own bundle. No
 * schema path is passed: `esbuild.mjs` inlines the store DDL into
 * `serviceMain`, and the VSIX ships no `.sql` file for the manager to check.
 */
function resolveEmbeddedPaths(extensionUri: vscode.Uri): EmbeddedPaths {
  const at = (segments: readonly string[]): string =>
    vscode.Uri.joinPath(extensionUri, ...segments).fsPath;
  return Object.freeze({
    serviceMain: at(EMBEDDED_LAYOUT.serviceMain),
    servicePromptsDir: at(EMBEDDED_LAYOUT.servicePromptsDir),
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

/** Whether a value is one of the closed {@link ServiceOriginRule} names. */
function isServiceOriginRule(value: unknown): value is ServiceOriginRule {
  return typeof value === 'string' && Object.hasOwn(SERVICE_ORIGIN_RULES, value);
}

/**
 * The log fields that describe the service URL the client is using: the one
 * projection the activation record and the "Service URL changed" record share.
 *
 * The configured `debuggen.serviceUrl` is never among them. A refused value
 * may carry a pasted credential in its user information, query or fragment,
 * and the output channel redacts nothing (AAP §0.5.2, §0.5.6), so every field
 * is read from the client's validated state instead:
 *
 * - accepted: `{ serviceUrl, accepted: true }`, where `serviceUrl` is
 *   `client.baseUrl`, the canonical loopback origin the protocol client
 *   validated, which has no user information, path, query or fragment;
 * - refused: `{ accepted: false, code, rule }`, where `code` is the refusal's
 *   error code and `rule` its {@link ServiceOriginRule}, present only when
 *   `details.rule` is one of {@link SERVICE_ORIGIN_RULES}.
 *
 * @example
 * describeServiceUrl(client);
 * // accepted → { serviceUrl: 'http://127.0.0.1:43117', accepted: true }
 * // refused  → { accepted: false, code: 'CONFIG_INVALID', rule: 'userinfo' }
 *
 * @param client The service client whose current base URL is described.
 * @returns Fields safe to hand to any log level.
 */
function describeServiceUrl(
  client: Pick<ServiceClient, 'baseUrl' | 'configurationError'>,
): LogFields {
  const refused = client.configurationError;
  if (refused === undefined) {
    return { serviceUrl: client.baseUrl, accepted: true };
  }
  const rule = refused.details?.rule;
  return {
    accepted: false,
    code: refused.code,
    rule: isServiceOriginRule(rule) ? rule : undefined,
  };
}

/**
 * Classifies a `debuggen.provider` snapshot value for the output channel.
 *
 * `package.json` advertises the setting as an enum over {@link PROVIDER_IDS},
 * but a hand-edited `settings.json` can hold any text there, so the value is
 * logged only once it is known to be one of those ids. {@link readSettings}
 * trims the value and reads a non-string as empty, so a missing and a
 * non-string setting are both `unset`. Only the log is affected:
 * `ExtensionState.setProvider` still receives the snapshot for display.
 *
 * @example
 * classifyProviderSetting('deterministic'); // 'deterministic'
 * classifyProviderSetting('');              // 'unset'
 * classifyProviderSetting('sk-pasted-key'); // 'invalid'
 *
 * @param provider The trimmed `debuggen.provider` value from {@link readSettings}.
 * @returns The provider id, `unset` or `invalid`.
 */
function classifyProviderSetting(provider: string): ProviderSettingClass {
  if (provider === '') {
    return 'unset';
  }
  return PROVIDER_IDS.find((id) => id === provider) ?? 'invalid';
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
    //    Every HTTP call gets a deadline: its own `timeoutMs` when it passes
    //    one (the probe, the deactivation end, the session lookups), else the
    //    per-operation bound for the operations whose service-side work
    //    legitimately runs long, else the default — so a service that accepts
    //    connections but stalls surfaces as a retryable failure instead of a
    //    command that never settles.
    //    The service admits the editor's session requests only while one of
    //    its sockets announces the project there, so the socket to the
    //    service owning the session in view survives a `debuggen.serviceUrl`
    //    or project change, and is released once the store tracks another
    //    session (or none) — checked on every store change.
    const client = own(
      createServiceClient({
        credential: credentials,
        projectRoot: isOk(projectRoot) ? projectRoot.value.projectRoot : undefined,
        logger: logger.child({ component: 'service-client' }),
        webSocketConstructor: WebSocket,
        defaultTimeoutMs: DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
        operationTimeoutsMs: EDITOR_OPERATION_TIMEOUTS_MS,
        retainedEndpoint: () => state.activeSessionEndpoint,
      }),
    );
    own(
      state.onDidChange(() => {
        client.pruneRetainedConnections();
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
    // The validated origin or the refusal's code and rule — never the raw
    // setting, which a refused value may carry a credential in.
    logger.info('Debug Generator activated', {
      ...describeServiceUrl(client),
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
 * | `session.updated`       | `applySessionRecord(payload.session)`, the selected target included |
 * | `session.progress`      | `applyProgress(payload)`                          |
 * | `session.bound`         | logged; the record's `boundTab` arrives on `session.updated` |
 * | `target.selected`       | not subscribed: DevTools → service only           |
 * | `instrumentation.plan`  | `applyInstrumentationPlan(payload)`               |
 * | `instrumentation.ready` | `applyInstrumentationReady(payload)` + degradation notice |
 * | `instrumentation.failed`| `applyInstrumentationFailed(payload)` + its hint  |
 * | `capture.started`       | `applyCaptureStarted(payload)`                    |
 * | `capture.stopped`       | `applyCaptureStopped(payload)`                    |
 * | `analysis.completed`    | `applyAnalysis(payload.analysis)`                 |
 * | `panel.generated`       | `applyPanelGenerated(payload)` + fallback banner  |
 * | `cleanup.completed`     | `applyCleanupCompleted(payload)`                  |
 * | `source.open`           | `openSourceLocation(payload.location, session root + payload.pinned)`, answered with `source.result` (`ref` = the frame's `id`); a frame without `pinned` is refused unopened |
 * | `error`                 | logged at `warn` + one notice                     |
 *
 * `source.open` is the one row that answers: the service waits for the
 * editor's `source.result` and relays it to the DevTools panel that asked, so
 * the panel reports a click as done only once the editor has opened it.
 *
 * The element selected in DevTools reaches the editor only as the `target` of
 * the `SessionRecord` inside `session.updated`, which is authoritative: the
 * service stores a `target.selected` it accepted from the tab bound to the
 * session and then broadcasts the stored record, from which
 * `applySessionRecord` takes the target. `target.selected` itself travels
 * DevTools → service only (AAP §0.4.2) and no service path sends it to an
 * editor, so it is intentionally not subscribed here: a listener for it could
 * never fire, and it would present a selection the service had not recorded.
 *
 * @returns The unsubscribe function of every subscribed row.
 */
function subscribeInbound(rt: ExtensionRuntime): Array<() => void> {
  const { client, state, logger } = rt;
  return [
    client.on(MESSAGE_TYPE.SESSION_CREATED, (message) => {
      state.applySessionRecord(message.payload.session);
    }),
    client.on(MESSAGE_TYPE.SESSION_UPDATED, (message) => {
      state.applySessionRecord(message.payload.session);
    }),
    client.on(MESSAGE_TYPE.SESSION_PROGRESS, (message) => {
      state.applyProgress(message.payload);
    }),
    client.on(MESSAGE_TYPE.SESSION_BOUND, (message) => {
      logger.debug('Tab binding changed', {
        sessionId: message.payload.sessionId,
        tabId: message.payload.tabId,
        reason: message.payload.reason,
      });
    }),
    client.on(MESSAGE_TYPE.INSTRUMENTATION_PLAN, (message) => {
      state.applyInstrumentationPlan(message.payload);
    }),
    client.on(MESSAGE_TYPE.INSTRUMENTATION_READY, (message) => {
      state.applyInstrumentationReady(message.payload);
      announceDegradedSignals(rt, message.payload);
    }),
    client.on(MESSAGE_TYPE.INSTRUMENTATION_FAILED, (message) => {
      state.applyInstrumentationFailed(message.payload);
      announceInstrumentationFailure(rt, message.payload);
    }),
    client.on(MESSAGE_TYPE.CAPTURE_STARTED, (message) => {
      state.applyCaptureStarted(message.payload);
    }),
    client.on(MESSAGE_TYPE.CAPTURE_STOPPED, (message) => {
      state.applyCaptureStopped(message.payload);
    }),
    client.on(MESSAGE_TYPE.ANALYSIS_COMPLETED, (message) => {
      state.applyAnalysis(message.payload.analysis);
    }),
    client.on(MESSAGE_TYPE.PANEL_GENERATED, (message) => {
      state.applyPanelGenerated(message.payload);
      announcePanel(rt, message.payload);
    }),
    client.on(MESSAGE_TYPE.CLEANUP_COMPLETED, (message) => {
      state.applyCleanupCompleted(message.payload);
    }),
    client.on(MESSAGE_TYPE.SOURCE_OPEN, (message) => {
      void answerSourceOpen(rt, message).catch((error: unknown) => {
        logger.error('Answering a source.open failed unexpectedly', {
          code: DebuggenError.from(error).code,
        });
      });
    }),
    client.on(MESSAGE_TYPE.ERROR, (message) => {
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
 * Handles one forwarded `source.open` end to end: opens the location, then
 * answers the service with `source.result`, `ref` = this frame's `id`.
 *
 * Exactly one answer per frame, and every path produces it — `opened`, or
 * `failed` for an unknown session, a refused or failed open, and an attempt
 * that threw — except one: once `deactivate()` has begun nothing is sent, and
 * the service's own deadline answers the panel. The answer's text is built by
 * `sourceResultFor` from constants, never from the local error, whose message
 * and cause may quote a path (AAP §0.5.2). A send that fails is logged by code
 * and never shown: the developer already saw this window's own notice, and the
 * service tells the panel when no answer arrives.
 */
async function answerSourceOpen(
  rt: ExtensionRuntime,
  message: MessageByType<'source.open'>,
): Promise<void> {
  let outcome: ForwardedSourceOpenOutcome | undefined;
  try {
    outcome = await openSourceFromService(rt, message.payload);
  } catch (error) {
    rt.logger.error('Opening a source location failed unexpectedly', {
      code: DebuggenError.from(error).code,
    });
    outcome = { kind: 'unexpected' };
  }
  if (outcome === undefined || rt.disposed) {
    return;
  }

  const answer = sourceResultFor(
    { sessionId: message.payload.sessionId, ref: message.id },
    outcome,
  );
  if (isErr(answer)) {
    rt.logger.warn('The answer to a source.open could not be built', { code: answer.error.code });
    return;
  }
  const sent = rt.client.send(MESSAGE_TYPE.SOURCE_RESULT, answer.value);
  if (isErr(sent)) {
    rt.logger.info('The answer to a source.open was not sent', { code: sent.error.code });
  }
}

/**
 * `source.open` — the editor end of DevTools → service → editor. The location
 * is validated against the project root of the session *record* (never a root
 * carried by the frame) inside `openSourceLocation`, which also reports any
 * refusal to the developer itself.
 *
 * The frame's `pinned` — the canonical file and identity the service proved
 * before forwarding — travels with the root, so `openSourceLocation` opens
 * nothing unless what it resolves itself is that same file. The service pins
 * every frame it forwards, so a frame without a pin is refused first, before
 * the session lookup and before any filesystem or editor call: answered
 * `not-opened` with the refusal's code, logged by that code, shown once.
 *
 * @returns What became of the attempt, for the answer; `undefined` when the
 *   runtime was disposed while the session was being looked up, in which case
 *   nothing was opened and nothing is answered.
 */
async function openSourceFromService(
  rt: ExtensionRuntime,
  payload: MessageByType<'source.open'>['payload'],
): Promise<ForwardedSourceOpenOutcome | undefined> {
  const pin = forwardedSourcePin(payload.pinned);
  if (isErr(pin)) {
    rt.logger.warn('Source location refused: the forwarded frame carries no pinned file', {
      sessionId: payload.sessionId,
      code: pin.error.code,
    });
    surface(rt, { level: 'warning', message: pin.error.message, hint: pin.error.hint });
    return { kind: 'not-opened', code: pin.error.code };
  }

  const projectRoot = await projectRootOfSession(rt, payload.sessionId);
  if (rt.disposed) {
    return undefined;
  }
  if (projectRoot === undefined) {
    rt.logger.warn('Source location refused: the session is unknown', {
      sessionId: payload.sessionId,
    });
    surface(rt, {
      level: 'warning',
      message: 'Could not open the source location: its session is not known to this window.',
    });
    return { kind: 'unknown-session' };
  }
  const opened = await openSourceLocation(
    payload.location,
    { projectRoot, pinned: pin.value },
    { logger: rt.logger.child({ component: 'open-source' }) },
  );
  if (isErr(opened)) {
    rt.logger.info('Source location not opened', {
      sessionId: payload.sessionId,
      code: opened.error.code,
    });
    return { kind: 'not-opened', code: opened.error.code };
  }
  return { kind: 'opened' };
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
 *   acts, so it is one notification that leads with restarting
 *   the service — which re-issues the editor credential in `auth.json` as it
 *   starts — and offers a re-read of `auth.json`. Rotation needs a credential
 *   the service accepts, so it is offered only after a restart and a
 *   successful re-read (see {@link promptForCredentialRepair}).
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
    void promptForCredentialRepair(rt).catch((error: unknown) => {
      logger.error('Repairing the editor credential failed unexpectedly', {
        code: DebuggenError.from(error).code,
      });
    });
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
 * The refused-credential notification, one per refusal the client reports.
 *
 * The service refuses the editor credential when `auth.json` names one its
 * store does not hold. Rotation cannot repair that: `credentials.rotate`
 * requires an editor credential the service accepts, and the service refuses
 * it `UNAUTHORIZED` before the rotation runs. A restart can: the service
 * re-registers or re-mints the editor credential in `auth.json` as it starts.
 * So the prompt leads with the restart, and its actions depend
 * on who owns the service:
 *
 * - a child of this window (`running`) — {@link RESTART_SERVICE_ACTION}, then
 *   {@link RETRY_CREDENTIAL_ACTION}; the restart is
 *   {@link restartForCredentialRepair};
 * - any other service — {@link RETRY_CREDENTIAL_ACTION} only, with a hint to
 *   restart it where it was started. `ServiceProcess.restart` refuses a
 *   service this window did not spawn.
 *
 * "Retry" reads `auth.json` again and, once it was read, resumes the socket;
 * it never offers rotation. No token or file content is ever part of a
 * message or a log record.
 *
 * @param rt The runtime of the activation whose socket was refused.
 */
async function promptForCredentialRepair(rt: ExtensionRuntime): Promise<void> {
  const restartable = rt.serviceProcess.status.state === 'running';
  const choice = await showNotification(
    rt.logger,
    restartable
      ? {
          level: 'warning',
          message: CREDENTIAL_REFUSED_MESSAGE,
          hint: 'Restart the service: as it starts it re-issues the editor credential in auth.json. Retry reads auth.json again.',
        }
      : {
          level: 'warning',
          message: CREDENTIAL_REFUSED_MESSAGE,
          hint: 'Restart the service where it was started — a terminal or another VS Code window — so it re-issues the editor credential in auth.json, then choose Retry.',
        },
    restartable ? [RESTART_SERVICE_ACTION, RETRY_CREDENTIAL_ACTION] : [RETRY_CREDENTIAL_ACTION],
  );
  if (rt.disposed || choice === undefined) {
    return;
  }
  if (restartable && choice === RESTART_SERVICE_ACTION) {
    await restartForCredentialRepair(rt);
    return;
  }
  if (choice === RETRY_CREDENTIAL_ACTION && (await rereadEditorCredential(rt))) {
    rt.client.connect();
  }
}

/**
 * The refused-credential prompt's "Restart service": confirm with
 * {@link RESTART_WITH_LIVE_SESSION} while a session is live, restart this
 * window's service once, read `auth.json` again and reconnect. One message per
 * outcome:
 *
 * - declined confirmation — nothing is restarted and nothing is shown;
 * - the restart failed — one error with the process manager's message and
 *   hint; nothing is re-read, connected or offered;
 * - the re-read failed — one error, as {@link rereadEditorCredential} words
 *   it; nothing is connected or offered;
 * - both succeeded — the socket is resumed, then one information notice whose
 *   single action is {@link ROTATE_SERVICE_TOKEN_ACTION}. This is the only
 *   point the repair offers rotation: `auth.json` now holds a credential the
 *   restarted service issued or adopted, so the rotation it runs is accepted,
 *   and it is worth running when something other than Debug Generator changed
 *   the file. The command asks for its own confirmation.
 *
 * @param rt The runtime of the activation whose socket was refused.
 */
async function restartForCredentialRepair(rt: ExtensionRuntime): Promise<void> {
  if (hasLiveSession({ state: rt.state })) {
    const confirmed = await confirmModal(rt, RESTART_WITH_LIVE_SESSION);
    if (rt.disposed || !confirmed) {
      return;
    }
  }

  const restarted = await rt.serviceProcess.restart();
  if (rt.disposed) {
    return;
  }
  if (isErr(restarted)) {
    rt.logger.warn('The service could not be restarted to repair the editor credential', {
      code: restarted.error.code,
    });
    surface(rt, {
      level: 'error',
      message: toDisplayText(
        `Could not restart the Debug Generator service: ${restarted.error.message}`,
      ),
      hint: restarted.error.hint === undefined ? undefined : toDisplayText(restarted.error.hint),
    });
    return;
  }

  if (!(await rereadEditorCredential(rt))) {
    return;
  }
  rt.client.connect();
  rt.logger.info('The service was restarted to repair the editor credential', {
    state: restarted.value.state,
  });

  const choice = await showNotification(
    rt.logger,
    {
      level: 'info',
      message:
        'Restarted the Debug Generator service; this editor reconnects with the credential it issued.',
      hint: 'If anything other than Debug Generator changed auth.json, rotate the service token to revoke every credential issued before.',
    },
    [ROTATE_SERVICE_TOKEN_ACTION],
  );
  if (rt.disposed || choice !== ROTATE_SERVICE_TOKEN_ACTION) {
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
 * Reads `auth.json` again for the credential repair. A failure is logged by
 * its code and surfaced once, with the store's message and hint — never a
 * token or the file's content.
 *
 * @param rt The runtime of the activation whose socket was refused.
 * @returns `true` once the credential was read and the runtime is still live.
 */
async function rereadEditorCredential(rt: ExtensionRuntime): Promise<boolean> {
  const refreshed = await rt.credentials.refresh();
  if (rt.disposed) {
    return false;
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
    return false;
  }
  return true;
}

/**
 * Asks for confirmation in a modal warning, as `CommandUi.confirmDestructive`
 * does for the commands. Never rejects: a modal that cannot be shown is logged
 * by code and counts as declined.
 *
 * @param rt The runtime the modal belongs to.
 * @param confirmation The headline, what will be lost, and the one confirming button.
 * @returns `true` only when the developer chose exactly `confirmation.confirmLabel`.
 */
async function confirmModal(
  rt: ExtensionRuntime,
  confirmation: DestructiveConfirmation,
): Promise<boolean> {
  try {
    const choice = await vscode.window.showWarningMessage(
      confirmation.message,
      { modal: true, detail: confirmation.detail },
      confirmation.confirmLabel,
    );
    return choice === confirmation.confirmLabel;
  } catch (error) {
    rt.logger.debug('Confirmation could not be shown', {
      code: DebuggenError.from(error).code,
    });
    return false;
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
      rt.logger.info('Service URL changed', describeServiceUrl(rt.client));
      ensure = true;
    }
    if (event.affectsConfiguration(SETTING.provider)) {
      rt.state.setProvider(settings.provider);
      // The setting is free text in `settings.json`; only its class is logged.
      rt.logger.info('Model provider setting changed', {
        provider: classifyProviderSetting(settings.provider),
      });
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
 * How the end of the active session went during shutdown:
 *
 * | Outcome | Meaning |
 * | --- | --- |
 * | `no-session` | no open session to end |
 * | `ended` | the service answered the end request: its cleanup concluded |
 * | `in-progress` | the request timed out on this side; the service is still serving it — waiting for a cancelled install to settle, then restoring the files |
 * | `not-ended` | the service refused or failed the request, or could not be reached: nothing is being restored for it |
 */
export type ShutdownEndOutcome = 'no-session' | 'ended' | 'in-progress' | 'not-ended';

/**
 * Deactivates the extension and upholds the end-of-session cleanup guarantee
 * (AAP §0.5.1): every session this editor is responsible for is ended at the
 * service that owns it — the service restores every instrumented file — and
 * the service child this extension spawned is never acted on in a way that
 * interrupts that restore: it is left running while an end is still in
 * progress, and force-stopped only when every end concluded. VS Code awaits
 * the returned promise within its own budget ({@link DEACTIVATE_BUDGET_MS}
 * stays inside it), which is why this is asynchronous while `activate` is
 * not. Never throws.
 *
 * The session work is {@link endSessionsForShutdown}, the one routine the
 * suites exercise as "actual deactivation": it ends the active session, waits
 * (bounded) for every `POST /sessions` in flight, and ends what those created.
 */
export async function deactivate(): Promise<void> {
  const rt = runtime;
  runtime = undefined;
  if (rt === undefined) {
    return;
  }
  rt.disposed = true;

  try {
    // 0. Close the gate: from here on no command creates, reopens or adopts a
    //    session, and a create already in flight hands its session over.
    rt.state.beginShutdown();

    // 1. End the sessions, and 2. stop the child this extension spawned (a
    //    service someone else runs is never touched). Both are issued
    //    synchronously, before the first `await`: the routine sends the active
    //    session's end before its own first `await`, and its promise is
    //    registered with the process manager in this same turn. The extension
    //    host disposes `context.subscriptions` — the store, the client and the
    //    process manager included — right after this function returns its
    //    promise; the create ledger survives that disposal, HTTP still works on
    //    a disposed client, and the manager's disposal leaves the child to a
    //    stop already in flight instead of racing it with a termination of its
    //    own. The stop waits for the ends before it acts on the child, and
    //    leaves it running while an end is still in progress; signalling it
    //    earlier would stop the
    //    service mid-cleanup and leave patched files in the developer's
    //    working tree until the service's start-up reconciliation repairs
    //    them — a safety net, not a substitute for ending the session here.
    const ending = rt.serviceProcess.keepAliveFor(
      endSessionsForShutdown({ state: rt.state, client: rt.client, logger: rt.logger }).then(
        shutdownEndOutcomeOf,
      ),
    );
    await stopServiceForShutdown(rt.serviceProcess, ending, rt.logger);
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
 * Reads the shutdown routine's report as the one outcome the stop acts on
 * ({@link ShutdownEndOutcome}): `in-progress` when an end timed out on this
 * side or a create was still unanswered — the service may still be restoring
 * files, or be about to create a session the start command then ends —
 * `not-ended` when an end was refused or failed, or an open session had no
 * known owner, `ended` when every end concluded, and `no-session` when there
 * was nothing to end.
 *
 * @param report What {@link endSessionsForShutdown} did.
 */
export function shutdownEndOutcomeOf(report: ShutdownReport): ShutdownEndOutcome {
  if (report.unsettledCreates > 0 || report.ended.some((end) => end.timedOut === true)) {
    return 'in-progress';
  }
  if (report.unowned.length > 0 || report.ended.some((end) => end.code !== undefined)) {
    return 'not-ended';
  }
  return report.ended.length === 0 ? 'no-session' : 'ended';
}

/**
 * Stops the service child for shutdown within {@link DEACTIVATE_BUDGET_MS},
 * without ever cutting a restore short.
 *
 * `stop()` is called synchronously — before this function's first `await` —
 * so a `dispose()` that follows at once finds the stop in flight and leaves
 * the child to it. The stop waits for `ending` (bounded by
 * {@link DEACTIVATE_QUIESCE_TIMEOUT_MS}) and then, by the outcome:
 *
 * - **still in progress** (`in-progress`, or not settled by the bound) — the
 *   child is **released**: left running and never signalled, because the
 *   service keeps serving the end request after this window stops waiting
 *   and a signal would interrupt its restore. It restores the files on its
 *   own schedule, and a later window finds it answering and uses it. A child
 *   kept on an address `debuggen.serviceUrl` no longer names cannot be
 *   serving the request and is stopped as below;
 * - **refused or failed** (`not-ended`) — `SIGTERM`, and no `SIGKILL`: the
 *   service runs its own shutdown, and whatever it leaves instrumented is
 *   restored when it next starts (AAP §0.5.1);
 * - **concluded** (`ended`, or `no-session`) — `SIGTERM`, then `SIGKILL`
 *   after {@link DEACTIVATE_STOP_GRACE_MS} if the child is still running.
 *
 * @example
 * ```ts
 * const report = endSessionsForShutdown({ state, client, logger });
 * const ending = rt.serviceProcess.keepAliveFor(report.then(shutdownEndOutcomeOf));
 * await stopServiceForShutdown(rt.serviceProcess, ending, rt.logger);
 * ```
 *
 * @param serviceProcess The process manager; a service it did not spawn is never touched.
 * @param ending How the active session's end went; a rejection counts as `not-ended`.
 * @param logger Where an unconcluded end is reported.
 * @returns The end's outcome, or `undefined` when it had not settled by the
 *   time the stop acted on the child. Never rejects.
 */
export async function stopServiceForShutdown(
  serviceProcess: Pick<ServiceProcess, 'stop'>,
  ending: Promise<ShutdownEndOutcome>,
  logger: Logger,
): Promise<ShutdownEndOutcome | undefined> {
  let outcome: ShutdownEndOutcome | undefined;
  const settled = ending.then(
    (value) => {
      outcome = value;
    },
    () => {
      outcome = 'not-ended';
    },
  );
  const inProgress = (): boolean => outcome === undefined || outcome === 'in-progress';
  const concluded = (): boolean => outcome === 'ended' || outcome === 'no-session';
  try {
    // Issued before the first `await` of this function; see the TSDoc.
    const stopping = serviceProcess.stop({
      awaitInFlight: settled,
      quiesceTimeoutMs: DEACTIVATE_QUIESCE_TIMEOUT_MS,
      graceMs: DEACTIVATE_STOP_GRACE_MS,
      release: inProgress,
      escalate: concluded,
    });
    await stopping;
  } catch (error) {
    logger.error('Stopping the service on shutdown failed unexpectedly', {
      code: DebuggenError.from(error).code,
    });
  }
  if (inProgress()) {
    logger.warn(
      'The session end was still in progress at shutdown; a service this window started is left running, unsignalled, so it finishes restoring the instrumented files',
      { outcome: outcome ?? 'pending' },
    );
  } else if (!concluded()) {
    logger.warn(
      'The session end did not conclude before shutdown; a service this window started is sent SIGTERM but never force-stopped, and anything it leaves instrumented is restored when the service next starts',
      { outcome },
    );
  }
  return outcome;
}
