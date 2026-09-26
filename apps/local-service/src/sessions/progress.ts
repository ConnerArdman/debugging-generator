/**
 * `session.progress` from real pipeline findings: the module that produces the
 * developer-visible progress view both user interfaces render.
 *
 * The view the editor shows for a session reads like this (prompt §11, Step 8):
 *
 * ```text
 * Understanding problem          ← the `understand` stage's `running` row
 * Investigating code             ← the `investigate` stage's `running` row
 * ✓ Found ‹component›            ← a `done` row per component the code graph found
 * ✓ Traced event handler         ← one `done` row when an event handler was traced;
 *                                  its detail lists the traced symbols and a file
 * ✓ Found ‹route path›           ← a `done` row per API route actually resolved
 * ✓ Found database dependency    ← one `done` row when a database call site exists
 *
 * Preparing instrumentation      ← the `instrument` stage's `running` row, settled
 *                                  to `done` when readiness is satisfied
 * ✓ Browser performance          ← one `done` row per signal actually armed
 * ✓ React renders
 * ✓ Network tracing
 * ✓ Server spans
 * ✓ Database tracing
 * ✗ Could not enable ‹signal›: ‹reason›.   ← one `failed` row per unavailable signal
 *
 * Ready to capture               ← the `instrument` stage's closing `done` row
 * ```
 *
 * A **group header** is a stage's `running` row, whose `message` is the stage
 * title from {@link PROGRESS_STAGE_TITLES}; the `done` row a stage closes with
 * carries that same title unless its caller states another, so a client keying
 * rows on `(stage, message)` settles the header rather than adding a line. A
 * **✓ row** is any other `done` row and a **✗ row** a `failed` one. Both user
 * interfaces group whatever the service sent by stage and draw it in arrival
 * order, so neither of them restates a title, a label or a step list.
 *
 * ## The rows are rendered from findings, never from canned text
 *
 * This is the constraint the product is judged on (AAP §0.5.4). Every finding
 * row is built by {@link buildInvestigationRows} or
 * {@link buildInstrumentationRows} from the structured input it was handed —
 * the names the code graph resolved, the hooks the installer armed, the signals
 * an adapter reported unavailable — and a class of finding with no input
 * produces **no row at all**: no placeholder, no "checking…" line, no default
 * name. Deleting a component or a route from the input deletes exactly its row.
 * The event-handler and database classes are one row each whose detail lists
 * their findings: deleting one of those findings deletes it from that detail,
 * and deleting the last deletes the row. The source holds only templates such
 * as `` `Found ${name}` `` and the product's fixed Step-8 labels; the concrete
 * findings exist only at run time. Nothing here reads, receives or branches on
 * the developer's question — it is not an input of any function in this
 * module — and no name of any particular application appears in it;
 * `scripts/check-no-hardcoding.mjs` scans this file for both.
 *
 * The stage titles and signal labels below are the product's own vocabulary
 * (its pipeline stages and its capture signals), not a description of any
 * project it debugs.
 *
 * ## Two halves: pure builders, one emitter
 *
 * - The **builders** are exported, pure, synchronous and I/O-free — no store,
 *   no transport, no clock, no logger — so the from-findings guarantee is
 *   asserted directly against them by
 *   `apps/local-service/test/integration/session-lifecycle.test.ts`; the
 *   colocated `./progress.test.ts` covers the public failure copy and the
 *   emitter's failure handling.
 * - The **emitter**, {@link createSessionProgress}, turns a row into a validated
 *   `session.progress` payload, persists it through the session store's
 *   `session_progress` table and broadcasts it to the session's editor and
 *   DevTools clients. Persisting first is what lets `./reopen.ts` replay a
 *   session with every row that was persisted. A row whose persistence failed
 *   is still broadcast — live delivery is best effort and never withheld — but
 *   it exists only in the frames already sent and cannot be replayed.
 *
 * ## What this module never does
 *
 * - **It never changes a session's status.** Status transitions belong to
 *   `./state-machine.ts` and are applied only by `./manager.ts`; a progress row
 *   is a report of what a stage did, not a decision about the session.
 * - **It never owns transport.** It receives a broadcaster port and hands it a
 *   finished envelope; sockets, client registries and routing live in
 *   `apps/local-service/src/server/**`, which this module does not import.
 * - **It never puts a secret into a row or a log record.** Its inputs are names,
 *   project-relative paths, the product's labels and adapters' developer-facing
 *   reasons and hints. Log records carry only stages, statuses, counts, error
 *   codes and diagnostic references — never a message, a detail or a rejected
 *   payload (AAP §0.5.2).
 * - **It never shows a failure's own words.** A `failed` row is projected from
 *   the failure's stage and closed error code alone: its message is
 *   {@link publicFailureCopy}'s fixed text, its detail the failure's hint only
 *   when that hint is proven product text ({@link isProductAuthoredText}) and
 *   the code's own hint otherwise, followed by the code and a diagnostic
 *   reference minted for that failure. The failure's message — which
 *   `DebuggenError.from` may have taken verbatim from any exception — and an
 *   unproven hint go only to the local service log, as the error field of the
 *   `debug` record {@link STAGE_FAILURE_DIAGNOSTIC_MESSAGE} carrying the same
 *   reference, where the service's error serializer emits them redacted
 *   (CWE-209). The `warn` record {@link STAGE_FAILURE_LOG_MESSAGE}, which the
 *   service's default log level keeps, carries the reference, the code and a
 *   proven hint only.
 * - **It never lets its own diagnostics cost a client a row.** The logger it is
 *   given is wrapped by `../logging.ts`'s `guardLogger`, so no log call on the
 *   emit path — or the creation of its subsystem child — can throw between
 *   persisting a row and broadcasting it.
 *
 * @module
 */

import {
  MESSAGE_TYPE,
  createEnvelope,
  parseSessionProgressPayload,
  type ClientKind,
  type ProgressStage,
  type ProgressStatus,
  type ProtocolMessage,
  type RelevantFile,
  type SessionProgressPayload,
} from '@debuggen/protocol';
import {
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  READINESS_HINT_MAX_LENGTH,
  READINESS_REASON_MAX_LENGTH,
  SERVER_AGENT_SIGNAL_KEYS,
  isCaptureSignal,
  type AgentHookConfig,
  type CaptureSignal,
  type ProblemEntity,
  type ProblemEntityKind,
  type Readiness,
  type ServerAgentSignals,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
  newMessageId,
  noopLogger,
  nowEpochMs,
  ok,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result, SessionId } from '@debuggen/shared';

import {
  LOG_BINDING_KEYS,
  LOG_ERROR_FIELD_KEY,
  describeException,
  guardLogger,
  subsystemLogger,
} from '../logging.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import type { SessionFailure } from './state-machine.js';

// ---------------------------------------------------------------------------
// Section A — the display vocabulary (single definitions)
// ---------------------------------------------------------------------------

/**
 * The group header of every progress stage.
 *
 * Travels on the wire as the `message` of each stage's `running` row, which is
 * how both user interfaces obtain it: neither duplicates a title, and a stage
 * added to protocol's `PROGRESS_STAGES` is a compile error here until it has
 * one. The two titles prompt §11 prints are used verbatim; the other seven are
 * written in the same plain voice and name only the product's own pipeline
 * phases — no framework, no application, no project noun.
 */
export const PROGRESS_STAGE_TITLES = Object.freeze({
  understand: 'Understanding problem',
  investigate: 'Investigating code',
  plan: 'Planning instrumentation',
  instrument: 'Preparing instrumentation',
  capture: 'Capturing runtime evidence',
  analyze: 'Analyzing captured evidence',
  'generate-panel': 'Generating debugging panel',
  followup: 'Evaluating follow-up question',
  cleanup: 'Removing instrumentation',
} as const satisfies Readonly<Record<ProgressStage, string>>);

/**
 * The human label of every capture signal: the text of an instrumentation
 * stage's ✓ row, and the `‹signal›` of its ✗ row.
 *
 * The five labels prompt §11 prints are the labels of the signals behind them:
 * the performance-entry signal is "Browser performance", the fiber-hook signal
 * "React renders", request tracing "Network tracing", the incoming-request and
 * route-handler signals "Server spans", and both database signals "Database
 * tracing". Several signals legitimately share a label, which is why
 * {@link buildInstrumentationRows} de-duplicates by label.
 *
 * **Declaration order is display order.** The five labels come first, in the
 * prompt's order, so the Step-8 group reads as printed whenever those signals
 * are armed; the signals the prompt does not show follow. The signal names
 * themselves are protocol's — owned by `CAPTURE_SIGNALS` in
 * `packages/instrumentation/src/schema/readiness.ts` — and a signal added there
 * is a compile error here until it has a label.
 */
export const CAPTURE_SIGNAL_LABELS = Object.freeze({
  perf: 'Browser performance',
  react: 'React renders',
  fetch: 'Network tracing',
  http: 'Server spans',
  routeHandlers: 'Server spans',
  prisma: 'Database tracing',
  pg: 'Database tracing',
  interactions: 'Interaction timing',
  state: 'State transitions',
  componentTree: 'Component tree',
  errors: 'Runtime errors',
  functions: 'Function timing',
} as const satisfies Readonly<Record<CaptureSignal, string>>);

/** One of the labels in {@link CAPTURE_SIGNAL_LABELS}. */
export type CaptureSignalLabel = (typeof CAPTURE_SIGNAL_LABELS)[CaptureSignal];

/**
 * The stable display order of the instrumentation stage's ✓ rows: every
 * distinct label of {@link CAPTURE_SIGNAL_LABELS}, in declaration order.
 *
 * Derived rather than written out, so no signal name or label is restated and
 * the order cannot drift from the label map it describes.
 */
export const INSTRUMENTATION_ROW_ORDER: readonly CaptureSignalLabel[] = Object.freeze([
  ...new Set(Object.values(CAPTURE_SIGNAL_LABELS)),
]);

