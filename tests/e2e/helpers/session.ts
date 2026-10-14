/**
 * The workflow driver of the `e2e` suite: one call takes a debugging question
 * and a spec-owned interaction through the REAL pipeline — create, bind,
 * select, get ready, capture, analyse, generate — and answers with a
 * fully-populated {@link DebugSessionOutcome}. Ordering, synchronisation and
 * teardown live here once, so no spec re-derives the pipeline.
 *
 * ## The three rules this module never bends
 *
 * 1. **It installs nothing and fakes nothing.** The product plans and
 *    installs the instrumentation; this module observes
 *    `instrumentation.plan` / `instrumentation.ready` and reports what
 *    happened. It never sends a protocol frame itself — the panel's DevTools
 *    page sends `session.bind`, the service worker sends `target.selected` —
 *    and every HTTP call goes through `./service`, every DOM interaction
 *    through `./chrome`.
 * 2. **It never sleeps.** Every wait is driven by protocol frames recorded on
 *    the editor connection (`EditorClientHandle.next`, bounded by a named
 *    budget from {@link SessionTimeouts}) or by `expect.poll`. The only
 *    wall-clock time spent on the caller's behalf is the `interact` callback,
 *    which the spec owns.
 * 3. **A failure always names the stage.** Every failure is a
 *    {@link SessionWorkflowError} whose message carries the phase, the elapsed
 *    time, the session status last seen, the last three `session.progress`
 *    rows, the message TYPES received since the phase began and every `error`
 *    / `instrumentation.failed` payload the session produced — so "flaky" and
 *    "the plan stage rejected the model output" read differently in a report.
 *
 * ## How the stream is read
 *
 * The service broadcasts `session.progress`, `instrumentation.plan` and even
 * `instrumentation.ready` faster than a spec can subscribe, so the driver takes
 * `editorClient.snapshotIndex()` BEFORE it creates the session and consumes the
 * recording from that mark with a private recorder. Every later wait is scoped
 * to an index taken before the action it waits on — the buffer is never
 * cleared mid-session.
 *
 * `GET /sessions/:id` is also the reopen route: whoever calls it (this module,
 * the tracker, a spec) makes the service replay the stored record, the stored
 * `session.progress` rows with their original stamps, the latest
 * `analysis.completed` and the latest `panel.generated` to every client of the
 * session (`apps/local-service/src/sessions/reopen.ts`). The recorder
 * recognises that replay rather than recording it twice: a progress row
 * stamped before the operation began, or re-sent inside a replay burst (it
 * opens with a `session.updated` carrying no newer record), is history; an
 * analysis or panel whose id was already seen is the same artifact again.
 *
 * ## What the service says, and how each remediation is recognised
 *
 * The readiness gate (`apps/local-service/src/instrumentation/readiness.ts`,
 * not importable from `tests/**`) publishes no structured remediation on the
 * wire, so each one is recognised by the frames it produces:
 *
 * - **bind-tab** — the session's binding is lost (`session.bound` naming this
 *   session with reason `replaced`, `origin-changed` or `unbound`): the tab is
 *   re-announced once through the panel's DevTools page.
 * - **reload-page** — the `instrument` stage's `running` row asking for a
 *   reload (recognised by stage, status and the verb, exactly as
 *   `tests/browser/telemetry-capture.spec.ts` does, because the wording is the
 *   readiness module's). It is honoured at most once: the service asks at most
 *   once per document.
 * - **relaunch-dev-server** — `instrumentation.ready` reporting a server-only
 *   capture signal unavailable. Its `hint` is the service's relaunch
 *   instruction and is quoted verbatim; the fix is a setup change a spec cannot
 *   make, so the driver fails at once unless the caller opted into
 *   `allowMissingServerAgent`.
 *
 * Any other `unavailable` entry is a legitimate degraded capture, in which the
 * product proceeds with the signals it could enable. It is kept in the outcome
 * and the spec decides whether it is acceptable.
 *
 * This file declares no `test(...)`, `describe(...)` or fixture:
 * `tests/e2e/helpers/fixtures.ts` wires {@link createSessionTracker} into
 * teardown.
 *
 * @module tests/e2e/helpers/session
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  BROWSER_CAPTURE_SIGNALS,
  SERVER_CAPTURE_SIGNALS,
  selectedTargetSchema,
} from '@debuggen/instrumentation/schema';
import type {
  AnalysisResult,
  CaptureSignal,
  CaptureSummary,
  CleanupStatus,
  InstrumentationPlan,
  ModificationRecord,
  PanelNodeType,
  PanelSpec,
  ProgressStage,
  ProgressStatus,
  ProtocolMessage,
  SelectedTarget,
  SessionBoundPayload,
  SessionProgressPayload,
  SessionRecord,
  SessionStatus,
  UnavailableSignalPayload,
} from '@debuggen/protocol';

import { expectValidPanelSpec, nodeTypesOf, visualizationNodeTypesOf } from './assertions';
import { describeSelection, selectTarget, tabIdForPage } from './chrome';
import type { PanelConnectionStatus, PanelHandle, TargetSelectionRoute } from './chrome';
import { CaptureConflictError, POLL_INTERVALS_MS, ServiceCallError } from './service';
import type { EditorClientHandle, ServiceHandle } from './service';

// ---------------------------------------------------------------------------
// Budgets — named once, sized for the deterministic provider
// ---------------------------------------------------------------------------

/**
 * The named budget of every wait this module performs, in milliseconds.
 *
 * Each budget bounds the wait for a protocol frame, never a pause: a wait ends
 * the moment its frame is recorded. The defaults ({@link DEFAULT_SESSION_TIMEOUTS})
 * are sized for `DEBUGGEN_PROVIDER=deterministic`, which every automated run
 * uses; a caller running a slower provider or a colder host overrides the
 * members it needs through `timeouts`.
 */
export interface SessionTimeouts {
  /** The panel re-announcing the tab and the service answering `session.bound`. */
  readonly bind: number;
  /**
   * The pipeline reaching `ready`: understand → investigate (the first code
   * index of the project) → plan → install → the readiness gate, plus at most
   * one page reload and one re-bind.
   */
  readonly ready: number;
  /** `capture.start` answering and `capture.started` arriving. */
  readonly captureStart: number;
  /** `capture.stop` answering, `capture.stopped` arriving and the session leaving `capturing`. */
  readonly captureStop: number;
  /** Stage 5 — `analysis.completed` after the capture window closed. */
  readonly analysis: number;
  /** Stage 6 — `panel.generated`, then the guarded `analyzing → generated` edge. */
  readonly panel: number;
  /** One `POST /sessions/:id/end`, cleanup included, retried while an operation is still settling. */
  readonly end: number;
  /** A follow-up question being recorded and the service choosing its path. */
  readonly followUp: number;
}

/**
 * The default budgets.
 *
 * - `bind` 20 s — a DevTools-page reload (itself bounded by `./chrome`'s
 *   readiness budgets) plus one WebSocket round trip.
 * - `ready` 90 s — dominated by the first ts-morph index of the project; the
 *   deterministic model stages are milliseconds each.
 * - `captureStart` 15 s, `captureStop` 30 s — HTTP answers plus their
 *   broadcasts; stopping also summarises the capture.
 * - `analysis` 60 s, `panel` 60 s — aggregate queries over a capture of up to
 *   a few thousand events and the panel's semantic validation.
 * - `end` 60 s — cleanup restores every patched file and verifies hashes.
 * - `followUp` 30 s — the follow-up stage's decision.
 */
export const DEFAULT_SESSION_TIMEOUTS: Readonly<SessionTimeouts> = Object.freeze({
  bind: 20_000,
  ready: 90_000,
  captureStart: 15_000,
  captureStop: 30_000,
  analysis: 60_000,
  panel: 60_000,
  end: 60_000,
  followUp: 30_000,
});

/** The ceiling on any one budget: a typo of three zeros must not turn a wait into an hour. */
const MAX_BUDGET_MS = 30 * 60_000;

/** How many progress rows a failure message quotes. */
const QUOTED_PROGRESS_ROWS = 3;

/** How many error payloads a failure message quotes. */
const QUOTED_ERRORS = 5;

/** How many characters of one service-composed sentence a failure message prints. */
const MAX_QUOTED_TEXT = 400;

/**
 * The verb the readiness gate's reload request always contains. The sentence
 * itself is owned by the service's readiness module, which `tests/**` cannot
 * import, so the row is recognised by stage, status and this verb — the same
 * rule `tests/browser/telemetry-capture.spec.ts` applies.
 */
const RELOAD_REQUEST_VERB = /\breload\b/i;

/** The progress stage the readiness gate files its reload request under. */
const INSTRUMENT_STAGE: ProgressStage = 'instrument';

/** The progress stage whose closing row carries the empty-capture sentence. */
const CAPTURE_STAGE: ProgressStage = 'capture';

/** The capture-start refusal code the readiness gate uses for a missing dev-server preload. */
const SERVER_AGENT_NOT_READY_CODE = 'SERVER_AGENT_NOT_READY';

/** The refusal code of a session route answered while another operation is still settling. */
const SESSION_INVALID_STATE_CODE = 'SESSION_INVALID_STATE';

/** The refusal code of an unknown session. */
const SESSION_NOT_FOUND_CODE = 'SESSION_NOT_FOUND';

/**
 * The patch-based server signal: function timing is applied by the installer
 * and can be reported unavailable for reasons unrelated to the preload (an
 * unpatchable symbol), so it alone never implies a missing preload. Typed
 * against the schema's vocabulary, so a renamed signal fails to compile here.
 */
const PATCH_BASED_SIGNALS: ReadonlySet<CaptureSignal> = new Set([
  'functions',
] as const satisfies readonly CaptureSignal[]);

/**
 * The capture signals only the dev-server preload's tracer delivers: the
 * server vocabulary minus every signal the page agent also carries and minus
 * the patch-based one. Derived from the instrumentation schema's own tuples.
 */
const SERVER_ONLY_SIGNALS: ReadonlySet<string> = new Set<string>(
  SERVER_CAPTURE_SIGNALS.filter(
    (signal: CaptureSignal) =>
      !(BROWSER_CAPTURE_SIGNALS as readonly CaptureSignal[]).includes(signal) &&
      !PATCH_BASED_SIGNALS.has(signal),
  ),
);

