/**
 * The typed contract between the extension host and the "Debug Generator"
 * webview view — the only module both halves of this workspace share.
 *
 * ## Why this file is shaped the way it is
 *
 * The workspace has two composite TypeScript projects: `tsconfig.json` (the
 * extension host, a Node process with no DOM) and `tsconfig.webview.json` (the
 * React page, with DOM and no Node). A relative import cannot cross a project
 * boundary, so both projects include this one file and compile it twice. That is
 * safe only because the module is inert, and every rule below follows from it:
 *
 * - **Every import is `import type`.** Under `verbatimModuleSyntax` they are
 *   erased, so the emitted JavaScript has no `import` at all and the webview
 *   bundle cannot pull `@debuggen/protocol`'s Zod graph in through here.
 * - **No environment-specific type.** No `MessageEvent`, `Window`, `Buffer` or
 *   `NodeJS.*`: each exists in only one of the two programs. The predicates
 *   therefore take `unknown`.
 * - **No runtime side effect.** The module emits two `as const` tuples, one
 *   version string and three pure functions — no top-level call, no `new`, no
 *   mutable state, no logging.
 *
 * ## Single definitions
 *
 * Every shape that crosses a process boundary is imported, never restated
 * (AAP §0.2.3): the session record, the analysis, relevant files, modification
 * records, the cleanup state, the selected target and the panel identity come
 * from `@debuggen/protocol` (which re-exports the upstream instrumentation and
 * panel types precisely so this workspace can name them without depending on
 * their owners), and `SourceLocation` comes from its owner, `@debuggen/shared`.
 * The types declared here are the webview's *projection* of those shapes, and
 * the two message unions that carry it.
 *
 * ## Serialization
 *
 * Every value crosses `webview.postMessage` / `vscode.postMessage` as plain
 * data, so every type here is JSON-serializable: no `Date` (time is an
 * epoch-millisecond `number`, the product's canonical time base), no `Map`, no
 * `Set`, no class instance, no function, and optional keys rather than sentinel
 * values.
 *
 * ## Privacy
 *
 * No type in this file carries a credential. The bearer tokens, the contents of
 * `auth.json` and the service's issued credentials stay in the host
 * (`src/service/auth.ts`) and never reach the page (AAP §0.5.2, §0.5.6).
 *
 * @example
 * ```ts
 * // Host: answer `ready` with the current snapshot.
 * view.webview.onDidReceiveMessage((value: unknown) => {
 *   if (!isWebviewToHostMessage(value)) return;
 *   if (value.type === 'ready') {
 *     const message: HostToWebviewMessage = { type: 'state', state: currentState };
 *     void view.webview.postMessage(message);
 *   }
 * });
 *
 * // Webview: accept only messages of this contract.
 * window.addEventListener('message', (event) => {
 *   if (isHostToWebviewMessage(event.data)) render(event.data);
 * });
 * ```
 */

import type {
  AnalysisResult,
  ConnectionState,
  ModificationRecord,
  PanelSpec,
  ProgressStatus,
  RelevantFile,
  SelectedTarget,
  SessionCleanup,
  SessionRecord,
} from '@debuggen/protocol';
import type { SourceLocation } from '@debuggen/shared';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * One row of the `ProgressSteps` view, built by the host from a real
 * `session.progress` frame and nothing else (AAP §0.5.4).
 *
 * **`stage` and `message` are server-provided strings.** The service composes
 * each line from what the stage actually found — a file it resolved, a handler
 * it traced, a signal it armed. This file must not enumerate stage names or step
 * labels, and no consumer may hardcode a step list, a canned progress script or
 * a label keyed by stage: the view groups and renders whatever the service
 * sent, in the order it arrived. `stage` is deliberately `string` rather than a
 * closed union so that no consumer can build an exhaustive table of it.
 *
 * `status` reuses the protocol's own three-value vocabulary (a spinner, a check,
 * a cross), so a row can never claim a state the service cannot report.
 */
export interface ProgressEntry {
  /** The pipeline stage that reported, exactly as the service named it. */
  stage: string;
  /** Whether that stage is working, finished or failed. */
  status: ProgressStatus;
  /** The line to show, composed by the service. */
  message: string;
  /** An optional second line, shown under the first when there is room. */
  detail?: string;
  /** When the host received the frame, in Unix epoch milliseconds. */
  ts: number;
}

/**
 * The identity of the latest generated panel, as the editor view needs it.
 *
 * The VS Code webview does not render panels — the DevTools panel does — so
 * only the panel's identity, version, title and fallback flag travel here.
 * Shipping the whole `PanelSpec` (its layout forest and summary) into the
 * webview is deliberately avoided: the editor links to the panel, it does not
 * duplicate it. The fields are picked from `PanelSpec` rather than restated, so
 * they cannot drift from the specification.
 *
 * `fallback` is `panel.meta?.fallback === true`: a panel assembled
 * deterministically because a generated one failed validation, which the view
 * labels as a fallback rather than presenting it as an answer (AAP §0.5.5).
 *
 * Not to be confused with `@debuggen/panel-schema`'s summary-header shape of the
 * same name, which this workspace never imports.
 */
