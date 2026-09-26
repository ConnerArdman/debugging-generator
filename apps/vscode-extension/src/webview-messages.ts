/**
 * The typed contract between the extension host and the "Debug Generator"
 * webview view — the only module both halves of this workspace share — and the
 * one validator of every frame that crosses it, in either direction.
 *
 * ## Why this file is shaped the way it is
 *
 * The workspace has two composite TypeScript projects: `tsconfig.json` (the
 * extension host, a Node process with no DOM) and `tsconfig.webview.json` (the
 * React page, with DOM and no Node). A relative import cannot cross a project
 * boundary, so both projects include this one file and compile it twice, and
 * both bundles (esbuild's host bundle, Vite's webview bundle) inline it. That is
 * safe only because the module is environment-neutral and inert:
 *
 * - **Its runtime imports are schemas and vocabularies, nothing else.** The
 *   value imports are single-definition Zod schemas and `as const` tuples from
 *   `@debuggen/protocol` and `@debuggen/shared` (AAP §0.2.3). Both declare
 *   `sideEffects: false`, their root entries reach no Node builtin, and both are
 *   designed to be bundled into the webview, where `src/webview/csp-runtime.ts`
 *   has switched Zod to its jitless mode before any schema is constructed.
 *   Every import that names only types is `import type`, which
 *   `verbatimModuleSyntax` erases.
 *   `zod` itself is not imported: it is not a dependency of this workspace, and
 *   {@link SafeParser} names the one method this file calls on a schema.
 * - **No environment-specific type.** No `MessageEvent`, `Window`, `Buffer` or
 *   `NodeJS.*`: each exists in only one of the two programs. The parsers
 *   therefore take `unknown`.
 * - **No runtime side effect.** Top-level code declares `as const` tuples,
 *   numeric bounds, a version string, literal rule tables and functions, and
 *   reads properties of imported schemas — no call, no `new`, no mutable state,
 *   no logging, no I/O.
 *
 * ## Validation, on both sides
 *
 * Each endpoint treats the other's frames as untrusted input (CWE-20):
 * {@link parseHostToWebviewMessage} guards the webview (`src/webview/vscode-api.ts`)
 * and {@link parseWebviewToHostMessage} guards the host
 * (`src/views/session-view-provider.ts`). A frame is accepted only when
 *
 * 1. it is a non-array object whose **own** `type` is a member of that
 *    direction's closed discriminant tuple;
 * 2. its own keys are exactly that member's keys — an unknown key is a
 *    rejection, at the message level and in every webview-local object nested in
 *    it (`connection`, `capture`, {@link ProgressEntry}, {@link PairingState},
 *    {@link StageFailure}, {@link PanelSummary});
 * 3. every field passes its rule: an embedded protocol shape (the session
 *    record, the analysis, relevant files, modification records, the cleanup
 *    state, the selected target, a source location) through its own Zod schema,
 *    and every webview-local field through the rules in this file.
 *
 * An optional key whose value is `undefined` is read as absent. Structured
 * clone preserves such keys, and a sender compiled without
 * `exactOptionalPropertyTypes` can produce them; the rebuilt copy omits them.
 *
 * What a parser returns is a **rebuilt copy** assembled from validated fields
 * only — the Zod schemas' parsed output for the embedded shapes, absent optional
 * keys omitted — never the input object. A rejection is a closed value: a
 * reason, the input's `typeof` class, or the already-validated member name. It
 * never carries anything the frame contained, so logging it cannot leak a
 * payload into an output channel (CWE-532).
 *
 * The compiler enforces exhaustiveness. Each direction's validators are a
 * record keyed by its discriminant union, and the snapshot's rule table is keyed
 * by `keyof WebviewState`, so a message member or a snapshot field added without
 * a validator is a compile error rather than a field that goes unchecked.
 *
 * ## Requests and their results
 *
 * Every webview intent the view waits on is a **request**
 * ({@link WEBVIEW_REQUEST_TYPES}): it carries a `requestId` the view mints, and
 * the host answers it with exactly one `actionResult` echoing that id and
 * reporting `accepted` or `failed`. That frame is the only thing that ends the
 * request's pending state in the view. Snapshots, notices and pairing frames
 * stay presentational, because none of them names the request it answers: a
 * snapshot also moves for unrelated reasons (progress, the capture counter,
 * another session reopened), and a notice may belong to another request, to a
 * command run from the palette, or to a service event. `ready` and `openFile`
 * wait on nothing and carry no id.
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
 * // Host: answer `ready` with the current snapshot; log rejections as closed values.
 * view.webview.onDidReceiveMessage((value: unknown) => {
 *   const parsed = parseWebviewToHostMessage(value);
 *   if (!parsed.ok) {
 *     logger.warn('Ignored a webview message', { reason: parsed.rejection.reason });
 *     return;
 *   }
 *   if (parsed.message.type === 'ready') {
 *     const message: HostToWebviewMessage = { type: 'state', state: currentState };
 *     void view.webview.postMessage(message);
 *   }
 * });
 *
 * // Webview: render only the validated copy of a frame of this contract.
 * window.addEventListener('message', (event) => {
 *   const parsed = parseHostToWebviewMessage(event.data);
 *   if (parsed.ok) render(parsed.message);
 * });
 * ```
 */