/** The `session.bound` reasons that end this session's binding of its tab. */
const BINDING_LOSS_REASONS: ReadonlySet<string> = new Set([
  'replaced',
  'origin-changed',
  'unbound',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One `session.progress` row, recorded verbatim in arrival order. The prose is
 * the service's, composed from real findings (`docs/ARCHITECTURE.md`, "Progress
 * from real findings"); nothing here re-authors a stage name or a message.
 */
export interface SessionStageRecord {
  /** The reporting stage, protocol's vocabulary. */
  readonly stage: ProgressStage;
  /** `running`, `done` or `failed`. */
  readonly status: ProgressStatus;
  /** The service's line, verbatim. */
  readonly message: string;
  /** The service's second line, verbatim, when it sent one. */
  readonly detail?: string;
  /** When the editor connection received the row (epoch milliseconds). */
  readonly at: number;
  /** The row's absolute position in the editor client's recording. */
  readonly index: number;
}

/** One failure the service reported for the session: an `error` frame or an `instrumentation.failed` payload. */
export interface SessionErrorRecord {
  /** The protocol error code. */
  readonly code: string;
  /** The service's message, verbatim. */
  readonly message: string;
  /** The recovery step, when the frame carried one. */
  readonly hint?: string;
  /** Which frame reported it. */
  readonly source: 'error' | 'instrumentation.failed';
  /** When the editor connection received it (epoch milliseconds). */
  readonly at: number;
}

/** The three fields of the latest `instrumentation.ready`, exactly as the service sent them. */
export interface InstrumentationSnapshot {
  /** The file modifications the installer applied (function-timing patches). */
  readonly applied: readonly ModificationRecord[];
  /** The runtime hooks that came up. */
  readonly runtimeHooks: readonly string[];
  /** The signals that did not: a degraded capture when non-empty. */
  readonly unavailable: readonly UnavailableSignalPayload[];
}

/**
 * How the session reached `ready`:
 *
 * - `direct` — no reload was requested (the normal case: the page was
 *   navigated after the persistent context existed, so the MAIN-world agent
 *   ran at `document_start`);
 * - `reload-consented` — the service asked for a reload and the tab's
 *   document was replaced without this module reloading it (the service
 *   worker's consented `chrome.tabs.reload`);
 * - `reload-page-fallback` — the service asked for a reload and this module
 *   performed the developer's reload with `appPage.reload()`.
 */
export type ReadinessRoute = 'direct' | 'reload-consented' | 'reload-page-fallback';

/**
 * Which follow-up path the service took (`docs/ARCHITECTURE.md`, "Follow-ups"),
 * as observed from its status choreography.
 */
export type FollowUpPath = 'existing-evidence' | 'new-capture';

/** The phases a workflow moves through; every failure names one. */
export type SessionPhase =
  | 'create'
  | 'bind'
  | 'target'
  | 'ready'
  | 'captureStart'
  | 'interact'
  | 'captureStop'
  | 'analysis'
  | 'panel'
  | 'finalize'
  | 'followUp';

/** Everything one workflow observed, populated from real frames and real HTTP answers only. */
export interface DebugSessionOutcome {
  /** The session's id. */
  readonly sessionId: string;
  /** The final record (`GET /sessions/:id` after the panel was generated). */
  readonly session: SessionRecord;
  /** Every status observed, in order (consecutive repeats collapsed). */
  readonly statuses: readonly SessionStatus[];
  /** Every `session.progress` row, in arrival order. */
  readonly stages: readonly SessionStageRecord[];
  /** The latest `instrumentation.plan`, or `undefined` when none arrived. */
  readonly plan: InstrumentationPlan | undefined;
  /** The latest `instrumentation.ready`, or `undefined` when none arrived. */
  readonly instrumentation: InstrumentationSnapshot | undefined;
  /** The capture that answered the question. */
  readonly captureId: string | undefined;
  /** That capture's summary, as `capture.stopped` carried it. */
  readonly captureSummary: CaptureSummary | undefined;
  /** The validated analysis `analysis.completed` carried. */
  readonly analysis: AnalysisResult | undefined;
  /** The id `panel.generated` carried. */
  readonly panelId: string | undefined;
  /** The validated panel specification `panel.generated` carried. */
  readonly panel: PanelSpec | undefined;
  /** The session's modification journal (`GET /sessions/:id/modifications`), in application order. */
  readonly modifications: readonly ModificationRecord[];
  /** How the session reached `ready`. */
  readonly readinessRoute: ReadinessRoute;
  /** The tab binding `session.bound` established. */
  readonly boundTab: { readonly tabId: number; readonly url: string } | undefined;
  /** The target the session was asked about: passed in, or selected through the product. */
  readonly target: SelectedTarget | undefined;
  /** Every `error` / `instrumentation.failed` the session produced. */
  readonly errors: readonly SessionErrorRecord[];
  /** Coarse per-phase durations in milliseconds (`total` included), for the report. */
  readonly timings: Record<string, number>;
  /** The follow-up path this outcome answered, or `undefined` for the initial question. */
  readonly followUpPath: FollowUpPath | undefined;
}

/** What the spec's interaction receives: the page to drive, the panel, and the open capture. */
export interface SessionInteractionContext {
  /** The application page — the panel's inspected tab. */
  readonly appPage: Page;
  /** The DevTools surface of that tab. */
  readonly panel: PanelHandle;
  /** The capture window the interaction runs inside. */
  readonly captureId: string;
}

/** The spec-owned reproduction step; with {@link SessionPreparation}, the only place this module spends wall-clock time. */
export type SessionInteraction = (context: SessionInteractionContext) => Promise<void>;

/** What a {@link RunDebugSessionOptions.beforeCapture} step reaches: the ready session's page and panel. */
export interface SessionPreparationContext {
  /** The application page — the panel's inspected tab. */
  readonly appPage: Page;
  /** The DevTools surface of that tab. */
  readonly panel: PanelHandle;
}

/** A spec-owned step between "Ready to capture" and `capture.start`. */
export type SessionPreparation = (context: SessionPreparationContext) => Promise<void>;

/** A target given as a CSS selector of the application page, selected through the product. */
export interface SelectorTarget {
  /** The element to select (its first match becomes `$0`). */
  readonly selector: string;
}

/** Options of {@link runDebugSession}. */
export interface RunDebugSessionOptions {
  /** The service handle (`./service`). */
  readonly service: ServiceHandle;
  /** The recording editor connection; it must announce a folder containing `projectRoot`. */
  readonly editorClient: EditorClientHandle;
  /** The absolute project root the session debugs (the demo, or a copy of the fixture app). */
  readonly projectRoot: string;
  /** The developer's question, verbatim. */
  readonly question: string;
  /** The DevTools surface of `appPage`'s tab (`./chrome`'s `openPanelPage`), already paired. */
  readonly panel: PanelHandle;
  /** The application page, navigated to the project's dev server. */
  readonly appPage: Page;
  /**
   * The element the question is about: a pre-built `SelectedTarget` is sent
   * with `session.create`; a `{ selector }` is selected through the product
   * after the tab is bound (`./chrome`'s `selectTarget`).
   */
  readonly target?: SelectedTarget | SelectorTarget | undefined;
  /** Reproduces the issue while the capture is open. */
  readonly interact: SessionInteraction;
  /** Registers the session the moment it exists, so teardown ends it whatever happens. */
  readonly tracker?: SessionTracker | undefined;
  /** Budgets overriding {@link DEFAULT_SESSION_TIMEOUTS}. */
  readonly timeouts?: Partial<SessionTimeouts> | undefined;
  /** Force one selection route instead of preferring `devtools-eval`. */
  readonly selectTargetVia?: TargetSelectionRoute | undefined;
  /**
   * Point at a `{ selector }` target *before* asking, as a developer who
   * selects an element and then asks about it does. The DevTools
   * page describes `$0` through the product (`./chrome`'s `describeSelection`)
   * while no session exists, until the descriptor carries the element's React
   * owner chain; `session.create` carries that descriptor — the editor's
   * pending target — so problem understanding (Stage 1) reads it. Once the
   * session is ready the element is selected through the product again, so
   * `target.selected` runs for the live session and must record the same
   * element with its owner chain. `false` by default: the selector is then
   * selected after the tab is bound only, which is after Stage 1 has already
   * started.
   */
  readonly selectBeforeQuestion?: boolean | undefined;
  /**
   * Accept a deterministic fallback panel (`meta.fallback`). `false` by
   * default: a fallback proves the failure path, not an answer.
   */
  readonly allowFallbackPanel?: boolean | undefined;
  /**
   * Continue when `instrumentation.ready` reports a server-only signal
   * unavailable (no dev-server preload). `false` by default: the driver fails
   * with the service's relaunch instruction verbatim. A spec that exercises
   * that degradation deliberately opts in.
   */
  readonly allowMissingServerAgent?: boolean | undefined;
  /**
   * Runs once the session is ready and before `capture.start`: the pause a
   * developer takes between "Ready to capture" and pressing Start capture.
   * Installing a plan that patches a client module can make the dev server's
   * Fast Refresh reload the page on its own, a moment after the session turns
   * ready; a reproduction started within milliseconds of readiness would
   * capture the outgoing, uninstrumented document's traffic alongside the
   * instrumented one's. Absent by default. A throw fails the `ready` phase.
   */
  readonly beforeCapture?: SessionPreparation | undefined;
}

/** Options of {@link askFollowUp}. */
export interface AskFollowUpOptions {
  /** The service handle. */
  readonly service: ServiceHandle;
  /** The recording editor connection the first run used (or another one following the session). */
  readonly editorClient: EditorClientHandle;
  /** The outcome of {@link runDebugSession} (or of a previous follow-up). */
  readonly outcome: DebugSessionOutcome;
  /** The follow-up question, verbatim. */
  readonly question: string;
  /**
   * Reproduces the issue again, required when the service takes the
   * new-capture path; the driver fails clearly when it is needed but absent.
   */
  readonly interact?: SessionInteraction | undefined;
  /** Budgets overriding the ones the first run used. */
  readonly timeouts?: Partial<SessionTimeouts> | undefined;
  /** The application page; defaults to the one the outcome's run used. */
  readonly appPage?: Page | undefined;
  /** The panel; defaults to the one the outcome's run used. */
  readonly panel?: PanelHandle | undefined;
  /** Accept a fallback panel; defaults to the outcome's run setting. */
  readonly allowFallbackPanel?: boolean | undefined;
  /** Tolerate a missing dev-server preload; defaults to the outcome's run setting. */
  readonly allowMissingServerAgent?: boolean | undefined;
}

/** Why a workflow failed; the message says the rest. */
export type SessionFailureCode =
  | 'invalid-options'
  | 'service-refused'
  | 'timeout'
  | 'session-failed'
  | 'session-ended'
  | 'instrumentation-failed'
  | 'relaunch-required'
  | 'reload-ineffective'
  | 'binding-lost'
  | 'bound-elsewhere'
  | 'capture-conflict'
  | 'empty-capture'
  | 'interaction-failed'
  | 'interaction-required'
  | 'target-selection-failed'
  | 'invalid-panel'
  | 'no-progression'
  | 'editor-closed'
  | 'unexpected-state';

/** The facts a {@link SessionWorkflowError} carries besides its message. */
export interface SessionWorkflowErrorInit {
  readonly phase: SessionPhase;
  readonly code: SessionFailureCode;
  readonly message: string;
  readonly sessionId?: string | undefined;
  readonly lastStatus?: SessionStatus | undefined;
  readonly elapsedMs?: number | undefined;
  readonly owningSessionId?: string | undefined;
  readonly hint?: string | undefined;
  readonly cause?: unknown;
}

/**
 * A workflow failure. The message is the complete diagnosis (phase, elapsed
 * time, status, recent progress, message types, errors); the fields let a spec
 * that forces a failure path assert which one it hit.
 */
export class SessionWorkflowError extends Error {
  /** The phase that failed. */
  readonly phase: SessionPhase;
  /** Why. */
  readonly code: SessionFailureCode;
  /** The session, once it exists. */
  readonly sessionId: string | undefined;
  /** The session status last seen. */
  readonly lastStatus: SessionStatus | undefined;
  /** How long the phase had run. */
  readonly elapsedMs: number;
  /** The session holding the project's capture, for `capture-conflict`. */
  readonly owningSessionId: string | undefined;
  /** The service's own recovery instruction, verbatim, when it gave one. */
  readonly hint: string | undefined;

  constructor(init: SessionWorkflowErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'SessionWorkflowError';
    this.phase = init.phase;
    this.code = init.code;
    this.sessionId = init.sessionId;
    this.lastStatus = init.lastStatus;
    this.elapsedMs = init.elapsedMs ?? 0;
    this.owningSessionId = init.owningSessionId;
    this.hint = init.hint;
  }
}

// ---------------------------------------------------------------------------
// Small total helpers
// ---------------------------------------------------------------------------

/** One line of at most `max` characters, whitespace runs collapsed. */
function clip(text: string, max: number = MAX_QUOTED_TEXT): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** A thrown value as one bounded line. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return clip(`${error.name}: ${error.message}`, 2 * MAX_QUOTED_TEXT);
  }
  return clip(String(error));
}