export type PanelSummary = Pick<PanelSpec, 'id' | 'title' | 'panelVersion'> & {
  fallback: boolean;
};

/**
 * The session's cleanup state — `{ status, completedAt?, conflicts }` — which
 * `ModificationsList` and the "End session" row render.
 *
 * An alias of the protocol's own `SessionCleanup` (the type of
 * `SessionRecord['cleanup']` and of the `cleanup.completed` payload), not a
 * restatement of it: `status` is a `CleanupStatus`, `conflicts` is the
 * `ModificationConflict[]` cleanup refused to overwrite, and `completedAt` is
 * epoch milliseconds, absent while cleanup is pending.
 */
export type SessionCleanupState = SessionCleanup;

/**
 * The one-time pairing code of AAP §0.5.6, shown by the `PairingCode`
 * component after `debuggen.pairChrome` until the developer types it into the
 * DevTools panel's pair dialog or it expires.
 *
 * The code is a short-lived, single-use capability, never a credential: the
 * devtools credential it is exchanged for is issued to the Chrome extension and
 * never seen by the editor. **No bearer token, `auth.json` content or service
 * credential may ever appear in any type in this file** — the webview is a page,
 * and nothing it holds is secret.
 */
export interface PairingState {
  /** The code to display, exactly as the service issued it. */
  code: string;
  /** When the code stops being accepted, in Unix epoch milliseconds. */
  expiresAt: number;
}

/**
 * A pipeline stage that failed, rendered by the view as a failure with its
 * stage, message, hint and a retry action (AAP §0.5.5).
 *
 * Structurally separate from `WebviewState.analysis` and
 * `WebviewState.latestPanel` on purpose: a failure is rendered as a failure and
 * is never folded into an analysis, so no code path can present it as a
 * successful result.
 */
