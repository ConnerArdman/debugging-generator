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
 *    treated as untrusted input (AAP §0.5.6, CWE-20): it is parsed with
 *    {@link parseWebviewToHostMessage}, which validates the discriminant, the
 *    member's exact key set and every payload field, and only the rebuilt copy
 *    it returns is dispatched — through an exhaustive `switch` closed by
 *    `assertNever`, so a new member of {@link WebviewToHostMessage} is a compile
 *    error here rather than a silently dropped action. A refused frame is logged
 *    with closed values only — a rejection reason, a `typeof` class or an
 *    already-validated message type — and never with anything the frame
 *    carried, because the output channel is not redacted (CWE-532). Outbound,
 *    this class is the only sender of {@link HostToWebviewMessage}, and it
 *    implements all five variants.
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
 * source-location containment all stay where the commands put them. Only the
 * actions no command covers call the `ServiceClient` directly, and every such
 * call branches on the returned `Result`, because the client never throws:
 *
 * - a follow-up question (`askFollowUp`) → `session.question`;
 * - "Pick element" (`requestTarget`) → `target.request`
 *   (`POST /sessions/:id/target/request`). The element picker lives in the
 *   Debug Generator panel of Chrome DevTools, which the editor has no
 *   connection to, so the view asks the service, and the service pushes the
 *   WebSocket `target.request` to the DevTools tab bound to the active session
 *   — the binding, not the editor, chooses the tab. That panel enters picker
 *   mode, and the element the developer clicks returns to this view as the
 *   record's `target` in `session.updated`, never as a reply to this request.
 *   Success is answered with a notice saying where to pick; a refusal (no tab
 *   bound, its connection offline, the service unreachable, the session over)
 *   is answered with a notice saying what to do about it.
 *
 * Command ids are written as literals in {@link COMMAND_ROUTES}; nothing here
 * derives a command id from message content.
 *
 * ## Why every action is answered
 *
 * Every intent the view waits on is a **request** (`WEBVIEW_REQUEST_TYPES` in
 * `src/webview-messages.ts`): it carries a `requestId` the view minted, and the
 * view keeps the control that sent it pending — and, for a question or a
 * follow-up, keeps the typed text — until the host answers with **exactly one**
 * `actionResult` echoing that id, `accepted` or `failed`. Nothing else settles
 * a request: a snapshot also moves for unrelated reasons (progress, the capture
 * counter), and a notice may belong to another request, to a command run from
 * the Command Palette or to a service event, so neither names the request it
 * answers. `ready` and `openFile` wait on nothing, carry no id and get no
 * result.
 *
 * - **Attribution by request scope.** Each request is handled inside an
 *   `AsyncLocalStorage` scope that names it. The scope follows every promise
 *   chain the handling builds — the `vscode.commands.executeCommand` call, the
 *   contributed command's handler it reaches inside this same extension host,
 *   and the `CommandUi` notices that handler raises through
 *   {@link SessionViewProvider.postNotice} — so a notice is attributed to the
 *   request whose own execution raised it, and to no other. Two requests in
 *   flight at once never settle each other.
 * - **Why an error *and* a warning mean `failed`.** Commands report every
 *   outcome only through notices, and they raise warnings both for refusals
 *   (no active session, no workspace folder, a stage that cannot be retried)
 *   and for results that came with a caveat the developer must read. The view
 *   keeps a question or a follow-up for a `failed` result and clears it for an
 *   `accepted` one, so reading a warning as failure can at worst keep text the
 *   developer may resend, never discard text that did not land. The first
 *   warning or error settles the request at once; a command that keeps running
 *   afterwards (awaiting a notification's buttons, say) finds its request
 *   already answered and posts nothing more. An `info` notice settles nothing.
 * - **`accepted`** is posted once the handling returned and every piece of
 *   asynchronous work it registered through {@link SessionViewProvider.track}
 *   has resolved without a warning or error — after the fresh `state` snapshot
 *   that work posts, so the view renders the new state before it re-enables
 *   the control.
 * - **Notices outside every request scope** — service events surfaced by
 *   `src/extension.ts`, a command run from the Command Palette, the answer to a
 *   malformed frame — are presentational: they are shown and settle nothing.
 * - **Bounds.** At most {@link MAX_IN_FLIGHT_REQUESTS} requests are in flight
 *   at once; a request beyond that is answered `failed` without running
 *   anything. A request whose id is already in flight is logged and dropped —
 *   the original's result answers the id. The registry is cleared whenever the
 *   view is detached or the provider disposed: a re-resolved view is a new
 *   document with no pending state, so a late completion finds no request and
 *   posts no result.
 *
 * A request with a malformed payload is not a request at all: it is answered
 * with an error notice. A frame that is not an object, or whose `type` is not
 * an action, cannot be anything the view waits on and is logged and dropped.
 * Snapshots are idempotent, so the one posted after a command ran costs one
 * structured clone and can never show anything the store does not hold.
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

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import {
  FOLLOW_UP_ATTEMPT_ID_PREFIX,
  PROGRESS_STAGES,
  isFollowUpAnswered,
} from '@debuggen/protocol';
import type { ProgressStage, SessionRecord } from '@debuggen/protocol';
import { DebuggenError, assertNever, err, isErr, newId, ok } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';

import type { ServiceClient } from '../service/client';
import type { ExtensionState } from '../state';
import { isWebviewRequestMessage, parseWebviewToHostMessage } from '../webview-messages';
import type {
  ActionResultStatus,
  HostToWebviewMessage,
  HostToWebviewMessageOf,
  PairingState,
  WebviewMessageRejection,
  WebviewRequestMessage,
  WebviewRequestType,
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
 * `vite.config.mts` emits it **unhashed and single-chunk** as exactly
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
  | 'debuggen.pairChrome'
  | 'debuggen.showModifications';

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
  | 'loadModifications'
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
  loadModifications: {
    command: 'debuggen.showModifications',
    failure: 'load the file modifications',
  },
});