import {
  CONNECTION_STATES,
  PROGRESS_STATUSES,
  analysisResultSchema,
  relevantFileSchema,
  sessionCleanupSchema,
  sessionRecordSchema,
} from '@debuggen/protocol';
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
import { sourceLocationSchema } from '@debuggen/shared';
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
 * member. That is what guarantees each parser below accepts exactly the
 * discriminants of the union it produces.
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
 * The severities a `notice` frame may carry, as the tuple its parser checks.
 * The `level` type of that frame is derived from it, so the vocabulary and the
 * validator cannot drift.
 */
export const NOTICE_LEVELS = ['info', 'warning', 'error'] as const;

/**
 * The sections of the view a `focus` frame may name, as the tuple its parser
 * checks. The `section` type of that frame is derived from it.
 */
export const FOCUS_SECTIONS = ['question', 'modifications', 'analysis', 'followUp'] as const;

/**
 * How the host reports a request it has finished handling, as the tuple the
 * `actionResult` parser checks:
 *
 * - `accepted` — the host carried the request out and raised no error or
 *   warning while doing so;
 * - `failed` — the host raised an error or a warning while handling it (the
 *   request was refused, did not happen, or happened only with a caveat the
 *   developer was warned about), or its work failed unexpectedly.
 *
 * The view keeps a submitted question or follow-up for a `failed` result and
 * clears it for an `accepted` one; for every other request the result only
 * ends the pending state of the control that sent it.
 */
export const ACTION_RESULT_STATUSES = ['accepted', 'failed'] as const;

/** One of {@link ACTION_RESULT_STATUSES}. */
export type ActionResultStatus = (typeof ACTION_RESULT_STATUSES)[number];

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
    /** How the view presents it: one of {@link NOTICE_LEVELS}. */
    level: (typeof NOTICE_LEVELS)[number];
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
  focus: { section: (typeof FOCUS_SECTIONS)[number] };
  /**
   * The host's answer to one webview request (a member of
   * {@link WEBVIEW_REQUEST_TYPES}), posted exactly once per request it
   * received, after any snapshot or notice the handling produced. It is the
   * only frame that ends a request's pending state in the view: snapshots,
   * notices and pairing frames are presentational and settle nothing, because
   * none of them names the request it belongs to.
   */
  actionResult: {
    /** The id the view gave the request; see {@link MAX_WEBVIEW_REQUEST_ID_LENGTH}. */
    requestId: string;
    /** The request's `type`, as it was validated when the request arrived. */
    action: WebviewRequestType;
    /** How the handling ended: one of {@link ACTION_RESULT_STATUSES}. */
    status: ActionResultStatus;
  };
}