/** Whether two URLs name the same document, ignoring query and fragment (the service redacts query values). */
function sameDocument(expected: string, actual: string): boolean {
  try {
    const a = new URL(expected);
    const b = new URL(actual);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/** `type×count` pairs in first-arrival order — types only, never payloads. */
function describeTypes(rows: readonly { readonly type: string; readonly count: number }[]): string {
  return rows.length === 0
    ? 'none'
    : rows.map((row) => `${row.type}×${String(row.count)}`).join(', ');
}

/** A `session.bound` frame that establishes a binding (no reason, or `bound`). */
function isEstablishment(payload: SessionBoundPayload): boolean {
  return payload.reason === undefined || payload.reason === 'bound';
}

/** The running Playwright test, or `undefined` outside one (teardown of a worker fixture). */
function currentTestInfo(): ReturnType<typeof test.info> | undefined {
  try {
    return test.info();
  } catch {
    return undefined;
  }
}

/** A progress row as one bounded line. */
function describeStage(row: SessionStageRecord): string {
  const detail = row.detail === undefined || row.detail === '' ? '' : ` — ${clip(row.detail)}`;
  return `${row.stage}/${row.status}: ${clip(row.message)}${detail}`;
}

/** An error record as one bounded line. */
function describeErrorRecord(record: SessionErrorRecord): string {
  const hint = record.hint === undefined ? '' : ` — hint: ${clip(record.hint)}`;
  return `[${record.source}] ${record.code}: ${clip(record.message)}${hint}`;
}

/**
 * A validated, bounded copy of the caller's budgets over the defaults.
 *
 * @param invalid Builds the error for an out-of-range budget, so each entry
 *   point names itself (and its phase) in the refusal.
 */
function resolveTimeouts(
  base: Readonly<SessionTimeouts>,
  overrides: Partial<SessionTimeouts> | undefined,
  invalid: (message: string) => Error,
): Readonly<SessionTimeouts> {
  const merged: SessionTimeouts = { ...base, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > MAX_BUDGET_MS
    ) {
      throw invalid(
        `timeouts.${name} must be a positive number of milliseconds of at most ${String(MAX_BUDGET_MS)} (got ${String(value)}).`,
      );
    }
  }
  return Object.freeze(merged);
}

/** An option refusal of `phase`, named like every other failure of this module. */
function invalidOption(
  phase: SessionPhase,
  entryPoint: string,
  message: string,
  sessionId?: string,
): SessionWorkflowError {
  return new SessionWorkflowError({
    phase,
    code: 'invalid-options',
    message: `[${phase}] ${entryPoint}: ${message}`,
    sessionId,
  });
}

/** The counts an empty-capture failure quotes, read defensively from a summary that crossed a boundary. */
function describeCaptureCounts(summary: CaptureSummary | undefined): string {
  if (summary === undefined) {
    return 'no capture summary was returned';
  }
  const count = (value: unknown): string =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : '?';
  const tiers = summary.tierCounts as Partial<Record<string, unknown>> | undefined;
  const kinds = summary.kindCounts as Partial<Record<string, unknown>> | undefined;
  return [
    `events ${count(summary.eventCount)}`,
    `interactions ${count(kinds?.interaction)}`,
    `browser ${count(tiers?.browser)}`,
    `server ${count(tiers?.server)}`,
    `db ${count(tiers?.db)}`,
    `traces ${count(summary.traceCount)}`,
  ].join(', ');
}

// ---------------------------------------------------------------------------
// The recorder: one session's view of the editor connection's recording
// ---------------------------------------------------------------------------

/** A value with the absolute index and arrival time of the frame that carried it. */
interface Indexed<T> {
  readonly index: number;
  readonly at: number;
  readonly value: T;
}

/** One observed status, with where it was observed. */
interface ObservedStatus {
  readonly status: SessionStatus;
  readonly index: number;
  readonly at: number;
}

/** What the session's binding frames say about one tab, from a given index on. */
type BindingState =
  | { readonly kind: 'none' }
  | { readonly kind: 'bound'; readonly tabId: number; readonly url: string; readonly index: number }
  | { readonly kind: 'lost'; readonly reason: string; readonly index: number };

/** A same-origin navigation keeps a binding of `tabId` and records the document's new URL. */
function navigatedBinding(
  state: BindingState,
  payload: SessionBoundPayload,
  tabId: number,
): BindingState {
  return state.kind === 'bound' && payload.tabId === tabId ? { ...state, url: payload.url } : state;
}

/** What a recorder is told about the time before its mark, so a reopen replay of it is recognised. */
interface RecorderSeed {
  /** When the operation began (before its mark): progress stamped earlier is history. */
  readonly operationStartedAt: number;
  /** Analyses already known (the previous outcome's), which a replay re-sends. */
  readonly analysisIds?: readonly string[] | undefined;
  /** Panels already known (the previous outcome's), which a replay re-sends. */
  readonly panelIds?: readonly string[] | undefined;
}

/** The identity of one progress row: its stamp (a replay keeps it) and its content. */
function progressKey(ts: number, row: SessionProgressPayload): string {
  return JSON.stringify([ts, row.stage, row.status, row.message, row.detail ?? null]);
}

/**
 * Consumes the editor client's recording from a mark, keeping only what
 * concerns one session (plus the binding frames of every session, which is how
 * a tab bound elsewhere is noticed). It reads the recording and nothing else:
 * no subscription, no clearing, no frame sent. The service's reopen replay is
 * recognised and left out (see the module header).
 */
class SessionRecorder {
  readonly statuses: ObservedStatus[] = [];
  readonly stages: SessionStageRecord[] = [];
  readonly errors: SessionErrorRecord[] = [];
  readonly plans: Indexed<InstrumentationPlan>[] = [];
  readonly readies: Indexed<InstrumentationSnapshot>[] = [];
  readonly failures: Indexed<SessionErrorRecord>[] = [];
  readonly boundFrames: Indexed<SessionBoundPayload>[] = [];
  readonly capturesStarted: Indexed<string>[] = [];
  readonly capturesStopped: Indexed<{
    readonly captureId: string;
    readonly summary: CaptureSummary;
  }>[] = [];
  readonly analyses: Indexed<AnalysisResult>[] = [];
  readonly panels: Indexed<{ readonly panelId: string; readonly panel: PanelSpec }>[] = [];
  /** Frames between the mark and the first retained one, lost to the recording's retention cap. */
  unavailableFrames = 0;
  /** Frames recognised as the service's reopen replay and therefore not recorded. */
  replayedFrames = 0;
  private latestRecord: SessionRecord | undefined;
  private cursor: number;
  private readonly operationStartedAt: number;
  /** Live progress rows recorded, by {@link progressKey}, with their multiplicity. */
  private readonly liveProgress = new Map<string, number>();
  /** The newest stamp of a live progress row. */
  private newestProgressTs = Number.NEGATIVE_INFINITY;
  /** The rows matched so far by the replay burst in progress, if one is. */
  private burst: Map<string, number> | undefined;
  private readonly knownAnalyses: Set<string>;
  private readonly knownPanels: Set<string>;

  constructor(
    private readonly client: EditorClientHandle,
    readonly sessionId: string,
    sinceIndex: number,
    seed: RecorderSeed,
  ) {
    this.cursor = sinceIndex;
    this.operationStartedAt = seed.operationStartedAt;
    this.knownAnalyses = new Set(seed.analysisIds ?? []);
    this.knownPanels = new Set(seed.panelIds ?? []);
  }

  /** The latest record observed (by `updatedAt`), from a frame or an HTTP answer. */
  get session(): SessionRecord | undefined {
    return this.latestRecord;
  }

  /** The session's current status, as last observed. */
  get status(): SessionStatus | undefined {
    return this.latestRecord?.status;
  }

  /** The index the next recorded frame will get once drained. */
  get position(): number {
    return this.cursor;
  }

  /** Consume every frame recorded since the last drain. */
  drain(): void {
    for (const entry of this.client.entries({ sinceIndex: this.cursor })) {
      if (entry.index < this.cursor) {
        continue;
      }
      if (entry.index > this.cursor) {
        this.unavailableFrames += entry.index - this.cursor;
      }
      this.cursor = entry.index + 1;
      this.consume(entry.message, entry.index, entry.receivedAt);
    }
  }

  /**
   * Note a record the service answered over HTTP. It counts only when it is
   * newer than what the frames already said, so a late HTTP answer can never
   * reorder the statuses.
   */
  noteRecord(record: SessionRecord): void {
    this.drain();
    this.observeRecord(record, this.cursor, Date.now(), 'http');
  }

  /**
   * Take `record` when it is at least as new as the latest one. Answers
   * whether it carried a newer state, which is how a replay's opening
   * `session.updated` (the stored record again) is told from a live update.
   *
   * The service stamps `updatedAt` with millisecond resolution, so two
   * successive states can share a stamp. Frames arrive in the order the
   * service sent them, so a frame with an equal stamp and another status is
   * the later state; an HTTP answer with an equal stamp may have been read
   * before that frame was sent, so it never changes the status.
   */
  private observeRecord(
    record: SessionRecord,
    index: number,
    at: number,
    source: 'frame' | 'http',
  ): boolean {
    if (record.id !== this.sessionId) {
      return false;
    }
    const previous = this.latestRecord;
    if (previous !== undefined) {
      if (record.updatedAt < previous.updatedAt) {
        return false;
      }
      if (record.updatedAt === previous.updatedAt) {
        if (record.status === previous.status) {
          this.latestRecord = record;
        }
        if (record.status === previous.status || source === 'http') {
          return false;
        }
      }
    }
    this.latestRecord = record;
    if (this.statuses.at(-1)?.status !== record.status) {
      this.statuses.push({ status: record.status, index, at });
    }
    return true;
  }

  /**
   * Whether a progress row is the reopen replay re-sending history: stamped
   * before this operation began, or a row already recorded that is re-sent
   * inside a replay burst (each recorded occurrence matched once per burst),
   * or re-sent with an older stamp than a row already recorded.
   */
  private isReplayedProgress(key: string, ts: number): boolean {
    if (ts < this.operationStartedAt) {
      return true;
    }
    const live = this.liveProgress.get(key) ?? 0;
    if (live === 0) {
      return false;
    }
    if (this.burst !== undefined) {
      const matched = this.burst.get(key) ?? 0;
      if (matched < live) {
        this.burst.set(key, matched + 1);
        return true;
      }
      return false;
    }
    return ts < this.newestProgressTs;
  }

  private consume(message: ProtocolMessage, index: number, at: number): void {
    const own = this.sessionId;
    if (message.type !== 'session.progress' && message.type !== 'session.updated') {
      // A replay is delivered as one contiguous run: any other frame ends it.
      this.burst = undefined;
    }
    switch (message.type) {
      case 'session.created':
        this.observeRecord(message.payload.session, index, at, 'frame');
        return;
      case 'session.updated':
        if (message.payload.session.id === own) {
          // A frame carrying no newer record opens a reopen replay.
          this.burst = this.observeRecord(message.payload.session, index, at, 'frame')
            ? undefined
            : new Map();
        }
        return;
      case 'session.progress': {
        const row = message.payload;
        if (row.sessionId !== own) {
          return;
        }
        const key = progressKey(message.ts, row);
        if (this.isReplayedProgress(key, message.ts)) {
          this.replayedFrames += 1;
          return;
        }
        this.burst = undefined;
        this.liveProgress.set(key, (this.liveProgress.get(key) ?? 0) + 1);
        this.newestProgressTs = Math.max(this.newestProgressTs, message.ts);
        this.stages.push({
          stage: row.stage,
          status: row.status,
          message: row.message,
          ...(row.detail === undefined ? {} : { detail: row.detail }),
          at,
          index,
        });
        return;
      }
      case 'session.bound':
        this.boundFrames.push({ index, at, value: message.payload });
        return;
      case 'instrumentation.plan':
        if (message.payload.sessionId === own) {
          this.plans.push({ index, at, value: message.payload.plan });
        }
        return;
      case 'instrumentation.ready':
        if (message.payload.sessionId === own) {
          const { applied, runtimeHooks, unavailable } = message.payload;
          this.readies.push({ index, at, value: { applied, runtimeHooks, unavailable } });
        }
        return;
      case 'instrumentation.failed':
        if (message.payload.sessionId === own) {
          const { code, message: text, hint } = message.payload.error;
          const record: SessionErrorRecord = {
            code,
            message: text,
            hint,
            source: 'instrumentation.failed',
            at,
          };
          this.failures.push({ index, at, value: record });
          this.errors.push(record);
        }
        return;
      case 'capture.started':
        if (message.payload.sessionId === own) {
          this.capturesStarted.push({ index, at, value: message.payload.captureId });
        }
        return;
      case 'capture.stopped':
        if (message.payload.sessionId === own) {
          const { captureId, summary } = message.payload;
          this.capturesStopped.push({ index, at, value: { captureId, summary } });
        }
        return;
      case 'analysis.completed':
        if (message.payload.sessionId === own) {
          const { analysis } = message.payload;
          if (this.knownAnalyses.has(analysis.id)) {
            this.replayedFrames += 1;
            return;
          }
          this.knownAnalyses.add(analysis.id);
          this.analyses.push({ index, at, value: analysis });
        }
        return;
      case 'panel.generated':
        if (message.payload.sessionId === own) {
          const { panelId, panel } = message.payload;
          if (this.knownPanels.has(panelId)) {
            this.replayedFrames += 1;
            return;
          }
          this.knownPanels.add(panelId);
          this.panels.push({ index, at, value: { panelId, panel } });
        }
        return;
      case 'error':
        // An error frame scoped to this session, or to none: the editor
        // connection sends nothing of its own, so an unscoped error arriving
        // while this session runs is reported rather than swallowed.
        if (message.sessionId === undefined || message.sessionId === own) {
          const { code, message: text } = message.payload;
          this.errors.push({ code, message: text, source: 'error', at });
        }
        return;
      default:
        return;
    }
  }

  /** Every status observed at or after `index`, oldest first. */
  statusesSince(index: number): readonly ObservedStatus[] {
    return this.statuses.filter((entry) => entry.index >= index);
  }

  /** Every progress row at or after `index`. */
  stagesSince(index: number): readonly SessionStageRecord[] {
    return this.stages.filter((row) => row.index >= index);
  }

  /** The newest element of `list` recorded at or after `index`. */
  latestSince<T>(list: readonly Indexed<T>[], index: number): Indexed<T> | undefined {
    for (let position = list.length - 1; position >= 0; position -= 1) {
      const entry = list[position];
      if (entry !== undefined && entry.index >= index) {
        return entry;
      }
    }
    return undefined;
  }

  /** The oldest element of `list` recorded at or after `index` that satisfies `accept`. */
  firstSince<T>(
    list: readonly Indexed<T>[],
    index: number,
    accept: (value: T) => boolean = () => true,
  ): Indexed<T> | undefined {
    return list.find((entry) => entry.index >= index && accept(entry.value));
  }

  /**
   * What the binding frames naming this session say about `tabId` from
   * `index` on: the newest establishment or loss decides; `navigated` keeps a
   * binding and records its new URL.
   */
  bindingState(tabId: number, index: number): BindingState {
    let state: BindingState = { kind: 'none' };
    for (const frame of this.boundFrames) {
      const payload = frame.value;
      if (frame.index < index || payload.sessionId !== this.sessionId) {
        continue;
      }
      if (isEstablishment(payload)) {
        state =
          payload.tabId === tabId
            ? { kind: 'bound', tabId, url: payload.url, index: frame.index }
            : {
                kind: 'lost',
                reason: `the session was bound to tab ${String(payload.tabId)} instead`,
                index: frame.index,
              };
      } else if (payload.reason === 'navigated') {
        state = navigatedBinding(state, payload, tabId);
      } else if (payload.tabId === tabId && BINDING_LOSS_REASONS.has(payload.reason ?? '')) {
        state = { kind: 'lost', reason: payload.reason ?? 'unbound', index: frame.index };
      }
    }
    return state;
  }

  /** The newest establishment binding `tabId` to ANOTHER session at or after `index`. */
  boundElsewhere(tabId: number, index: number): SessionBoundPayload | undefined {
    for (let position = this.boundFrames.length - 1; position >= 0; position -= 1) {
      const frame = this.boundFrames[position];
      if (frame === undefined || frame.index < index) {
        break;
      }
      const payload = frame.value;
      if (payload.tabId !== tabId || !isEstablishment(payload)) {
        continue;
      }
      return payload.sessionId === this.sessionId ? undefined : payload;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The driver: phase clocks, bounded frame-driven waits, failure text
// ---------------------------------------------------------------------------

/** When a phase began: its name, the recording index and the wall-clock time. */
interface PhaseClock {
  readonly name: SessionPhase;
  readonly startIndex: number;
  readonly startedAt: number;
}

/** One bounded wait inside a phase. */
interface WaitSpec {
  readonly phase: PhaseClock;
  readonly budget: keyof SessionTimeouts;
  readonly budgetMs: number;
  readonly deadline: number;
  /** What is awaited, for the timeout text. */
  readonly what: string;
  /** Extra diagnostics read when the wait times out (the panel's pill, say). */
  readonly describeTimeout?: (() => Promise<readonly string[]>) | undefined;
}

/** What a failure adds besides its lead sentence. */
interface FailureExtras {
  readonly owningSessionId?: string | undefined;
  readonly hint?: string | undefined;
  readonly cause?: unknown;
  readonly notes?: readonly string[] | undefined;
}

/**
 * The per-operation machinery every step shares: the recorder, the budgets,
 * the timings, and the one way this module waits — drain the recording, check
 * that the session is still alive, test the condition, then wait for the next
 * recorded frame, never for a fixed time.
 */
class WorkflowDriver {
  readonly timings: Record<string, number> = {};

  constructor(
    readonly service: ServiceHandle,
    readonly client: EditorClientHandle,
    readonly recorder: SessionRecorder,
    readonly timeouts: Readonly<SessionTimeouts>,
    /** The index the fatal checks are scoped from: the operation's own mark. */
    readonly operationMark: number,
  ) {}

  get sessionId(): string {
    return this.recorder.sessionId;
  }

  /** Start a phase at the current end of the recording. */
  begin(name: SessionPhase): PhaseClock {
    this.recorder.drain();
    return { name, startIndex: this.client.snapshotIndex(), startedAt: Date.now() };
  }

  /** Close a phase, adding its duration to {@link timings}. */
  end(phase: PhaseClock): void {
    this.timings[phase.name] = (this.timings[phase.name] ?? 0) + (Date.now() - phase.startedAt);
  }

  /** A bounded wait on `budget`, starting now. */
  waitSpec(
    phase: PhaseClock,
    budget: keyof SessionTimeouts,
    what: string,
    describeTimeout?: () => Promise<readonly string[]>,
  ): WaitSpec {
    const budgetMs = this.timeouts[budget];
    return { phase, budget, budgetMs, deadline: Date.now() + budgetMs, what, describeTimeout };
  }

  /**
   * The failure of `phase`, carrying the diagnosis every failure of this
   * module carries: phase, elapsed time, status last seen, the last progress
   * rows, the message types since the phase began and the session's errors.
   */
  fail(
    phase: PhaseClock,
    code: SessionFailureCode,
    lead: string,
    extras: FailureExtras = {},
  ): SessionWorkflowError {
    this.recorder.drain();
    const elapsedMs = Date.now() - phase.startedAt;
    const status = this.recorder.status;
    const observed = this.recorder.statuses.map((entry) => entry.status);
    const rows = this.recorder.stages.slice(-QUOTED_PROGRESS_ROWS);
    const errors = this.recorder.errors;
    const quotedErrors = errors.slice(-QUOTED_ERRORS);
    const lines = [
      `[${phase.name}] session ${this.sessionId}: ${lead} (after ${String(elapsedMs)} ms in this phase)`,
      `  session status last seen: ${status ?? 'none observed'}; statuses observed: ${observed.length === 0 ? 'none' : observed.join(' → ')}`,
      `  last ${String(QUOTED_PROGRESS_ROWS)} session.progress rows:${rows.length === 0 ? ' none' : ''}`,
      ...rows.map((row) => `    - ${describeStage(row)}`),
      `  message types since the phase started: ${describeTypes(this.client.timeline({ sinceIndex: phase.startIndex }))}`,
      `  error / instrumentation.failed payloads for the session:${errors.length === 0 ? ' none' : ''}`,
      ...(errors.length > quotedErrors.length
        ? [`    (${String(errors.length - quotedErrors.length)} earlier omitted)`]
        : []),
      ...quotedErrors.map((record) => `    - ${describeErrorRecord(record)}`),
      ...(extras.hint === undefined
        ? []
        : [`  the service's instruction, verbatim: ${extras.hint}`]),
      ...(extras.notes ?? []).map((note) => `  ${note}`),
      ...(this.recorder.unavailableFrames > 0
        ? [
            `  ${String(this.recorder.unavailableFrames)} frame(s) of this session's window were no longer retained by the editor client (retention cap or clear()).`,
          ]
        : []),
      ...(this.recorder.replayedFrames > 0
        ? [
            `  ${String(this.recorder.replayedFrames)} frame(s) were the service's reopen replay (GET /sessions/:id re-sends stored progress, the latest analysis and the latest panel) and were not counted as new.`,
          ]
        : []),
    ];
    return new SessionWorkflowError({
      phase: phase.name,
      code,
      message: lines.join('\n'),
      sessionId: this.sessionId,
      lastStatus: status,
      elapsedMs,
      owningSessionId: extras.owningSessionId,
      hint: extras.hint,
      cause: extras.cause,
    });
  }

  /**
   * Throw when the session can no longer make progress: the service reported
   * `instrumentation.failed`, filed the session `failed` (naming the stage from
   * its own `failed` row), or the session ended under the wait.
   */
  assertLive(phase: PhaseClock): void {
    const failure = this.recorder.latestSince(this.recorder.failures, this.operationMark);
    if (failure !== undefined) {
      throw this.fail(
        phase,
        'instrumentation-failed',
        `the service reported instrumentation.failed — ${failure.value.code}: ${clip(failure.value.message)}`,
        { hint: failure.value.hint },
      );
    }
    const status = this.recorder.status;
    if (status === 'failed') {
      const failedRow = [...this.recorder.stagesSince(this.operationMark)]
        .reverse()
        .find((row) => row.status === 'failed');
      throw this.fail(
        phase,
        'session-failed',
        failedRow === undefined
          ? 'the service filed the session failed without a failed progress row'
          : `the service filed the session failed at stage "${failedRow.stage}": ${clip(failedRow.message)}`,
      );
    }
    if (status === 'ended') {
      throw this.fail(
        phase,
        'session-ended',
        'the session was ended while this phase was waiting on it',
      );
    }
  }

  /** Wait for the next recorded frame, or fail the wait when its budget is spent. */
  async nextFrame(wait: WaitSpec): Promise<void> {
    const remaining = wait.deadline - Date.now();
    if (remaining <= 0) {
      const notes = wait.describeTimeout === undefined ? [] : await wait.describeTimeout();
      throw this.fail(
        wait.phase,
        'timeout',
        `timed out after ${String(wait.budgetMs)} ms (SessionTimeouts.${wait.budget}) waiting for ${wait.what}`,
        { notes },
      );
    }
    const before = this.client.snapshotIndex();
    const next = await this.client.next(remaining);
    // `next` answers `undefined` before its deadline only when the client was closed.
    if (
      next === undefined &&
      this.client.snapshotIndex() === before &&
      Date.now() < wait.deadline
    ) {
      throw this.fail(
        wait.phase,
        'editor-closed',
        `the editor connection closed (state ${this.client.state()}) while waiting for ${wait.what}`,
      );
    }
  }

  /** Drain, check liveness, test `check`; wait for the next frame until it answers or the budget ends. */
  async until<T>(wait: WaitSpec, check: () => T | undefined): Promise<T> {
    for (;;) {
      this.recorder.drain();
      this.assertLive(wait.phase);
      const value = check();
      if (value !== undefined) {
        return value;
      }
      await this.nextFrame(wait);
    }
  }

  /** Wait until the session's current status is `status`. */
  untilStatus(wait: WaitSpec, status: SessionStatus): Promise<SessionStatus> {
    return this.until(wait, () => (this.recorder.status === status ? status : undefined));
  }
}

/** The run a {@link DebugSessionOutcome} came from, for {@link askFollowUp}'s defaults. */
interface RunContext {
  readonly appPage: Page | undefined;
  readonly panel: PanelHandle | undefined;
  readonly timeouts: Readonly<SessionTimeouts>;
  readonly allowFallbackPanel: boolean;
  readonly allowMissingServerAgent: boolean;
  readonly tracker: SessionTracker | undefined;
}

/** Outcome → the run that produced it. A `WeakMap`, so an outcome carries no page handle itself. */
const RUN_CONTEXTS = new WeakMap<DebugSessionOutcome, RunContext>();

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The tab binding a step established. */
interface BoundTabInfo {
  readonly tabId: number;
  readonly url: string;
}

/** A target split into what `session.create` carries and what is selected through the product. */
interface ClassifiedTarget {
  readonly prebuilt: SelectedTarget | undefined;
  readonly selector: string | undefined;
}

/**
 * Tell a pre-built `SelectedTarget` (validated against the instrumentation
 * schema, so a malformed one is refused here rather than by the service) from
 * a `{ selector }` to select through the product.
 */
function classifyTarget(target: SelectedTarget | SelectorTarget | undefined): ClassifiedTarget {
  if (target === undefined) {
    return { prebuilt: undefined, selector: undefined };
  }
  const parsed = selectedTargetSchema.safeParse(target);
  if (parsed.success) {
    return { prebuilt: parsed.data, selector: undefined };
  }
  const keys = Object.keys(target);
  if (keys.length === 1 && keys[0] === 'selector' && target.selector.trim() !== '') {
    return { prebuilt: undefined, selector: target.selector };
  }
  throw invalidOption(
    'create',
    'runDebugSession',
    `target must be a valid SelectedTarget or exactly { selector } with a non-empty CSS selector; the SelectedTarget schema reports: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')}.`,
  );
}

/** Step 1 — `POST /sessions`. There is no session yet, so the failure text is built here. */
async function createSessionStep(
  service: ServiceHandle,
  editorClient: EditorClientHandle,
  projectRoot: string,
  question: string,
  target: SelectedTarget | undefined,
  mark: number,
): Promise<SessionRecord> {
  const startedAt = Date.now();
  try {
    return await service.createSession({
      projectRoot,
      question,
      ...(target === undefined ? {} : { target }),
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const hint = error instanceof ServiceCallError ? error.hint : undefined;
    throw new SessionWorkflowError({
      phase: 'create',
      code: 'service-refused',
      message: [
        `[create] session.create for ${projectRoot} failed: ${describeError(error)} (after ${String(elapsedMs)} ms in this phase)`,
        '  session status last seen: none — no session exists',
        `  message types since the phase started: ${describeTypes(editorClient.timeline({ sinceIndex: mark }))}`,
        ...(hint === undefined ? [] : [`  the service's instruction, verbatim: ${hint}`]),
        '  the project must lie under a workspace folder the editor connection announced, and its dev server must be known to the service (launched through ./demo-app or ./sample-app).',
      ].join('\n'),
      elapsedMs,
      hint,
      cause: error,
    });
  }
}

/** The panel's connection pill, for a binding failure. */
async function describePill(panel: PanelHandle): Promise<readonly string[]> {
  const status: PanelConnectionStatus | undefined = await panel
    .connectionStatus()
    .catch(() => undefined);
  return [
    `the panel's connection pill reads ${status ?? 'nothing recognisable'}; the extension must be paired (./chrome's ensurePaired) and the panel's DevTools page must stay open, because it is what announces the tab.`,
  ];
}

/**
 * Step 2 — bind the application's tab to the session through the product.
 *
 * The panel's DevTools page announced the tab when it opened — normally before
 * this session existed, so that bind found no session, or another one. The
 * service remembers such a tab and delivers the session created for its
 * origin to the panel, whose worker then announces the tab again (AAP §0.2.3),
 * so a tab the recording shows no binding for yet is simply waited for. The
 * DevTools page is reloaded — the worker sends `session.bind`, and the service
 * binds the tab to the most recently updated non-ended session on its origin —
 * only to re-announce a tab whose binding was lost, one bound to another
 * document, or any tab when `mode` is `always`; a reload while the product's
 * own bind is landing would unbind the tab again as its DevTools closes. This
 * module never sends `session.bind` itself.
 */
async function bindTabStep(
  driver: WorkflowDriver,
  phase: PhaseClock,
  panel: PanelHandle,
  appPage: Page,
  mode: 'if-unbound' | 'always',
): Promise<BoundTabInfo> {
  if (panel.isClosed() || appPage.isClosed()) {
    throw driver.fail(
      phase,
      'invalid-options',
      'the panel handle or the application page is closed',
    );
  }
  let tabId: number;
  try {
    tabId = await tabIdForPage(panel.extension, appPage);
  } catch (error) {
    throw driver.fail(
      phase,
      'invalid-options',
      `the application page's tab could not be resolved: ${describeError(error)}`,
      { cause: error },
    );
  }
  if (tabId !== panel.tabId) {
    throw driver.fail(
      phase,
      'invalid-options',
      `the panel inspects tab ${String(panel.tabId)}, but the application page is tab ${String(tabId)} — open the panel for the application's tab`,
    );
  }
  const appUrl = appPage.url();
  const scope = driver.operationMark;
  driver.recorder.drain();
  const current = driver.recorder.bindingState(tabId, scope);
  const announceMark = driver.client.snapshotIndex();
  const reannounce =
    mode === 'always' ||
    current.kind === 'lost' ||
    (current.kind === 'bound' && !sameDocument(appUrl, current.url));
  if (reannounce) {
    try {
      await panel.reload();
    } catch (error) {
      throw driver.fail(
        phase,
        'binding-lost',
        `the panel's DevTools page could not be reloaded to re-announce tab ${String(tabId)}: ${describeError(error)}`,
        { cause: error },
      );
    }
  }
  const wait = driver.waitSpec(
    phase,
    'bind',
    `session.bound binding tab ${String(tabId)} (${appUrl}) to this session`,
    () => describePill(panel),
  );
  return driver.until(wait, () => {
    const elsewhere = driver.recorder.boundElsewhere(tabId, announceMark);
    if (elsewhere !== undefined) {
      throw driver.fail(
        phase,
        'bound-elsewhere',
        `tab ${String(tabId)} was bound to session ${elsewhere.sessionId}, not to this one: the service binds a re-announced tab to the most recently updated non-ended session on the tab's dev-server origin, so ${elsewhere.sessionId} is still open there — end it (the session tracker ends every session it registered in teardown)`,
      );
    }
    const state = driver.recorder.bindingState(tabId, scope);
    return state.kind === 'bound' && sameDocument(appUrl, state.url)
      ? { tabId, url: state.url }
      : undefined;
  });
}

/**
 * Step 3 — select `selector` through the product (`$0` → the agent's
 * descriptor → `target.selected`). With `requireOwnerChain`, only a descriptor
 * and a recorded target that carry the element's React owner chain are
 * accepted (`./chrome`'s `SelectTargetOptions.requireOwnerChain`).
 */
async function selectTargetStep(
  driver: WorkflowDriver,
  phase: PhaseClock,
  panel: PanelHandle,
  appPage: Page,
  selector: string,
  route: TargetSelectionRoute | undefined,
  requireOwnerChain: boolean,
): Promise<SelectedTarget> {
  try {
    const selected = await selectTarget({
      panel,
      appPage,
      selector,
      editorClient: driver.client,
      sessionId: driver.sessionId,
      route,
      timeoutMs: driver.timeouts.bind,
      requireOwnerChain,
    });
    return selected.target;
  } catch (error) {
    throw driver.fail(
      phase,
      'target-selection-failed',
      `selecting "${clip(selector, 120)}" through the product failed: ${describeError(error)}`,
      { cause: error },
    );
  }
}

/**
 * Step 0 — point at `selector` before any session exists (`./chrome`'s
 * `describeSelection`). There is no session yet, so the failure text is built
 * here, as `createSessionStep` builds its own.
 */
async function preselectTargetStep(
  panel: PanelHandle,
  appPage: Page,
  selector: string,
  timeoutMs: number,
): Promise<SelectedTarget> {
  const startedAt = Date.now();
  try {
    return await describeSelection({
      panel,
      appPage,
      selector,
      timeoutMs,
      requireOwnerChain: true,
    });
  } catch (error) {
    throw new SessionWorkflowError({
      phase: 'target',
      code: 'target-selection-failed',
      message: [
        `[target] describing "${clip(selector, 120)}" before the question failed: ${describeError(error)} (after ${String(Date.now() - startedAt)} ms in this phase)`,
        '  session status last seen: none — no session exists yet',
      ].join('\n'),
      elapsedMs: Date.now() - startedAt,
      cause: error,
    });
  }
}

/** Whether two descriptors name the same element of the same document. */
/** How long a re-selection waits for the page to present its target as it was first described. */
const DESCRIPTION_SETTLE_TIMEOUT_MS = 10_000;

/** How many consecutive polls must find the described path matching exactly one element. */
const DESCRIPTION_STABLE_POLLS = 3;

/** The interval between those polls, in milliseconds. */
const DESCRIPTION_POLL_INTERVAL_MS = 200;

/**
 * Wait, within {@link DESCRIPTION_SETTLE_TIMEOUT_MS}, until `appPage` has
 * matched `selector` — the path the product built when the element was first
 * described — to exactly one element on {@link DESCRIPTION_STABLE_POLLS}
 * consecutive polls. Installing the plan reloads the page through Fast
 * Refresh, and for a moment after that reload the depth-bounded path can match
 * a second node, which the product rightly disambiguates with a leaf
 * `:nth-child(n)`. Selecting once the page presents the element as it did
 * before the question compares like with like. Never throws: on the deadline
 * the selection goes ahead and the comparison after it reports any difference.
 */
async function awaitSettledDescription(appPage: Page, selector: string): Promise<void> {
  const deadline = Date.now() + DESCRIPTION_SETTLE_TIMEOUT_MS;
  let stable = 0;
  while (Date.now() < deadline && !appPage.isClosed()) {
    const count = await appPage
      .waitForLoadState('load', { timeout: DESCRIPTION_SETTLE_TIMEOUT_MS })
      .then(() => appPage.locator(selector).count())
      .catch(() => undefined);
    stable = count === 1 ? stable + 1 : 0;
    if (stable >= DESCRIPTION_STABLE_POLLS) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, DESCRIPTION_POLL_INTERVAL_MS));
  }
}

function sameElement(a: SelectedTarget, b: SelectedTarget): boolean {
  return a.selector === b.selector && a.tagName === b.tagName && a.url === b.url;
}

/** Whether a progress row is the readiness gate's request for a page reload. */
function isReloadRequest(row: SessionStageRecord): boolean {
  return (
    row.stage === INSTRUMENT_STAGE &&
    row.status === 'running' &&
    RELOAD_REQUEST_VERB.test(row.message)
  );
}

/** The server-only signals the latest `instrumentation.ready` since `index` reports unavailable. */
function serverAgentGaps(
  driver: WorkflowDriver,
  index: number,
): readonly UnavailableSignalPayload[] {
  const latest = driver.recorder.latestSince(driver.recorder.readies, index);
  return latest === undefined
    ? []
    : latest.value.unavailable.filter((entry) => SERVER_ONLY_SIGNALS.has(entry.signal));
}

/** The relaunch-dev-server remediation: fail with the service's instruction verbatim. */
function assertServerAgentPresent(driver: WorkflowDriver, phase: PhaseClock): void {
  const gaps = serverAgentGaps(driver, driver.operationMark);
  if (gaps.length === 0) {
    return;
  }
  const signals = gaps.map((gap) => gap.signal).join(', ');
  const reasons = [...new Set(gaps.map((gap) => clip(gap.reason, 200)))].join('; ');
  const hints = [...new Set(gaps.map((gap) => gap.hint))];
  throw driver.fail(
    phase,
    'relaunch-required',
    `instrumentation.ready reports ${signals} unavailable (${reasons}): the project's dev server is running without the telemetry preload, which is a setup change this spec cannot make — relaunch it through the product's launcher (./demo-app or ./sample-app start it that way), or pass allowMissingServerAgent to accept a browser-only capture`,
    { hint: hints.join(' | ') },
  );
}

/** How the session reached `ready`, from what was observed. */
function readinessRouteFor(
  ask: SessionStageRecord | undefined,
  reloadedByDriver: boolean,
  loads: readonly number[],
): ReadinessRoute {
  if (ask === undefined) {
    return 'direct';
  }
  if (reloadedByDriver) {
    return 'reload-page-fallback';
  }
  return loads.some((at) => at >= ask.at) ? 'reload-consented' : 'direct';
}

/** What the readiness ladder needs besides the driver. */
interface ReadinessInputs {
  readonly panel: PanelHandle | undefined;
  readonly appPage: Page | undefined;
  /** The bound tab to watch for a lost binding, when one is known. */
  readonly tabId: number | undefined;
  readonly allowMissingServerAgent: boolean;
}

/**
 * Step 4 — wait for status `ready`, handling the three remediations the way
 * the module header describes: a lost binding is re-announced once, the
 * reload request is honoured once (the product's reload is observed; the
 * developer's reload is performed otherwise), and a missing dev-server preload
 * fails at once with the service's own instruction.
 */
async function readinessStep(
  driver: WorkflowDriver,
  phase: PhaseClock,
  inputs: ReadinessInputs,
): Promise<ReadinessRoute> {
  const { panel, appPage, tabId } = inputs;
  const scope = driver.operationMark;
  // Full document loads of the application page, so a reload the product
  // performed (the worker's consented `chrome.tabs.reload`) is told apart from
  // the one this module performs.
  const loads: number[] = [];
  const onLoad = (): void => {
    loads.push(Date.now());
  };
  appPage?.on('load', onLoad);
  let handledAsk: SessionStageRecord | undefined;
  let reloadedByDriver = false;
  let rebinds = 0;
  try {
    const wait = driver.waitSpec(
      phase,
      'ready',
      'status "ready" (the readiness gate admitting the instrumenting → ready edge)',
    );
    for (;;) {
      driver.recorder.drain();
      driver.assertLive(phase);
      if (!inputs.allowMissingServerAgent) {
        assertServerAgentPresent(driver, phase);
      }
      const latestAsk = driver.recorder.stagesSince(scope).filter(isReloadRequest).at(-1);
      if (driver.recorder.status === 'ready') {
        return readinessRouteFor(handledAsk ?? latestAsk, reloadedByDriver, loads);
      }

      if (latestAsk !== undefined && latestAsk !== handledAsk) {
        if (handledAsk !== undefined) {
          throw driver.fail(
            phase,
            'reload-ineffective',
            `the service asked for a reload again after the page had been reloaded once ("${clip(latestAsk.message)}"): the new document did not satisfy the readiness gate either, and the service asks at most once per document, so another reload would only repeat this`,
          );
        }
        handledAsk = latestAsk;
        const replacedAlready = loads.some((at) => at >= latestAsk.at);
        if (!replacedAlready) {
          if (appPage === undefined) {
            throw driver.fail(
              phase,
              'invalid-options',
              `the service asked for a reload ("${clip(latestAsk.message)}"), but no application page was given to reload`,
            );
          }
          // The panel renders no consent affordance for the worker's reload
          // (`apps/chrome-extension/src/background/service-worker.ts` records
          // the contract gap), so the developer's own reload is performed.
          try {
            await appPage.reload({ timeout: Math.max(1, wait.deadline - Date.now()) });
          } catch (error) {
            throw driver.fail(
              phase,
              'timeout',
              `the reload the service asked for did not complete: ${describeError(error)}`,
              { cause: error },
            );
          }
          reloadedByDriver = true;
        }
        continue;
      }

      if (tabId !== undefined && panel !== undefined && appPage !== undefined) {
        const binding = driver.recorder.bindingState(tabId, scope);
        if (binding.kind === 'lost') {
          if (rebinds >= 1) {
            throw driver.fail(
              phase,
              'binding-lost',
              `the session lost its tab binding again (${binding.reason}) after one re-bind`,
            );
          }
          rebinds += 1;
          await bindTabStep(driver, phase, panel, appPage, 'always');
          continue;
        }
      }

      await driver.nextFrame(wait);
    }
  } finally {
    appPage?.off('load', onLoad);
  }
}

/** Step 6 — `capture.start`, then `capture.started` for the answered capture. */
async function startCaptureStep(driver: WorkflowDriver, phase: PhaseClock): Promise<string> {
  let captureId: string;
  try {
    ({ captureId } = await driver.service.startCapture(driver.sessionId));
  } catch (error) {
    if (error instanceof CaptureConflictError) {
      throw driver.fail(
        phase,
        'capture-conflict',
        `capture.start was refused: session ${error.owningSessionId} already holds the capture for this project (one capture per project) — end it; the session tracker ends every session it registered in teardown`,
        { owningSessionId: error.owningSessionId, cause: error },
      );
    }
    if (error instanceof ServiceCallError && error.code === SERVER_AGENT_NOT_READY_CODE) {
      const hint = serverAgentGaps(driver, driver.operationMark)[0]?.hint ?? error.hint;
      throw driver.fail(
        phase,
        'relaunch-required',
        `capture.start was refused by the readiness gate (${error.code}): ${clip(error.message)}`,
        { hint, cause: error },
      );
    }
    throw driver.fail(
      phase,
      'service-refused',
      `capture.start was refused: ${describeError(error)}`,
      { hint: error instanceof ServiceCallError ? error.hint : undefined, cause: error },
    );
  }
  await driver.until(
    driver.waitSpec(phase, 'captureStart', `capture.started for capture ${captureId}`),
    () =>
      driver.recorder.firstSince(
        driver.recorder.capturesStarted,
        phase.startIndex,
        (id) => id === captureId,
      ) === undefined
        ? undefined
        : true,
  );
  return captureId;
}

/**
 * Step 5b — the spec's {@link RunDebugSessionOptions.beforeCapture} step, run
 * on the ready session; a throw is reported against the `ready` phase.
 */
async function prepareStep(
  driver: WorkflowDriver,
  phase: PhaseClock,
  prepare: SessionPreparation,
  context: SessionPreparationContext,
): Promise<void> {
  try {
    await prepare(context);
  } catch (error) {
    throw driver.fail(
      phase,
      'interaction-failed',
      `the spec's step before capture.start threw: ${describeError(error)}`,
      { cause: error },
    );
  }
}

/** Step 7 — the spec's interaction, where the reproduction's wall-clock time is spent. */
async function interactStep(
  driver: WorkflowDriver,
  phase: PhaseClock,
  interact: SessionInteraction,
  context: SessionInteractionContext,
): Promise<void> {
  try {
    await interact(context);
  } catch (error) {
    throw driver.fail(
      phase,
      'interaction-failed',
      `the spec's interaction threw inside capture ${context.captureId}: ${describeError(error)}`,
      { cause: error },
    );
  }
}

/**
 * Step 8 — `capture.stop`, `capture.stopped`, then where the window sent the
 * session: `analyzing` with evidence, or back to `ready` when the capture
 * yielded nothing — reported with the service's own sentence and
 * the capture's counts, never as a generic timeout.
 */
async function stopCaptureStep(
  driver: WorkflowDriver,
  phase: PhaseClock,
  captureId: string,
): Promise<CaptureSummary> {
  try {
    await driver.service.stopCapture(driver.sessionId);
  } catch (error) {
    throw driver.fail(
      phase,
      'service-refused',
      `capture.stop for capture ${captureId} was refused: ${describeError(error)}`,
      { hint: error instanceof ServiceCallError ? error.hint : undefined, cause: error },
    );
  }
  const stopped = await driver.until(
    driver.waitSpec(phase, 'captureStop', `capture.stopped for capture ${captureId}`),
    () =>
      driver.recorder.firstSince(
        driver.recorder.capturesStopped,
        phase.startIndex,
        (value) => value.captureId === captureId,
      ),
  );
  const next = await driver.until(
    driver.waitSpec(
      phase,
      'captureStop',
      'the session leaving "capturing" ("analyzing" with evidence, "ready" when the capture was empty)',
    ),
    () =>
      driver.recorder.statusesSince(phase.startIndex).find((entry) => entry.status !== 'capturing')
        ?.status,
  );
  if (next === 'ready') {
    const closing = driver.recorder
      .stagesSince(phase.startIndex)
      .filter((row) => row.stage === CAPTURE_STAGE && row.status === 'done')
      .at(-1);
    throw driver.fail(
      phase,
      'empty-capture',
      `capture ${captureId} yielded nothing to analyse and the service returned the session to "ready": "${closing === undefined ? '(no closing capture row)' : clip(closing.message)}" — ${describeCaptureCounts(stopped.value.summary)}. The interaction must reproduce the issue while the capture is open.`,
    );
  }
  if (next !== 'analyzing' && next !== 'generated') {
    throw driver.fail(
      phase,
      'unexpected-state',
      `after capture ${captureId} closed, the session moved to "${next}" rather than "analyzing"`,
    );
  }
  return stopped.value.summary;
}

/** What Stages 5 and 6 produced. */
interface GeneratedResults {
  readonly analysis: AnalysisResult;
  readonly panelId: string;
  readonly panel: PanelSpec;
}

/**
 * Step 9 — `analysis.completed`, then `panel.generated` (a panel other than
 * `priorPanelId`), validated with the suite's own acceptance rule (a fallback
 * is refused unless allowed), then the guarded `analyzing → generated` edge.
 * A replayed analysis or panel never qualifies: the recorder leaves out every
 * one it already knows.
 */
async function resultsStep(
  driver: WorkflowDriver,
  since: number,
  priorPanelId: string | undefined,
  allowFallbackPanel: boolean,
): Promise<GeneratedResults> {
  const analysisPhase = driver.begin('analysis');
  const analysis = await driver.until(
    driver.waitSpec(analysisPhase, 'analysis', 'analysis.completed (Stage 5)'),
    () => driver.recorder.firstSince(driver.recorder.analyses, since)?.value,
  );
  driver.end(analysisPhase);

  const panelPhase = driver.begin('panel');
  const generated = await driver.until(
    driver.waitSpec(panelPhase, 'panel', 'panel.generated (Stage 6)'),
    () =>
      driver.recorder.firstSince(
        driver.recorder.panels,
        since,
        (value) => value.panelId !== priorPanelId,
      )?.value,
  );
  let panel: PanelSpec;
  try {
    panel = expectValidPanelSpec(generated.panel, {
      allowFallback: allowFallbackPanel,
      message: `panel.generated ${generated.panelId} of session ${driver.sessionId}`,
    });
  } catch (error) {
    throw driver.fail(
      panelPhase,
      'invalid-panel',
      `panel.generated carried panel ${generated.panelId}, which fails the suite's acceptance rule: ${describeError(error)}`,
      { cause: error },
    );
  }
  await driver.untilStatus(
    driver.waitSpec(
      panelPhase,
      'panel',
      'status "generated" (the guarded analyzing → generated edge)',
    ),
    'generated',
  );
  driver.end(panelPhase);
  return { analysis, panelId: generated.panelId, panel };
}

/** Step 10 — the modification journal and the final record, over HTTP. */
async function finalizeStep(driver: WorkflowDriver): Promise<{
  readonly session: SessionRecord;
  readonly modifications: readonly ModificationRecord[];
}> {
  const phase = driver.begin('finalize');
  let modifications: readonly ModificationRecord[];
  let session: SessionRecord;
  try {
    modifications = await driver.service.getModifications(driver.sessionId);
    session = await driver.service.getSession(driver.sessionId);
  } catch (error) {
    throw driver.fail(
      phase,
      'service-refused',
      `reading the session's modifications and record failed: ${describeError(error)}`,
      { cause: error },
    );
  }
  driver.recorder.noteRecord(session);
  if (session.status !== 'generated') {
    throw driver.fail(
      phase,
      'unexpected-state',
      `GET /sessions/:id answers status "${session.status}", not "generated"`,
    );
  }
  driver.end(phase);
  return { session, modifications };
}

/** The durations of every phase plus the whole operation. */
function finishTimings(driver: WorkflowDriver, startedAt: number): Record<string, number> {
  return { ...driver.timings, total: Date.now() - startedAt };
}

/**
 * Without a tracker, a failed workflow ends its own session, so an open
 * capture or an applied patch cannot leak into the next spec under
 * `workers: 1`. The failure is annotated with the cleanup verdict and
 * rethrown; this never replaces it.
 */
async function endAfterFailure(
  service: ServiceHandle,
  sessionId: string,
  error: unknown,
): Promise<never> {
  let note: string;
  try {
    const { cleanup } = await service.endSession(sessionId);
    note = `no session tracker was given, so the driver ended session ${sessionId} after the failure: cleanup ${cleanup}`;
  } catch (endError) {
    note = `no session tracker was given and ending session ${sessionId} after the failure also failed: ${describeError(endError)} — end it by hand`;
  }
  if (error instanceof Error) {
    error.message = `${error.message}\n  ${note}`;
    throw error;
  }
  throw new Error(`${String(error)}\n  ${note}`);
}

/**
 * Drive one question through the real pipeline and answer with everything it
 * produced.
 *
 * Order (each step fails with a {@link SessionWorkflowError} naming it):
 *
 * 1. **create** — `session.create`; the session is registered with the
 *    tracker at once, before any assertion, so teardown ends it whatever
 *    happens next.
 * 2. **bind** — the panel re-announces `appPage`'s tab and the service answers
 *    `session.bound` for this session, tab and document.
 * 3. **target** — a `{ selector }` target is selected through the product.
 * 4. **ready** — status `ready`, handling the readiness remediations.
 * 5. `instrumentation.plan` / `instrumentation.ready` are recorded whenever
 *    they arrive; `unavailable` is kept (a degraded capture is legitimate).
 * 6. **captureStart** — `capture.start` and `capture.started`.
 * 7. **interact** — the spec's `interact`.
 * 8. **captureStop** — `capture.stop`, `capture.stopped`, `analyzing` (an
 *    empty capture fails with the service's sentence and the counts).
 * 9. **analysis** / **panel** — `analysis.completed`, `panel.generated`
 *    (validated; no fallback unless allowed), status `generated`.
 * 10. **finalize** — the modification journal and the final record.
 *
 * @throws {SessionWorkflowError} On any failure; the session is left to the
 * tracker (or ended here when no tracker was given).
 */
export async function runDebugSession(
  options: RunDebugSessionOptions,
): Promise<DebugSessionOutcome> {
  const startedAt = Date.now();
  const { service, editorClient, panel, appPage, projectRoot, question } = options;
  const timeouts = resolveTimeouts(DEFAULT_SESSION_TIMEOUTS, options.timeouts, (message) =>
    invalidOption('create', 'runDebugSession', message),
  );
  if (question.trim() === '') {
    throw invalidOption('create', 'runDebugSession', 'the question is empty.');
  }
  const target = classifyTarget(options.target);
  const selectBeforeQuestion = options.selectBeforeQuestion === true;
  if (selectBeforeQuestion && target.selector === undefined) {
    throw invalidOption(
      'create',
      'runDebugSession',
      'selectBeforeQuestion needs a { selector } target: a pre-built SelectedTarget is already sent with session.create.',
    );
  }
  const allowFallbackPanel = options.allowFallbackPanel === true;
  const allowMissingServerAgent = options.allowMissingServerAgent === true;

  // 0. Point at the element first, when asked to: there is no session yet, so
  // the descriptor is the next question's pending target.
  const preselected =
    selectBeforeQuestion && target.selector !== undefined
      ? await preselectTargetStep(panel, appPage, target.selector, timeouts.bind)
      : undefined;

  // The mark comes first: the service answers `session.create` and starts
  // broadcasting in the same breath.
  const mark = editorClient.snapshotIndex();

  // 1. Create.
  const created = await createSessionStep(
    service,
    editorClient,
    projectRoot,
    question,
    target.prebuilt ?? preselected,
    mark,
  );
  options.tracker?.register(created.id);
  const recorder = new SessionRecorder(editorClient, created.id, mark, {
    operationStartedAt: startedAt,
  });
  recorder.noteRecord(created);
  const driver = new WorkflowDriver(service, editorClient, recorder, timeouts, mark);
  driver.timings.create = Date.now() - startedAt;

  try {
    // 2. Bind the tab.
    const bindPhase = driver.begin('bind');
    const boundTab = await bindTabStep(driver, bindPhase, panel, appPage, 'if-unbound');
    driver.end(bindPhase);

    // 3. Select the target through the product, when one was named by selector.
    // A target pointed at before the question is selected again once the
    // session is ready instead: installing the plan can reload the page (a
    // patched client module makes Fast Refresh reload it), and selecting then
    // would describe an element React does not own yet.
    let selected: SelectedTarget | undefined = target.prebuilt ?? preselected;
    if (target.selector !== undefined && preselected === undefined) {
      const targetPhase = driver.begin('target');
      selected = await selectTargetStep(
        driver,
        targetPhase,
        panel,
        appPage,
        target.selector,
        options.selectTargetVia,
        false,
      );
      driver.end(targetPhase);
    }

    // 4–5. Ready, with plan and instrumentation recorded as they arrive.
    const readyPhase = driver.begin('ready');
    const readinessRoute = await readinessStep(driver, readyPhase, {
      panel,
      appPage,
      tabId: boundTab.tabId,
      allowMissingServerAgent,
    });
    driver.end(readyPhase);

    // 5a. The element pointed at before the question, selected for the live
    // session, which must record the same element.
    if (target.selector !== undefined && preselected !== undefined) {
      const targetPhase = driver.begin('target');
      await awaitSettledDescription(appPage, preselected.selector);
      selected = await selectTargetStep(
        driver,
        targetPhase,
        panel,
        appPage,
        target.selector,
        options.selectTargetVia,
        true,
      );
      if (!sameElement(preselected, selected)) {
        throw driver.fail(
          targetPhase,
          'target-selection-failed',
          `the element selected before the question (<${preselected.tagName}> ${clip(preselected.selector, 120)} on ${preselected.url}) is not the one the live session recorded (<${selected.tagName}> ${clip(selected.selector, 120)} on ${selected.url}).`,
        );
      }
      driver.end(targetPhase);
    }

    // 5b. The developer's pause before pressing Start capture, when the spec
    // asked for one.
    if (options.beforeCapture !== undefined) {
      const pausePhase = driver.begin('ready');
      await prepareStep(driver, pausePhase, options.beforeCapture, { appPage, panel });
      driver.end(pausePhase);
    }

    // 6. Start the capture.
    const startPhase = driver.begin('captureStart');
    const captureId = await startCaptureStep(driver, startPhase);
    driver.end(startPhase);

    // 7. Interact.
    const interactPhase = driver.begin('interact');
    await interactStep(driver, interactPhase, options.interact, { appPage, panel, captureId });
    driver.end(interactPhase);

    // 8. Stop the capture.
    const stopPhase = driver.begin('captureStop');
    const captureSummary = await stopCaptureStep(driver, stopPhase, captureId);
    driver.end(stopPhase);

    // 9. Analysis and panel.
    const results = await resultsStep(driver, stopPhase.startIndex, undefined, allowFallbackPanel);

    // 10. Modifications and the final record.
    const final = await finalizeStep(driver);

    const outcome: DebugSessionOutcome = {
      sessionId: created.id,
      session: final.session,
      statuses: recorder.statuses.map((entry) => entry.status),
      stages: [...recorder.stages],
      plan: recorder.plans.at(-1)?.value,
      instrumentation: recorder.readies.at(-1)?.value,
      captureId,
      captureSummary,
      analysis: results.analysis,
      panelId: results.panelId,
      panel: results.panel,
      modifications: final.modifications,
      readinessRoute,
      boundTab,
      target: selected,
      errors: [...recorder.errors],
      timings: finishTimings(driver, startedAt),
      followUpPath: undefined,
    };
    RUN_CONTEXTS.set(outcome, {
      appPage,
      panel,
      timeouts,
      allowFallbackPanel,
      allowMissingServerAgent,
      tracker: options.tracker,
    });
    return outcome;
  } catch (error) {
    if (options.tracker === undefined) {
      return endAfterFailure(service, created.id, error);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

/** `a` then `b`, with a repeat at the seam collapsed (the follow-up starts where the run ended). */
function concatStatuses(
  a: readonly SessionStatus[],
  b: readonly SessionStatus[],
): readonly SessionStatus[] {
  const merged = [...a];
  for (const status of b) {
    if (merged.at(-1) !== status) {
      merged.push(status);
    }
  }
  return merged;
}

/**
 * Ask a follow-up question on a generated session and drive whichever path
 * the service takes, detected from the observed statuses rather than assumed:
 *
 * - **existing evidence** — `generated → analyzing → generated`: a new analysis
 *   and a new panel version from the stored capture; no capture may start.
 * - **new capture** — `generated → planning → instrumenting → ready`: an
 *   additive plan version n + 1, then a second capture driven by `interact`
 *   (a clear failure when it was not supplied).
 *
 * Either way the new panel must supersede the previous one with a higher
 * `panelVersion`. The returned outcome is cumulative: statuses, stages and
 * errors continue the previous outcome's; `timings` are the follow-up's own.
 *
 * @throws {SessionWorkflowError} Naming the phase that failed.
 */
export async function askFollowUp(options: AskFollowUpOptions): Promise<DebugSessionOutcome> {
  const startedAt = Date.now();
  const { service, editorClient, outcome, question } = options;
  const context = RUN_CONTEXTS.get(outcome);
  const timeouts = resolveTimeouts(
    context?.timeouts ?? DEFAULT_SESSION_TIMEOUTS,
    options.timeouts,
    (message) => invalidOption('followUp', 'askFollowUp', message, outcome.sessionId),
  );
  const appPage = options.appPage ?? context?.appPage;
  const panel = options.panel ?? context?.panel;
  const allowFallbackPanel = options.allowFallbackPanel ?? context?.allowFallbackPanel ?? false;
  const allowMissingServerAgent =
    options.allowMissingServerAgent ?? context?.allowMissingServerAgent ?? false;
  if (question.trim() === '') {
    throw invalidOption('followUp', 'askFollowUp', 'the question is empty.', outcome.sessionId);
  }

  const { sessionId } = outcome;
  const mark = editorClient.snapshotIndex();
  // The previous outcome's analysis and panel are what a reopen replay
  // re-sends, so they are known from the start.
  const recorder = new SessionRecorder(editorClient, sessionId, mark, {
    operationStartedAt: startedAt,
    analysisIds: outcome.analysis === undefined ? [] : [outcome.analysis.id],
    panelIds: outcome.panelId === undefined ? [] : [outcome.panelId],
  });
  const driver = new WorkflowDriver(service, editorClient, recorder, timeouts, mark);

  try {
    const askPhase = driver.begin('followUp');
    let before: SessionRecord;
    let priorPanel: PanelSpec | undefined = outcome.panel;
    try {
      before = await service.getSession(sessionId);
      priorPanel ??= (await service.getCurrentPanel(sessionId)) ?? undefined;
    } catch (error) {
      throw driver.fail(
        askPhase,
        'service-refused',
        `reading the session before the follow-up failed: ${describeError(error)}`,
        { cause: error },
      );
    }
    recorder.noteRecord(before);
    if (before.status !== 'generated') {
      throw driver.fail(
        askPhase,
        'unexpected-state',
        `a follow-up starts from "generated", but the session is "${before.status}"`,
      );
    }
    if (priorPanel === undefined) {
      throw driver.fail(
        askPhase,
        'unexpected-state',
        'the session has no generated panel for a follow-up to supersede',
      );
    }
    const supersededPanel = priorPanel;
    const priorPlanVersion = before.plans.at(-1)?.planVersion;

    try {
      await service.askFollowUp(sessionId, question);
    } catch (error) {
      throw driver.fail(
        askPhase,
        'service-refused',
        `session.question was refused: ${describeError(error)}`,
        { hint: error instanceof ServiceCallError ? error.hint : undefined, cause: error },
      );
    }
    const path = await driver.until<FollowUpPath>(
      driver.waitSpec(
        askPhase,
        'followUp',
        'the session leaving "generated" ("analyzing" for existing evidence, "planning" for a new capture)',
      ),
      () => {
        const leaving = recorder.statusesSince(mark).find((entry) => entry.status !== 'generated');
        if (leaving === undefined) {
          return undefined;
        }
        if (leaving.status === 'analyzing') {
          return 'existing-evidence';
        }
        if (leaving.status === 'planning') {
          return 'new-capture';
        }
        throw driver.fail(
          askPhase,
          'unexpected-state',
          `after the follow-up the session moved from "generated" to "${leaving.status}", which neither follow-up path (existing-evidence or new-capture) takes`,
        );
      },
    );
    driver.end(askPhase);

    let readinessRoute = outcome.readinessRoute;
    let captureId = outcome.captureId;
    let captureSummary = outcome.captureSummary;
    let resultsSince = mark;

    if (path === 'new-capture') {
      const readyPhase = driver.begin('ready');
      readinessRoute = await readinessStep(driver, readyPhase, {
        panel,
        appPage,
        tabId: outcome.boundTab?.tabId,
        allowMissingServerAgent,
      });
      driver.end(readyPhase);
      const planVersionNow = recorder.session?.plans.at(-1)?.planVersion;
      if (
        planVersionNow === undefined ||
        (priorPlanVersion !== undefined && planVersionNow <= priorPlanVersion)
      ) {
        throw driver.fail(
          readyPhase,
          'no-progression',
          `the new-capture path must install an additive plan version, but the session's latest plan version is ${String(planVersionNow)} (before the follow-up: ${String(priorPlanVersion)})`,
        );
      }
      if (options.interact === undefined) {
        throw driver.fail(
          readyPhase,
          'interaction-required',
          `the service took the new-capture path (plan version ${String(planVersionNow)} installed, status "ready") and needs the issue reproduced again, but askFollowUp was called without \`interact\``,
        );
      }
      if (appPage === undefined || panel === undefined) {
        throw driver.fail(
          readyPhase,
          'invalid-options',
          'the new-capture path needs the application page and the panel: pass appPage and panel, or ask on an outcome runDebugSession returned',
        );
      }

      const startPhase = driver.begin('captureStart');
      const newCaptureId = await startCaptureStep(driver, startPhase);
      driver.end(startPhase);

      const interactPhase = driver.begin('interact');
      await interactStep(driver, interactPhase, options.interact, {
        appPage,
        panel,
        captureId: newCaptureId,
      });
      driver.end(interactPhase);

      const stopPhase = driver.begin('captureStop');
      captureSummary = await stopCaptureStep(driver, stopPhase, newCaptureId);
      driver.end(stopPhase);
      captureId = newCaptureId;
      resultsSince = stopPhase.startIndex;
    }

    const results = await resultsStep(driver, resultsSince, supersededPanel.id, allowFallbackPanel);

    const checkPhase = driver.begin('finalize');
    if (path === 'existing-evidence') {
      const started = recorder.firstSince(recorder.capturesStarted, mark);
      if (started !== undefined) {
        throw driver.fail(
          checkPhase,
          'unexpected-state',
          `the existing-evidence path must reuse the stored capture, but capture ${started.value} started`,
        );
      }
    }
    if (
      results.panel.panelVersion <= supersededPanel.panelVersion ||
      results.panel.supersedes !== supersededPanel.id
    ) {
      throw driver.fail(
        checkPhase,
        'no-progression',
        `the follow-up's panel ${results.panelId} must supersede ${supersededPanel.id} with a higher panelVersion, but it carries panelVersion ${String(results.panel.panelVersion)} (previous ${String(supersededPanel.panelVersion)}) and supersedes ${String(results.panel.supersedes)}`,
      );
    }
    const priorAnalysis = outcome.analysis;
    if (
      priorAnalysis !== undefined &&
      results.analysis.analysisVersion <= priorAnalysis.analysisVersion
    ) {
      throw driver.fail(
        checkPhase,
        'no-progression',
        `the follow-up's analysis ${results.analysis.id} must be a new analysis version, but it carries analysisVersion ${String(results.analysis.analysisVersion)} (previous ${String(priorAnalysis.analysisVersion)})`,
      );
    }
    const final = await finalizeStep(driver);

    const next: DebugSessionOutcome = {
      sessionId,
      session: final.session,
      statuses: concatStatuses(
        outcome.statuses,
        recorder.statuses.map((entry) => entry.status),
      ),
      stages: [...outcome.stages, ...recorder.stages],
      plan: recorder.plans.at(-1)?.value ?? outcome.plan,
      // The instrumentation in effect: a new-capture install's delta when it
      // reported one, otherwise the previous install, which still stands.
      instrumentation: recorder.readies.at(-1)?.value ?? outcome.instrumentation,
      captureId,
      captureSummary,
      analysis: results.analysis,
      panelId: results.panelId,
      panel: results.panel,
      modifications: final.modifications,
      readinessRoute,
      boundTab: outcome.boundTab,
      target: outcome.target,
      errors: [...outcome.errors, ...recorder.errors],
      timings: finishTimings(driver, startedAt),
      followUpPath: path,
    };
    RUN_CONTEXTS.set(next, {
      appPage,
      panel,
      timeouts,
      allowFallbackPanel,
      allowMissingServerAgent,
      tracker: context?.tracker,
    });
    return next;
  } catch (error) {
    if (context !== undefined && context.tracker === undefined) {
      return endAfterFailure(service, sessionId, error);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The session tracker — teardown that never throws and never hides a leak
// ---------------------------------------------------------------------------

/** How one registered session was ended. */
export type SessionEndOutcome = 'ended' | 'already-ended' | 'missing' | 'failed';

/** One registered session's end, as {@link SessionTracker.endAll} reports it. */
export interface SessionEndEntry {
  /** The session. */
  readonly sessionId: string;
  /** What happened. */
  readonly outcome: SessionEndOutcome;
  /** The cleanup verdict the service answered (or stored, for an already-ended session). */
  readonly cleanup: CleanupStatus | undefined;
  /** How many modifications cleanup refused to overwrite. */
  readonly conflicts: number;
  /** How long ending it took. */
  readonly durationMs: number;
  /** Why ending it failed, when it did. */
  readonly error: string | undefined;
}

/** What {@link SessionTracker.endAll} did — bounded, credential-free, attachable to a report. */
export interface EndAllReport {
  /** One entry per session this call ended, in the order they were ended (newest registration first). */
  readonly entries: readonly SessionEndEntry[];
  /** Whether every session ended with cleanup `clean`. */
  readonly clean: boolean;
  /** One sentence per session that did not end clean. */
  readonly problems: readonly string[];
  /** The report as plain text, for `testInfo.attach`. */
  readonly text: string;
}

/**
 * Tracks every session a spec created and ends them all in teardown, so the
 * shared `$DEBUGGEN_HOME`, the shared database and the one-per-project capture
 * are clean for the next spec under `workers: 1`.
 */
export interface SessionTracker {
  /** Track a session; idempotent. {@link runDebugSession} calls it the moment the session exists. */
  register(sessionId: string): void;
  /** End one tracked (or untracked) session now, recording it as ended. Never throws. */
  end(sessionId: string): Promise<SessionEndEntry>;
  /**
   * End every registered session not yet ended, newest first. Never throws: a
   * cleanup that came back `partial` or `conflict` (or an end that failed) is
   * recorded as a soft failure of the running test — loud, but it masks
   * neither the test's own failure nor the rest of teardown. A second call
   * ends nothing and reports an empty, clean run.
   */
  endAll(): Promise<EndAllReport>;
  /** Every registered session, in registration order. */
  readonly registered: readonly string[];
  /** Every session this tracker has ended (or found ended), in the order it did. */
  readonly ended: readonly string[];
}

/** How many sessions one report prints before it summarises the rest. */
const MAX_REPORTED_SESSIONS = 50;

/** The report of one `endAll()`. */
function buildEndAllReport(entries: readonly SessionEndEntry[]): EndAllReport {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.outcome === 'failed') {
      problems.push(
        `session ${entry.sessionId} could not be ended: ${entry.error ?? 'unknown error'}`,
      );
    } else if (entry.outcome === 'missing') {
      problems.push(
        `session ${entry.sessionId} is unknown to the service, so its cleanup cannot be confirmed`,
      );
    } else if (entry.cleanup !== 'clean') {
      problems.push(
        `session ${entry.sessionId} ended with cleanup "${String(entry.cleanup)}" (${String(entry.conflicts)} conflict(s)) — a patch may remain in the project`,
      );
    }
  }
  const listed = entries.slice(0, MAX_REPORTED_SESSIONS);
  const text = [
    `Session tracker: ended ${String(entries.length)} session(s); ${problems.length === 0 ? 'every cleanup is clean' : `${String(problems.length)} problem(s)`}.`,
    ...listed.map(
      (entry) =>
        `- ${entry.sessionId}: ${entry.outcome}, cleanup ${String(entry.cleanup)}, ${String(entry.conflicts)} conflict(s), ${String(entry.durationMs)} ms${entry.error === undefined ? '' : ` — ${entry.error}`}`,
    ),
    ...(entries.length > listed.length
      ? [`(+${String(entries.length - listed.length)} more)`]
      : []),
    ...problems.map((problem) => `PROBLEM: ${problem}`),
  ].join('\n');
  return { entries, clean: problems.length === 0, problems, text };
}

/**
 * Create a {@link SessionTracker} over `service`.
 *
 * Ending calls `POST /sessions/:id/end`, which awaits cleanup and is
 * idempotent for an ended session. A `409` answered while another operation of
 * the session is still settling is retried with `expect.poll` within
 * `SessionTimeouts.end` (the service's rule: "ending again retries").
 */
export function createSessionTracker(
  service: ServiceHandle,
  timeouts: Partial<SessionTimeouts> = {},
): SessionTracker {
  const budgets = resolveTimeouts(
    DEFAULT_SESSION_TIMEOUTS,
    timeouts,
    (message) => new Error(`createSessionTracker: ${message}`),
  );
  const registered: string[] = [];
  const ended: string[] = [];

  const markEnded = (sessionId: string): void => {
    if (!ended.includes(sessionId)) {
      ended.push(sessionId);
    }
  };

  const conflictsOf = async (sessionId: string): Promise<number> => {
    try {
      return (await service.getSession(sessionId)).cleanup.conflicts.length;
    } catch {
      return 0;
    }
  };

  const endOne = async (sessionId: string): Promise<SessionEndEntry> => {
    const startedAt = Date.now();
    const entry = (
      outcome: SessionEndOutcome,
      cleanup: CleanupStatus | undefined,
      conflicts: number,
      error?: string,
    ): SessionEndEntry => ({
      sessionId,
      outcome,
      cleanup,
      conflicts,
      durationMs: Date.now() - startedAt,
      error,
    });

    let before: SessionRecord;
    try {
      before = await service.getSession(sessionId);
    } catch (error) {
      if (error instanceof ServiceCallError && error.code === SESSION_NOT_FOUND_CODE) {
        markEnded(sessionId);
        return entry('missing', undefined, 0, describeError(error));
      }
      return entry('failed', undefined, 0, `reading the session failed: ${describeError(error)}`);
    }
    if (before.status === 'ended') {
      markEnded(sessionId);
      return entry('already-ended', before.cleanup.status, before.cleanup.conflicts.length);
    }

    const attempt: { cleanup: CleanupStatus | undefined; failure: string | undefined } = {
      cleanup: undefined,
      failure: undefined,
    };
    try {
      await expect
        .poll(
          async () => {
            try {
              attempt.cleanup = (await service.endSession(sessionId)).cleanup;
              attempt.failure = undefined;
              return 'ended';
            } catch (error) {
              attempt.failure = describeError(error);
              if (error instanceof ServiceCallError && error.code === SESSION_INVALID_STATE_CODE) {
                return 'still settling';
              }
              return 'refused';
            }
          },
          {
            message: `POST /sessions/${sessionId}/end`,
            timeout: budgets.end,
            intervals: [...POLL_INTERVALS_MS],
          },
        )
        .not.toBe('still settling');
    } catch {
      return entry(
        'failed',
        undefined,
        0,
        `the service was still answering ${SESSION_INVALID_STATE_CODE} (another operation of the session settling) when SessionTimeouts.end (${String(budgets.end)} ms) ran out: ${attempt.failure ?? 'no answer'}`,
      );
    }
    if (attempt.cleanup === undefined) {
      return entry('failed', undefined, 0, attempt.failure ?? 'the end request was refused');
    }
    markEnded(sessionId);
    return entry('ended', attempt.cleanup, await conflictsOf(sessionId));
  };

  /** Record problems as a soft failure of the running test; outside a test, on stderr. */
  const surface = (report: EndAllReport): void => {
    if (report.clean) {
      return;
    }
    const info = currentTestInfo();
    if (info === undefined) {
      process.stderr.write(`${report.text}\n`);
      return;
    }
    expect.soft(report.problems, `Session teardown did not end clean:\n${report.text}`).toEqual([]);
  };

  return {
    register(sessionId: string): void {
      if (sessionId.trim() === '') {
        throw new Error('SessionTracker.register: the session id is empty.');
      }
      if (!registered.includes(sessionId)) {
        registered.push(sessionId);
      }
    },

    async end(sessionId: string): Promise<SessionEndEntry> {
      if (!registered.includes(sessionId)) {
        registered.push(sessionId);
      }
      return endOne(sessionId);
    },

    async endAll(): Promise<EndAllReport> {
      const entries: SessionEndEntry[] = [];
      for (const sessionId of [...registered].reverse()) {
        if (ended.includes(sessionId)) {
          continue;
        }
        try {
          entries.push(await endOne(sessionId));
        } catch (error) {
          entries.push({
            sessionId,
            outcome: 'failed',
            cleanup: undefined,
            conflicts: 0,
            durationMs: 0,
            error: describeError(error),
          });
        }
      }
      const report = buildEndAllReport(entries);
      try {
        surface(report);
      } catch {
        // `expect.soft` records and does not throw; this guard keeps the
        // teardown contract even if a reporter misbehaves.
      }
      return report;
    },

    get registered(): readonly string[] {
      return [...registered];
    },

    get ended(): readonly string[] {
      return [...ended];
    },
  };
}

// ---------------------------------------------------------------------------
// The comparison baseline
// ---------------------------------------------------------------------------

/** The generated panel's node-type sets, with the outcome that produced them. */
export interface PanelNodeTypesResult {
  readonly outcome: DebugSessionOutcome;
  /** Every node type of the panel's layout, at any depth. */
  readonly nodeTypes: Set<PanelNodeType>;
  /** The visualization node types only (the catalog's split, via `./assertions`). */
  readonly visualizationNodeTypes: Set<PanelNodeType>;
}

/**
 * Run a question and answer with its panel's node-type sets — a thin
 * composition of {@link runDebugSession} and `./assertions`'
 * `nodeTypesOf` / `visualizationNodeTypesOf`.
 *
 * It exists so `demo-excessive-renders.spec.ts` derives the slow-interaction
 * baseline IN ITS OWN FILE for the "materially different" comparison of the
 * two panels' node-type sets (`docs/DEMO.md`, "How the three panels differ"),
 * instead of depending on the order sibling specs run in. The baseline session
 * is a session like any other: pass the spec's tracker so teardown ends it,
 * and end it (`tracker.end(outcome.sessionId)`) before asking the next
 * question on the same project — its patches stay applied until it ends, and
 * the next session would otherwise instrument on top of them.
 */
export async function generatePanelNodeTypes(
  options: RunDebugSessionOptions,
): Promise<PanelNodeTypesResult> {
  const outcome = await runDebugSession(options);
  const { panel } = outcome;
  if (panel === undefined) {
    throw new SessionWorkflowError({
      phase: 'panel',
      code: 'unexpected-state',
      message: `[panel] generatePanelNodeTypes: session ${outcome.sessionId} completed without a panel.`,
      sessionId: outcome.sessionId,
    });
  }
  return {
    outcome,
    nodeTypes: nodeTypesOf(panel),
    visualizationNodeTypes: visualizationNodeTypesOf(panel),
  };
}