/**
 * How a failed stage is retried. There is no HTTP operation that re-runs a
 * single stage (`HTTP_ROUTES` has none), so each retry re-dispatches exactly
 * one existing action that runs the failed stage again:
 *
 * - `restartSession` — the pipeline stages up to instrumentation run when a
 *   session is created, so the session's own question is asked again through
 *   `debuggen.startSession` (which also re-probes the dev server). That command
 *   first ends the failed session and awaits the service's cleanup verdict
 *   (`endBeforeReplacing` in `src/commands/end-session.ts`): the replacement is
 *   created only once every patch of the failed session has been restored, and
 *   a refused end, or a verdict that leaves files for the developer to review,
 *   stops it with one notice. The failure therefore stays on screen, with its
 *   Retry, until the replacement session is adopted — which clears it.
 * - `captureAgain` — capture, analysis and panel generation run from a
 *   capture; `debuggen.startCapture` re-arms with the installed plan (AAP
 *   §0.5.5 "Capture again"), and stopping it analyzes and generates anew.
 * - `resendFollowUp` — the failed follow-up attempt, and only that one, is
 *   sent again under **its own attempt id** (see
 *   `SessionViewProvider.resendFollowUp`). Every new ask carries a fresh
 *   `attemptId`; a Retry resends the same id and question, so the service
 *   retries the attempt it recorded in place — the same ladder entry and the
 *   same stored row, one counter higher (`SessionManager.appendFollowUp` in
 *   `apps/local-service/src/sessions/manager.ts`) — or, when it never
 *   recorded it, records it once. The attempt is chosen by its id and its
 *   outcome links, never by its text (AAP §0.5.4), and an answered or
 *   superseded attempt is never resent.
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

/**
 * One follow-up attempt as `session.question` keys it: the session it belongs
 * to, the attempt id and the question to send. A Retry sends exactly this
 * again — the same id and the same question — so the service retries the
 * attempt instead of recording a second follow-up. The question is kept only
 * to be sent again, never compared (AAP §0.5.4).
 */
interface FollowUpAttempt {
  readonly sessionId: string;
  /** The protocol's attempt id (`FOLLOW_UP_ATTEMPT_ID_PREFIX`), minted by this view per new ask. */
  readonly attemptId: string;
  readonly question: string;
}

/** The attempt a Retry sends again, and how it was found. */
interface RetryableFollowUp {
  readonly attempt: FollowUpAttempt;
  /** Whether the session's record holds the attempt (`false`: it failed before the service recorded it). */
  readonly recorded: boolean;
  /** Whether it is the attempt this view last sent (`false`: read from the record's latest entry). */
  readonly remembered: boolean;
}