/**
 * The closing `done` row of the instrumentation stage, emitted once readiness
 * is satisfied — immediately after the stage's own title row is settled to
 * `done`, so the "Preparing instrumentation" header is never left spinning
 * beside a session that is ready (see {@link SessionProgress.readyToCapture}).
 *
 * The VS Code view's "Reproduce the issue now." (AAP §0.7.3) is **not** a
 * progress row: it is the webview's own rendering of the armed state it reads
 * from the session record, and no stage emits it.
 */
export const READY_TO_CAPTURE_MESSAGE = 'Ready to capture';

/**
 * The public text of one failure code: a sentence naming what failed and the
 * developer's next step.
 */
export interface PublicFailureCopy {
  /** One complete sentence naming what failed, in the product's words. */
  readonly summary: string;
  /** The developer's next step when the failure carried none of its own. */
  readonly hint: string;
}

/**
 * The only failure text a stage's `failed` row — and `instrumentation.failed`
 * — may carry, keyed by the closed error-code vocabulary.
 *
 * A failure reaches this module as a `DebuggenError`, and
 * `DebuggenError.from` keeps the message of whatever it wrapped: a driver
 * error quoting a statement, a filesystem error quoting an absolute path, a
 * provider error quoting its response. Both user interfaces display and
 * persist a failure row, so its text must never be that message (CWE-209).
 * It is this fixed copy instead, chosen by the failure's code — which is from
 * `DEBUGGEN_ERROR_CODES` and therefore safe by construction — while the
 * failure's own words are kept for the local, redacted service log under a
 * diagnostic reference the row shows.
 *
 * Exhaustive over the vocabulary (`satisfies`), so a code added to
 * `DEBUGGEN_ERROR_CODES` is a compile error here until it has copy. The model
 * provider row is AAP §0.5.5's own wording, and the empty-capture row is its
 * recovery sentence; the rest are written in the same plain, generic voice and
 * name no project, framework or application.
 */
export const FAILURE_COPY_BY_CODE = Object.freeze({
  CONFIG_INVALID: {
    summary: 'The Debug Generator service configuration is invalid.',
    hint: 'Check the DEBUGGEN_* settings in the environment, then restart the service.',
  },
  FORBIDDEN_ORIGIN: {
    summary: 'A request from a web page was refused.',
    hint: 'Use the Debug Generator view in VS Code or the Debug Generator DevTools panel.',
  },
  PAIRING_EXPIRED: {
    summary: 'The pairing code expired.',
    hint: 'Pair Chrome again from VS Code to get a new code.',
  },
  PAIRING_INVALID: {
    summary: 'The pairing code was not accepted.',
    hint: 'Pair Chrome again from VS Code to get a new code.',
  },
  RATE_LIMITED: {
    summary: 'Too many attempts were refused.',
    hint: 'Wait a minute, then try again.',
  },
  UNAUTHORIZED: {
    summary: 'The request was not authorized.',
    hint: 'Reconnect the editor, or pair the DevTools panel again.',
  },
  CAPTURE_ALREADY_ACTIVE: {
    summary: 'Another session is already capturing this project.',
    hint: 'Stop that capture or end its session, then start capture again.',
  },
  CAPTURE_EMPTY: {
    summary: 'No telemetry was captured.',
    hint: 'Interact with the page while capture is running, then Capture again.',
  },
  SESSION_INVALID_STATE: {
    summary: 'The session was not in a state that allows this step.',
    hint: 'Check the session status, then retry the step.',
  },
  SESSION_NOT_FOUND: {
    summary: 'The session no longer exists.',
    hint: 'Start a new session from the Debug Generator view.',
  },
  TAB_NOT_BOUND: {
    summary: 'No browser tab is bound to this session.',
    hint: "Open the Debug Generator DevTools panel on the application's tab.",
  },
  FS_UNSAFE_PATH: {
    summary: 'A file path was refused as unsafe.',
    hint: 'Check that DEBUGGEN_HOME is a private directory you own, then retry.',
  },
  PATH_OUTSIDE_PROJECT: {
    summary: 'A path outside the project was refused.',
    hint: 'Only files inside the project being debugged can be used.',
  },
  PROJECT_NOT_FOUND: {
    summary: 'The project could not be found or read.',
    hint: 'Open the project folder in VS Code, then start the session again.',
  },
  AGENT_NOT_READY: {
    summary: 'The page agent is not ready in the bound tab.',
    hint: 'Reload the page, then start capture again.',
  },
  DEV_SERVER_LAUNCH_FAILED: {
    summary: 'The dev server could not be launched.',
    hint: "Check the project's dev script, then launch the dev server again.",
  },
  DEV_SERVER_UNAVAILABLE: {
    summary: 'The dev server did not answer.',
    hint: 'Start the dev server, then retry.',
  },
  SERVER_AGENT_NOT_READY: {
    summary: 'The dev server is not running with the telemetry preload.',
    hint: 'Relaunch the dev server from Debug Generator, then retry.',
  },
  CLEANUP_PARTIAL: {
    summary: 'Some instrumentation could not be removed.',
    hint: 'Review the modifications list, then end the session again to retry cleanup.',
  },
  INSTRUMENTATION_INSTALL_FAILED: {
    summary: 'Instrumentation could not be installed.',
    hint: 'Review the modifications list, then ask the question again to retry.',
  },
  INSTRUMENTATION_UNAVAILABLE: {
    summary: 'The planned instrumentation is not available here.',
    hint: 'Check the dev server and the DevTools panel, then retry.',
  },
  MODIFICATION_CONFLICT: {
    summary: 'An instrumented file was edited during the session.',
    hint: 'Debug Generator did not overwrite it; review the conflict in the modifications list.',
  },
  PATCH_TARGET_NOT_FOUND: {
    summary: 'A planned instrumentation target was not found in the code.',
    hint: 'Ask the question again so the plan is rebuilt from the current code.',
  },
  PATCH_UNSUPPORTED: {
    summary: 'A planned instrumentation target cannot be wrapped safely.',
    hint: 'Ask the question again so the plan is rebuilt from the current code.',
  },
  CODE_INDEX_FAILED: {
    summary: 'The project could not be indexed.',
    hint: "Check that the project's tsconfig.json loads, then start the session again.",
  },
  MODEL_OUTPUT_INVALID: {
    summary: "The model's output failed validation.",
    hint: 'Retry the step; if it keeps failing, switch DEBUGGEN_PROVIDER.',
  },
  MODEL_UNAVAILABLE: {
    summary: 'Model provider unavailable (MODEL_UNAVAILABLE).',
    hint: 'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.',
  },
  PANEL_INVALID: {
    summary: 'The generated panel failed validation.',
    hint: 'Retry panel generation; the captured evidence is kept.',
  },
  PANEL_SEMANTIC_INVALID: {
    summary: 'The generated panel cited evidence the capture does not hold.',
    hint: 'Retry panel generation; the captured evidence is kept.',
  },
  PLAN_INVALID: {
    summary: 'The instrumentation plan failed validation.',
    hint: 'Ask the question again to build a new plan.',
  },
  PROTOCOL_INVALID_MESSAGE: {
    summary: 'A message between Debug Generator components was malformed.',
    hint: 'Update the VS Code and Chrome extensions to match the service, then retry.',
  },
  STORE_ERROR: {
    summary: 'The session store failed.',
    hint: 'Check the free space and permissions of DEBUGGEN_HOME, then retry.',
  },
  TRANSPORT_DISCONNECTED: {
    summary: 'A connection between Debug Generator components was lost.',
    hint: 'Check that the Debug Generator service is running, then retry.',
  },
  INTERNAL: {
    summary: 'An unexpected error stopped this step.',
    hint: 'Retry the step; the service log records the failure under the reference shown.',
  },
  NOT_IMPLEMENTED: {
    summary: 'This step is not available in this version.',
    hint: 'Update Debug Generator, then retry.',
  },
} as const satisfies Readonly<Record<DebuggenErrorCode, PublicFailureCopy>>);

/** The public text of one failed stage, as {@link publicFailureCopy} composes it. */
export interface PublicStageFailure {
  /** `‹stage title› failed: ‹summary›` — the row's first line. */
  readonly message: string;
  /** The code's next step from {@link FAILURE_COPY_BY_CODE}. */
  readonly hint: string;
}

/**
 * Composes the public text of `code` failing in `stage`: the stage's title
 * from {@link PROGRESS_STAGE_TITLES} and the code's copy from
 * {@link FAILURE_COPY_BY_CODE}, and nothing else.
 *
 * Pure and total. A stage or code read from outside the type system that is
 * not in its vocabulary falls back to the generic "this step" wording and the
 * `INTERNAL` copy rather than echoing the value, so whatever a caller passes,
 * the result is product copy.
 *
 * @param stage The failing stage.
 * @param code The failure's code.
 * @returns The row's message and the code's default hint.
 *
 * @example
 * ```ts
 * publicFailureCopy('understand', 'MODEL_UNAVAILABLE');
 * // { message: 'Understanding problem failed: Model provider unavailable (MODEL_UNAVAILABLE).',
 * //   hint: 'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.' }
 * ```
 */
export function publicFailureCopy(
  stage: ProgressStage,
  code: DebuggenErrorCode,
): PublicStageFailure {
  const title: string = Object.hasOwn(PROGRESS_STAGE_TITLES, stage)
    ? PROGRESS_STAGE_TITLES[stage]
    : 'This step';
  const copy: PublicFailureCopy = Object.hasOwn(FAILURE_COPY_BY_CODE, code)
    ? FAILURE_COPY_BY_CODE[code]
    : FAILURE_COPY_BY_CODE.INTERNAL;
  return { message: `${title} failed: ${copy.summary}`, hint: copy.hint };
}