/** Every host-to-webview discriminant, as the tuple the parser checks. */
export const HOST_TO_WEBVIEW_MESSAGE_TYPES = [
  'state',
  'notice',
  'pairing',
  'focus',
  'actionResult',
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
 * - `{ type: 'actionResult'; requestId: string; action: WebviewRequestType; status: 'accepted' | 'failed' }`
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
 * The longest `question` an `askQuestion` or `askFollowUp` frame may carry:
 * **16 384** UTF-16 code units.
 *
 * A transport bound, not the product rule. It sits deliberately above the
 * service's own 2 000-character question limit, so an over-long question still
 * reaches the service and is refused there with the service's precise message
 * and hint, while a frame the webview could never legitimately produce — a
 * megabyte pasted into a message, or a question field that is not text at all —
 * is refused here before the host acts on it.
 */
export const MAX_WEBVIEW_QUESTION_LENGTH = 16_384;

/**
 * The longest `stage` a `retryStage` frame may carry: **128** characters.
 *
 * Stage names are short identifiers the service reported (`generate-panel` is
 * the longest today); the bound refuses a frame whose stage field is a payload
 * rather than a name. Whether the stage can be retried is the host's decision,
 * made against the protocol's own stage vocabulary.
 */
export const MAX_RETRY_STAGE_LENGTH = 128;

/**
 * The longest `requestId` a request frame (and the `actionResult` answering
 * it) may carry: **64** characters, each an ASCII letter, a digit, `_` or `-`.
 *
 * The id is minted by the view — random, unique for the lifetime of the
 * document — and only ever compared for equality; the host echoes it back and
 * never interprets it. The bound and the alphabet make it a token rather than
 * a payload, so it is safe to hold in memory as a map key.
 */
export const MAX_WEBVIEW_REQUEST_ID_LENGTH = 64;

/** The alphabet of a request id; see {@link MAX_WEBVIEW_REQUEST_ID_LENGTH}. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * What every request frame carries besides its own fields: the id the host
 * echoes in the `actionResult` that answers it.
 */
interface RequestPayload {
  /** One of {@link MAX_WEBVIEW_REQUEST_ID_LENGTH} characters from `[A-Za-z0-9_-]`. */
  requestId: string;
}

/**
 * What each webview-to-host message carries, keyed by its `type`.
 *
 * Every entry is an intent the host carries out — an HTTP call to the service,
 * a command, an editor action — so the webview never needs a socket or the
 * `vscode` API. Every intent the view waits on is a **request**: it carries a
 * `requestId` and is answered by exactly one `actionResult` (see
 * {@link WEBVIEW_REQUEST_TYPES}). `ready` and `openFile` wait on nothing and
 * carry no id. Module-private: a consumer names one member as
 * `WebviewToHostMessageOf<'openFile'>`.
 */
interface WebviewToHostPayloads {
  /**
   * Posted once on mount; the host answers with the current snapshot. The
   * webview never assumes it received earlier pushes: `retainContextWhenHidden`
   * keeps its state while hidden, but a reload must resynchronise.
   */
  ready: NoPayload;
  /**
   * Starts a session with the developer's question, as typed: not blank, at
   * most {@link MAX_WEBVIEW_QUESTION_LENGTH} code units, forwarded untrimmed.
   */
  askQuestion: RequestPayload & { question: string };
  /** Asks a follow-up question on the active session, under the same rule as `askQuestion`. */
  askFollowUp: RequestPayload & { question: string };
  /** Starts a capture window on the active session. */
  startCapture: RequestPayload;
  /** Stops the running capture. */
  stopCapture: RequestPayload;
  /** Ends the active session, which removes every instrumentation it applied. */
  endSession: RequestPayload;
  /**
   * Opens a source location in the editor — the click-to-source origin of
   * `RelevantFiles`, `ModificationsList` and the suggested locations in
   * `AnalysisSummary`. The same `SourceLocation` shape the service and the
   * DevTools panel use, validated by its own schema (a safe project-relative
   * POSIX path, 1-based line and column); the host still resolves it against
   * the session's project root before opening anything.
   */
  openFile: { location: SourceLocation };
  /** Asks the DevTools panel bound to the session to enter element-picker mode. */
  requestTarget: RequestPayload;
  /** Starts Chrome pairing (`debuggen.pairChrome`), which yields a pairing code. */
  pairChrome: RequestPayload;
  /** Hides the pairing code on display. */
  dismissPairing: RequestPayload;
  /** Launches the project's dev server with the telemetry preload attached. */
  launchDevServer: RequestPayload;
  /**
   * Retries the failed stage named by {@link StageFailure.stage}: a non-empty
   * name of at most {@link MAX_RETRY_STAGE_LENGTH} characters.
   */
  retryStage: RequestPayload & { stage: string };
}

/** The webview-to-host members whose payload carries a `requestId`, derived from the payloads. */
type RequestCarryingType = {
  [K in keyof WebviewToHostPayloads]: WebviewToHostPayloads[K] extends RequestPayload ? K : never;
}[keyof WebviewToHostPayloads];

/**
 * Every webview-to-host member that is a **request**: it carries a `requestId`,
 * the view keeps the control that sent it pending, and the host answers it with
 * exactly one `actionResult` naming that id. The `satisfies` clause proves each
 * listed member's payload carries the id; {@link isWebviewRequestType} is
 * derived from the payloads themselves, so the two cannot disagree silently.
 */
export const WEBVIEW_REQUEST_TYPES = [
  'askQuestion',
  'askFollowUp',
  'startCapture',
  'stopCapture',
  'endSession',
  'requestTarget',
  'pairChrome',
  'dismissPairing',
  'launchDevServer',
  'retryStage',
] as const satisfies readonly RequestCarryingType[];

/** One of {@link WEBVIEW_REQUEST_TYPES}: a webview-to-host member that carries a `requestId`. */
export type WebviewRequestType = RequestCarryingType;

/**
 * Whether each webview-to-host member is a request. Typed from the payloads,
 * so every value is forced: a member whose payload gains or loses `requestId`
 * without this table changing is a compile error.
 */
const REQUEST_TYPE_MEMBERSHIP: {
  readonly [K in keyof WebviewToHostPayloads]: WebviewToHostPayloads[K] extends RequestPayload
    ? true
    : false;
} = {
  ready: false,
  askQuestion: true,
  askFollowUp: true,
  startCapture: true,
  stopCapture: true,
  endSession: true,
  openFile: false,
  requestTarget: true,
  pairChrome: true,
  dismissPairing: true,
  launchDevServer: true,
  retryStage: true,
};

/** Every webview-to-host discriminant, as the tuple the parser checks. */
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
 * - `{ type: 'askQuestion'; requestId: string; question: string }`,
 *   `{ type: 'askFollowUp'; requestId: string; question: string }`
 * - `{ type: 'startCapture'; requestId: string }`, and likewise `stopCapture`, `endSession`,
 *   `requestTarget`, `pairChrome`, `dismissPairing` and `launchDevServer`
 * - `{ type: 'openFile'; location: SourceLocation }`
 * - `{ type: 'retryStage'; requestId: string; stage: string }`
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

/** A webview-to-host message that is a request: it carries a `requestId`. */
export type WebviewRequestMessage = WebviewToHostMessageOf<WebviewRequestType>;

/**
 * Whether a webview-to-host member is a request, answered by one
 * `actionResult`.
 *
 * @param type A validated member name.
 * @returns `true` for a member of {@link WEBVIEW_REQUEST_TYPES}.
 */
export function isWebviewRequestType(type: WebviewToHostMessageType): type is WebviewRequestType {
  return REQUEST_TYPE_MEMBERSHIP[type];
}

/**
 * Whether a validated webview-to-host message is a request, narrowing it to
 * the members that carry a `requestId`.
 *
 * @param message A message {@link parseWebviewToHostMessage} returned.
 * @returns `true` when the host must answer it with an `actionResult`.
 */
export function isWebviewRequestMessage(
  message: WebviewToHostMessage,
): message is WebviewRequestMessage {
  return isWebviewRequestType(message.type);
}

// ---------------------------------------------------------------------------
// Version
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

// ---------------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------------

/**
 * The class of a frame that is not an object: its `typeof`, with `null` and
 * arrays named on their own because `typeof` reports both as `'object'`.
 */
export type NonObjectValueType =
  | 'undefined'
  | 'null'
  | 'boolean'
  | 'number'
  | 'bigint'
  | 'string'
  | 'symbol'
  | 'function'
  | 'array';

/**
 * Why a frame was refused: a closed value built from this contract, never from
 * the frame, so it is safe to log verbatim.
 *
 * - `not-an-object` — the frame is a primitive, `null`, a function or an array;
 *   `valueType` says which.
 * - `unknown-type` — an object whose own `type` is absent, is not a string, or
 *   is not a member of the direction's discriminant tuple. It deliberately
 *   carries nothing: an unrecognised `type` is sender-controlled text, and
 *   copying it into a log record is exactly the leak this shape rules out.
 * - `invalid-payload` — `type` is a validated member of the tuple, so it is
 *   reported, but the rest of the frame is not exactly that member: a field is
 *   missing or fails its rule, or a key the member does not declare is present.
 *
 * @typeParam Type The direction's discriminant union.
 */
export type WebviewMessageRejection<Type extends string> =
  | { readonly reason: 'not-an-object'; readonly valueType: NonObjectValueType }
  | { readonly reason: 'unknown-type' }
  | { readonly reason: 'invalid-payload'; readonly type: Type };

/**
 * The outcome of parsing one frame: the validated, rebuilt message, or the
 * closed reason it was refused.
 *
 * @typeParam M The message union of the direction parsed.
 */
export type WebviewMessageParse<M extends { readonly type: string }> =
  | { readonly ok: true; readonly message: M }
  | { readonly ok: false; readonly rejection: WebviewMessageRejection<M['type']> };

// ---------------------------------------------------------------------------
// Parsers and predicates
// ---------------------------------------------------------------------------

/**
 * Parses an unknown value — `event.data` in the webview — as a
 * {@link HostToWebviewMessage}, validating the whole frame: the discriminant,
 * the member's exact key set and every field, including the entire
 * {@link WebviewState} of a `state` frame (see the module documentation for the
 * rules). Never throws.
 *
 * @param value The received frame, untrusted.
 * @returns `{ ok: true, message }` with a copy rebuilt from validated fields —
 * consume `message`, never `value` — or `{ ok: false, rejection }`.
 *
 * @example
 * ```ts
 * const parsed = parseHostToWebviewMessage(event.data);
 * if (parsed.ok && parsed.message.type === 'state') setState(parsed.message.state);
 * ```
 */
export function parseHostToWebviewMessage(
  value: unknown,
): WebviewMessageParse<HostToWebviewMessage> {
  return parseMessage(value, HOST_TO_WEBVIEW_MESSAGE_TYPES, HOST_TO_WEBVIEW_VALIDATORS);
}

/**
 * Parses an unknown value — the argument of `onDidReceiveMessage` in the host —
 * as a {@link WebviewToHostMessage}, validating the whole frame: `ready` must be
 * exactly `{ type }`, every request must carry a `requestId` of 1 to
 * {@link MAX_WEBVIEW_REQUEST_ID_LENGTH} characters from `[A-Za-z0-9_-]` and no
 * key beyond its own fields, a question must be non-blank text of at most
 * {@link MAX_WEBVIEW_QUESTION_LENGTH} code units, an `openFile` location must
 * pass the shared `SourceLocation` schema, and a retried stage must be a name
 * of 1 to {@link MAX_RETRY_STAGE_LENGTH} characters. Never throws.
 *
 * Shape validation is not authorization: the host still resolves an `openFile`
 * location against the session's project root before opening anything, and
 * still decides whether a named stage can be retried.
 *
 * @param value The received frame, untrusted.
 * @returns `{ ok: true, message }` with a copy rebuilt from validated fields —
 * dispatch `message`, never `value` — or `{ ok: false, rejection }`, whose
 * fields are closed values safe to log.
 */
export function parseWebviewToHostMessage(
  value: unknown,
): WebviewMessageParse<WebviewToHostMessage> {
  return parseMessage(value, WEBVIEW_TO_HOST_MESSAGE_TYPES, WEBVIEW_TO_HOST_VALIDATORS);
}

/**
 * Whether `value` is a complete, valid {@link HostToWebviewMessage}: the boolean
 * form of {@link parseHostToWebviewMessage}, with the same full validation.
 * Prefer the parser where the message is consumed — it returns the rebuilt copy
 * (embedded schemas' parsed output) and the reason for a refusal.
 */
export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
  return parseHostToWebviewMessage(value).ok;
}