/**
 * The failed follow-up attempt a Retry sends again, or `undefined` when there
 * is none. Decided by attempt ids and outcome links alone — never by question
 * text, count or timestamp (AAP §0.5.4) — and in this order:
 *
 * 1. **The attempt this view last sent** for this session, unless the record
 *    shows it answered or followed by a later follow-up: either the record
 *    does not hold it (the ask failed before the service recorded it, and the
 *    resend records it once), or it is the record's latest entry and carries
 *    no outcome link (recorded, then failed; the resend retries it in place).
 *    It comes first because it is the developer's latest ask from this view.
 * 2. **The record's latest follow-up**, when it is unanswered and carries an
 *    attempt id — an attempt asked before a reload cleared what this view
 *    remembered, or from another surface.
 *
 * A latest entry without an attempt id (written before attempts were
 * identified) is never resent: the service could only record it again as a
 * new follow-up, a duplicate. Nor is an answered attempt, which the service
 * would refuse as already answered, or a superseded one, which it would refuse
 * because a later follow-up followed it.
 *
 * @param session The active session's record.
 * @param remembered The attempt this view last sent, for any session.
 * @returns The attempt to send again, or `undefined`.
 */
function followUpToRetry(
  session: SessionRecord,
  remembered: FollowUpAttempt | undefined,
): RetryableFollowUp | undefined {
  const ladder = session.followUps;
  const latestIndex = ladder.length - 1;

  if (remembered !== undefined && remembered.sessionId === session.id) {
    const index = ladder.findIndex((entry) => entry.attemptId === remembered.attemptId);
    if (index === -1) {
      return { attempt: remembered, recorded: false, remembered: true };
    }
    const entry = ladder[index];
    if (index === latestIndex && entry !== undefined && !isFollowUpAnswered(entry)) {
      return { attempt: remembered, recorded: true, remembered: true };
    }
  }

  const latest = ladder[latestIndex];
  if (latest?.attemptId !== undefined && !isFollowUpAnswered(latest)) {
    return {
      attempt: { sessionId: session.id, attemptId: latest.attemptId, question: latest.question },
      recorded: true,
      remembered: false,
    };
  }
  return undefined;
}

/**
 * Mints the attempt id of a new follow-up ask: `@debuggen/shared`'s `newId`
 * under the protocol's {@link FOLLOW_UP_ATTEMPT_ID_PREFIX}, the same form the
 * service mints for an ask that carries none.
 *
 * @returns The id, or the typed failure of a host without the Web Crypto
 *   random source `newId` draws from — returned, never thrown, so the view
 *   answers the ask with a notice.
 */
function mintFollowUpAttemptId(): Result<string, DebuggenError> {
  try {
    return ok(newId(FOLLOW_UP_ATTEMPT_ID_PREFIX));
  } catch (error) {
    return err(DebuggenError.from(error, 'INTERNAL'));
  }
}

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
 * The answer to a `requestTarget` the service accepted: the `target.request`
 * push reached the live connection of the Chrome DevTools tab bound to the
 * session, whose Debug Generator panel arms picker mode on receipt.
 *
 * It claims only what the reply proves — the request reached the panel. The
 * push is one-way (AAP §0.4.2), so whether the page could enter picker mode is
 * reported by the panel itself, which shows the failure and turns picker mode
 * back off when the page agent is not running. The picked element returns to
 * this view as the record's `target` in `session.updated`. The notice carries
 * no tab id, no URL and no payload.
 */
const PICKER_MODE_NOTICE: SessionViewNotice = Object.freeze({
  level: 'info',
  message: 'Asked the Debug Generator panel in Chrome DevTools to enter picker mode.',
  hint: 'Pick the element in the application\'s tab. It becomes this session\'s target and appears here once the panel reports it; if the panel says picker mode could not start, reload the page there, or select the element in the Elements panel and press "Use selected element".',
});

/** Completes the failure notice of a `requestTarget` the service refused. */
const TARGET_REQUEST_FAILURE = 'Could not ask Chrome DevTools to pick an element';

/**
 * The next step for each refusal the `target.request` route defines
 * (`packages/protocol/src/http.ts`, Section D2).
 *
 * The service's error body carries no hint, so without this table a
 * `TAB_NOT_BOUND` would reach the developer with no next step, and a
 * `503 TRANSPORT_DISCONNECTED` with the protocol client's generic "the service
 * failed" advice, which is wrong: the service answered, the panel is what is
 * offline. Every text is constant and names product surfaces only.
 */