/**
 * Whether `error`'s message is text copied from the value it wraps rather than
 * a sentence the product wrote.
 *
 * `DebuggenError.from` keeps a wrapped `Error`'s message — or its name, when
 * the message is empty — and a thrown string verbatim, and sets that value as
 * the `cause`; that is exactly the shape tested here. A failure whose
 * properties cannot even be read is treated as copied text, the conservative
 * answer for something about to be shown to a developer.
 *
 * A surface that shows an error's message verbatim — standard error at
 * start-up, an HTTP refusal body — asks this first and shows
 * {@link FAILURE_COPY_BY_CODE} instead when it answers `true`.
 *
 * @param error A failure about to be shown.
 * @returns `true` when its message is the wrapped value's own text.
 *
 * @example
 * ```ts
 * carriesWrappedExceptionText(DebuggenError.from(new Error('EACCES: /home/dev/x')));  // true
 * carriesWrappedExceptionText(new DebuggenError('SESSION_NOT_FOUND', 'No such session.')); // false
 * ```
 */
export function carriesWrappedExceptionText(error: DebuggenError): boolean {
  try {
    const cause: unknown = error.cause;
    if (typeof cause === 'string') {
      return error.message === cause;
    }
    if (cause instanceof Error) {
      return error.message === cause.message || error.message === cause.name;
    }
    return false;
  } catch {
    // A hostile accessor or a `Proxy` trap on the cause: nothing about the
    // message is known to be product copy, so it is treated as copied text.
    return true;
  }
}

/**
 * The most distinct product-authored texts {@link authorProductText}
 * remembers at once. The oldest registration is forgotten first, so the
 * registry's memory is bounded however many sessions a service runs.
 */
export const PRODUCT_TEXT_REGISTRY_LIMIT = 512;

/**
 * The longest text {@link authorProductText} registers, in UTF-16 code units.
 * Longer text is returned unchanged but never recorded, so it is never shown as
 * the product's.
 */
export const PRODUCT_TEXT_MAX_LENGTH = 2000;

/**
 * The texts {@link FAILURE_COPY_BY_CODE} holds: product copy by construction,
 * and therefore product-authored without being registered.
 */
const FIXED_PRODUCT_TEXTS: ReadonlySet<string> = new Set(
  Object.values(FAILURE_COPY_BY_CODE).flatMap((copy: PublicFailureCopy) => [
    copy.summary,
    copy.hint,
  ]),
);

/**
 * Registered product texts, in registration order (a `Map`'s iteration order),
 * so the first key is the least recently registered or recognised one.
 */
const registeredProductTexts = new Map<string, true>();

/**
 * Records `text` as written by this product and returns it unchanged.
 *
 * A failure surface — a failed progress row, `instrumentation.failed`, an HTTP
 * refusal — shows a failure's own message or hint only when
 * {@link isProductAuthoredText} recognises it; anything else is replaced by the
 * code's {@link FAILURE_COPY_BY_CODE} copy (CWE-209). A builder that composes a
 * recovery sentence from product templates and service-derived values — the
 * dev-server relaunch command, a readiness gate's reason — passes its result
 * through here at the point of composition, which is the proof the surface
 * later relies on: exact equality with text the product itself produced in
 * this process. A value an adapter, a dependency or a thrown exception
 * supplied is never passed here, so it can never match, whatever it says.
 *
 * Bounded: at most {@link PRODUCT_TEXT_REGISTRY_LIMIT} texts, each at most
 * {@link PRODUCT_TEXT_MAX_LENGTH} long; registering an already-known text makes
 * it the most recent. Never throws.
 *
 * @param text A sentence the product composed.
 * @returns `text`, unchanged, so a builder can register what it returns inline.
 *
 * @example
 * ```ts
 * const hint = authorProductText(`Restart the dev server with: ${command}`);
 * isProductAuthoredText(hint); // true
 * isProductAuthoredText(thrown.message); // false, unless it is that exact sentence
 * ```
 */
export function authorProductText<T extends string>(text: T): T {
  if (typeof text !== 'string' || text.length === 0 || text.length > PRODUCT_TEXT_MAX_LENGTH) {
    return text;
  }
  if (FIXED_PRODUCT_TEXTS.has(text)) {
    return text;
  }
  registeredProductTexts.delete(text);
  registeredProductTexts.set(text, true);
  while (registeredProductTexts.size > PRODUCT_TEXT_REGISTRY_LIMIT) {
    const oldest = registeredProductTexts.keys().next();
    if (oldest.done === true) {
      break;
    }
    registeredProductTexts.delete(oldest.value);
  }
  return text;
}

/**
 * Whether `text` is proven product copy: one of {@link FAILURE_COPY_BY_CODE}'s
 * texts, or a text a product builder registered with
 * {@link authorProductText} and that is still remembered.
 *
 * The comparison is exact — no trimming, no case folding — so a failure's text
 * is shown only when it is, character for character, something the product
 * wrote. Recognising a registered text makes it the most recent, so the texts
 * in use are the last to be forgotten. Never throws.
 *
 * @param text A failure's message or hint, of any type.
 * @returns `true` only for a non-empty string the product authored.
 */
export function isProductAuthoredText(text: unknown): text is string {
  if (typeof text !== 'string' || text.length === 0 || text.length > PRODUCT_TEXT_MAX_LENGTH) {
    return false;
  }
  if (FIXED_PRODUCT_TEXTS.has(text)) {
    return true;
  }
  if (!registeredProductTexts.has(text)) {
    return false;
  }
  registeredProductTexts.delete(text);
  registeredProductTexts.set(text, true);
  return true;
}

/**
 * The most rows either builder returns for its stage, including the single
 * overflow row `` `+${n} more` `` that stands for the remainder.
 *
 * Every class of finding that produced anything keeps at least one visible row
 * before any class is given a second, so a large project can never crowd a
 * database dependency or an unavailable signal out of the view. Consequently no
 * single class exceeds this bound either.
 */
export const MAX_FINDING_ROWS_PER_STAGE = 12;

/**
 * The client kinds a `session.progress` frame is delivered to: the editor's
 * view and the bound tab's DevTools panel (AAP §0.4.2).
 *
 * Typed against protocol's `ClientKind`, so renaming a kind breaks this line
 * rather than silently routing progress to nobody.
 */
export const PROGRESS_RECIPIENT_KINDS: readonly ClientKind[] = Object.freeze([
  'vscode',
  'devtools',
]);

/** The one row the database class produces, whenever a call site was found. */
const DATABASE_DEPENDENCY_MESSAGE = 'Found database dependency';

/**
 * The one row the event-handler class produces, whenever a handler was traced
 * (prompt §11, Step 8, verbatim). The traced symbols are the row's evidence and
 * travel in its `detail`; they are never folded into the message, because both
 * user interfaces key rows on `(stage, message)` and the Step-8 wording is a
 * fixed label, not a template.
 */
const TRACED_EVENT_HANDLER_MESSAGE = 'Traced event handler';

/** The logger binding naming this folder, per `../logging.ts`'s convention. */
const LOG_SUBSYSTEM = 'sessions';

/**
 * The `msg` of the `warn` record each stage failure is logged with: the
 * record whose `ref` field is the reference its `failed` row shows. Its error
 * field carries the failure's code, its message — which the service's error
 * serializer never emits at `warn` — and its hint only when that hint is
 * proven product text, so the record is safe at the service's default level.
 */
export const STAGE_FAILURE_LOG_MESSAGE =
  'a stage failed; its row shows the public copy under this reference';

/**
 * The `msg` of the `debug` twin of {@link STAGE_FAILURE_LOG_MESSAGE}: the same
 * session, stage, code and reference, with the failure's own message and hint
 * — proven or not — under the error field.
 *
 * Written at `debug` because that is the one level family at which the
 * service's error serializer adds an error's message and stack, after masking
 * URL query values and SQL literals and removing source codeframes. So the
 * reference a developer reads off a `failed` row leads, once
 * `DEBUGGEN_LOG_LEVEL=debug` is set, to a detailed and redacted local
 * diagnostic, and at the default level to nothing that could quote a path, a
 * statement or a credential.
 *
 * @example
 * ```text
 * {"level":20,"subsystem":"sessions","sessionId":"ses_…","stage":"plan",
 *  "code":"INTERNAL","ref":"msg_…","err":{"type":"DebuggenError",
 *  "code":"INTERNAL","message":"…redacted…","hint":"…"},"msg":"…"}
 * ```
 */
export const STAGE_FAILURE_DIAGNOSTIC_MESSAGE =
  'the diagnostic of a failed stage, under the reference its row shows';

/**
 * Display bound for one finding name — a component, a handler symbol, a route
 * path. Far above any identifier or path the code graph produces, and far below
 * the transport's message bound, so a clipped name still makes a valid row.
 */
const MAX_FINDING_TEXT_LENGTH = 240;

/**
 * Display bound for a composed first line (a stage failure's message).
 * Half of protocol's transport bound for `message`, whose schema remains the
 * authority {@link SessionProgress.emit} validates against.
 */
const MAX_MESSAGE_TEXT_LENGTH = 1000;

/**
 * Display bound for a composed second line. A quarter of protocol's transport
 * bound for `detail`, which again stays the validator of record.
 */
const MAX_DETAIL_TEXT_LENGTH = 1000;

/** Separator between the entries a single `detail` line lists. */
const DETAIL_LIST_SEPARATOR = ', ';

/** Separator between the independent facts one `detail` line carries. */
const DETAIL_PART_SEPARATOR = ' · ';

/** Appended to a clipped display text. */
const ELLIPSIS = '…';

/**
 * A database call site in callee form — `a.b.c` or `a.b.c()` — the only shape
 * of database finding this module is willing to print. Anything else (a
 * statement, a location string) is counted but never echoed, so no SQL text can
 * reach a progress row through this path (AAP §0.5.2).
 */