/**
 * Whether `value` is a complete, valid {@link WebviewToHostMessage}: the boolean
 * form of {@link parseWebviewToHostMessage}, with the same full validation.
 * Prefer the parser where the message is dispatched, for the rebuilt copy and
 * the closed rejection.
 */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return parseWebviewToHostMessage(value).ok;
}

// ---------------------------------------------------------------------------
// Validation machinery (module-private)
// ---------------------------------------------------------------------------

/**
 * A field rule: the validated value — for a Zod-backed shape, the schema's
 * parsed output — or `undefined` when `value` is refused. No acceptable value
 * in this contract is itself `undefined` (an absent optional key is handled by
 * {@link validateFields} before any rule runs), so `undefined` is an
 * unambiguous refusal.
 */
type Check<T> = (value: unknown) => T | undefined;

/** The rule of an optional key, applied only when the key holds a value. */
interface OptionalRule<T> {
  readonly optional: Check<T>;
}

/** A rule of any key, as {@link validateFields} walks them. */
type AnyRule = Check<unknown> | OptionalRule<unknown>;

/**
 * Exactly one rule per key of `T`: a bare {@link Check} for a required key, an
 * {@link OptionalRule} for an optional one.
 *
 * `-?` makes every key of `T` mandatory in the table, and an object literal
 * annotated with this type may not name a key `T` lacks — so a field added to
 * `T` without a rule, or a rule for a field `T` does not have, is a compile
 * error. `Record<never, never> extends Pick<T, K>` holds exactly when `K` is
 * optional in `T`, which is what selects the rule's form.
 */