const TARGET_REQUEST_HINTS = Object.freeze({
  /** No DevTools tab is bound to the session. */
  tabNotBound:
    'Open Chrome DevTools on the application\'s tab and select the Debug Generator panel so it binds to this session, then press "Pick element" again.',
  /** A tab is bound, but its connection to the service is offline. */
  panelOffline:
    'The Debug Generator panel bound to this session is not connected. Reopen Chrome DevTools on the application\'s tab, wait until the panel shows Connected, then press "Pick element" again.',
  /** The session ended or failed, so a target could no longer be used. */
  sessionOver:
    'This session has ended or failed, so it can no longer take a target. Ask a question to start a new session, then pick the element.',
  /** The service does not know the session (it may have been purged). */
  sessionMissing:
    'The local service no longer has this session. Ask a question to start a new session, then pick the element.',
});

/**
 * The hint shown for a refused `target.request`.
 *
 * `TRANSPORT_DISCONNECTED` means two different things here, and only the
 * status tells them apart: with an HTTP status the service answered `503` —
 * the bound panel is offline; without one the request never reached the
 * service, whose own hint (the service may not be running) is the right one.
 * Codes outside the route's contract keep the error's own hint.
 *
 * @param error The typed failure the client returned.
 * @returns The developer-facing next step, or `undefined` when there is none.
 */
function targetRequestHint(error: DebuggenError): string | undefined {
  switch (error.code) {
    case 'TAB_NOT_BOUND':
      return TARGET_REQUEST_HINTS.tabNotBound;
    case 'TRANSPORT_DISCONNECTED':
      return typeof error.details?.status === 'number'
        ? TARGET_REQUEST_HINTS.panelOffline
        : error.hint;
    case 'SESSION_INVALID_STATE':
      return TARGET_REQUEST_HINTS.sessionOver;
    case 'SESSION_NOT_FOUND':
      return TARGET_REQUEST_HINTS.sessionMissing;
    default:
      return error.hint;
  }
}

/** The hint of a notice raised when VS Code could not run a command at all. */
const COMMAND_FAILURE_HINT =
  'Reload the window to restart the extension; the Debug Generator output channel has the details.';

/** The notice sent for a message whose `type` is known but whose payload is not. */
const MALFORMED_MESSAGE_NOTICE: SessionViewNotice = Object.freeze({
  level: 'error',
  message: 'The Debug Generator view sent a request the extension could not read.',
  hint: 'Reload the window; if it happens again, reinstall the extension.',
});

/** Longest stage name echoed back in a notice. */
const MAX_ECHOED_STAGE_LENGTH = 64;

/**
 * A refusal the provider only logs: a frame that is not an object, or whose
 * `type` is not a webview-to-host action. An `invalid-payload` refusal names a
 * known action and is answered through {@link SessionViewProvider.rejectPayload}
 * instead.
 */
type UnrecognisedFrameRejection = Exclude<
  WebviewMessageRejection<WebviewToHostMessageType>,
  { readonly reason: 'invalid-payload' }
>;

/**
 * The log fields of an unrecognised frame: the closed rejection reason and, for
 * a non-object, its closed `typeof` class. Nothing else — in particular never
 * the frame's `type`, which is sender-controlled text and could carry a URL, a
 * query string or a token into the unredacted output channel (CWE-532). The
 * rejection holds no frame content by construction, so no truncation or
 * scrubbing is needed here.
 *
 * @param rejection The parser's refusal.
 * @returns Log fields built from closed values only.
 */
function describeRejection(rejection: UnrecognisedFrameRejection): LogFields {
  switch (rejection.reason) {
    case 'not-an-object':
      return { reason: rejection.reason, valueType: rejection.valueType };
    case 'unknown-type':
      return { reason: rejection.reason };
    default:
      return assertNever(rejection, 'Unhandled webview message rejection');
  }
}

/**
 * Whether a payload field is a string. Defence in depth behind
 * {@link parseWebviewToHostMessage}, which has already validated every field;
 * it never looks at the content.
 *
 * @param value The field.
 * @returns `true` for a string.
 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

// ---------------------------------------------------------------------------
// Request registry
// ---------------------------------------------------------------------------

/**
 * The most webview requests the provider holds in flight at once: **64**.
 *
 * The view disables each control while its request is pending, so a
 * well-behaved document never has more than one request per request type in
 * flight — ten today. The bound exists for a document that misbehaves: every
 * in-flight request holds a registry entry, and a command that never settles
 * would otherwise let a flood of frames grow the registry without limit. A
 * request beyond the bound is answered `failed` at once and runs nothing.
 */
export const MAX_IN_FLIGHT_REQUESTS = 64;