const CALL_SITE_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/u;

/** Trailing sentence punctuation stripped from a reason before it is quoted. */
const TRAILING_PUNCTUATION_PATTERN = /[\s.]+$/u;

/**
 * The only shape a diagnostic reference may take before a `failed` row shows
 * it: an identifier-like token such as `newMessageId()`'s `msg_…`, bounded.
 * A reference from an injected generator that does not match is replaced by
 * a fresh message id, so the row can never carry a generator's free text.
 */
const DIAGNOSTIC_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/**
 * The fallback of a failure whose code is outside the closed vocabulary: the
 * code {@link publicFailureCopy} words it as, and therefore the code its row
 * names.
 */
const UNKNOWN_FAILURE_CODE: DebuggenErrorCode = 'INTERNAL';

// ---------------------------------------------------------------------------
// Section B — the builders' inputs and output
// ---------------------------------------------------------------------------

/**
 * One progress row before it is addressed to a session: exactly the fields of
 * protocol's `session.progress` payload other than `sessionId`, picked rather
 * than restated so the two cannot drift. `detail`, when present, is the
 * optional second line — a string on the wire, never a structure.
 */
export type ProgressRow = Pick<SessionProgressPayload, 'stage' | 'status' | 'message' | 'detail'>;

/**
 * What the investigation actually found, as {@link buildInvestigationRows}
 * reads it.
 *
 * Declared here rather than imported from `../pipeline/**`, which is a higher
 * layer that calls into this one. Every member is optional and each array is a
 * list of **findings**, not of guesses:
 *
 * - An explicit array — even an empty one — is authoritative for its class.
 * - When an array is absent, its class is derived from {@link entities} by
 *   entity kind (see {@link buildInvestigationRows}), so a caller holding only
 *   the Stage-1 entities and the investigation's relevant files is served too.
 * - {@link relevantFiles} is never a class of its own; it supplies the
 *   evidential origin (the file) a finding row carries as its `detail`.
 */
export interface InvestigationFindings {
  /** Component or symbol names the code graph actually resolved. */
  readonly components?: readonly string[];
  /** Event-handler symbols actually traced. */
  readonly eventHandlers?: readonly string[];
  /** API route paths actually resolved to a handler. */
  readonly routes?: readonly string[];
  /** Database call sites actually found. */
  readonly databaseDependencies?: readonly string[];
  /** The Stage-1 entities, when the caller has them. */
  readonly entities?: readonly ProblemEntity[];
  /** The investigation's relevant files, used for each row's origin. */
  readonly relevantFiles?: readonly RelevantFile[];
}

/**
 * What the installer actually armed, as {@link buildInstrumentationRows} reads
 * it. Every member is optional; a signal is shown as enabled only when one of
 * {@link signals}, {@link hooks}, {@link serverSignals} or {@link runtimeHooks}
 * says so, and is never assumed.
 */
export interface InstalledSignals {
  /** Signals actually enabled, by name. */
  readonly signals?: readonly CaptureSignal[];
  /** The page-agent hook configuration actually sent (`agent.config`). */
  readonly hooks?: AgentHookConfig;
  /** The dev-server signal set actually sent (`server-agent.config`). */
  readonly serverSignals?: ServerAgentSignals;
  /**
   * `InstallResult.runtimeHooks`: an entry counts when it is exactly a signal
   * name or exactly one of {@link CAPTURE_SIGNAL_LABELS}' labels. Adapters'
   * finer-grained hook descriptions are carried by `instrumentation.ready`
   * instead and are not mapped here, because mapping free text would be a guess.
   */
  readonly runtimeHooks?: readonly string[];
  /**
   * `InstallResult.unavailable`. Protocol's `unavailableSignalSchema` is the
   * wire validator of the same shape; this module reads the instrumentation
   * type the installer produces.
   */
  readonly unavailable?: readonly UnavailableSignal[];
  /**
   * The aggregated readiness report. A row `unavailable` here withdraws the
   * signal's ✓ row (and reports it as ✗ when no `unavailable` entry already
   * did); a `degraded` row keeps the ✓ and explains itself in the detail.
   */
  readonly readiness?: Readiness;
}

/** The four classes of investigation finding, in the order they are displayed. */
type FindingClass = 'components' | 'eventHandlers' | 'routes' | 'databaseDependencies';

/**
 * Which finding class a Stage-1 entity kind seeds, when the explicit array for
 * that class is absent.
 *
 * Keyed by the closed `PROBLEM_ENTITY_KINDS` vocabulary with `satisfies`, so a
 * kind added upstream is a compile error until it is placed here. Only kinds
 * that *are* one of the four classes map to one: a `component` entity is a
 * component, a `route` a route path, a `query` a data-layer operation. No kind
 * denotes an event handler, so that class is never derived — a `function`
 * entity is not evidence that a handler was traced, and inferring one from a
 * name would be a guess.
 */
const ENTITY_KIND_FINDING_CLASS = Object.freeze({
  component: 'components',
  function: undefined,
  hook: undefined,
  route: 'routes',
  file: undefined,
  symbol: undefined,
  selector: undefined,
  url: undefined,
  query: 'databaseDependencies',
  other: undefined,
} as const satisfies Readonly<Record<ProblemEntityKind, FindingClass | undefined>>);

/** One resolved finding: its display name and, when known, its file. */
interface Finding {
  readonly name: string;
  readonly file?: string;
}

// ---------------------------------------------------------------------------
// Section C — display-text helpers (pure)
// ---------------------------------------------------------------------------

/** Highest code point of the C0 control block. */
const C0_CONTROL_MAX = 0x1f;

/** Lowest code point of the DEL/C1 control block. */
const C1_CONTROL_MIN = 0x7f;

/** Highest code point of the C1 control block. */
const C1_CONTROL_MAX = 0x9f;

/** Whether a code point is whitespace or a control character. */
function isBreakingCodePoint(codePoint: number): boolean {
  return (
    codePoint <= C0_CONTROL_MAX ||
    (codePoint >= C1_CONTROL_MIN && codePoint <= C1_CONTROL_MAX) ||
    /\s/u.test(String.fromCodePoint(codePoint))
  );
}

/**
 * Normalises a value into one line of display text: every run of whitespace
 * or control characters becomes a single space, the ends are trimmed, and a
 * value longer than `maxLength` code points is clipped with an ellipsis.
 *
 * A progress row is one line in two user interfaces and a log-free store row;
 * a name carrying a line feed would split it. Clipping counts code points, so
 * a surrogate pair is never cut in half.
 *
 * @param value Any value; a non-string yields the empty string.
 * @param maxLength The most code points to keep, ellipsis included.
 * @returns The display text, or `''` when nothing printable remains.
 */
function toDisplayText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  const codePoints: string[] = [];
  let pendingSpace = false;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (isBreakingCodePoint(codePoint)) {
      pendingSpace = codePoints.length > 0;
      continue;
    }

    if (pendingSpace) {
      codePoints.push(' ');
      pendingSpace = false;
    }

    codePoints.push(character);
  }

  if (codePoints.length <= maxLength) {
    return codePoints.join('');
  }

  return `${codePoints
    .slice(0, Math.max(0, maxLength - 1))
    .join('')
    .trimEnd()}${ELLIPSIS}`;
}

/**
 * Joins entries into one bounded line, stopping before the bound and saying
 * how many entries were left out.
 *
 * Stops as soon as the line is full, so a list of ten thousand names costs no
 * more than the bound to render.
 *
 * @param entries The entries, already display text.
 * @param separator What goes between two entries.
 * @param maxLength The bound on the joined entries, before the omission note.
 * @param alsoOmitted Entries the caller withheld itself (never printable), to
 * be counted in the same omission note rather than a second one.
 * @returns The line, or `''` for an empty list with nothing omitted.
 */
function joinBounded(
  entries: readonly string[],
  separator: string,
  maxLength: number,
  alsoOmitted = 0,
): string {
  let line = '';
  let shown = 0;

  for (const entry of entries) {
    const next = shown === 0 ? entry : `${line}${separator}${entry}`;

    if (next.length > maxLength) {
      break;
    }

    line = next;
    shown += 1;
  }

  const omitted = entries.length - shown + alsoOmitted;

  if (omitted === 0) {
    return line;
  }

  const suffix = `+${String(omitted)} more`;

  return shown === 0 ? suffix : `${line}${separator}${suffix}`;
}

/**
 * The display names of a list, normalised, with blanks dropped and duplicates
 * collapsed onto their first occurrence — so the output is deterministic for a
 * given input and follows its order.
 */