type FieldRules<T> = {
  readonly [K in keyof T]-?: Record<never, never> extends Pick<T, K>
    ? OptionalRule<Exclude<T[K], undefined>>
    : Check<T[K]>;
};

/**
 * One validator per member of a message union, keyed by its discriminant, so a
 * member without a validator is a compile error. Each receives a frame whose
 * `type` has already been matched to its key.
 */
type MessageValidators<M extends { readonly type: string }> = {
  readonly [K in M['type']]: (
    record: Readonly<Record<string, unknown>>,
  ) => Extract<M, { type: K }> | undefined;
};

/**
 * The one method this module calls on a Zod schema.
 *
 * Structural, so this workspace needs no `zod` dependency: every Zod 4 schema
 * satisfies it. Each call site passes the contract's declared type as the type
 * argument, which makes the compiler prove the schema's output is that type —
 * the single definition and this contract cannot drift apart silently.
 */
interface SafeParser<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

/**
 * The single `ModificationRecord` schema, reached through the session record
 * that embeds it: the element of `modifications`. The record's own count bound
 * is deliberately not applied — the snapshot's list is the host's journal,
 * merged from records and `instrumentation.ready` pushes, not a stored record.
 */
const modificationRecordSchema = sessionRecordSchema.shape.modifications.element;

/**
 * The single `SelectedTarget` schema as the session record embeds it (optional
 * there). Applied only to a present value, so its optionality never admits an
 * absent target as valid.
 */
const selectedTargetSchema = sessionRecordSchema.shape.target;

/**
 * Parses one frame of either direction: the class of the value, then its own
 * `type` against `types`, then the matched member's validator.
 *
 * Total: an accessor that throws cannot arrive through structured clone or
 * JSON, but a value built to throw while being read is refused like any other
 * malformed frame instead of escaping into the receiving listener.
 *
 * @param value The frame, untrusted.
 * @param types The direction's closed discriminant tuple.
 * @param validators The direction's exhaustive validator table.
 * @returns The rebuilt message, or a closed rejection.
 */