/**
 * One webview request the provider has received and not yet answered.
 *
 * The object itself is the request's identity: it is what the request scope
 * carries, and a settlement only takes effect while this exact object is the
 * one registered under its id. A completion that outlives its registration —
 * the view was re-resolved, or the request was already answered — therefore
 * settles nothing, even if a later request happens to reuse the id.
 */
interface InFlightRequest {
  /** The id the view minted, echoed in the `actionResult`; never logged. */
  readonly requestId: string;
  /** The request's validated type, echoed as the result's `action`. */
  readonly action: WebviewRequestType;
  /**
   * Pieces of asynchronous work registered through `track()` that have not
   * resolved yet. The request is `accepted` once its handling has returned and
   * this reaches zero.
   */
  outstanding: number;
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
   * The follow-up attempt this view last sent — a new ask or a Retry —
   * replaced by every send. A Retry sends it again under the same attempt id
   * unless the record shows it answered or superseded (see
   * {@link followUpToRetry}).
   */
  private sentFollowUp: FollowUpAttempt | undefined;

  /**
   * The request whose handling is running, visible to everything that
   * handling calls — synchronously or through promise chains — including the
   * contributed command a request runs and the notices that command raises.
   * Empty outside every request.
   */
  private readonly requestScope = new AsyncLocalStorage<InFlightRequest>();
  /**
   * The requests received and not yet answered, keyed by their id; at most
   * {@link MAX_IN_FLIGHT_REQUESTS}. Cleared whenever the view is detached.
   */
  private readonly requests = new Map<string, InFlightRequest>();

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
   * Stops posting, releases the view's subscriptions and forgets every
   * request in flight (through {@link detachView}), so work that completes
   * afterwards answers nothing. Idempotent. The registration itself is disposed
   * by whoever created it (see {@link SessionViewProvider.register}).
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
   * The notice is posted first, then attributed. A `warning` or `error` raised
   * inside a request's scope — by the request's own arm, or by the contributed
   * command it ran, which reports every outcome through `CommandUi.notify` and
   * so through here — settles that request `failed` at once, so the view shows
   * the reason before the result re-enables its control. An `info` notice
   * settles nothing, and a notice raised outside every request scope (a
   * service event, a command run from the palette) is presentational only.
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

    if (notice.level === 'info') {
      return;
    }
    const request = this.requestScope.getStore();
    if (request !== undefined) {
      this.settleRequest(request, 'failed');
    }
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
   * Parses one frame from the webview and dispatches the parsed copy.
   *
   * A request (a member of `WEBVIEW_REQUEST_TYPES`, carrying a validated
   * `requestId`) goes through {@link dispatchRequest}, which answers it with
   * exactly one `actionResult`. `ready` and `openFile` wait on nothing and are
   * dispatched outside every request scope, so nothing they raise can be
   * attributed to a request, whatever context delivered the frame.
   *
   * A frame naming a known action with a malformed payload — a request without
   * a valid `requestId` included — is logged by its validated type and
   * answered with {@link MALFORMED_MESSAGE_NOTICE}; with no trustworthy id
   * there is no request to answer. Any other refusal — not an object, or an
   * unknown `type` — is logged with {@link describeRejection}'s closed fields
   * and dropped. No log record ever carries the raw frame or any part of it.
   *
   * @param source The view the frame came from; frames from a view that has
   * since been replaced or disposed are ignored.
   * @param raw The frame, untrusted.
   */
  private handleMessage(source: vscode.WebviewView, raw: unknown): void {
    if (this.disposed || this.view !== source) {
      return;
    }
    const parsed = parseWebviewToHostMessage(raw);
    if (!parsed.ok) {
      const { rejection } = parsed;
      if (rejection.reason === 'invalid-payload') {
        this.rejectPayload(rejection.type);
      } else {
        this.logger.warn('Ignored an unrecognised webview message', describeRejection(rejection));
      }
      return;
    }
    const { message } = parsed;
    this.logger.debug('Webview message received', { type: message.type });
    if (isWebviewRequestMessage(message)) {
      this.dispatchRequest(message);
      return;
    }
    this.requestScope.exit(() => {
      this.dispatch(message);
    });
  }

