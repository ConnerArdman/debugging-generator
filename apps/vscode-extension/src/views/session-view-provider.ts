/**
 * The extension-host provider of the `debuggen.session` webview view: the
 * **Debug Generator** sidebar (AAP §0.7.1 Group 3, §0.7.3).
 *
 * ## What this file owns, and what it deliberately does not
 *
 * It owns exactly two things:
 *
 * 1. **The document shell.** A static HTML page under a strict,
 *    nonce-based Content-Security-Policy that loads the one Vite bundle
 *    (`dist/webview/main.js` + `dist/webview/main.css`) into `<div id="root">`.
 *    The page is parameterised only by those two `asWebviewUri` results, a
 *    fresh nonce and `webview.cspSource`: no state, no session data, no
 *    question text, no project path, no theme and no credential is ever
 *    written into it. Everything the view shows arrives afterwards over
 *    `postMessage`.
 * 2. **The whole host↔webview message channel.** Inbound, every frame is
 *    treated as untrusted input (AAP §0.5.6): it is checked with
 *    {@link isWebviewToHostMessage}, its payload is checked, and it is then
 *    dispatched through an exhaustive `switch` closed by `assertNever`, so a new
 *    member of {@link WebviewToHostMessage} is a compile error here rather than
 *    a silently dropped action. Outbound, this class is the only sender of
 *    {@link HostToWebviewMessage}, and it implements all four variants.
 *
 * It renders no UI (the React application lives in `src/webview/**`), holds no
 * copy of the view state (`src/state.ts` is the single host cache), performs no
 * pipeline behaviour (that is the local service) and speaks no transport of its
 * own (that is `src/service/client.ts`). It validates, projects and dispatches.
 *
 * ## Dispatch policy
 *
 * A webview action that has a contributed command runs **that command**, so the
 * Command Palette and the view share one implementation and one
 * error-notification path — project-root resolution, dev-server probing and
 * source-location containment all stay where the commands put them. Only an
 * action no command covers (a follow-up question) calls the `ServiceClient`
 * directly, and every such call branches on the returned `Result`, because the
 * client never throws. An action that neither covers — asking for the element
 * picker, which lives in the DevTools panel and has no HTTP operation — is
 * answered with an explanatory notice, never with an invented route and never
 * with silence.
 *
 * Command ids are written as literals in {@link COMMAND_ROUTES}; nothing here
 * derives a command id from message content.
 *
 * ## Why every action is answered
 *
 * The webview marks the action it sent as pending until the host next speaks
 * (a `state`, `notice` or `pairing` frame) and disables the matching control
 * meanwhile. A command that succeeds without changing the store would otherwise
 * leave that control disabled for good, so once a dispatched action settles the
 * provider posts either a notice (it failed) or a fresh `state` snapshot (it
 * ran). Snapshots are idempotent, so the acknowledgement costs one structured
 * clone and can never show anything the store does not hold.
 *
 * ## Handshake
 *
 * `retainContextWhenHidden` keeps the document alive while the sidebar is
 * hidden, but a window reload, an extension restart or a recreated view still
 * produces a fresh document with no state. The webview therefore posts one
 * `ready` frame from module scope (`src/webview/main.tsx`) and this provider
 * answers it with the current snapshot (plus the live pairing code, when one is
 * showing). `src/webview/vscode-api.ts` buffers frames that arrive before React
 * subscribes, so the handshake is race-free on both sides.
 *
 * @example
 * ```ts
 * // In activate(): construct, register with the options constant, keep the
 * // instance for the commands that post notices and focus requests.
 * const sessionView = new SessionViewProvider({ extensionUri, state, client, logger });
 * context.subscriptions.push(
 *   sessionView,
 *   vscode.window.registerWebviewViewProvider(
 *     SESSION_VIEW_ID,
 *     sessionView,
 *     SESSION_VIEW_REGISTRATION_OPTIONS,
 *   ),
 * );
 * ```
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { PROGRESS_STAGES } from '@debuggen/protocol';
import type { ProgressStage } from '@debuggen/protocol';
import { DebuggenError, assertNever, isErr } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';

import type { ServiceClient } from '../service/client';
import type { ExtensionState } from '../state';
import { isWebviewToHostMessage } from '../webview-messages';
import type {
  HostToWebviewMessage,
  HostToWebviewMessageOf,
  PairingState,
  WebviewState,
  WebviewToHostMessage,
  WebviewToHostMessageType,
} from '../webview-messages';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * The contributed webview view id. It must equal `contributes.views` in
 * `apps/vscode-extension/package.json` (and the `onView:` activation event);
 * `test/suite/activation.test.ts` resolves the view through it, and a typo
 * yields a permanently empty view with no error.
 */
export const SESSION_VIEW_ID = 'debuggen.session';

/** The options bag `vscode.window.registerWebviewViewProvider` accepts. */
export type SessionViewRegistrationOptions = NonNullable<
  Parameters<typeof vscode.window.registerWebviewViewProvider>[2]