function uniqueDisplayNames(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const value of values) {
    const name = toDisplayText(value, MAX_FINDING_TEXT_LENGTH);

    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

/**
 * A project-relative path as a display text: normalised like any other line,
 * with the cosmetic `./` prefix an authored path may carry removed.
 */
function toDisplayPath(value: unknown): string {
  let path = toDisplayText(value, MAX_FINDING_TEXT_LENGTH);

  while (path.startsWith('./')) {
    path = path.slice(2);
  }

  return path;
}

/**
 * Builds a row, adding `detail` only when there is one — an absent key rather
 * than an `undefined` value, which is how protocol spells "no detail" and what
 * survives a JSON round trip unchanged. The row is frozen: builders hand out
 * values, not state.
 */
function makeRow(
  stage: ProgressStage,
  status: ProgressStatus,
  message: string,
  detail?: string,
): ProgressRow {
  return Object.freeze(
    detail === undefined || detail.length === 0
      ? { stage, status, message }
      : { stage, status, message, detail },
  );
}

// ---------------------------------------------------------------------------
// Section D — bounding a stage's rows (pure)
// ---------------------------------------------------------------------------

/**
 * Bounds a stage's rows to {@link MAX_FINDING_ROWS_PER_STAGE}, replacing the
 * remainder with one `` `+${n} more` `` row.
 *
 * `groups` are the stage's classes of row in display order. When everything
 * fits it is returned whole. Otherwise one slot is reserved for the overflow
 * row, every non-empty group is given one slot first — so no class of finding
 * disappears behind another — and the remaining slots are filled group by
 * group in `fillOrder`. Shown rows keep their display order; the overflow row
 * comes last, is `failed` when any row it stands for is a failure (a failure is
 * never hidden under a ✓), and lists the hidden rows' messages as its detail.
 *
 * @param stage The stage every row belongs to.
 * @param groups The rows, grouped by class, in display order.
 * @param fillOrder Group indices in the order spare slots are granted.
 * @returns At most {@link MAX_FINDING_ROWS_PER_STAGE} frozen rows.
 */
function boundStageRows(
  stage: ProgressStage,
  groups: readonly (readonly ProgressRow[])[],
  fillOrder: readonly number[],
): readonly ProgressRow[] {
  const total = groups.reduce((sum, group) => sum + group.length, 0);

  if (total <= MAX_FINDING_ROWS_PER_STAGE) {
    return Object.freeze(groups.flat());
  }

  const allocation = groups.map(() => 0);
  let remaining = MAX_FINDING_ROWS_PER_STAGE - 1;

  for (const index of fillOrder) {
    if (remaining > 0 && (groups[index]?.length ?? 0) > 0) {
      allocation[index] = 1;
      remaining -= 1;
    }
  }

  for (const index of fillOrder) {
    const available = (groups[index]?.length ?? 0) - (allocation[index] ?? 0);
    const granted = Math.min(Math.max(available, 0), remaining);

    allocation[index] = (allocation[index] ?? 0) + granted;
    remaining -= granted;
  }

  const shown = groups.flatMap((group, index) => group.slice(0, allocation[index] ?? 0));
  const hidden = groups.flatMap((group, index) => group.slice(allocation[index] ?? 0));
  const overflowStatus: ProgressStatus = hidden.some((row) => row.status === 'failed')
    ? 'failed'
    : 'done';
  const overflow = makeRow(
    stage,
    overflowStatus,
    `+${String(hidden.length)} more`,
    joinBounded(
      hidden.map((row) => row.message),
      DETAIL_LIST_SEPARATOR,
      MAX_DETAIL_TEXT_LENGTH,
    ),
  );

  return Object.freeze([...shown, overflow]);
}

// ---------------------------------------------------------------------------
// Section E — the investigation rows (pure)
// ---------------------------------------------------------------------------

/**
 * Indexes the investigation's relevant files by symbol, keeping the first file
 * listed for a symbol so the origin a row shows is deterministic.
 */
function indexOriginsBySymbol(
  relevantFiles: readonly RelevantFile[] | undefined,
): Map<string, string> {
  const origins = new Map<string, string>();

  for (const relevant of relevantFiles ?? []) {
    const symbol = toDisplayText(relevant.symbol, MAX_FINDING_TEXT_LENGTH);
    const file = toDisplayPath(relevant.file);

    if (symbol.length > 0 && file.length > 0 && !origins.has(symbol)) {
      origins.set(symbol, file);
    }
  }

  return origins;
}

/**
 * Resolves one finding class to its findings.
 *
 * An explicit array is authoritative, including an empty one. Without it the
 * class is derived from the Stage-1 entities whose kind maps to it through
 * {@link ENTITY_KIND_FINDING_CLASS} — and only from **anchored** ones: an
 * entity names what the question points at, so it counts as something the run
 * *found* only when it has a file of its own or when the investigation's
 * relevant files resolved its name. An entity that is merely named in the
 * question produces no row.
 *
 * The origin is the relevant file resolved for the name, falling back to the
 * entity's own file.
 */
function resolveFindings(
  findingClass: FindingClass,
  explicit: readonly string[] | undefined,
  entities: readonly ProblemEntity[] | undefined,
  origins: ReadonlyMap<string, string>,
): Finding[] {
  if (explicit !== undefined) {
    return uniqueDisplayNames(explicit).map((name) => withOrigin(name, origins.get(name)));
  }

  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const entity of entities ?? []) {
    const kind: ProblemEntityKind = entity.kind;

    if (!Object.hasOwn(ENTITY_KIND_FINDING_CLASS, kind)) {
      continue;
    }

    if (ENTITY_KIND_FINDING_CLASS[kind] !== findingClass) {
      continue;
    }

    const name = toDisplayText(entity.name, MAX_FINDING_TEXT_LENGTH);
    const file = origins.get(name) ?? toDisplayPath(entity.file);

    if (name.length === 0 || file.length === 0 || seen.has(name)) {
      continue;
    }

    seen.add(name);
    findings.push({ name, file });
  }

  return findings;
}

/** A finding, with its origin file only when one is known. */
function withOrigin(name: string, file: string | undefined): Finding {
  return file === undefined || file.length === 0 ? { name } : { name, file };
}

/**
 * The single database row: emitted only when at least one call site exists,
 * with a detail listing the call sites that are in callee form and the origin
 * file of the first one that has one. A site that is not in callee form is
 * counted, never printed.
 */
function databaseRows(findings: readonly Finding[]): ProgressRow[] {
  if (findings.length === 0) {
    return [];
  }

  const printable = findings
    .map((finding) => finding.name)
    .filter((name) => CALL_SITE_PATTERN.test(name));
  const origin = findings.find((finding) => finding.file !== undefined)?.file;
  const parts: string[] = [];

  if (printable.length > 0) {
    parts.push(
      joinBounded(
        printable,
        DETAIL_LIST_SEPARATOR,
        MAX_DETAIL_TEXT_LENGTH / 2,
        findings.length - printable.length,
      ),
    );
  } else if (findings.length > 1) {
    parts.push(`${String(findings.length)} call sites`);
  }

  if (origin !== undefined) {
    parts.push(origin);
  }

  return [
    makeRow('investigate', 'done', DATABASE_DEPENDENCY_MESSAGE, parts.join(DETAIL_PART_SEPARATOR)),
  ];
}

/**
 * The single event-handler row: emitted only when at least one handler was
 * traced, with a detail listing the traced symbols (bounded, with an omission
 * note past the bound) and the origin file of the first handler that has one —
 * so one handler reads `` `${symbol} · ${file}` ``. The file part is omitted
 * when no traced handler resolved to a file.
 *
 * One row for the whole class rather than one per handler: both user
 * interfaces de-duplicate rows by `(stage, message)`, so several rows sharing
 * the fixed Step-8 label would collapse into one and lose all but the first
 * handler's evidence.
 */
function eventHandlerRows(findings: readonly Finding[]): ProgressRow[] {
  if (findings.length === 0) {
    return [];
  }

  const origin = findings.find((finding) => finding.file !== undefined)?.file;
  const parts = [
    joinBounded(
      findings.map((finding) => finding.name),
      DETAIL_LIST_SEPARATOR,
      MAX_DETAIL_TEXT_LENGTH / 2,
    ),
  ];

  if (origin !== undefined) {
    parts.push(origin);
  }

  return [
    makeRow('investigate', 'done', TRACED_EVENT_HANDLER_MESSAGE, parts.join(DETAIL_PART_SEPARATOR)),
  ];
}

/**
 * Builds the investigation stage's finding rows from what the investigation
 * actually found.
 *
 * - one `` `Found ${name}` `` row per component found;
 * - one "Traced event handler" row when at least one event handler was traced
 *   — the Step-8 label verbatim, with the traced symbols as its evidence;
 * - one `` `Found ${routePath}` `` row per API route resolved;
 * - one "Found database dependency" row when at least one call site was found.
 *
 * A component or route row's `detail` is the finding's origin file when one is
 * known (a project-relative path the editor can open). The event-handler and
 * database rows each stand for their whole class, so their `detail` lists the
 * class's findings — the traced handler symbols, the call sites — then the
 * origin file of the first finding that has one, separated by `` ` · ` ``
 * (`` `${symbol} · ${file}` `` for a single traced handler). A class with no
 * finding emits no row, and an empty input returns an empty array. Output is
 * bounded by {@link MAX_FINDING_ROWS_PER_STAGE}, follows input order within
 * each class, and is identical for identical input. All rows belong to the
 * `investigate` stage and are `done`.
 *
 * Pure, synchronous and I/O-free: no store, no transport, no clock, no logger.
 *
 * @param findings What the investigation found.
 * @returns The rows, frozen, in display order.
 *
 * @example
 * ```ts
 * buildInvestigationRows({ components: [name], routes: [] });
 * // → [{ stage: 'investigate', status: 'done', message: `Found ${name}` }]
 * buildInvestigationRows({});
 * // → []
 * ```
 */
export function buildInvestigationRows(findings: InvestigationFindings): readonly ProgressRow[] {
  const origins = indexOriginsBySymbol(findings.relevantFiles);
  const entities = findings.entities;

  const components = resolveFindings('components', findings.components, entities, origins);
  const handlers = resolveFindings('eventHandlers', findings.eventHandlers, entities, origins);
  const routes = resolveFindings('routes', findings.routes, entities, origins);
  const database = resolveFindings(
    'databaseDependencies',
    findings.databaseDependencies,
    entities,
    origins,
  );

  const groups: readonly (readonly ProgressRow[])[] = [
    components.map((finding) =>
      makeRow('investigate', 'done', `Found ${finding.name}`, finding.file),
    ),
    eventHandlerRows(handlers),
    routes.map((finding) => makeRow('investigate', 'done', `Found ${finding.name}`, finding.file)),
    databaseRows(database),
  ];

  return boundStageRows(
    'investigate',
    groups,
    groups.map((_group, index) => index),
  );
}

// ---------------------------------------------------------------------------
// Section F — the instrumentation rows (pure)
// ---------------------------------------------------------------------------

/** The label vocabulary widened to `string`, for membership tests only. */
const LABEL_VALUES: readonly string[] = INSTRUMENTATION_ROW_ORDER;