  /**
   * Handles one request inside its own request scope and answers it with
   * exactly one `actionResult`.
   *
   * - An id already in flight is logged by the request's type and dropped: it
   *   runs nothing and gets no second result, because the original request's
   *   result already answers that id.
   * - Beyond {@link MAX_IN_FLIGHT_REQUESTS}, the request is logged and
   *   answered `failed` without running anything.
   * - Otherwise it is registered and {@link dispatch}ed inside
   *   {@link requestScope}. A warning or error notice raised by the handling
   *   settles it `failed` ({@link postNotice}); a rejected piece of tracked
   *   work settles it `failed` ({@link track}); an unexpected synchronous throw
   *   is logged by code and settles it `failed` here. If the handling returned
   *   without settling it and registered no outstanding work, it is `accepted`
   *   now; otherwise the last piece of tracked work to resolve accepts it.
   *
   * Nothing the frame carried besides its validated type is logged — never the
   * id, a question or a stage.
   *
   * @param message A validated request.
   */
  private dispatchRequest(message: WebviewRequestMessage): void {
    const { type, requestId } = message;
    if (this.requests.has(requestId)) {
      this.logger.warn('Ignored a webview request whose id is already in flight', { type });
      return;
    }
    if (this.requests.size >= MAX_IN_FLIGHT_REQUESTS) {
      this.logger.warn('Refused a webview request: too many requests in flight', {
        type,
        limit: MAX_IN_FLIGHT_REQUESTS,
      });
      this.postActionResult(requestId, type, 'failed');
      return;
    }

    const request: InFlightRequest = { requestId, action: type, outstanding: 0 };
    this.requests.set(requestId, request);
    try {
      this.requestScope.run(request, () => {
        this.dispatch(message);
      });
    } catch (error) {
      this.logger.error('Webview request failed unexpectedly', {
        action: type,
        code: DebuggenError.from(error).code,
      });
      this.settleRequest(request, 'failed');
      return;
    }
    if (request.outstanding === 0) {
      this.settleRequest(request, 'accepted');
    }
  }

  /**
   * Maps one parsed message to its host action. Exhaustive: a member added to
   * {@link WebviewToHostMessage} without an arm fails to compile at the
   * `assertNever` below.
   *
   * A request's arm runs inside that request's scope ({@link dispatchRequest}):
   * a warning or error notice it posts settles the request `failed`, and any
   * asynchronous work it starts must go through {@link track} for the request
   * to wait on it.
   *
   * @param message The copy {@link parseWebviewToHostMessage} rebuilt, every
   * payload field already validated. The string checks in the arms below are
   * defence in depth, never the only guard.
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
      case 'loadModifications':
        this.dispatchCommand(message.type);
        return;
      case 'openFile':
        // The parser has validated the location's shape only (a safe
        // project-relative path, 1-based line and column). That is lexical: it
        // cannot see a link, so `src/link/passwd` passes it when `src/link`
        // points at `/etc`. Containment belongs to `debuggen.openSource`,
        // whose opener, `openSourceLocation`, is the canonical gate: it
        // realpaths the session root and the target, requires a regular file
        // with a pinned device and inode inside the root, re-probes it without
        // following links, re-checks that identity and the loaded text after
        // the load and reveals that verified document at the canonical path.
        // The location is forwarded exactly as parsed and nothing is opened
        // or resolved here, so no frame reaches the editor around that gate.
        this.dispatchCommand(message.type, [message.location]);
        return;
      case 'requestTarget':
        this.requestTarget();
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
   * Runs the contributed command behind a webview action, then updates the
   * view: a fresh snapshot once the command has run (the command reports its
   * own failures through the shared notification path), or an error notice
   * when VS Code could not run the command at all. The work is tracked, so a
   * request that dispatched it is answered after that snapshot or notice.
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
   * Sends a new follow-up question for the active session. No contributed
   * command covers follow-ups, so this is the one action that calls the
   * service directly.
   *
   * Every new ask is a new attempt with a freshly minted attempt id — however
   * its wording relates to an earlier one, which is never compared (AAP
   * §0.5.4) — so the service appends it as its own follow-up. The attempt is
   * remembered so that a Retry of its failure resends the same id (see
   * `resendFollowUp`).
   *
   * A new ask needs only the active session's id — nothing of its record is
   * read — so it asks the store for `activeSessionId` alone, exactly as
   * {@link requestTarget} does. Only a Retry reads the whole record, to choose
   * the attempt it resends from the record's follow-up ladder.
   *
   * @param question The follow-up, forwarded unread.
   */
  private sendFollowUp(question: string): void {
    const sessionId = this.deps.state.activeSessionId;
    if (sessionId === undefined) {
      this.postNotice(NO_ACTIVE_SESSION_NOTICE);
      return;
    }
    const attemptId = mintFollowUpAttemptId();
    if (isErr(attemptId)) {
      this.logger.error('Could not mint a follow-up attempt id', { code: attemptId.error.code });
      this.postNotice({
        level: 'error',
        message: `Could not send the follow-up question: ${attemptId.error.message}`,
        hint: attemptId.error.hint,
      });
      return;
    }
    this.askAttempt({ sessionId, attemptId: attemptId.value, question });
  }