function parseMessage<M extends { readonly type: string }>(
  value: unknown,
  types: readonly M['type'][],
  validators: MessageValidators<M>,
): WebviewMessageParse<M> {
  const valueType = nonObjectValueType(value);
  if (valueType !== undefined) {
    return { ok: false, rejection: { reason: 'not-an-object', valueType } };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const type = readOwnType(record);
  if (!isMember(types, type)) {
    return { ok: false, rejection: { reason: 'unknown-type' } };
  }
  const message = runValidator(validators[type], record);
  return message === undefined
    ? { ok: false, rejection: { reason: 'invalid-payload', type } }
    : { ok: true, message };
}

/**
 * The {@link NonObjectValueType} of `value`, or `undefined` for a non-array
 * object — the only class a frame may have.
 */
function nonObjectValueType(value: unknown): NonObjectValueType | undefined {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const kind = typeof value;
  return kind === 'object' ? undefined : kind;
}

/**
 * The frame's **own** `type`; an inherited one is never read. `undefined` when
 * it is absent or reading it throws.
 */
function readOwnType(record: Readonly<Record<string, unknown>>): unknown {
  try {
    return Object.hasOwn(record, 'type') ? record['type'] : undefined;
  } catch {
    // Only a hostile accessor or proxy throws here; it has no readable type.
    return undefined;
  }
}

/**
 * Runs one member's validator, reading a throw as a refusal (see
 * {@link parseMessage}).
 */
function runValidator<M>(
  validate: (record: Readonly<Record<string, unknown>>) => M | undefined,
  record: Readonly<Record<string, unknown>>,
): M | undefined {
  try {
    return validate(record);
  } catch {
    // A field that throws while being read is not a field of this contract.
    return undefined;
  }
}

/** Whether `value` is one of the strings of `vocabulary`. */
function isMember<T extends string>(vocabulary: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (vocabulary as readonly string[]).includes(value);
}

/**
 * Validates `record` against `rules` and rebuilds it.
 *
 * Every own enumerable key of `record` must be named by `rules` (or be
 * `discriminant`, for a message frame); every required key must hold a value
 * its rule accepts; an optional key holding a value must pass its rule, and one
 * that is absent or `undefined` is omitted. The result is a fresh object of the
 * rules' outputs, never `record` itself.
 *
 * @param record The object to validate.
 * @param rules The exhaustive rule table of `T`.
 * @param discriminant The one key a message frame carries beyond its payload.
 * @returns The rebuilt `T`, or `undefined` when anything is refused.
 */
function validateFields<T>(
  record: Readonly<Record<string, unknown>>,
  rules: FieldRules<T>,
  discriminant?: 'type',
): T | undefined {
  const table: Readonly<Record<string, AnyRule>> = rules;
  for (const key of Object.keys(record)) {
    if (key !== discriminant && !Object.hasOwn(table, key)) {
      return undefined;
    }
  }
  const output: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(table)) {
    const raw = Object.hasOwn(record, key) ? record[key] : undefined;
    const optional = typeof rule !== 'function';
    if (raw === undefined) {
      if (optional) {
        continue;
      }
      return undefined;
    }
    const checked = typeof rule === 'function' ? rule(raw) : rule.optional(raw);
    if (checked === undefined) {
      return undefined;
    }
    output[key] = checked;
  }
  // `FieldRules<T>` holds one rule per key of `T`, each typed by that key, and
  // every required key was filled above, so the assembled object is a `T`.
  return output as T;
}

/** Validates a nested object against its rule table; see {@link validateFields}. */
function checkObject<T>(value: unknown, rules: FieldRules<T>): T | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return validateFields(value as Readonly<Record<string, unknown>>, rules);
}

/**
 * Validates an array element by element, rebuilding it from the checked
 * elements. A hole reads as `undefined` and is refused.
 */
function checkArray<T>(value: unknown, check: Check<T>): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const output: T[] = [];
  for (const element of value as readonly unknown[]) {
    const checked = check(element);
    if (checked === undefined) {
      return undefined;
    }
    output.push(checked);
  }
  return output;
}

/** Validates `value` with a Zod schema and returns its parsed output. */
function checkWithSchema<T>(schema: SafeParser<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Prefixes a validated payload with its discriminant. */
function withType<K extends string, P extends object>(
  type: K,
  payload: P | undefined,
): ({ type: K } & P) | undefined {
  return payload === undefined ? undefined : { type, ...payload };
}

// --- Primitive rules --------------------------------------------------------

function checkString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function checkNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function checkBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** A finite number of at least zero: a timestamp or an expiry in epoch milliseconds. */
function checkNonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A safe integer of at least zero: a count. */
function checkNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A safe integer of at least one: a version counting from 1. */
function checkPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** A question as typed: not blank, at most {@link MAX_WEBVIEW_QUESTION_LENGTH} code units. */
function checkQuestion(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= MAX_WEBVIEW_QUESTION_LENGTH &&
    value.trim().length > 0
    ? value
    : undefined;
}

/** A stage name of 1 to {@link MAX_RETRY_STAGE_LENGTH} characters. */
function checkRetryStage(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RETRY_STAGE_LENGTH
    ? value
    : undefined;
}

/**
 * A request id: 1 to {@link MAX_WEBVIEW_REQUEST_ID_LENGTH} characters from
 * `[A-Za-z0-9_-]`.
 */
function checkRequestId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= MAX_WEBVIEW_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
    ? value
    : undefined;
}