/** Whether a string is exactly one of {@link CAPTURE_SIGNAL_LABELS}' labels. */
function isCaptureSignalLabel(value: string): value is CaptureSignalLabel {
  return LABEL_VALUES.includes(value);
}

/**
 * The signals behind each label, derived from {@link CAPTURE_SIGNAL_LABELS}
 * over the imported `CAPTURE_SIGNALS`, so a label armed by name can be
 * withdrawn when every signal it stands for is unavailable.
 */
const SIGNALS_BY_LABEL: ReadonlyMap<CaptureSignalLabel, readonly CaptureSignal[]> = new Map(
  INSTRUMENTATION_ROW_ORDER.map((label) => [
    label,
    Object.freeze(CAPTURE_SIGNALS.filter((signal) => CAPTURE_SIGNAL_LABELS[signal] === label)),
  ]),
);

/**
 * The signals the installer actually enabled, read from every source that can
 * say so: the explicit list, the page-agent hook flags, the dev-server signal
 * set (a non-empty `functions` list is what enables function timing) and any
 * runtime hook named exactly by its signal. Runtime hooks named exactly by a
 * label are returned separately, because a label may stand for several signals
 * and choosing one would be a guess.
 */
function collectEnabled(installed: InstalledSignals): {
  readonly signals: ReadonlySet<CaptureSignal>;
  readonly labels: ReadonlySet<CaptureSignalLabel>;
} {
  const signals = new Set<CaptureSignal>();
  const labels = new Set<CaptureSignalLabel>();

  for (const signal of installed.signals ?? []) {
    if (isCaptureSignal(signal)) {
      signals.add(signal);
    }
  }

  const hooks = installed.hooks;

  if (hooks !== undefined) {
    for (const key of AGENT_HOOK_KEYS) {
      if (hooks[key] === true) {
        signals.add(key);
      }
    }
  }

  const serverSignals = installed.serverSignals;

  if (serverSignals !== undefined) {
    for (const key of SERVER_AGENT_SIGNAL_KEYS) {
      const value = serverSignals[key];

      if (value === true || (Array.isArray(value) && value.length > 0)) {
        signals.add(key);
      }
    }
  }

  for (const hook of installed.runtimeHooks ?? []) {
    if (isCaptureSignal(hook)) {
      signals.add(hook);
    } else if (isCaptureSignalLabel(hook)) {
      labels.add(hook);
    }
  }

  return { signals, labels };
}

/**
 * The display label of a signal named by an unavailable report: its label
 * when it is one of the twelve known signals, otherwise the reported name
 * itself (a third-party adapter's own signal), normalised.
 */
function labelForReportedSignal(signal: unknown): string {
  return isCaptureSignal(signal)
    ? CAPTURE_SIGNAL_LABELS[signal]
    : toDisplayText(signal, MAX_FINDING_TEXT_LENGTH);
}

/**
 * The AAP §0.5.5 failure row: `` `Could not enable ${label}: ${reason}.` ``,
 * with the adapter's hint as the detail. A reason that is blank after
 * normalisation leaves the sentence at `` `Could not enable ${label}.` ``; an
 * entry that does not even name its signal yields no row, since its failure
 * still reaches both user interfaces through `instrumentation.ready`.
 */
function unavailableRow(signal: unknown, reason: unknown, hint: unknown): ProgressRow | undefined {
  const label = labelForReportedSignal(signal);

  if (label.length === 0) {
    return undefined;
  }

  const because = toDisplayText(reason, READINESS_REASON_MAX_LENGTH).replace(
    TRAILING_PUNCTUATION_PATTERN,
    '',
  );
  const message =
    because.length === 0 ? `Could not enable ${label}.` : `Could not enable ${label}: ${because}.`;

  return makeRow('instrument', 'failed', message, toDisplayText(hint, READINESS_HINT_MAX_LENGTH));
}

/**
 * Builds the instrumentation stage's rows from what the installer actually
 * armed and what it could not.
 *
 * - **✓ rows** — one `done` row per enabled signal, mapped through
 *   {@link CAPTURE_SIGNAL_LABELS}, de-duplicated by label and ordered by
 *   {@link INSTRUMENTATION_ROW_ORDER}. Enablement is read from
 *   `signals`/`hooks`/`serverSignals`/`runtimeHooks` and never assumed. A
 *   signal reported unavailable — by an `unavailable` entry or by an
 *   `unavailable` readiness row — is withdrawn, so a ✓ is never shown beside
 *   its own ✗; a `degraded` readiness row keeps the ✓ and puts its reason in
 *   the detail.
 * - **✗ rows** — one `failed` row per `unavailable` entry, in input order, as
 *   AAP §0.5.5 words it (`` `Could not enable ${label}: ${reason}.` ``, the
 *   hint as detail), plus one per `unavailable` readiness row whose signal no
 *   entry already reported. Byte-identical rows are collapsed onto the first.
 *
 * When nothing at all could be enabled there are no ✓ rows; the caller
 * (`src/instrumentation/service.ts`) raises `instrumentation.failed`. Output is
 * bounded by {@link MAX_FINDING_ROWS_PER_STAGE} with failures granted spare
 * slots before successes, and is identical for identical input. All rows
 * belong to the `instrument` stage. The closing "Ready to capture" row is not
 * built here: it is emitted once readiness is satisfied, by
 * {@link SessionProgress.readyToCapture}.
 *
 * Pure, synchronous and I/O-free: no store, no transport, no clock, no logger.
 *
 * @param installed What the installer armed, and what it could not.
 * @returns The rows, frozen: ✓ rows first, then ✗ rows.
 */
export function buildInstrumentationRows(installed: InstalledSignals): readonly ProgressRow[] {
  const readinessRows = installed.readiness?.signals ?? [];
  const unavailable = installed.unavailable ?? [];

  const withdrawn = new Set<string>();

  for (const entry of unavailable) {
    withdrawn.add(entry.signal);
  }

  for (const row of readinessRows) {
    if (row.status === 'unavailable') {
      withdrawn.add(row.signal);
    }
  }

  const enabled = collectEnabled(installed);
  const enabledLabels = new Set<CaptureSignalLabel>();

  for (const signal of CAPTURE_SIGNALS) {
    if (enabled.signals.has(signal) && !withdrawn.has(signal)) {
      enabledLabels.add(CAPTURE_SIGNAL_LABELS[signal]);
    }
  }

  for (const label of enabled.labels) {
    if ((SIGNALS_BY_LABEL.get(label) ?? []).some((signal) => !withdrawn.has(signal))) {
      enabledLabels.add(label);
    }
  }

  const degradedReasons = new Map<CaptureSignalLabel, string>();

  for (const row of readinessRows) {
    const label = CAPTURE_SIGNAL_LABELS[row.signal];
    const reason = toDisplayText(row.reason, READINESS_REASON_MAX_LENGTH);

    if (
      row.status === 'degraded' &&
      enabledLabels.has(label) &&
      reason.length > 0 &&
      !degradedReasons.has(label)
    ) {
      degradedReasons.set(label, `Partially available: ${reason}`);
    }
  }

  const enabledRows = INSTRUMENTATION_ROW_ORDER.filter((label) => enabledLabels.has(label)).map(
    (label) => makeRow('instrument', 'done', label, degradedReasons.get(label)),
  );

  const failedRows: ProgressRow[] = [];
  const seenFailures = new Set<string>();
  const reported = new Set<string>();

  const pushFailure = (row: ProgressRow | undefined): void => {
    if (row === undefined) {
      return;
    }

    const key = `${row.message}\n${row.detail ?? ''}`;

    if (!seenFailures.has(key)) {
      seenFailures.add(key);
      failedRows.push(row);
    }
  };

  for (const entry of unavailable) {
    reported.add(entry.signal);
    pushFailure(unavailableRow(entry.signal, entry.reason, entry.hint));
  }

  for (const row of readinessRows) {
    if (row.status === 'unavailable' && !reported.has(row.signal)) {
      reported.add(row.signal);
      pushFailure(unavailableRow(row.signal, row.reason, row.hint));
    }
  }

  return boundStageRows('instrument', [enabledRows, failedRows], [1, 0]);
}

// ---------------------------------------------------------------------------
// Section G — the emitter
// ---------------------------------------------------------------------------

/**
 * The one transport capability this module needs: deliver a finished frame to
 * the clients of a session whose kind is listed.
 *
 * Deliberately the narrowest port that works. It is satisfied structurally by
 * the session manager's `SessionBroadcaster` (`./manager.ts`) and by the client
 * registry behind it (`apps/local-service/src/server/clients.ts`), neither of
 * which this module imports: the manager depends on this module — it applies
 * `stageFailed` as part of every transition into `failed` — so importing it back
 * would close a cycle, and the server layer sits above this folder. Declaring
 * the single method here is what keeps both edges pointing one way.
 */
export interface ProgressBroadcaster {
  /**
   * Sends `message` to every connected client of `sessionId` whose kind is in
   * `kinds`. Delivery is best effort and synchronous; a client that is offline
   * misses the frame and recovers it through the persisted replay — provided
   * the row was persisted. A row whose persistence failed is sent here all the
   * same, and a client that misses that frame never receives the row.
   */
  broadcastToKinds(
    sessionId: SessionId,
    kinds: readonly ClientKind[],
    message: ProtocolMessage,
  ): void;
}