  /**
   * Sends one follow-up attempt — a new ask or a Retry — and remembers it as
   * the attempt this view last sent. The service answers once it has recorded
   * the attempt, or with the refusal or failure that came first; either way
   * the pending action is answered.
   *
   * @param attempt The attempt: its session, its id and its question.
   */
  private askAttempt(attempt: FollowUpAttempt): void {
    this.sentFollowUp = attempt;
    this.track(
      'askFollowUp',
      this.deps.client
        .askQuestion(attempt.sessionId, {
          question: attempt.question,
          attemptId: attempt.attemptId,
        })
        .then((result) => {
          if (isErr(result)) {
            this.reportServiceFailure(
              'askFollowUp',
              'Could not send the follow-up question',
              result.error,
            );
            return;
          }
          // The updated record reaches the store through the `session.updated`
          // broadcast; this snapshot is posted ahead of the request's result.
          this.postState();
        }),
    );
  }

  /**
   * Asks the Chrome DevTools tab bound to the active session to enter
   * element-picker mode, through the service's `target.request` operation. No
   * contributed command covers it, so like {@link sendFollowUp} it calls the
   * service directly and branches on the `Result`.
   *
   * Either outcome answers the pending action with a notice: success says the
   * panel was asked to enter picker mode and where to pick; a refusal says
   * what could not be done and what to do next ({@link targetRequestHint}).
   * The picked element itself arrives later, as the record's `target` in
   * `session.updated`, which the store applies and the view renders — nothing
   * here waits for it.
   */
  private requestTarget(): void {
    const sessionId = this.deps.state.activeSessionId;
    if (sessionId === undefined) {
      this.postNotice(NO_ACTIVE_SESSION_NOTICE);
      return;
    }
    this.track(
      'requestTarget',
      this.deps.client.requestTarget(sessionId).then((result) => {
        if (isErr(result)) {
          this.reportServiceFailure(
            'requestTarget',
            TARGET_REQUEST_FAILURE,
            result.error,
            targetRequestHint(result.error),
          );
          return;
        }
        this.logger.info('The bound Chrome DevTools panel was asked to enter picker mode');
        this.postNotice(PICKER_MODE_NOTICE);
      }),
    );
  }