// --- Closed vocabularies ----------------------------------------------------

function checkConnectionStatus(value: unknown): ConnectionState | undefined {
  return isMember(CONNECTION_STATES, value) ? value : undefined;
}

function checkProgressStatus(value: unknown): ProgressStatus | undefined {
  return isMember(PROGRESS_STATUSES, value) ? value : undefined;
}

function checkNoticeLevel(value: unknown): (typeof NOTICE_LEVELS)[number] | undefined {
  return isMember(NOTICE_LEVELS, value) ? value : undefined;
}

function checkFocusSection(value: unknown): (typeof FOCUS_SECTIONS)[number] | undefined {
  return isMember(FOCUS_SECTIONS, value) ? value : undefined;
}

function checkRequestType(value: unknown): WebviewRequestType | undefined {
  return isMember(WEBVIEW_REQUEST_TYPES, value) ? value : undefined;
}

function checkActionResultStatus(value: unknown): ActionResultStatus | undefined {
  return isMember(ACTION_RESULT_STATUSES, value) ? value : undefined;
}

// --- Embedded protocol shapes: their single-definition schemas --------------

function checkSessionRecord(value: unknown): SessionRecord | undefined {
  return checkWithSchema<SessionRecord>(sessionRecordSchema, value);
}

function checkAnalysis(value: unknown): AnalysisResult | undefined {
  return checkWithSchema<AnalysisResult>(analysisResultSchema, value);
}

function checkRelevantFile(value: unknown): RelevantFile | undefined {
  return checkWithSchema<RelevantFile>(relevantFileSchema, value);
}

function checkModificationRecord(value: unknown): ModificationRecord | undefined {
  return checkWithSchema<ModificationRecord>(modificationRecordSchema, value);
}

function checkSelectedTarget(value: unknown): SelectedTarget | undefined {
  return checkWithSchema<SelectedTarget | undefined>(selectedTargetSchema, value);
}

function checkCleanup(value: unknown): SessionCleanup | undefined {
  return checkWithSchema<SessionCleanup>(sessionCleanupSchema, value);
}

function checkSourceLocation(value: unknown): SourceLocation | undefined {
  return checkWithSchema<SourceLocation>(sourceLocationSchema, value);
}

// --- Webview-local projections: exact key sets ------------------------------

const CONNECTION_RULES: FieldRules<WebviewState['connection']> = {
  status: checkConnectionStatus,
  serviceUrl: checkString,
  serviceReachable: checkBoolean,
  provider: checkString,
};

const PROGRESS_ENTRY_RULES: FieldRules<ProgressEntry> = {
  stage: checkNonEmptyString,
  status: checkProgressStatus,
  message: checkString,
  detail: { optional: checkString },
  ts: checkNonNegativeFinite,
};

const PANEL_SUMMARY_RULES: FieldRules<PanelSummary> = {
  id: checkNonEmptyString,
  title: checkString,
  panelVersion: checkPositiveInteger,
  fallback: checkBoolean,
};

const CAPTURE_RULES: FieldRules<WebviewState['capture']> = {
  active: checkBoolean,
  captureId: { optional: checkNonEmptyString },
  eventCount: checkNonNegativeInteger,
};

const PAIRING_RULES: FieldRules<PairingState> = {
  code: checkNonEmptyString,
  expiresAt: checkNonNegativeFinite,
};

const STAGE_FAILURE_RULES: FieldRules<StageFailure> = {
  stage: checkString,
  code: checkString,
  message: checkString,
  hint: { optional: checkString },
};

function checkConnection(value: unknown): WebviewState['connection'] | undefined {
  return checkObject(value, CONNECTION_RULES);
}

function checkProgressEntry(value: unknown): ProgressEntry | undefined {
  return checkObject(value, PROGRESS_ENTRY_RULES);
}

function checkProgress(value: unknown): ProgressEntry[] | undefined {
  return checkArray(value, checkProgressEntry);
}

function checkRelevantFiles(value: unknown): RelevantFile[] | undefined {
  return checkArray(value, checkRelevantFile);
}

function checkModifications(value: unknown): ModificationRecord[] | undefined {
  return checkArray(value, checkModificationRecord);
}

function checkPanelSummary(value: unknown): PanelSummary | undefined {
  return checkObject(value, PANEL_SUMMARY_RULES);
}

function checkCapture(value: unknown): WebviewState['capture'] | undefined {
  return checkObject(value, CAPTURE_RULES);
}

function checkPairing(value: unknown): PairingState | undefined {
  return checkObject(value, PAIRING_RULES);
}

function checkStageFailure(value: unknown): StageFailure | undefined {
  return checkObject(value, STAGE_FAILURE_RULES);
}

/**
 * The snapshot's rule table: one rule per key of {@link WebviewState}, so a
 * field added to the interface without a rule here fails to compile.
 */