/** Everything {@link createSessionProgress} is given; all of it is injected. */
export interface SessionProgressDeps {
  /** The session store's progress log — the only store method this module calls. */
  readonly sessions: Pick<SessionsRepo, 'appendProgress'>;
  /** Where finished `session.progress` frames go. */
  readonly broadcaster: ProgressBroadcaster;
  /**
   * The service logger; defaults to `noopLogger`. Wrapped by `guardLogger`, so
   * a logger that throws from any method or from `child()` never costs a row,
   * then bound to `subsystem: "sessions"`.
   */
  readonly logger?: Logger;
  /** The clock rows and frames are stamped with; defaults to `nowEpochMs`. */
  readonly now?: () => number;
  /**
   * Mints the diagnostic reference of one stage failure — shown in its row's
   * detail and carried by its two log records; defaults to `newMessageId`. A
   * generator that throws, or answers anything but a short identifier-like
   * token, is replaced by `newMessageId` for that failure.
   */
  readonly newRef?: () => string;
}

/**
 * The progress emitter of one service process.
 *
 * Every method validates, persists and broadcasts, and answers with a
 * `Result` — none throws. The asymmetry between the two failure kinds is
 * deliberate:
 *
 * - **A row the protocol schema rejects is a product bug** and returns `Err`:
 *   it is neither persisted nor broadcast, and it is logged at `error` with the
 *   issue paths only, never the rejected value.
 * - **A row the store cannot persist, or the transport cannot deliver, is a
 *   degraded success**: progress is advisory, so the failure is logged at `warn`
 *   and the method still returns `ok`. Persistence precedes the broadcast, so
 *   every row that was persisted is in the log before any client sees it and
 *   replays with the session. A persistence failure does not withhold the live
 *   row — it is still broadcast, best effort — but that row is absent from the
 *   log, so a replayed session lacks it even though a connected client saw it.
 *
 * None of these methods changes a session's status (see the module overview).
 */
export interface SessionProgress {
  /**
   * The core: addresses `row` to `sessionId`, validates it against protocol's
   * `session.progress` schema, appends it to the session's progress log and
   * broadcasts it to the session's editor and DevTools clients.
   *
   * @returns The payload as sent, or `Err` when the schema rejected it.
   */
  emit(sessionId: SessionId, row: ProgressRow): Result<SessionProgressPayload, DebuggenError>;

  /**
   * A stage's group header: a `running` row whose message defaults to the
   * stage's title in {@link PROGRESS_STAGE_TITLES}.
   */
  stageStarted(
    sessionId: SessionId,
    stage: ProgressStage,
    message?: string,
  ): Result<SessionProgressPayload, DebuggenError>;

  /**
   * A stage's closing `done` row; the message defaults to the stage's title, so
   * a stage that found nothing worth a row of its own still closes its group.
   */
  stageCompleted(
    sessionId: SessionId,
    stage: ProgressStage,
    message?: string,
  ): Result<SessionProgressPayload, DebuggenError>;

  /**
   * The `failed` row of the failing stage, projected onto public text.
   *
   * This row is how the failing stage reaches both user interfaces: protocol's
   * `SessionRecord` has no failure field, so the persisted `failed` progress row,
   * together with the `error` / `instrumentation.failed` message the caller
   * sends, is the carrier (AAP §0.5.5). `./manager.ts` emits it as part of every
   * transition into `failed`, which makes this method the single point every
   * stage failure — of any stage, the orchestrator, the manager or a route —
   * reaches a client through. The projection is therefore applied here, once:
   *
   * - **message** — `publicFailureCopy(failure.stage, failure.code).message`,
   *   e.g. `Generating debugging panel failed: Model provider unavailable
   *   (MODEL_UNAVAILABLE).` Never `failure.message`, which `DebuggenError.from`
   *   may have copied from an arbitrary exception quoting a path, a statement,
   *   a URL or a credential (CWE-209).
   * - **detail** — the failure's own hint when {@link isProductAuthoredText}
   *   proves it product text (a sentence of {@link FAILURE_COPY_BY_CODE}, or
   *   one a product builder registered through {@link authorProductText} when
   *   it composed it — such as the exact dev-server relaunch command AAP §0.5.5
   *   requires), else the code's default hint; then
   *   `(error code: ‹code›, ref: ‹ref›)`. Provenance is judged on the raw
   *   hint, before any display normalisation. A hint `DebuggenError.from`
   *   salvaged, or an adapter or dependency supplied, is never proven and is
   *   never shown. A code outside the closed vocabulary is shown, and worded,
   *   as `INTERNAL`.
   * - **ref** — one fresh diagnostic reference per call, from `deps.newRef`.
   *
   * The failure is logged locally twice under the same session, stage, code
   * and reference, so a developer can match the row to its diagnostic, and in
   * no other field than the error field:
   *
   * - at `warn`, {@link STAGE_FAILURE_LOG_MESSAGE}, whose error carries the
   *   code, the message (which the serializer withholds at that level) and
   *   the hint only when it was proven;
   * - at `debug`, {@link STAGE_FAILURE_DIAGNOSTIC_MESSAGE}, whose error carries
   *   the failure's own message and hint, emitted redacted by the service's
   *   error serializer when `debug` is enabled.
   *
   * Both go through the guarded logger, so neither can cost the row.
   *
   * @returns The payload as sent, or `Err` when the schema rejected the row.
   */
  stageFailed(
    sessionId: SessionId,
    failure: SessionFailure,
  ): Result<SessionProgressPayload, DebuggenError>;

  /** One `done` finding row, composed by the caller from what it found. */
  finding(
    sessionId: SessionId,
    stage: ProgressStage,
    message: string,
    detail?: string,
  ): Result<SessionProgressPayload, DebuggenError>;

  /**
   * Emits {@link buildInvestigationRows}' rows in order.
   *
   * @returns Every payload sent, or the first `Err` when any row was rejected —
   * the other rows are still emitted.
   */
  reportInvestigation(
    sessionId: SessionId,
    findings: InvestigationFindings,
  ): Result<readonly SessionProgressPayload[], DebuggenError>;

  /**
   * Emits {@link buildInstrumentationRows}' rows in order.
   *
   * @returns Every payload sent, or the first `Err` when any row was rejected —
   * the other rows are still emitted.
   */
  reportInstrumentation(
    sessionId: SessionId,
    installed: InstalledSignals,
  ): Result<readonly SessionProgressPayload[], DebuggenError>;

  /**
   * Closes the instrumentation stage once readiness is satisfied, in two rows:
   * first the stage's title row as `done` — exactly what
   * {@link SessionProgress.stageCompleted} emits for `instrument`, settling the
   * group header its `running` row opened — then
   * {@link READY_TO_CAPTURE_MESSAGE}, which stays the stage's last row.
   *
   * This is the instrument stage's only closing call: a caller does not also
   * call `stageCompleted` for it. The Ready row is emitted even when the header
   * row was rejected, because the developer's next step depends on it; that
   * rejection is logged by {@link SessionProgress.emit} and does not fail this
   * call.
   *
   * @returns The Ready row's payload as sent, or `Err` when the schema rejected
   * the Ready row.
   */
  readyToCapture(sessionId: SessionId): Result<SessionProgressPayload, DebuggenError>;
}

/**
 * The first line of a stage's header or closing row: the caller's message as
 * one line of display text when given, otherwise the stage's title. A message
 * that normalises to nothing stays empty and is refused by the schema, which is
 * the right answer to a caller that passed a blank line.
 */
function stageLine(stage: ProgressStage, message: string | undefined): string {
  return message === undefined
    ? PROGRESS_STAGE_TITLES[stage]
    : toDisplayText(message, MAX_MESSAGE_TEXT_LENGTH);
}

/**
 * A failure's code as its row may name it: the code itself when it is in the
 * closed `DEBUGGEN_ERROR_CODES` vocabulary, {@link UNKNOWN_FAILURE_CODE}
 * otherwise — the same fallback {@link publicFailureCopy} words it with, so a
 * row's message and its detail always agree on the code.
 */
function publicCodeOf(code: unknown): DebuggenErrorCode {
  return DEBUGGEN_ERROR_CODES.find((known) => known === code) ?? UNKNOWN_FAILURE_CODE;
}

/** The public text of one stage failure: exactly what its `failed` row shows. */
interface ProjectedFailure {
  /** The code the row names, from the closed vocabulary. */
  readonly code: DebuggenErrorCode;
  /**
   * Whose next step the detail shows: the failure's own hint, which is then
   * proven product text, or the code's default.
   */
  readonly hintSource: 'failure' | 'code';
  /** `‹stage title› failed: ‹summary›`, from {@link publicFailureCopy}. */
  readonly message: string;
  /** The next step, then `(error code: ‹code›, ref: ‹ref›)`. */
  readonly detail: string;
}

/**
 * Projects a stage failure onto the text its `failed` row may carry (see
 * {@link SessionProgress.stageFailed}).
 *
 * Pure apart from refreshing the provenance registry's recency.
 * `failure.message` is not read: the row's message is the fixed copy of the
 * failure's stage and code. The hint is the failure's own only when
 * {@link isProductAuthoredText} proves the raw value product text — the
 * stage's recovery step as a product builder composed it (a relaunch command,
 * a reload request) — and the code's default hint otherwise, however
 * plausible an unproven hint reads: a hint salvaged from an exception or
 * propagated from an adapter can quote a path, a statement or a URL. The
 * proof is taken on the raw value before any normalisation, because the
 * registry proves exact text and a normalised string is not what was
 * registered. The hint shown is clipped so that it and the suffix fit the
 * detail bound together, and the suffix — code and reference — is never the
 * part cut.
 *
 * @param failure The failure being filed.
 * @param ref The diagnostic reference minted for it.
 * @returns The row's code, message and detail.
 */
function projectFailure(failure: SessionFailure, ref: string): ProjectedFailure {
  const code = publicCodeOf(failure.code);
  const copy = publicFailureCopy(failure.stage, code);
  const suffix = `(error code: ${code}, ref: ${ref})`;
  const hintBound = Math.max(0, MAX_DETAIL_TEXT_LENGTH - suffix.length - 1);
  const stated = isProductAuthoredText(failure.hint) ? toDisplayText(failure.hint, hintBound) : '';
  const hint = stated.length > 0 ? stated : toDisplayText(copy.hint, hintBound);

  return {
    code,
    hintSource: stated.length > 0 ? 'failure' : 'code',
    message: toDisplayText(copy.message, MAX_MESSAGE_TEXT_LENGTH),
    detail: hint.length > 0 ? `${hint} ${suffix}` : suffix,
  };
}