  /**
   * Retries a failed stage: exactly one existing action is dispatched
   * according to {@link RETRY_ACTIONS}. The failure is cleared first, so the
   * view leaves its failed state at once — except for `restartSession`, whose
   * command may refuse to replace the failed session (its end was refused, or
   * its cleanup left files to review); there the failure and its Retry stay
   * until the replacement session is adopted, which clears them. A stage
   * outside the protocol's vocabulary, or a retry whose input is gone, is
   * answered with a notice.
   *
   * @param stage The failed stage as the view reported it.
   */
  private retryStage(stage: string): void {
    if (!isProgressStage(stage)) {
      this.deps.state.clearStageFailure();
      this.logger.warn('Retry requested for a stage outside the protocol vocabulary');
      this.postNotice({
        level: 'warning',
        message: `The "${stage.slice(0, MAX_ECHOED_STAGE_LENGTH)}" stage cannot be retried automatically.`,
        hint: 'Ask the question again to start a new session.',
      });
      return;
    }

    const retry = RETRY_ACTIONS[stage];
    if (retry !== 'restartSession') {
      this.deps.state.clearStageFailure();
    }
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
      case 'resendFollowUp':
        this.resendFollowUp();
        return;
      default:
        assertNever(retry, 'Unhandled retry action');
    }
  }

  /**
   * Sends the failed follow-up attempt again — exactly the attempt that
   * failed, under its own attempt id, never an answered or superseded one
   * (chosen by {@link followUpToRetry}; no question text is ever compared, AAP
   * §0.5.4). The service keys the resend by that id: an attempt it recorded is
   * retried in place — one ladder entry and one stored row, `attempt + 1` —
   * and one it never recorded is recorded once.
   *
   * A follow-up only fails on a `failed` session (the orchestrator files the
   * failing stage there), so any other status has nothing to resend. With
   * nothing to resend, the developer is asked to type the question again.
   */
  private resendFollowUp(): void {
    const session = this.deps.state.activeSession;
    if (session === undefined) {
      this.postNotice(NO_ACTIVE_SESSION_NOTICE);
      return;
    }

    const retry =
      session.status === 'failed' ? followUpToRetry(session, this.sentFollowUp) : undefined;
    if (retry !== undefined) {
      this.logger.info('Resending a failed follow-up attempt', {
        followUps: session.followUps.length,
        recorded: retry.recorded,
        remembered: retry.remembered,
      });
      this.askAttempt(retry.attempt);
      return;
    }

    this.logger.info('No failed follow-up to send again', {
      status: session.status,
      followUps: session.followUps.length,
    });
    this.postNotice({
      level: 'warning',
      message: 'There is no follow-up question to send again.',
      hint: 'Ask the follow-up question again in the Debug Generator view.',
    });
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
   * @param hint The next step to show; defaults to the error's own hint. An
   * action whose route defines refusals the error carries no remedy for (see
   * {@link targetRequestHint}) passes its own.
   */
  private reportServiceFailure(
    action: WebviewToHostMessageType,
    prefix: string,
    error: DebuggenError,
    hint: string | undefined = error.hint,
  ): void {
    this.logger.warn('Service request from the view failed', { action, code: error.code });
    this.postNotice({ level: 'error', message: `${prefix}: ${error.message}`, hint });
  }

  /**
   * Consumes a background action's promise, logging an unexpected rejection
   * instead of leaving it unhandled, and makes the request whose scope called
   * it wait on the work.
   *
   * Called inside a request scope, the work counts as outstanding for that
   * request: when it resolves, the request is `accepted` once no other tracked
   * work of it is outstanding (unless a warning or error notice has already
   * settled it `failed`); when it rejects, the request is settled `failed`.
   * Called outside every scope (`openFile`), it only consumes the promise.
   *
   * Asynchronous work in a request's arm of {@link dispatch} must go through
   * here for the request to wait on it: work that is not tracked is invisible
   * to the request, which is then accepted as soon as its arm returns.
   *
   * @param action The webview action the work belongs to.
   * @param work The work. It reports its own failures through notices and
   * resolves; a rejection means something failed unexpectedly.
   */
  private track(action: WebviewToHostMessageType, work: Promise<void>): void {
    const scoped = this.requestScope.getStore();
    const request =
      scoped !== undefined && this.requests.get(scoped.requestId) === scoped ? scoped : undefined;
    if (request !== undefined) {
      request.outstanding += 1;
    }
    void work.then(
      () => {
        if (request === undefined || this.requests.get(request.requestId) !== request) {
          return;
        }
        request.outstanding -= 1;
        if (request.outstanding === 0) {
          this.settleRequest(request, 'accepted');
        }
      },
      (error: unknown) => {
        this.logger.error('Webview action failed unexpectedly', {
          action,
          code: DebuggenError.from(error).code,
        });
        if (request !== undefined) {
          this.settleRequest(request, 'failed');
        }
      },
    );
  }

  /**
   * Answers a request, once. A no-op unless `request` is still the entry
   * registered under its id — it may already have been answered, or the view
   * re-resolved since — so every request receives exactly one result however
   * many of its notices and completions race to settle it.
   *
   * @param request The request to answer.
   * @param status How its handling ended.
   */
  private settleRequest(request: InFlightRequest, status: ActionResultStatus): void {
    if (this.requests.get(request.requestId) !== request) {
      return;
    }
    this.requests.delete(request.requestId);
    this.postActionResult(request.requestId, request.action, status);
    // The type and the closed status only: never the id, a question or a payload.
    this.logger.debug('Webview request answered', { action: request.action, status });
  }

  /**
   * Posts the `actionResult` frame answering one request.
   *
   * @param requestId The id the view gave the request.
   * @param action The request's validated type.
   * @param status How its handling ended.
   */
  private postActionResult(
    requestId: string,
    action: WebviewRequestType,
    status: ActionResultStatus,
  ): void {
    const message: HostToWebviewMessageOf<'actionResult'> = {
      type: 'actionResult',
      requestId,
      action,
      status,
    };
    this.post(message);
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

  /**
   * Drops the current view, forgets every request in flight and disposes the
   * view's subscriptions. A re-resolved view is a new document with no pending
   * state, so the old document's requests have no one left to answer: their
   * late completions find no registered entry and post nothing.
   */
  private detachView(): void {
    const subscriptions = this.viewSubscriptions;
    this.viewSubscriptions = [];
    this.view = undefined;
    this.requests.clear();
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