export interface StageFailure {
  /** The stage that failed, exactly as the service named it. */
  stage: string;
  /** The machine-readable error code the service reported. */
  code: string;
  /** What went wrong, in the service's words. */
  message: string;
  /** What the developer can do about it, when the service offered a hint. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * Everything the webview renders, as one snapshot the host owns.
 *
 * This is the **only** state shape the host pushes. The host holds the single
 * connection to the local service, folds every message it receives into its
 * store (`src/state.ts`) and posts the whole snapshot rather than deltas — the
 * store coalesces bursts, and a whole snapshot means a reloaded webview is
 * correct after one message. The webview is a pure projection of it: it has no
 * socket and no `vscode` API beyond `postMessage`, so any field a component needs
 * must be added here rather than fetched by the webview.
 *
 * `relevantFiles`, `modifications`, `analysis`, `target` and `cleanup` are the
 * host's current view of those facts, which it keeps from the latest session
 * record and from the messages that refine it between records
 * (`instrumentation.ready`, `analysis.completed`, `target.selected`,
 * `cleanup.completed`). `target` also exists before any session does, because an
 * element can be selected before the question is asked.
 */
export interface WebviewState {
  /** The host's connection to the local service, and what the status bar shows. */
  connection: {
    /** The reconnecting WebSocket client's state (`ConnectionState` in protocol). */
    status: ConnectionState;
    /** The configured service base URL, for display and for the start hint. */
    serviceUrl: string;
    /** Whether the service's `GET /health` answered on the last probe. */
    serviceReachable: boolean;
    /** The configured model provider's name, shown by `StatusBar`. */
    provider: string;
  };
  /** The active session, whole; absent before a question has been asked. */
  session?: SessionRecord;
  /** Progress rows in arrival order; see {@link ProgressEntry}. */
  progress: readonly ProgressEntry[];
  /** The files the investigation judged relevant, most relevant first. */
  relevantFiles: readonly RelevantFile[];
  /** Every file modification the session made, in the order applied. */
  modifications: readonly ModificationRecord[];
  /** The latest validated analysis; absent until one exists. */
  analysis?: AnalysisResult;
  /** The latest generated panel's identity; absent until one exists. */
  latestPanel?: PanelSummary;
  /** The element selected in DevTools, when there is one. */
  target?: SelectedTarget;
  /** The capture window, which drives `CaptureControls` and its live counter. */
  capture: {
    /** Whether a capture is running now. */
    active: boolean;
    /** The running (or last) capture's id, when there is one. */
    captureId?: string;
    /** How many events the running capture has ingested so far. */
    eventCount: number;
  };
  /** The session's cleanup state; `pending` until cleanup runs. */
  cleanup: SessionCleanupState;
  /** The pairing code on display, when one is. */
  pairing?: PairingState;
  /** The failed stage, when the session failed; never part of `analysis`. */
  failure?: StageFailure;
}

// ---------------------------------------------------------------------------
// Union construction
// ---------------------------------------------------------------------------

/** Flattens an intersection into one object type, preserving `?` and docs. */
type Flatten<T> = { [P in keyof T]: T[P] };

/** The payload of a message that carries nothing beyond its `type`. */
type NoPayload = Record<never, never>;

/**
 * Builds a union discriminated on `type` from a closed discriminant tuple and a
 * payload map, and proves at compile time that both name exactly the same
 * messages: a discriminant without a payload fails the first half of the
 * constraint, a payload without a discriminant fails the second (its key must be
 * `never`), and a payload that declares its own `type` fails the `type?: never`
 * member. That is what guarantees each predicate below accepts exactly the
 * discriminants of the union it narrows to.
 */
type DiscriminatedUnion<
  Types extends string,
  Payloads extends { [K in Types]: object & { type?: never } } & {
    [K in Exclude<keyof Payloads, Types>]: never;
  },
> = { [K in Types]: Flatten<{ type: K } & Payloads[K]> }[Types];

// ---------------------------------------------------------------------------
// Host → webview
// ---------------------------------------------------------------------------

/**
 * What each host-to-webview message carries, keyed by its `type`.
 *
 * Module-private: a consumer names one member as
 * `HostToWebviewMessageOf<'notice'>`.
 */
interface HostToWebviewPayloads {
  /** The snapshot push — the whole {@link WebviewState}, replacing the last one. */
  state: { state: WebviewState };
  /**
   * A transient, developer-facing notice that is not part of the snapshot: the
   * graceful-failure and informational copy of AAP §0.5.5, such as a signal
   * that could not be enabled, a capture that yielded nothing, or a file edited
   * while instrumented. The text is the service's or the host's, never authored
   * here.
   */
  notice: {
    /** How the view presents it. */
    level: 'info' | 'warning' | 'error';
    /** The notice itself. */
    message: string;
    /** What the developer can do next, when there is something. */
    hint?: string;
  };
  /**
   * Sets the pairing code on display, or clears it when `pairing` is absent,
   * without a full snapshot.
   */
  pairing: { pairing?: PairingState };
  /**
   * Moves focus to a section of the view, so host commands such as
   * `debuggen.startSession` and `debuggen.showModifications` land the developer
   * where they asked to be.
   */
  focus: { section: 'question' | 'modifications' | 'analysis' | 'followUp' };
}

/** Every host-to-webview discriminant, as the tuple the predicate checks. */
export const HOST_TO_WEBVIEW_MESSAGE_TYPES = [
  'state',
  'notice',
  'pairing',
  'focus',
] as const satisfies readonly (keyof HostToWebviewPayloads)[];

/** One of {@link HOST_TO_WEBVIEW_MESSAGE_TYPES}. */
export type HostToWebviewMessageType = (typeof HOST_TO_WEBVIEW_MESSAGE_TYPES)[number];

/**
 * A message the host posts to the webview with `webview.postMessage`,
 * discriminated on `type`:
 *
 * - `{ type: 'state'; state: WebviewState }`
 * - `{ type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; hint?: string }`
 * - `{ type: 'pairing'; pairing?: PairingState }`
 * - `{ type: 'focus'; section: 'question' | 'modifications' | 'analysis' | 'followUp' }`
 */
export type HostToWebviewMessage = DiscriminatedUnion<
  HostToWebviewMessageType,
  HostToWebviewPayloads
>;

/** The member of {@link HostToWebviewMessage} whose `type` is `K`. */
export type HostToWebviewMessageOf<K extends HostToWebviewMessageType> = Extract<
  HostToWebviewMessage,
  { type: K }
>;

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

/**
 * What each webview-to-host message carries, keyed by its `type`.
 *
 * Every entry is an intent the host carries out — an HTTP call to the service,
 * a command, an editor action — so the webview never needs a socket or the
 * `vscode` API. Module-private: a consumer names one member as
 * `WebviewToHostMessageOf<'openFile'>`.
 */
interface WebviewToHostPayloads {
  /**
   * Posted once on mount; the host answers with the current snapshot. The
   * webview never assumes it received earlier pushes: `retainContextWhenHidden`
   * keeps its state while hidden, but a reload must resynchronise.
   */
  ready: NoPayload;
  /** Starts a session with the developer's question, as typed. */
  askQuestion: { question: string };
  /** Asks a follow-up question on the active session, as typed. */
  askFollowUp: { question: string };
  /** Starts a capture window on the active session. */
  startCapture: NoPayload;
  /** Stops the running capture. */
  stopCapture: NoPayload;
  /** Ends the active session, which removes every instrumentation it applied. */
  endSession: NoPayload;
  /**
   * Opens a source location in the editor — the click-to-source origin of
   * `RelevantFiles`, `ModificationsList` and the suggested locations in
   * `AnalysisSummary`. The same `SourceLocation` shape the service and the
   * DevTools panel use; the host validates it against the session's project
   * root before opening anything.
   */
  openFile: { location: SourceLocation };
  /** Asks the DevTools panel bound to the session to enter element-picker mode. */
  requestTarget: NoPayload;
  /** Starts Chrome pairing (`debuggen.pairChrome`), which yields a pairing code. */
  pairChrome: NoPayload;
  /** Hides the pairing code on display. */
  dismissPairing: NoPayload;
  /** Launches the project's dev server with the telemetry preload attached. */
  launchDevServer: NoPayload;
  /** Retries the failed stage named by {@link StageFailure.stage}. */
  retryStage: { stage: string };
}

/** Every webview-to-host discriminant, as the tuple the predicate checks. */
export const WEBVIEW_TO_HOST_MESSAGE_TYPES = [
  'ready',
  'askQuestion',
  'askFollowUp',
  'startCapture',
  'stopCapture',
  'endSession',
  'openFile',
  'requestTarget',
  'pairChrome',
  'dismissPairing',
  'launchDevServer',
  'retryStage',
] as const satisfies readonly (keyof WebviewToHostPayloads)[];

/** One of {@link WEBVIEW_TO_HOST_MESSAGE_TYPES}. */
export type WebviewToHostMessageType = (typeof WEBVIEW_TO_HOST_MESSAGE_TYPES)[number];

/**
 * A message the webview posts to the host with `vscode.postMessage`,
 * discriminated on `type`:
 *
 * - `{ type: 'ready' }`
 * - `{ type: 'askQuestion'; question: string }`, `{ type: 'askFollowUp'; question: string }`
 * - `{ type: 'startCapture' }`, `{ type: 'stopCapture' }`, `{ type: 'endSession' }`,
 *   `{ type: 'requestTarget' }`, `{ type: 'pairChrome' }`, `{ type: 'dismissPairing' }`,
 *   `{ type: 'launchDevServer' }`
 * - `{ type: 'openFile'; location: SourceLocation }`
 * - `{ type: 'retryStage'; stage: string }`
 */
export type WebviewToHostMessage = DiscriminatedUnion<
  WebviewToHostMessageType,
  WebviewToHostPayloads
>;

/** The member of {@link WebviewToHostMessage} whose `type` is `K`. */
export type WebviewToHostMessageOf<K extends WebviewToHostMessageType> = Extract<
  WebviewToHostMessage,
  { type: K }
>;

// ---------------------------------------------------------------------------
// Version and predicates
// ---------------------------------------------------------------------------

/**
 * The version of this host↔webview contract.
 *
 * Host and webview are built from this one module and shipped together inside
 * one VSIX, so nothing negotiates it. It exists so that a webview restored from
 * a stale cache after an extension update is detectable: the host can stamp the
 * value it was compiled with into the view's HTML, and the page compares it with
 * the copy compiled into its own bundle.
 */
export const WEBVIEW_MESSAGE_PROTOCOL_VERSION = '1';

/**
 * Narrows an unknown value — `event.data` in the webview, the argument of
 * `onDidReceiveMessage` in the host — to a {@link HostToWebviewMessage}.
 *
 * Validates the **discriminant only**: a non-null object whose `type` is one of
 * {@link HOST_TO_WEBVIEW_MESSAGE_TYPES}. The receiver is responsible for the
 * payload. Both endpoints ship inside one VSIX and neither is a trust boundary,
 * unlike `src/uri-handler.ts`, which handles hostile input and validates
 * exhaustively.
 */
export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
  return hasDiscriminant(value, HOST_TO_WEBVIEW_MESSAGE_TYPES);
}

/**
 * Narrows an unknown value to a {@link WebviewToHostMessage}.
 *
 * Validates the **discriminant only**: a non-null object whose `type` is one of
 * {@link WEBVIEW_TO_HOST_MESSAGE_TYPES}. The receiver is responsible for the
 * payload — the host, for example, still checks an `openFile` location against
 * the session's project root before opening it — because both endpoints ship
 * inside one VSIX and neither is a trust boundary, unlike `src/uri-handler.ts`,
 * which handles hostile input and validates exhaustively.
 */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return hasDiscriminant(value, WEBVIEW_TO_HOST_MESSAGE_TYPES);
}

/**
 * Whether `value` is a non-null object whose `type` is a string in
 * `discriminants`. Pure: reads one property and allocates nothing.
 */
function hasDiscriminant(value: unknown, discriminants: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { type } = value as { readonly type?: unknown };
  return typeof type === 'string' && discriminants.includes(type);
}