/**
 * The failure as the error of one of its local log records: its closed code
 * and its own message, verbatim, and its hint when `withHint` admits it — the
 * only place those words go.
 *
 * The service's error serializer emits a `DebuggenError`'s message and hint
 * only in records written at `debug`/`trace`, redacted, and at every other
 * level keeps only its closed code and content-free details. The `warn` record
 * still passes `withHint` only for a hint {@link isProductAuthoredText} proved
 * — so the record holds no unproven text even under a logger that serializes
 * errors differently — and the `debug` diagnostic passes it always: an
 * unproven hint is treated as the free text it may be, exactly like the
 * message.
 *
 * A fresh `DebuggenError` rather than the value the caller caught, which is
 * not part of a `SessionFailure`; a message or hint of the wrong type at run
 * time is dropped rather than coerced, so no foreign `toString` is invoked.
 *
 * @param failure The failure being logged.
 * @param code The code its row names.
 * @param withHint Whether the failure's hint belongs in this record.
 * @returns The error for the record's {@link LOG_ERROR_FIELD_KEY} field.
 */
function failureDiagnostic(
  failure: SessionFailure,
  code: DebuggenErrorCode,
  withHint: boolean,
): DebuggenError {
  const message = typeof failure.message === 'string' ? failure.message : '';

  return withHint && typeof failure.hint === 'string'
    ? new DebuggenError(code, message, { hint: failure.hint })
    : new DebuggenError(code, message);
}

/**
 * Creates the progress emitter.
 *
 * @param deps The store, the broadcaster, and optionally a logger and a clock.
 * @returns The emitter; it holds no state beyond its dependencies.
 *
 * @example
 * ```ts
 * const progress = createSessionProgress({ sessions, broadcaster: clients, logger });
 *
 * progress.stageStarted(sessionId, 'investigate');
 * progress.reportInvestigation(sessionId, { components, eventHandlers, routes, relevantFiles });
 * progress.stageCompleted(sessionId, 'investigate');
 * ```
 */
export function createSessionProgress(deps: SessionProgressDeps): SessionProgress {
  const { sessions, broadcaster } = deps;
  const clock = deps.now ?? nowEpochMs;
  // Guarded before the child is derived, so neither the child's creation nor
  // any later call can throw: `emit` logs a persistence failure *before* it
  // broadcasts, and a throwing destination there would otherwise cost every
  // connected client the live row as well as the replay.
  const log = subsystemLogger(guardLogger(deps.logger ?? noopLogger), LOG_SUBSYSTEM);

  /**
   * One timestamp per row, shared by the stored line and the frame so a replay
   * carries the same time a live client saw. A clock that throws or answers
   * something other than a positive finite number is replaced by the wall
   * clock rather than allowed to fail the row.
   *
   * The replacement is a deliberate best-effort decision: an injected clock is
   * a test seam, and its failure must not cost the developer a progress row.
   * A throwing clock is recorded at `debug` by its closed exception class only
   * — never its message — so the decision stays visible without the log
   * becoming a channel for whatever the clock threw.
   */
  function stamp(): number {
    try {
      const value = clock();

      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    } catch (thrown) {
      log.debug('the injected progress clock failed; the row is stamped with the wall clock', {
        ...describeException(thrown),
      });
    }

    return nowEpochMs();
  }

  /**
   * The diagnostic reference of one stage failure: the injected generator's
   * answer when it is a short identifier-like token, a fresh message id
   * otherwise. Either replacement is logged at `debug` and never fails the row.
   */
  function diagnosticRef(): string {
    const generate = deps.newRef;

    if (generate === undefined) {
      return newMessageId();
    }

    let candidate: unknown;

    try {
      candidate = generate();
    } catch (thrown) {
      log.debug('the injected diagnostic-reference generator failed; a message id is used', {
        ...describeException(thrown),
      });

      return newMessageId();
    }

    if (typeof candidate === 'string' && DIAGNOSTIC_REF_PATTERN.test(candidate)) {
      return candidate;
    }

    log.debug('the injected diagnostic-reference generator answered an unusable reference', {
      referenceType: typeof candidate,
    });

    return newMessageId();
  }

  function emit(
    sessionId: SessionId,
    row: ProgressRow,
  ): Result<SessionProgressPayload, DebuggenError> {
    const candidate =
      row.detail === undefined
        ? { sessionId, stage: row.stage, status: row.status, message: row.message }
        : {
            sessionId,
            stage: row.stage,
            status: row.status,
            message: row.message,
            detail: row.detail,
          };

    const parsed = parseSessionProgressPayload(candidate);

    if (!parsed.ok) {
      log.error('a progress row was rejected by the session.progress schema and was not sent', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        code: parsed.error.code,
        issues: parsed.error.details,
      });

      return parsed;
    }

    const payload = parsed.value;
    const ts = stamp();
    const fields = {
      [LOG_BINDING_KEYS.sessionId]: payload.sessionId,
      stage: payload.stage,
      status: payload.status,
    };

    const stored = sessions.appendProgress(
      payload.detail === undefined
        ? {
            sessionId: payload.sessionId,
            stage: payload.stage,
            status: payload.status,
            message: payload.message,
            ts,
          }
        : {
            sessionId: payload.sessionId,
            stage: payload.stage,
            status: payload.status,
            message: payload.message,
            detail: payload.detail,
            ts,
          },
    );

    if (!stored.ok) {
      log.warn('a progress row could not be persisted; it is broadcast but will not replay', {
        ...fields,
        code: stored.error.code,
      });
    }

    try {
      broadcaster.broadcastToKinds(
        payload.sessionId,
        PROGRESS_RECIPIENT_KINDS,
        createEnvelope(MESSAGE_TYPE.SESSION_PROGRESS, payload, { ts }),
      );
    } catch (thrown) {
      log.warn('a progress row could not be broadcast; connected clients will see it on replay', {
        ...fields,
        code: DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED').code,
      });
    }

    log.debug('progress row sent', fields);

    return ok(payload);
  }

  function emitAll(
    sessionId: SessionId,
    rows: readonly ProgressRow[],
  ): Result<readonly SessionProgressPayload[], DebuggenError> {
    const payloads: SessionProgressPayload[] = [];
    let firstError: DebuggenError | undefined;

    for (const row of rows) {
      const sent = emit(sessionId, row);

      if (sent.ok) {
        payloads.push(sent.value);
      } else {
        firstError ??= sent.error;
      }
    }

    return firstError === undefined ? ok(Object.freeze(payloads)) : err(firstError);
  }

  return Object.freeze({
    emit,

    stageStarted(sessionId: SessionId, stage: ProgressStage, message?: string) {
      return emit(sessionId, makeRow(stage, 'running', stageLine(stage, message)));
    },

    stageCompleted(sessionId: SessionId, stage: ProgressStage, message?: string) {
      return emit(sessionId, makeRow(stage, 'done', stageLine(stage, message)));
    },

    stageFailed(sessionId: SessionId, failure: SessionFailure) {
      const ref = diagnosticRef();
      const projected = projectFailure(failure, ref);
      const sent = emit(
        sessionId,
        makeRow(failure.stage, 'failed', projected.message, projected.detail),
      );

      // The failure's own words — possibly an exception's message, or a hint
      // an adapter supplied, quoting a path, a statement or a credential —
      // travel only as the error field of these two local records, under the
      // reference the row shows. The `warn` record is written at the default
      // level, so it carries a hint only when the projection proved it; the
      // `debug` twin carries the message and the hint as the failure stated
      // them, which the service's serializer emits redacted at that level
      // alone. Both calls go through the guarded logger and cannot throw.
      const identity = {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        ...(Object.hasOwn(PROGRESS_STAGE_TITLES, failure.stage) ? { stage: failure.stage } : {}),
        code: projected.code,
        ref,
      };

      log.warn(STAGE_FAILURE_LOG_MESSAGE, {
        ...identity,
        hintSource: projected.hintSource,
        rowSent: sent.ok,
        [LOG_ERROR_FIELD_KEY]: failureDiagnostic(
          failure,
          projected.code,
          projected.hintSource === 'failure',
        ),
      });
      log.debug(STAGE_FAILURE_DIAGNOSTIC_MESSAGE, {
        ...identity,
        [LOG_ERROR_FIELD_KEY]: failureDiagnostic(failure, projected.code, true),
      });

      return sent;
    },

    finding(sessionId: SessionId, stage: ProgressStage, message: string, detail?: string) {
      return emit(
        sessionId,
        makeRow(
          stage,
          'done',
          toDisplayText(message, MAX_MESSAGE_TEXT_LENGTH),
          detail === undefined ? undefined : toDisplayText(detail, MAX_DETAIL_TEXT_LENGTH),
        ),
      );
    },

    reportInvestigation(sessionId: SessionId, findings: InvestigationFindings) {
      return emitAll(sessionId, buildInvestigationRows(findings));
    },

    reportInstrumentation(sessionId: SessionId, installed: InstalledSignals) {
      return emitAll(sessionId, buildInstrumentationRows(installed));
    },

    readyToCapture(sessionId: SessionId) {
      // Settle the stage's group header first, so the Ready row stays the
      // stage's last. Its result is deliberately not returned: `emit` has
      // already logged a rejection, and the Ready row is sent regardless.
      emit(sessionId, makeRow('instrument', 'done', PROGRESS_STAGE_TITLES.instrument));

      return emit(sessionId, makeRow('instrument', 'done', READY_TO_CAPTURE_MESSAGE));
    },
  } satisfies SessionProgress);
}