>;

/**
 * The options every registration of {@link SessionViewProvider} must pass.
 *
 * `retainContextWhenHidden` belongs to the **registration** options, not to
 * `webview.options` (`vscode.WebviewOptions` carries `enableScripts` and
 * `localResourceRoots` only, and an unknown key there is silently ignored).
 * Exporting the constant means neither this file nor `src/extension.ts` can
 * omit it: the view holds a live React tree, streaming progress and a
 * half-typed question, all of which a hidden-and-shown sidebar would otherwise
 * throw away.
 */
export const SESSION_VIEW_REGISTRATION_OPTIONS: SessionViewRegistrationOptions = Object.freeze({
  webviewOptions: Object.freeze({ retainContextWhenHidden: true }),
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The severity vocabulary of a `notice` frame, as `src/webview-messages.ts` declares it. */
export type NoticeLevel = HostToWebviewMessageOf<'notice'>['level'];

/** The section vocabulary of a `focus` frame, as `src/webview-messages.ts` declares it. */
export type FocusSection = HostToWebviewMessageOf<'focus'>['section'];

/**
 * A notice to show in the view. `hint` may be passed as `undefined` (a
 * `DebuggenError` without a hint, for instance); an absent or empty hint is
 * omitted from the frame rather than sent as an empty line.
 */
export interface SessionViewNotice {
  readonly level: NoticeLevel;
  readonly message: string;
  readonly hint?: string | undefined;
}

/**
 * Everything the provider needs, injected so the file holds no module-level
 * singleton and reads no configuration (configuration belongs to
 * `src/service/**` and `src/extension.ts`).
 */
export interface SessionViewDeps {
  /** The extension's install root; the only resource root is its `dist/`. */
  readonly extensionUri: vscode.Uri;
  /** The single host cache of what the view renders. */
  readonly state: ExtensionState;
  /** The typed service façade; every operation resolves to a `Result`. */
  readonly client: ServiceClient;
  /** Structured, message-first logger. Receives shapes and codes, never payloads. */
  readonly logger: Logger;
  /**
   * Test seam: produces the per-document script nonce. Defaults to 16 bytes
   * (128 bits) from `node:crypto`, base64url-encoded. It must return a fresh,
   * unpredictable value on every call.
   */
  readonly nonceFactory?: (() => string) | undefined;
  /** Test seam over `vscode.commands.executeCommand`. */
  readonly executeCommand?: (<T>(command: string, ...args: unknown[]) => Thenable<T>) | undefined;
}

/**
 * The part of a `vscode.Webview` the HTML builder needs. A real webview
 * satisfies it structurally, which is what lets a test assert the CSP and the
 * two asset URIs without a live editor.
 */
export interface WebviewHtmlPort {
  readonly cspSource: string;
  asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

/**
 * What {@link SessionViewProvider.register} returns: one disposable that tears
 * down both the registration and the provider, plus the provider itself for the
 * callers (commands, the inbound WebSocket table) that post notices and focus
 * requests through it.
 */
export interface SessionViewRegistration extends vscode.Disposable {
  readonly provider: SessionViewProvider;
}

// ---------------------------------------------------------------------------
// The document shell
// ---------------------------------------------------------------------------

/** The only directory the webview may load resources from. */
const LOCAL_RESOURCE_ROOT = 'dist';

/**
 * Where Vite writes the webview bundle, relative to the extension root.
 *
 * `vite.config.ts` emits it **unhashed and single-chunk** as exactly
 * `main.js` and `main.css` (`entryFileNames: 'main.js'`,
 * `assetFileNames: 'main.[ext]'`, `cssCodeSplit: false`), and `esbuild.mjs`
 * never touches `dist/webview`. Those filenames are a cross-file agreement: if
 * the Vite config ever hashes them, the view loads blank, which is why they are
 * joined in exactly one place ({@link webviewAssetUri}).
 */
const WEBVIEW_ASSET_DIRECTORY = [LOCAL_RESOURCE_ROOT, 'webview'] as const;

/** The two files of the webview bundle. */
type WebviewAssetFile = 'main.js' | 'main.css';

/** The document title: product wording only. */
const DOCUMENT_TITLE = 'Debug Generator';

/** Bytes of entropy in the default nonce: 128 bits. */
const NONCE_BYTES = 16;

/**
 * A CSP nonce: the `base64-value` grammar of CSP Level 3 (letters, digits,
 * `+`, `/`, `-`, `_`, up to two trailing `=`), at least 22 characters — the
 * length of 128 bits in base64 without padding.
 */
const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{22,}={0,2}$/;

/**
 * Characters that must never appear in a value interpolated into the
 * double-quoted `content`/`href`/`src` attributes of the shell, nor split a
 * CSP directive. A single quote is deliberately allowed: VS Code's
 * `cspSource` is itself a source list such as `'self' https://*.vscode-cdn.net`,
 * and the attributes it lands in are double-quoted.
 */
const ATTRIBUTE_UNSAFE_PATTERN = /["<>;]/;

/**
 * Whether `value` contains a C0 control character or DEL — a line break or a
 * NUL in an attribute or a CSP directive would change how the document parses.
 *
 * @param value The value to scan.
 * @returns `true` when any code unit is below U+0020 or is U+007F.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves one file of the webview bundle to the URI its document loads.
 *
 * `asWebviewUri` is the only supported translation from an extension file to a
 * webview-loadable URI; no `vscode-resource:` or CDN URL is ever built by hand.
 *
 * @param port The webview (or a test double of it).
 * @param extensionUri The extension's install root.
 * @param file The bundle file.
 * @returns The webview URI of that file, as a string.
 */
function webviewAssetUri(
  port: WebviewHtmlPort,
  extensionUri: vscode.Uri,
  file: WebviewAssetFile,
): string {
  return port
    .asWebviewUri(vscode.Uri.joinPath(extensionUri, ...WEBVIEW_ASSET_DIRECTORY, file))
    .toString();
}

/**
 * Throws unless `value` is safe to interpolate into the shell.
 *
 * The shell interpolates generated values only — the nonce, `cspSource` and
 * the two `asWebviewUri` results — so there is deliberately no HTML-escaping
 * helper to rely on. This check makes that invariant fail loudly instead of
 * producing a document whose attributes can be broken out of.
 *
 * @param value The value to check.
 * @param what What the value is, for the error message.
 * @throws DebuggenError `INTERNAL` when the value is empty or carries a double
 * quote, an angle bracket, a semicolon or a control character.
 */
function assertAttributeSafe(value: string, what: string): void {
  if (!value || ATTRIBUTE_UNSAFE_PATTERN.test(value) || hasControlCharacter(value)) {
    throw new DebuggenError(
      'INTERNAL',
      `The webview ${what} is not safe to embed in the document.`,
    );
  }
}

/**
 * Builds the Content-Security-Policy of the shell.
 *
 * - `default-src 'none'` closes every fetch the view does not need, including
 *   `connect-src`: the webview opens no WebSocket and calls no `fetch`
 *   (`src/webview/vscode-api.ts`); all data arrives over `postMessage`.
 * - `script-src 'nonce-…'` admits exactly the one module script of the shell.
 *   There is no `'unsafe-eval'`: `src/webview/csp-runtime.ts` switches Zod to
 *   its jitless mode before anything else runs, so no `new Function` probe is
 *   attempted.
 * - `style-src` is `cspSource` alone because the stylesheet is a plain
 *   `<link>`; React sets element styles through the CSSOM, which `style-src`
 *   does not govern, so there is no `'unsafe-inline'`.
 * - `img-src`/`font-src` admit the extension's own resources, plus `data:`
 *   URLs for images a component renders inline.
 * - `base-uri 'none'` and `form-action 'none'` are not covered by
 *   `default-src`; they are closed so no injected `<base>` or `<form>` can
 *   redirect a resource or a submission.
 *
 * @param cspSource `webview.cspSource`, already checked.
 * @param nonce The per-document nonce, already checked.
 * @returns The policy, directives separated by `; `.
 */
function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Composes the webview document: a static shell that loads the webview bundle
 * under a strict nonce CSP and contains nothing else.
 *
 * The structure is fixed — doctype, `<html lang="en">`, charset, the CSP,
 * viewport, one stylesheet `<link>`, a title, then `<div id="root">` (the node
 * `src/webview/main.tsx` mounts into; it throws if the node is missing) before
 * the single `<script type="module">` (Vite emits an ES module). There is no
 * inline style, no inline script and no event-handler attribute; design tokens
 * arrive inside `main.css`, and the webview applies its theme attribute to the
 * document root itself.
 *
 * @param port The webview (or a structural double) supplying `cspSource` and
 * `asWebviewUri`.
 * @param extensionUri The extension's install root.
 * @param nonce A fresh CSP nonce for this document (see {@link SessionViewDeps.nonceFactory}).
 * @returns The HTML document.
 * @throws DebuggenError `INTERNAL` when the nonce is not a CSP nonce of at
 * least 128 bits, or when `cspSource` or a resolved asset URI is not safe to
 * embed. Both are programming errors, never data-dependent.
 */
export function buildSessionViewHtml(
  port: WebviewHtmlPort,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new DebuggenError(
      'INTERNAL',
      'The webview nonce must be a base64 value of at least 128 bits.',
    );
  }
  const cspSource = port.cspSource;
  assertAttributeSafe(cspSource, 'CSP source');
  const scriptUri = webviewAssetUri(port, extensionUri, 'main.js');
  const styleUri = webviewAssetUri(port, extensionUri, 'main.css');
  assertAttributeSafe(scriptUri, 'script URI');
  assertAttributeSafe(styleUri, 'stylesheet URI');
  const policy = contentSecurityPolicy(cspSource, nonce);

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    `    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <link rel="stylesheet" href="${styleUri}" />`,
    `    <title>${DOCUMENT_TITLE}</title>`,
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    `    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>`,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The document shown when the shell cannot be composed (a broken nonce seam or
 * an unsafe `cspSource`). Script-less and resource-less under
 * `default-src 'none'`, it states what happened instead of leaving a blank
 * sidebar (AAP §0.5.5). It carries no styling: the editor's default webview
 * styles apply.
 */
const UNAVAILABLE_DOCUMENT = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  `    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'" />`,
  `    <title>${DOCUMENT_TITLE}</title>`,
  '  </head>',
  '  <body>',
  '    <p>The Debug Generator view could not be loaded. Reload the window to try again; the Debug Generator output channel has the details.</p>',
  '  </body>',
  '</html>',
  '',
].join('\n');

/**
 * The default nonce: 16 bytes from the operating system's CSPRNG,
 * base64url-encoded (22 characters, no padding).
 *
 * @returns A fresh nonce.
 */
function defaultNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url');
}

/**
 * The default command runner: `vscode.commands.executeCommand`, resolved at
 * call time.
 *
 * @param command The command id.
 * @param args The command's arguments.
 * @returns Whatever the command returns.
 */
function defaultExecuteCommand<T>(command: string, ...args: unknown[]): Thenable<T> {
  return vscode.commands.executeCommand<T>(command, ...args);
}

// ---------------------------------------------------------------------------
// Dispatch tables
// ---------------------------------------------------------------------------

/**
 * The contributed commands the view drives — a subset of the twelve in
 * `package.json` `contributes.commands`, written as literals so a text search
 * finds every caller.
 */
type ViewCommandId =
  | 'debuggen.startSession'
  | 'debuggen.startCapture'
  | 'debuggen.stopCapture'
  | 'debuggen.endSession'
  | 'debuggen.openSource'
  | 'debuggen.launchDevServer'
  | 'debuggen.pairChrome';

/** The webview actions that run a contributed command. */
type CommandBackedAction = Extract<
  WebviewToHostMessageType,
  | 'askQuestion'
  | 'startCapture'
  | 'stopCapture'
  | 'endSession'
  | 'openFile'
  | 'launchDevServer'
  | 'pairChrome'
>;

/** One command-backed action: the command it runs and how to say it failed to run. */
interface CommandRoute {
  readonly command: ViewCommandId;
  /** Completes "Could not …" in the notice shown when the command itself cannot run. */
  readonly failure: string;
}

/**
 * Webview action → contributed command. Exhaustive over
 * {@link CommandBackedAction}, so adding an action to that union without a
 * route is a compile error.
 */
const COMMAND_ROUTES: Readonly<Record<CommandBackedAction, CommandRoute>> = Object.freeze({
  askQuestion: { command: 'debuggen.startSession', failure: 'start a debugging session' },
  startCapture: { command: 'debuggen.startCapture', failure: 'start the capture' },
  stopCapture: { command: 'debuggen.stopCapture', failure: 'stop the capture' },
  endSession: { command: 'debuggen.endSession', failure: 'end the session' },
  openFile: { command: 'debuggen.openSource', failure: 'open that source location' },
  launchDevServer: { command: 'debuggen.launchDevServer', failure: 'launch the dev server' },
  pairChrome: { command: 'debuggen.pairChrome', failure: 'start pairing with Chrome' },
});

/**
 * How a failed stage is retried. There is no HTTP operation that re-runs a
 * single stage (`HTTP_ROUTES` has none), so each retry re-dispatches exactly
 * one existing action that runs the failed stage again:
 *
 * - `restartSession` — the pipeline stages up to instrumentation run when a
 *   session is created, so the session's own question is asked again through
 *   `debuggen.startSession` (which also re-probes the dev server).
 * - `captureAgain` — capture, analysis and panel generation run from a
 *   capture; `debuggen.startCapture` re-arms with the installed plan (AAP
 *   §0.5.5 "Capture again"), and stopping it analyzes and generates anew.
 * - `resendFollowUp` — the last follow-up question is sent again.
 * - `endSessionAgain` — cleanup runs on `session.end`; ending again re-runs it.
 */
type RetryAction = 'restartSession' | 'captureAgain' | 'resendFollowUp' | 'endSessionAgain';

/**
 * Failed stage → retry. Keyed by the protocol's own stage vocabulary, so a
 * stage added to `PROGRESS_STAGES` without a retry is a compile error.
 */
const RETRY_ACTIONS: Readonly<Record<ProgressStage, RetryAction>> = Object.freeze({
  understand: 'restartSession',
  investigate: 'restartSession',
  plan: 'restartSession',
  instrument: 'restartSession',
  capture: 'captureAgain',
  analyze: 'captureAgain',
  'generate-panel': 'captureAgain',
  followup: 'resendFollowUp',
  cleanup: 'endSessionAgain',
});

/** The protocol's stage names, for narrowing a service-reported string. */
const PROGRESS_STAGE_NAMES: ReadonlySet<string> = new Set<string>(PROGRESS_STAGES);

/**
 * Narrows a stage name to the protocol's vocabulary.
 *
 * @param stage A stage name as the service (via the webview) reported it.
 * @returns Whether it is a {@link ProgressStage}.
 */
function isProgressStage(stage: string): stage is ProgressStage {
  return PROGRESS_STAGE_NAMES.has(stage);
}

/** The notice sent when an action needs a session and none is active. */
const NO_ACTIVE_SESSION_NOTICE: SessionViewNotice = Object.freeze({
  level: 'warning',
  message: 'No active session.',
  hint: 'Ask a question in the Debug Generator view to start one.',
});

/**
 * The answer to `requestTarget`. Element picking lives in the DevTools panel's
 * target picker, which the service reaches with the WebSocket `target.request`
 * message; the editor has no HTTP operation that asks the service to issue it,
 * so the developer is told where to pick — in the same words as the question
 * form's hint.
 */
const PICK_IN_DEVTOOLS_NOTICE: SessionViewNotice = Object.freeze({
  level: 'info',
  message:
    'To target a specific element, select it in the Debug Generator panel in Chrome DevTools.',
  hint: 'Press "Pick element" in the panel, or select the element in the Elements panel and press "Use selected element". The selection reaches this session automatically.',
});

/** The hint of a notice raised when VS Code could not run a command at all. */
const COMMAND_FAILURE_HINT =
  'Reload the window to restart the extension; the Debug Generator output channel has the details.';

/** The notice sent for a message whose `type` is known but whose payload is not. */
const MALFORMED_MESSAGE_NOTICE: SessionViewNotice = Object.freeze({
  level: 'error',
  message: 'The Debug Generator view sent a request the extension could not read.',
  hint: 'Reload the window; if it happens again, reinstall the extension.',
});

/** Longest `type` value copied into a log record from an unrecognised frame. */
const MAX_LOGGED_TYPE_LENGTH = 64;

/** Longest stage name echoed back in a notice. */
const MAX_ECHOED_STAGE_LENGTH = 64;

/**
 * The loggable shape of a frame that failed the message guard: whether it was
 * an object and, when its `type` is a string, that string (capped). Never the
 * payload — the webview is untrusted input (AAP §0.5.6).
 *
 * @param raw The rejected frame.
 * @returns Log fields describing its shape only.
 */
function describeShape(raw: unknown): LogFields {
  if (typeof raw !== 'object' || raw === null) {
    return { isObject: false, valueType: typeof raw };
  }
  const type: unknown = (raw as { readonly type?: unknown }).type;
  return typeof type === 'string'
    ? { isObject: true, type: type.slice(0, MAX_LOGGED_TYPE_LENGTH) }
    : { isObject: true };
}

/**
 * Whether a payload field is a string. Used for the payload checks the message
 * guard deliberately leaves to the receiver; it never looks at the content.
 *
 * @param value The field.
 * @returns `true` for a string.
 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * The `debuggen.session` webview view provider and the only sender of
 * host-to-webview messages.
 *
 * One instance lives for the whole activation. VS Code may resolve the view
 * more than once (the view is recreated after being moved, or after a
 * reload), so every resolution first tears down the previous view's
 * subscriptions; a post while no view is resolved, or after
 * {@link SessionViewProvider.dispose}, is a no-op rather than a rejection.
 */
export class SessionViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  /**
   * Constructs the provider and registers it under {@link SESSION_VIEW_ID}
   * with {@link SESSION_VIEW_REGISTRATION_OPTIONS}.
   *
   * @param deps The provider's dependencies.
   * @returns One disposable that disposes the registration and then the
   * provider, carrying the provider for callers that post through it.
   */
  static register(deps: SessionViewDeps): SessionViewRegistration {
    const provider = new SessionViewProvider(deps);
    let registration: vscode.Disposable;
    try {
      registration = vscode.window.registerWebviewViewProvider(
        SESSION_VIEW_ID,
        provider,
        SESSION_VIEW_REGISTRATION_OPTIONS,
      );
    } catch (error) {
      // A second registration of the same view id throws; nothing may leak.
      provider.dispose();
      throw error;
    }
    return {
      provider,
      dispose: (): void => {
        registration.dispose();
        provider.dispose();
      },
    };
  }

  private readonly logger: Logger;
  private readonly createNonce: () => string;
  private readonly runCommand: <T>(command: string, ...args: unknown[]) => Thenable<T>;

  /** The resolved view, while one is alive. */
  private view: vscode.WebviewView | undefined;
  /** Subscriptions scoped to {@link view}; disposed when it goes away. */
  private viewSubscriptions: readonly vscode.Disposable[] = [];
  private disposed = false;

  /**
   * @param deps The provider's dependencies; see {@link SessionViewDeps}.
   */
  constructor(private readonly deps: SessionViewDeps) {
    this.logger = deps.logger.child({ component: 'session-view' });
    this.createNonce = deps.nonceFactory ?? defaultNonce;
    this.runCommand = deps.executeCommand ?? defaultExecuteCommand;
  }

  /** Whether a view is currently resolved and the provider is live. */
  get isResolved(): boolean {
    return this.view !== undefined && !this.disposed;
  }

  // -------------------------------------------------------------------------
  // WebviewViewProvider
  // -------------------------------------------------------------------------

  /**
   * Resolves the view: options first (scripts on, `dist/` as the only
   * resource root), then the message and state subscriptions, then the
   * document. Synchronous, so there is nothing to cancel once it starts; a
   * resolution VS Code has already cancelled is skipped.
   *
   * @param webviewView The view to fill.
   * @param _context Resolution context; the webview restores its own UI state
   * through `vscode.getState`, so the host reads nothing from it.
   * @param token Cancelled when the view is disposed before it is resolved.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken,
  ): void {
    if (this.disposed) {
      this.logger.debug('Webview view resolution skipped: provider disposed');
      return;
    }
    if (token.isCancellationRequested) {
      this.logger.debug('Webview view resolution skipped: cancelled');
      return;
    }

    // A recreated view replaces the previous one; its listeners must not leak.
    this.detachView();

    const { webview } = webviewView;
    // Options before HTML: a document assigned while scripts are still
    // disabled would leave the bundle blocked. The root is `dist/` only —
    // never the extension root, which would expose `media/`, `package.json`
    // and, in a development checkout, `src/`.
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, LOCAL_RESOURCE_ROOT)],
    };

    this.view = webviewView;
    // Subscribed before the document is assigned, so the webview's `ready`
    // frame can never arrive ahead of its listener.
    this.viewSubscriptions = [
      webview.onDidReceiveMessage((raw: unknown) => {
        this.handleMessage(webviewView, raw);
      }),
      // `ExtensionState` already coalesces bursts into one event carrying a
      // fresh snapshot, so there is no timer, diff or dirty flag here.
      this.deps.state.onDidChange((snapshot: WebviewState) => {
        this.postSnapshot(snapshot);
      }),
      webviewView.onDidDispose(() => {
        this.handleViewDisposed(webviewView);
      }),
    ];

    webview.html = this.composeDocument(webview);
    this.logger.debug('Webview view resolved');
  }

  /**
   * Stops posting and releases the view's subscriptions. Idempotent. The
   * registration itself is disposed by whoever created it (see
   * {@link SessionViewProvider.register}).
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachView();
  }

  // -------------------------------------------------------------------------
  // Host → webview
  // -------------------------------------------------------------------------

  /** Posts the store's current snapshot as a `state` frame. */
  postState(): void {
    if (!this.isResolved) {
      return;
    }
    this.postSnapshot(this.deps.state.toWebviewState());
  }

  /**
   * Posts a developer-facing notice. An absent or empty hint is omitted.
   *
   * @param notice The level, message and optional hint. Never a token, a
   * credential, a raw payload or an error's `details`.
   */
  postNotice(notice: SessionViewNotice): void {
    const hint = notice.hint;
    const message: HostToWebviewMessageOf<'notice'> = {
      type: 'notice',
      level: notice.level,
      message: notice.message,
      ...(hint !== undefined && hint !== '' ? { hint } : {}),
    };
    this.post(message);
  }

  /**
   * Posts the pairing code to show, or clears the display.
   *
   * @param pairing The live code and its expiry; omit to clear.
   */
  postPairing(pairing?: PairingState): void {
    const message: HostToWebviewMessageOf<'pairing'> =
      pairing !== undefined
        ? { type: 'pairing', pairing: { code: pairing.code, expiresAt: pairing.expiresAt } }
        : { type: 'pairing' };
    this.post(message);
  }

  /**
   * Asks the view to move focus to a section.
   *
   * @param section One of the sections `src/webview-messages.ts` declares.
   */
  postFocus(section: FocusSection): void {
    const message: HostToWebviewMessageOf<'focus'> = { type: 'focus', section };
    this.post(message);
  }

  // -------------------------------------------------------------------------
  // Webview → host
  // -------------------------------------------------------------------------

  /**
   * Validates and dispatches one frame from the webview.
   *
   * @param source The view the frame came from; frames from a view that has
   * since been replaced or disposed are ignored.
   * @param raw The frame, untrusted.
   */
  private handleMessage(source: vscode.WebviewView, raw: unknown): void {
    if (this.disposed || this.view !== source) {
      return;
    }
    if (!isWebviewToHostMessage(raw)) {
      this.logger.warn('Ignored an unrecognised webview message', describeShape(raw));
      return;
    }
    this.logger.debug('Webview message received', { type: raw.type });
    this.dispatch(raw);
  }

  /**
   * Maps one validated message to its host action. Exhaustive: a member added
   * to {@link WebviewToHostMessage} without an arm fails to compile at the
   * `assertNever` below.
   *
   * @param message The validated message. Its payload fields are still
   * checked here, because the guard checks only the discriminant.
   */
  private dispatch(message: WebviewToHostMessage): void {
    switch (message.type) {
      case 'ready':
        this.replay();
        return;
      case 'askQuestion':
        if (!isString(message.question)) {
          this.rejectPayload(message.type);
          return;
        }
        // The question is forwarded as an opaque string; nothing here reads
        // its content (AAP §0.5.4).
        this.dispatchCommand(message.type, [{ question: message.question }]);
        return;
      case 'askFollowUp':
        if (!isString(message.question)) {
          this.rejectPayload(message.type);
          return;
        }
        this.sendFollowUp(message.question);
        return;
      case 'startCapture':
      case 'stopCapture':
      case 'endSession':
      case 'launchDevServer':
      case 'pairChrome':
        this.dispatchCommand(message.type);
        return;
      case 'openFile':
        // `debuggen.openSource` validates the location and enforces the
        // session's project root — one enforcement point, reached through the
        // command, so no path is checked or resolved here.
        this.dispatchCommand(message.type, [message.location]);
        return;
      case 'requestTarget':
        this.postNotice(PICK_IN_DEVTOOLS_NOTICE);
        return;
      case 'dismissPairing':
        // Local-only: the store's change event posts the new snapshot, so no
        // snapshot is posted by hand here.
        this.deps.state.clearPairing();
        return;
      case 'retryStage':
        if (!isString(message.stage)) {
          this.rejectPayload(message.type);
          return;
        }
        this.retryStage(message.stage);
        return;
      default:
        assertNever(message, 'Unhandled webview message');
    }
  }

  /**
   * Answers `ready`: the fresh document has no state, so it receives the
   * current snapshot and, when a pairing code is showing, that code.
   */
  private replay(): void {
    const snapshot = this.deps.state.toWebviewState();
    this.postSnapshot(snapshot);
    if (snapshot.pairing !== undefined) {
      this.postPairing(snapshot.pairing);
    }
  }

  /**
   * Runs the contributed command behind a webview action, then answers the
   * view: a fresh snapshot once the command has run (the command reports its
   * own failures through the shared notification path), or an error notice
   * when VS Code could not run the command at all.
   *
   * @param action The webview action.
   * @param args The command's arguments.
   */
  private dispatchCommand(action: CommandBackedAction, args: readonly unknown[] = []): void {
    const route = COMMAND_ROUTES[action];
    this.track(
      action,
      Promise.resolve()
        .then(() => this.runCommand<unknown>(route.command, ...args))
        .then(
          () => {
            this.postState();
          },
          (error: unknown) => {
            this.logger.warn('Webview action could not run its command', {
              action,
              command: route.command,
              code: DebuggenError.from(error).code,
            });
            this.postNotice({
              level: 'error',
              message: `Could not ${route.failure}.`,
              hint: COMMAND_FAILURE_HINT,
            });
          },
        ),
    );
  }

  /**
   * Sends a follow-up question for the active session. No contributed command
   * covers follow-ups, so this is the one action that calls the service
   * directly.
   *
   * @param question The follow-up, forwarded unread.
   */
  private sendFollowUp(question: string): void {
    const sessionId = this.deps.state.activeSessionId;
    if (sessionId === undefined) {
      this.postNotice(NO_ACTIVE_SESSION_NOTICE);
      return;
    }
    this.track(
      'askFollowUp',
      this.deps.client.askQuestion(sessionId, { question }).then((result) => {
        if (isErr(result)) {
          this.reportServiceFailure(
            'askFollowUp',
            'Could not send the follow-up question',
            result.error,
          );
          return;
        }
        // The updated record reaches the store through the `session.updated`
        // broadcast; this snapshot only answers the pending action.
        this.postState();
      }),
    );
  }

  /**
   * Retries a failed stage: the failure is cleared first, so the view leaves
   * its failed state at once, then exactly one existing action is dispatched
   * according to {@link RETRY_ACTIONS}. A stage outside the protocol's
   * vocabulary, or a retry whose input is gone, is answered with a notice.
   *
   * @param stage The failed stage as the view reported it.
   */
  private retryStage(stage: string): void {
    this.deps.state.clearStageFailure();

    if (!isProgressStage(stage)) {
      this.logger.warn('Retry requested for a stage outside the protocol vocabulary');
      this.postNotice({
        level: 'warning',
        message: `The "${stage.slice(0, MAX_ECHOED_STAGE_LENGTH)}" stage cannot be retried automatically.`,
        hint: 'Ask the question again to start a new session.',
      });
      return;
    }

    const retry = RETRY_ACTIONS[stage];
    this.logger.info('Retrying a failed stage', { stage, retry });
    switch (retry) {
      case 'restartSession': {
        const session = this.deps.state.activeSession;
        if (session === undefined) {
          this.postNotice(NO_ACTIVE_SESSION_NOTICE);
          return;
        }
        this.dispatchCommand('askQuestion', [{ question: session.question }]);
        return;
      }
      case 'captureAgain':
        this.dispatchCommand('startCapture');
        return;
      case 'endSessionAgain':
        this.dispatchCommand('endSession');
        return;
      case 'resendFollowUp': {
        const last = this.deps.state.activeSession?.followUps.at(-1);
        if (last === undefined) {
          this.postNotice({
            level: 'warning',
            message: 'There is no follow-up question to send again.',
            hint: 'Ask the follow-up question again in the Debug Generator view.',
          });
          return;
        }
        this.sendFollowUp(last.question);
        return;
      }
      default:
        assertNever(retry, 'Unhandled retry action');
    }
  }

  /**
   * Answers a message whose `type` is known but whose payload is not.
   *
   * @param type The message type; the payload is never logged.
   */
  private rejectPayload(type: WebviewToHostMessageType): void {
    this.logger.warn('Ignored a webview message with an invalid payload', { type });
    this.postNotice(MALFORMED_MESSAGE_NOTICE);
  }

  /**
   * Reports a typed service failure: logged by code, shown with the service's
   * message and hint. Never presented as success (AAP §0.5.5); `details` and
   * anything credential-bearing are never included.
   *
   * @param action The webview action that failed.
   * @param prefix What could not be done.
   * @param error The service's typed error.
   */
  private reportServiceFailure(
    action: WebviewToHostMessageType,
    prefix: string,
    error: DebuggenError,
  ): void {
    this.logger.warn('Service request from the view failed', { action, code: error.code });
    this.postNotice({ level: 'error', message: `${prefix}: ${error.message}`, hint: error.hint });
  }

  /**
   * Consumes a background action's promise, logging an unexpected rejection
   * instead of leaving it unhandled.
   *
   * @param action The webview action the work belongs to.
   * @param work The work.
   */
  private track(action: WebviewToHostMessageType, work: Promise<void>): void {
    void work.catch((error: unknown) => {
      this.logger.error('Webview action failed unexpectedly', {
        action,
        code: DebuggenError.from(error).code,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Private: view lifecycle and posting
  // -------------------------------------------------------------------------

  /**
   * Composes the document for a newly resolved view, falling back to a static
   * explanation when the shell cannot be built.
   *
   * @param webview The view's webview.
   * @returns The HTML to assign.
   */
  private composeDocument(webview: vscode.Webview): string {
    try {
      // A fresh nonce per document: never cached, never reused across resolves.
      return buildSessionViewHtml(webview, this.deps.extensionUri, this.createNonce());
    } catch (error) {
      this.logger.error('Could not compose the webview document', {
        code: DebuggenError.from(error).code,
      });
      return UNAVAILABLE_DOCUMENT;
    }
  }

  /**
   * Handles the resolved view going away.
   *
   * @param source The view that was disposed.
   */
  private handleViewDisposed(source: vscode.WebviewView): void {
    if (this.view !== source) {
      return;
    }
    this.detachView();
    this.logger.debug('Webview view disposed');
  }

  /** Drops the current view and disposes its subscriptions. */
  private detachView(): void {
    const subscriptions = this.viewSubscriptions;
    this.viewSubscriptions = [];
    this.view = undefined;
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  }

  /**
   * Posts a snapshot as a `state` frame.
   *
   * @param state The snapshot.
   */
  private postSnapshot(state: WebviewState): void {
    const message: HostToWebviewMessageOf<'state'> = { type: 'state', state };
    this.post(message);
  }

  /**
   * Posts one frame to the resolved view. Without a live view it is a no-op;
   * a rejection from a view torn down mid-post is logged at debug level and
   * swallowed, never left unhandled.
   *
   * @param message The frame.
   */
  private post(message: HostToWebviewMessage): void {
    const view = this.view;
    if (view === undefined || this.disposed) {
      this.logger.debug('Webview message not posted: no view', { type: message.type });
      return;
    }
    let delivery: Thenable<boolean>;
    try {
      delivery = view.webview.postMessage(message);
    } catch (error) {
      this.logger.debug('Webview message not posted: view unavailable', {
        type: message.type,
        code: DebuggenError.from(error).code,
      });
      return;
    }
    void Promise.resolve(delivery).then(
      (delivered: boolean) => {
        if (!delivered) {
          this.logger.debug('Webview message not delivered', { type: message.type });
        }
      },
      (error: unknown) => {
        this.logger.debug('Webview message rejected', {
          type: message.type,
          code: DebuggenError.from(error).code,
        });
      },
    );
  }
}