const WEBVIEW_STATE_RULES: FieldRules<WebviewState> = {
  connection: checkConnection,
  session: { optional: checkSessionRecord },
  progress: checkProgress,
  relevantFiles: checkRelevantFiles,
  modifications: checkModifications,
  analysis: { optional: checkAnalysis },
  latestPanel: { optional: checkPanelSummary },
  target: { optional: checkSelectedTarget },
  capture: checkCapture,
  cleanup: checkCleanup,
  pairing: { optional: checkPairing },
  failure: { optional: checkStageFailure },
};

function checkWebviewState(value: unknown): WebviewState | undefined {
  return checkObject(value, WEBVIEW_STATE_RULES);
}

// --- Message payloads and the two validator tables --------------------------

const STATE_PAYLOAD_RULES: FieldRules<HostToWebviewPayloads['state']> = {
  state: checkWebviewState,
};

const NOTICE_PAYLOAD_RULES: FieldRules<HostToWebviewPayloads['notice']> = {
  level: checkNoticeLevel,
  message: checkString,
  hint: { optional: checkString },
};

const PAIRING_PAYLOAD_RULES: FieldRules<HostToWebviewPayloads['pairing']> = {
  pairing: { optional: checkPairing },
};

const FOCUS_PAYLOAD_RULES: FieldRules<HostToWebviewPayloads['focus']> = {
  section: checkFocusSection,
};

const ACTION_RESULT_PAYLOAD_RULES: FieldRules<HostToWebviewPayloads['actionResult']> = {
  requestId: checkRequestId,
  action: checkRequestType,
  status: checkActionResultStatus,
};

/** The rules of every member that carries nothing but its `type`: no key at all. */
const NO_PAYLOAD_RULES: FieldRules<NoPayload> = {};

/** The rules of every request that carries nothing but its `type` and its id. */
const REQUEST_PAYLOAD_RULES: FieldRules<RequestPayload> = {
  requestId: checkRequestId,
};

const QUESTION_PAYLOAD_RULES: FieldRules<WebviewToHostPayloads['askQuestion']> = {
  requestId: checkRequestId,
  question: checkQuestion,
};

const OPEN_FILE_PAYLOAD_RULES: FieldRules<WebviewToHostPayloads['openFile']> = {
  location: checkSourceLocation,
};

const RETRY_STAGE_PAYLOAD_RULES: FieldRules<WebviewToHostPayloads['retryStage']> = {
  requestId: checkRequestId,
  stage: checkRetryStage,
};

/** Host → webview: exhaustive over {@link HostToWebviewMessageType}. */
const HOST_TO_WEBVIEW_VALIDATORS: MessageValidators<HostToWebviewMessage> = {
  state: (record) => withType('state', validateFields(record, STATE_PAYLOAD_RULES, 'type')),
  notice: (record) => withType('notice', validateFields(record, NOTICE_PAYLOAD_RULES, 'type')),
  pairing: (record) => withType('pairing', validateFields(record, PAIRING_PAYLOAD_RULES, 'type')),
  focus: (record) => withType('focus', validateFields(record, FOCUS_PAYLOAD_RULES, 'type')),
  actionResult: (record) =>
    withType('actionResult', validateFields(record, ACTION_RESULT_PAYLOAD_RULES, 'type')),
};

/** Webview → host: exhaustive over {@link WebviewToHostMessageType}. */
const WEBVIEW_TO_HOST_VALIDATORS: MessageValidators<WebviewToHostMessage> = {
  ready: (record) => withType('ready', validateFields(record, NO_PAYLOAD_RULES, 'type')),
  askQuestion: (record) =>
    withType('askQuestion', validateFields(record, QUESTION_PAYLOAD_RULES, 'type')),
  askFollowUp: (record) =>
    withType('askFollowUp', validateFields(record, QUESTION_PAYLOAD_RULES, 'type')),
  startCapture: (record) =>
    withType('startCapture', validateFields(record, REQUEST_PAYLOAD_RULES, 'type')),
  stopCapture: (record) =>
    withType('stopCapture', validateFields(record, REQUEST_PAYLOAD_RULES, 'type')),
  endSession: (record) =>
    withType('endSession', validateFields(record, REQUEST_PAYLOAD_RULES, 'type')),
  openFile: (record) =>
    withType('openFile', validateFields(record, OPEN_FILE_PAYLOAD_RULES, 'type')),
  requestTarget: (record) =>
    withType('requestTarget', validateFields(record, REQUEST_PAYLOAD_RULES, 'type')),
  pairChrome: (record) =>
    withType('pairChrome', validateFields(record, REQUEST_PAYLOAD_RULES, 'type')),
  dismissPairing: (record) =>
    withType('dismissPairing', validateFields(record, REQUEST_PAYLOAD_RULES, 'type')),
  launchDevServer: (record) =>
    withType('launchDevServer', validateFields(record, REQUEST_PAYLOAD_RULES, 'type')),
  retryStage: (record) =>
    withType('retryStage', validateFields(record, RETRY_STAGE_PAYLOAD_RULES, 'type')),
};
