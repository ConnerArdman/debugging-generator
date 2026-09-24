/**
 * The extension host's single in-memory store of server state (AAP §0.7.1
 * Group 3, §0.7.3).
 *
 * The host holds exactly one connection to the local service. Every message it
 * receives on that connection — and every authoritative answer it gets over
 * HTTP — is folded into one {@link ExtensionState} instance, and both editor
 * surfaces read from it: the `debuggen.session` webview view posts the
 * {@link WebviewState} snapshot this store emits straight through, and the
 * `debuggen.sessions` tree refreshes itself from {@link ExtensionState.sessionList}.
 * This is the **only** place the host caches server state, so the two views can
 * never disagree about what the service said.
 *
 * ```text
 * service ──WS/HTTP──▶ src/extension.ts ──apply*()/set*()──▶ ExtensionState
 *                                                              │ onDidChange (coalesced)
 *                                    ┌─────────────────────────┴───────────────┐
 *                                    ▼                                         ▼
 *                     session-view-provider (postMessage)          sessions-tree (refresh)
 * ```
 *
 * ## What the store is — and what it refuses to be
 *
 * - **A pure projection.** Every mutator is named after the protocol message
 *   (or HTTP answer) that caused it and takes that message's payload type from
 *   `@debuggen/protocol`. A mutator performs no I/O, shows no UI and logs
 *   nothing: the store never pulls, it is fed. That is what makes it directly
 *   unit-testable and what keeps a bug in a view from reaching the service.
 * - **In memory only.** Nothing is written to `workspaceState`, `globalState`,
 *   the workspace folder or any file. Session data lives under
 *   `$DEBUGGEN_HOME`, owned by the service (AAP §0.4.2, §0.5.2), which is what
 *   keeps a debugging session out of the developer's git status.
 * - **Never a holder of secrets.** The pairing code is a short-lived,
 *   single-use capability shown to the developer; no bearer token, no
 *   `auth.json` content and no service credential ever enters this store
 *   (AAP §0.5.6). {@link ExtensionState.setPairing} copies only the two
 *   displayable fields, so an object that happens to carry more cannot smuggle
 *   anything else in.
 * - **Never an author of results.** Progress rows are exactly what the service
 *   sent, in the order it sent it; no step list is synthesised, reordered or
 *   filled in, and the capture counter is never estimated (AAP §0.5.4). A
 *   failure is held in its own field and is never representable as a
 *   successful analysis (AAP §0.5.5). The store never inspects the session
 *   question's content.
 *
 * ## Reopen and live paths are the same path
 *
 * The service pushes `session.updated` after essentially every pipeline step,
 * so {@link ExtensionState.applySessionRecord} is the hottest mutator, and it
 * derives every member the record can supply — relevant files, modifications,
 * cleanup status, target, the latest analysis, the capture window — from the
 * record itself. Reopening a stored session (`GET /sessions/:id`) therefore
 * repopulates the whole view from one call, exactly as the live path does. The
 * one member a record cannot supply is the latest panel's summary (the record
 * carries panel ids only); on reopen the service replays the latest
 * `panel.generated` (AAP §0.4.2), which {@link ExtensionState.applyPanelGenerated}
 * turns back into that summary. Progress rows live in the service's
 * `session_progress` table rather than on the record, so a reopened session
 * shows exactly the rows the service chooses to send — none are invented.
 *
 * Because the record and the finer-grained pushes (`instrumentation.ready`,
 * `analysis.completed`, `capture.*`, `cleanup.completed`) can reach the host in
 * either order, applying a record never regresses a fact a push already
 * established: the modification journal is append-only, analyses are ordered
 * by `analysisVersion`, a stopped capture does not restart, and a finished
 * cleanup does not return to `pending`. Each merge rule is documented where it
 * is applied.
 *
 * ## Coalescing
 *
 * `session.progress` arrives in bursts and every notification becomes a
 * `postMessage` to the webview, so mutators never fire {@link
 * ExtensionState.onDidChange} synchronously. A mutation marks the store dirty
 * and schedules one flush on the microtask queue; further mutations before it
 * runs join the same flush. {@link ExtensionState.batch} additionally holds the
 * flush back for the duration of a callback. Listeners therefore always receive
 * one whole, consistent snapshot per burst, never a half-applied one.
 *
 * ## Immutability
 *
 * Incoming records are cloned and deep-frozen on ingest, so the store owns its
 * data independently of the caller's objects and every accessor can hand out
 * its internals without copying: an accidental write from a command throws
 * instead of silently corrupting the store. {@link ExtensionState.toWebviewState}
 * returns a fresh structured clone, so a consumer may freely mutate the
 * snapshot it receives without affecting the store, and the snapshot is
 * guaranteed to be JSON-serializable.
 *
 * @example
 * ```ts
 * const state = new ExtensionState({ serviceUrl, provider });
 * context.subscriptions.push(state);
 * state.onDidChange((snapshot) => view.postState(snapshot));
 * client.on('session.updated', (payload) => state.applySessionRecord(payload.session));
 * client.on('session.progress', (payload) => state.applyProgress(payload));
 * ```
 */

import * as vscode from 'vscode';

import type {
  AnalysisResult,
  CaptureRecord,
  CaptureStartedPayload,
  CaptureStoppedPayload,
  CleanupCompletedPayload,
  ConnectionState,
  InstrumentationFailedPayload,
  InstrumentationPlan,
  InstrumentationPlanPayload,
  InstrumentationReadyPayload,
  ModificationRecord,
  PanelGeneratedPayload,
  ProgressStage,
  RelevantFile,
  SelectedTarget,
  SessionProgressPayload,
  SessionRecord,
  TargetSelectedPayload,
  UnavailableSignalPayload,
} from '@debuggen/protocol';

import type {
  PairingState,
  PanelSummary,
  ProgressEntry,
  SessionCleanupState,
  StageFailure,
  WebviewState,
} from './webview-messages';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What the store needs to render an honest status bar before the first health
 * probe returns.
 */
export interface ExtensionStateOptions {
  /** The configured service base URL (`debuggen.serviceUrl`). */
  readonly serviceUrl: string;
  /**
   * The configured model provider (`debuggen.provider`). Replaced by the
   * service's own answer via {@link ExtensionState.setProvider} once `GET /health`
   * reports it, because the running service is the authority on which provider
   * it actually uses.
   */
  readonly provider: string;
  /**
   * The clock, in Unix epoch milliseconds. Defaults to `Date.now`; injectable so
   * progress receipt times and pairing expiry are deterministic under test.
   */
  readonly now?: () => number;
}

/** The capture window as the host knows it; the snapshot's `capture` member. */
export type CaptureState = Readonly<WebviewState['capture']>;

// ---------------------------------------------------------------------------
// Module constants (immutable; no module-level mutable state exists)
// ---------------------------------------------------------------------------

/**
 * The stage an `instrumentation.failed` frame reports on.
 *
 * That payload carries an error and no stage name, because its message type
 * already says which stage failed. The literal is checked against the
 * protocol's own `ProgressStage` vocabulary, so a rename there fails to compile
 * here rather than drifting silently.
 */
const INSTRUMENTATION_STAGE = 'instrument' satisfies ProgressStage;

/** The capture window before any capture has run. */
const IDLE_CAPTURE: CaptureState = Object.freeze({ active: false, eventCount: 0 });

/** The cleanup state before any session has run cleanup. */
const PENDING_CLEANUP: SessionCleanupState = deepFreeze<SessionCleanupState>({
  status: 'pending',
  conflicts: [],
});

/** The longest delay a Node.js timer honours (2^31 − 1 ms); longer delays fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Where the current target came from.
 *
 * - `session`: the active session's own target — from its record or from a
 *   `target.selected` naming it. Session-scoped, so {@link ExtensionState.resetSession}
 *   clears it.
 * - `pending`: an element selected while no session was active, which is
 *   legitimate because a developer may point at something before asking about
 *   it. It is an input to the *next* session rather than state of the previous
 *   one, so a reset keeps it; the first record of the next session either
 *   adopts it (the session was created with it) or supersedes it.
 */
type TargetScope = 'session' | 'pending';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Freezes a value and everything reachable from it, in place, and returns it.
 *
 * Applied only to values the store has just cloned, so the caller's objects
 * are never frozen. The frozen check makes shared or already-frozen subtrees
 * cost nothing and keeps the walk finite.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object) as unknown[]) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Takes ownership of an incoming value: a structured clone, deep-frozen.
 *
 * Every payload the store keeps passes through here, so the store never aliases
 * an object a caller might later mutate, and no accessor can be used to mutate
 * the store.
 */
function own<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * Whether the captures a record lists include the one with the given id.
 */
function recordHasCapture(captures: readonly CaptureRecord[], captureId: string): boolean {
  return captures.some((capture) => capture.id === captureId);
}

/**
 * The capture window a stored capture record describes.
 *
 * A capture without `stoppedAt` is in flight. Its count is the service's own
 * ingest counter (`CaptureRecord.eventCount`) when the service has reported one
 * on the record, and `0` otherwise — the host never counts or estimates events
 * itself (see {@link ExtensionState.applyCaptureStarted}). A stopped capture
 * reports its summary's total, falling back to the record's counter.
 */
function captureFromRecord(capture: CaptureRecord): CaptureState {
  const inFlight = capture.stoppedAt === undefined;
  const eventCount = inFlight
    ? (capture.eventCount ?? 0)
    : (capture.summary?.eventCount ?? capture.eventCount ?? 0);
  return Object.freeze({ active: inFlight, captureId: capture.id, eventCount });
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * The host's single in-memory store of server state; see the module
 * documentation for its contract.
 *
 * Instantiable any number of times — all state is held in instance fields — and
 * disposable: after {@link dispose} every mutator is inert and no further
 * {@link onDidChange} event fires.
 */
export class ExtensionState implements vscode.Disposable {
  /** The one change event; fired at most once per coalesced burst. */
  private readonly emitter = new vscode.EventEmitter<WebviewState>();

  /**
   * Fires with a fresh {@link WebviewState} snapshot after a burst of mutations
   * settles. Both views subscribe: the webview provider posts the payload
   * through, the Sessions tree refreshes from {@link sessionList}.
   */
  readonly onDidChange: vscode.Event<WebviewState> = this.emitter.event;

  private readonly now: () => number;

  // Connection and service -------------------------------------------------
  private connectionStatusValue: ConnectionState = 'closed';
  private serviceUrlValue: string;
  private serviceReachableValue = false;
  private providerValue: string;

  // The Sessions tree's list ------------------------------------------------
  private sessionListValue: readonly SessionRecord[] = Object.freeze([]);

  // Session-scoped (cleared by resetSession) -------------------------------
  private sessionValue: SessionRecord | undefined;
  private progressValue: readonly ProgressEntry[] = Object.freeze([]);
  private relevantFilesValue: readonly RelevantFile[] = Object.freeze([]);
  private modificationsValue: readonly ModificationRecord[] = Object.freeze([]);
  private runtimeHooksValue: readonly string[] = Object.freeze([]);
  private unavailableSignalsValue: readonly UnavailableSignalPayload[] = Object.freeze([]);
  private analysisValue: AnalysisResult | undefined;
  private latestPanelValue: PanelSummary | undefined;
  private captureValue: CaptureState = IDLE_CAPTURE;
  private failureValue: StageFailure | undefined;

  // Target (session-scoped or pending; see TargetScope) --------------------
  private targetValue: SelectedTarget | undefined;
  private targetScope: TargetScope | undefined;

  // Cleanup (survives resetSession until the next session's record) --------
  private cleanupValue: SessionCleanupState = PENDING_CLEANUP;
  private cleanupSessionId: string | undefined;

  // Pairing (survives resetSession; expires on its own) ---------------------
  private pairingValue: PairingState | undefined;
  private pairingTimer: ReturnType<typeof setTimeout> | undefined;

  // Notification bookkeeping -----------------------------------------------
  private dirty = false;
  private flushScheduled = false;
  private batchDepth = 0;
  private isDisposed = false;

  /**
   * @param options The configured service URL and provider, shown until the
   *   service answers for itself, and an optional clock.
   */
  constructor(options: ExtensionStateOptions) {
    this.serviceUrlValue = options.serviceUrl;
    this.providerValue = options.provider;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Read accessors — frozen values, never the live mutable internals
  // -------------------------------------------------------------------------

  /** The active session's record, deep-frozen; `undefined` before a question is asked. */
  get activeSession(): SessionRecord | undefined {
    return this.sessionValue;
  }

  /** The active session's id; `undefined` when no session is active. */
  get activeSessionId(): string | undefined {
    return this.sessionValue?.id;
  }

  /** The stored sessions for the Sessions tree, as `GET /sessions` last answered. */
  get sessionList(): readonly SessionRecord[] {
    return this.sessionListValue;
  }

  /** The reconnecting WebSocket client's state, in the protocol's vocabulary. */
  get connectionStatus(): ConnectionState {
    return this.connectionStatusValue;
  }

  /** Whether the service's `GET /health` answered on the last probe. */
  get serviceReachable(): boolean {
    return this.serviceReachableValue;
  }

  /** The service base URL the host is configured to use. */
  get serviceUrl(): string {
    return this.serviceUrlValue;
  }

  /** The model provider: the service's own answer when known, else the configured one. */
  get provider(): string {
    return this.providerValue;
  }

  /** Progress rows of the active session, in arrival order. */
  get progress(): readonly ProgressEntry[] {
    return this.progressValue;
  }

  /** The files the investigation judged relevant, most relevant first. */
  get relevantFiles(): readonly RelevantFile[] {
    return this.relevantFilesValue;
  }

  /** Every file modification the active session made, in the order applied. */
  get modifications(): readonly ModificationRecord[] {
    return this.modificationsValue;
  }

  /** The runtime hooks the latest `instrumentation.ready` reported as up. */
  get runtimeHooks(): readonly string[] {
    return this.runtimeHooksValue;
  }

  /**
   * The signals the latest `instrumentation.ready` could not enable, each with
   * its reason and hint, for the "Could not enable ‹signal›…" notice
   * (AAP §0.5.5). Kept rather than discarded so a partially enabled capture is
   * always visible as such.
   */
  get unavailableSignals(): readonly UnavailableSignalPayload[] {
    return this.unavailableSignalsValue;
  }

  /** The latest validated analysis of the active session, when one exists. */
  get latestAnalysis(): AnalysisResult | undefined {
    return this.analysisValue;
  }

  /** The latest generated panel's identity and fallback flag, when one exists. */
  get latestPanel(): PanelSummary | undefined {
    return this.latestPanelValue;
  }

  /** The element selected in DevTools, when there is one. */
  get target(): SelectedTarget | undefined {
    return this.targetValue;
  }

  /** The capture window. */
  get captureState(): CaptureState {
    return this.captureValue;
  }

  /** The cleanup state of the active (or most recently ended) session. */
  get cleanup(): SessionCleanupState {
    return this.cleanupValue;
  }

  /** The pairing code on display, or `undefined` once it has expired. */
  get pairing(): PairingState | undefined {
    const pairing = this.pairingValue;
    return pairing !== undefined && pairing.expiresAt > this.now() ? pairing : undefined;
  }

  /** The failed stage, when one failed; never part of the analysis. */
  get failure(): StageFailure | undefined {
    return this.failureValue;
  }

  // -------------------------------------------------------------------------
  // Lifecycle and notification
  // -------------------------------------------------------------------------

  /**
   * Runs `fn` with notifications held back, then flushes once.
   *
   * Every mutation `fn` makes joins a single {@link onDidChange} event, which is
   * delivered on the microtask queue like any other flush. Nested batches are
   * allowed; only the outermost one releases the flush. An exception from `fn`
   * propagates to the caller after the hold is released, and whatever `fn`
   * managed to apply before throwing is still notified.
   *
   * @example
   * ```ts
   * state.batch(() => {
   *   state.resetSession();
   *   state.applySessionRecord(record);
   * });
   * ```
   */
  batch(fn: () => void): void {
    this.batchDepth += 1;
    try {
      fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.dirty) {
        this.scheduleFlush();
      }
    }
  }

  /**
   * Releases the change event and the pairing-expiry timer.
   *
   * Idempotent. Afterwards every mutator is a no-op, a flush already queued on
   * the microtask queue does nothing, and {@link onDidChange} never fires again.
   * Read accessors and {@link toWebviewState} keep answering with the last
   * state, so a consumer disposed out of order still reads something coherent.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.dirty = false;
    this.cancelPairingTimer();
    this.emitter.dispose();
  }

  // -------------------------------------------------------------------------
  // Connection and service
  // -------------------------------------------------------------------------

  /**
   * Records the WebSocket client's state (`onStateChange` of the protocol's
   * `ReconnectingWsClient`), so the status bar and the DevTools
   * `ConnectionStatus` pill use one vocabulary.
   */
  setConnectionStatus(status: ConnectionState): void {
    if (this.isDisposed || status === this.connectionStatusValue) {
      return;
    }
    this.connectionStatusValue = status;
    this.markChanged();
  }

  /**
   * Records whether the service's `GET /health` answered. "Service not running"
   * is a renderable state — `false` here together with a `closed` connection —
   * never an exception.
   */
  setServiceReachable(reachable: boolean): void {
    if (this.isDisposed || reachable === this.serviceReachableValue) {
      return;
    }
    this.serviceReachableValue = reachable;
    this.markChanged();
  }

  /**
   * Records a changed `debuggen.serviceUrl` setting. A blank value is ignored so
   * the status bar keeps naming the URL the host is actually using.
   */
  setServiceUrl(url: string): void {
    const trimmed = url.trim();
    if (this.isDisposed || !trimmed || trimmed === this.serviceUrlValue) {
      return;
    }
    this.serviceUrlValue = trimmed;
    this.markChanged();
  }

  /**
   * Records the model provider: the service's `GET /health` answer when
   * available, otherwise the configured `debuggen.provider`. A blank value is
   * ignored so the status bar never goes empty.
   */
  setProvider(provider: string): void {
    const trimmed = provider.trim();
    if (this.isDisposed || !trimmed || trimmed === this.providerValue) {
      return;
    }
    this.providerValue = trimmed;
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Applies a whole session record — from `session.created`, `session.updated`,
   * or `GET /sessions/:id` when a stored session is reopened.
   *
   * The record becomes the active session when no session is active (a new
   * session after {@link resetSession}, or a reopen) or when it is the active
   * session. A record of any other session only refreshes that session's entry
   * in {@link sessionList}, so the tree shows its latest status without the
   * view switching away from the session the developer is looking at. For the
   * active session, a record older than the one held (`updatedAt`) is a stale
   * answer that crossed a newer push and is ignored.
   *
   * Every member the record can supply is re-derived from it, which is what
   * makes the reopen path and the live path identical; see the module
   * documentation for the merge rules that keep a push-established fact from
   * regressing when a record arrives out of order.
   */
  applySessionRecord(session: SessionRecord): void {
    if (this.isDisposed) {
      return;
    }
    const record = own(session);
    const listChanged = this.refreshListedSession(record);

    const active = this.sessionValue;
    if (active !== undefined && (active.id !== record.id || record.updatedAt < active.updatedAt)) {
      if (listChanged) {
        this.markChanged();
      }
      return;
    }

    this.sessionValue = record;
    this.relevantFilesValue = record.relevantFiles;
    this.modificationsValue = this.mergeModifications(record.modifications);
    this.analysisValue = this.newerAnalysis(record.analyses.at(-1), this.analysisValue);
    this.latestPanelValue = this.panelStillCurrent(record.panelIds);
    this.captureValue = this.mergeCapture(record.captures);
    this.cleanupValue = this.mergeCleanup(record);
    this.cleanupSessionId = record.id;
    this.applyRecordTarget(record);
    this.markChanged();
  }

  /**
   * Replaces the Sessions tree's list with `GET /sessions`'s answer.
   *
   * The tree reads from here and keeps no copy of its own. The active session's
   * view is not touched: pushes are authoritative for the session in view.
   */
  setSessionList(sessions: readonly SessionRecord[]): void {
    if (this.isDisposed) {
      return;
    }
    this.sessionListValue = own([...sessions]);
    this.markChanged();
  }

  /**
   * Clears session-scoped state because a new session is starting (or a
   * different stored session is being reopened).
   *
   * Clears the session, its progress rows, relevant files, modifications,
   * instrumentation report, analysis, panel summary, session target, capture
   * window and failure. Keeps the connection, provider, service URL and
   * {@link sessionList}; keeps the pairing code, which belongs to the Chrome
   * extension rather than to any session; keeps a target selected while no
   * session was active (it is the next question's input); and keeps the
   * previous session's cleanup status visible until the next session's record
   * replaces it, so "files restored" does not vanish the moment the developer
   * starts typing a new question.
   */
  resetSession(): void {
    if (this.isDisposed) {
      return;
    }
    this.sessionValue = undefined;
    this.progressValue = Object.freeze([]);
    this.relevantFilesValue = Object.freeze([]);
    this.modificationsValue = Object.freeze([]);
    this.runtimeHooksValue = Object.freeze([]);
    this.unavailableSignalsValue = Object.freeze([]);
    this.analysisValue = undefined;
    this.latestPanelValue = undefined;
    this.captureValue = IDLE_CAPTURE;
    this.failureValue = undefined;
    if (this.targetScope === 'session') {
      this.targetValue = undefined;
      this.targetScope = undefined;
    }
    this.markChanged();
  }

  /**
   * Upserts one `session.progress` row.
   *
   * Rows are keyed on `(stage, message)`: a row reported again — `running`
   * becoming `done` or `failed` — is replaced in place, so a step never appears
   * twice and arrival order is preserved; any other row is appended. The list
   * is exactly what the service sent, in the order it sent it: nothing is
   * synthesised, reordered into a template or filled in (AAP §0.5.4). Progress
   * of any session other than the active one is dropped.
   */
  applyProgress(payload: SessionProgressPayload): void {
    if (this.isDisposed || !this.isActiveSession(payload.sessionId)) {
      return;
    }
    const entry: ProgressEntry = Object.freeze({
      stage: payload.stage,
      status: payload.status,
      message: payload.message,
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      ts: this.now(),
    });
    const rows = [...this.progressValue];
    const index = rows.findIndex(
      (row) => row.stage === entry.stage && row.message === entry.message,
    );
    if (index === -1) {
      rows.push(entry);
    } else {
      rows[index] = entry;
    }
    this.progressValue = Object.freeze(rows);
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Instrumentation
  // -------------------------------------------------------------------------

  /**
   * Records an `instrumentation.plan` on the active session's record.
   *
   * Plans are kept by `planVersion` in ascending order, the last being the one
   * installed — the record's own convention — so a plan pushed before the next
   * `session.updated` is visible to `ProgressSteps` and `RelevantFiles` at
   * once. A plan re-sent under a version already held replaces it. The held
   * record is never mutated; a new frozen record is derived from it.
   */
  applyInstrumentationPlan(payload: InstrumentationPlanPayload): void {
    const session = this.sessionValue;
    if (this.isDisposed || session === undefined || session.id !== payload.sessionId) {
      return;
    }
    const plan: InstrumentationPlan = own(payload.plan);
    const plans = session.plans.filter((held) => held.planVersion !== plan.planVersion);
    plans.push(plan);
    plans.sort((left, right) => left.planVersion - right.planVersion);
    this.sessionValue = deepFreeze<SessionRecord>({ ...session, plans });
    this.markChanged();
  }

  /**
   * Records an `instrumentation.ready` report.
   *
   * `applied` lists the modification records *this* install produced — for a
   * follow-up plan version, only the delta — so the records are upserted by id
   * into the session's journal, in applied order, rather than replacing it.
   * The runtime hooks and, crucially, the `unavailable` signals are kept whole:
   * a partially enabled capture must stay visible as such (AAP §0.5.5). A
   * failure previously reported for the instrumentation stage is superseded by
   * this success and cleared; a failure of any other stage is left alone.
   */
  applyInstrumentationReady(payload: InstrumentationReadyPayload): void {
    if (this.isDisposed || !this.isActiveSession(payload.sessionId)) {
      return;
    }
    const report = own({
      applied: payload.applied,
      runtimeHooks: payload.runtimeHooks,
      unavailable: payload.unavailable,
    });
    this.modificationsValue = this.upsertModifications(this.modificationsValue, report.applied);
    this.runtimeHooksValue = report.runtimeHooks;
    this.unavailableSignalsValue = report.unavailable;
    if (this.failureValue?.stage === INSTRUMENTATION_STAGE) {
      this.failureValue = undefined;
    }
    this.markChanged();
  }

  /**
   * Records an `instrumentation.failed` as the instrumentation stage's failure,
   * with the service's code, message and hint. The analysis is never touched:
   * a failure is its own field and cannot be mistaken for a result.
   */
  applyInstrumentationFailed(payload: InstrumentationFailedPayload): void {
    if (this.isDisposed || !this.isActiveSession(payload.sessionId)) {
      return;
    }
    this.setStageFailure({
      stage: INSTRUMENTATION_STAGE,
      code: payload.error.code,
      message: payload.error.message,
      hint: payload.error.hint,
    });
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /**
   * Records `capture.started`: the capture window is open.
   *
   * The counter starts at `0` and the host does not advance it. While a capture
   * runs the extension host receives no telemetry at all — `telemetry.tail`
   * goes to the DevTools panel only (AAP §0.4.2) — so the host has nothing to
   * count, and inventing a number would be exactly the faked result
   * AAP §0.5.4 forbids. The view renders a capturing indicator instead. The
   * only number that may replace the `0` mid-capture is the service's own
   * ingest counter, when a later `session.updated` carries it on the in-flight
   * capture record (see {@link applySessionRecord}).
   */
  applyCaptureStarted(payload: CaptureStartedPayload): void {
    if (this.isDisposed || !this.isActiveSession(payload.sessionId)) {
      return;
    }
    this.captureValue = Object.freeze({
      active: true,
      captureId: payload.captureId,
      eventCount: 0,
    });
    this.markChanged();
  }

  /**
   * Records `capture.stopped`: the window is closed and its event count is the
   * total the service's `CaptureSummary` reports. A capture that yielded
   * nothing legitimately reports `0`.
   */
  applyCaptureStopped(payload: CaptureStoppedPayload): void {
    if (this.isDisposed || !this.isActiveSession(payload.sessionId)) {
      return;
    }
    this.captureValue = Object.freeze({
      active: false,
      captureId: payload.captureId,
      eventCount: payload.summary.eventCount,
    });
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  /**
   * Records `analysis.completed`'s validated analysis and clears the failure it
   * supersedes. An analysis older (by `analysisVersion`) than the one held is
   * ignored entirely — it neither replaces a follow-up's newer result nor
   * clears a failure reported after it.
   */
  applyAnalysis(analysis: AnalysisResult): void {
    if (this.isDisposed || !this.isActiveSession(analysis.sessionId)) {
      return;
    }
    const incoming = own(analysis);
    const newest = this.newerAnalysis(incoming, this.analysisValue);
    if (newest !== incoming) {
      return;
    }
    this.analysisValue = incoming;
    this.failureValue = undefined;
    this.markChanged();
  }

  /**
   * Records `panel.generated` as a {@link PanelSummary}: id, title, version and
   * the fallback flag. The full specification is the DevTools panel's to
   * render; the editor only links to it. The fallback flag is kept so the view
   * labels a deterministic fallback panel as such rather than presenting it as
   * an answer (AAP §0.5.5).
   */
  applyPanelGenerated(payload: PanelGeneratedPayload): void {
    if (this.isDisposed || !this.isActiveSession(payload.sessionId)) {
      return;
    }
    const { panel } = payload;
    this.latestPanelValue = Object.freeze({
      id: payload.panelId,
      title: panel.title,
      panelVersion: panel.panelVersion,
      fallback: panel.meta?.fallback === true,
    });
    this.markChanged();
  }

  /**
   * Records `cleanup.completed`. The payload has no timestamp — its arrival is
   * the time — so `completedAt` is stamped with the host clock here, and the
   * service's own stamp replaces it with the next record. The status stays
   * visible after the session ends and across {@link resetSession}, until the
   * next session's record brings that session's own cleanup state.
   */
  applyCleanupCompleted(payload: CleanupCompletedPayload): void {
    if (this.isDisposed || !this.isActiveSession(payload.sessionId)) {
      return;
    }
    this.cleanupValue = own<SessionCleanupState>({
      status: payload.status,
      completedAt: this.now(),
      conflicts: payload.conflicts,
    });
    this.cleanupSessionId = payload.sessionId;
    this.markChanged();
  }

  /**
   * Records `target.selected`, the element shown by `TargetBadge`. A later
   * selection replaces an earlier one. With a session active, only a selection
   * for that session is accepted; with none, the selection is kept as the next
   * question's pending target.
   */
  applyTargetSelected(payload: TargetSelectedPayload): void {
    if (this.isDisposed) {
      return;
    }
    const active = this.sessionValue;
    if (active !== undefined && active.id !== payload.sessionId) {
      return;
    }
    this.targetValue = own(payload.target);
    this.targetScope = active === undefined ? 'pending' : 'session';
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Pairing and failures
  // -------------------------------------------------------------------------

  /**
   * Shows the one-time pairing code from `POST /pair/start` until it expires.
   *
   * Only `code` and `expiresAt` are copied, so nothing else an object may carry
   * can enter the store; the code is a short-lived capability, never a
   * credential (AAP §0.5.6). A value that cannot be shown — a blank code, a
   * non-finite or already-passed expiry — clears any code on display instead.
   * A timer notifies the views the moment the code expires, and the snapshot
   * omits an expired code regardless of that timer.
   */
  setPairing(pairing: PairingState): void {
    if (this.isDisposed) {
      return;
    }
    const code = pairing.code;
    const expiresAt = pairing.expiresAt;
    if (!code || !Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      this.clearPairing();
      return;
    }
    this.pairingValue = Object.freeze({ code, expiresAt });
    this.schedulePairingExpiry();
    this.markChanged();
  }

  /** Removes the pairing code from display (paired, dismissed or replaced). */
  clearPairing(): void {
    if (this.isDisposed) {
      return;
    }
    this.cancelPairingTimer();
    if (this.pairingValue === undefined) {
      return;
    }
    this.pairingValue = undefined;
    this.markChanged();
  }

  /**
   * Records a failed stage, rendered by the view with its message, hint and a
   * retry action (AAP §0.5.5). Held apart from the analysis and the panel, so
   * no code path can present a failure as a result. Only the four fields of
   * {@link StageFailure} are copied.
   */
  setStageFailure(failure: StageFailure): void {
    if (this.isDisposed) {
      return;
    }
    this.failureValue = Object.freeze({
      stage: failure.stage,
      code: failure.code,
      message: failure.message,
      ...(failure.hint !== undefined ? { hint: failure.hint } : {}),
    });
    this.markChanged();
  }

  /** Clears the failed stage, e.g. when the developer retries it. */
  clearStageFailure(): void {
    if (this.isDisposed || this.failureValue === undefined) {
      return;
    }
    this.failureValue = undefined;
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * The whole {@link WebviewState} the webview renders, as an independent,
   * JSON-serializable structured clone: every array and object in it is a copy,
   * so a consumer mutating what it received cannot affect the store. An
   * expired pairing code is omitted.
   */
  toWebviewState(): WebviewState {
    const session = this.sessionValue;
    const analysis = this.analysisValue;
    const latestPanel = this.latestPanelValue;
    const target = this.targetValue;
    const pairing = this.pairing;
    const failure = this.failureValue;
    const snapshot: WebviewState = {
      connection: {
        status: this.connectionStatusValue,
        serviceUrl: this.serviceUrlValue,
        serviceReachable: this.serviceReachableValue,
        provider: this.providerValue,
      },
      ...(session !== undefined ? { session } : {}),
      progress: this.progressValue,
      relevantFiles: this.relevantFilesValue,
      modifications: this.modificationsValue,
      ...(analysis !== undefined ? { analysis } : {}),
      ...(latestPanel !== undefined ? { latestPanel } : {}),
      ...(target !== undefined ? { target } : {}),
      capture: this.captureValue,
      cleanup: this.cleanupValue,
      ...(pairing !== undefined ? { pairing } : {}),
      ...(failure !== undefined ? { failure } : {}),
    };
    return structuredClone(snapshot);
  }

  // -------------------------------------------------------------------------
  // Private: notification
  // -------------------------------------------------------------------------

  /** Marks the store changed and, outside a batch, queues the one flush. */
  private markChanged(): void {
    if (this.isDisposed) {
      return;
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Queues a flush on the microtask queue unless one is queued or held back. */
  private scheduleFlush(): void {
    if (this.flushScheduled || this.batchDepth > 0 || this.isDisposed) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  /** Fires one snapshot when something changed and nothing holds the flush back. */
  private flush(): void {
    if (this.isDisposed || !this.dirty || this.batchDepth > 0) {
      return;
    }
    this.dirty = false;
    this.emitter.fire(this.toWebviewState());
  }

  // -------------------------------------------------------------------------
  // Private: session-record merges
  // -------------------------------------------------------------------------

  /** Whether `sessionId` names the active session. */
  private isActiveSession(sessionId: string): boolean {
    return this.sessionValue !== undefined && this.sessionValue.id === sessionId;
  }

  /**
   * Replaces the {@link sessionList} entry for `record`'s session when the list
   * holds one that is not newer. Sessions are never added here: the list is
   * `GET /sessions`'s answer, and the tree refreshes it for new sessions.
   *
   * @returns Whether the list changed.
   */
  private refreshListedSession(record: SessionRecord): boolean {
    const index = this.sessionListValue.findIndex((listed) => listed.id === record.id);
    const listed = this.sessionListValue[index];
    if (listed === undefined || record.updatedAt < listed.updatedAt) {
      return false;
    }
    const sessions = [...this.sessionListValue];
    sessions[index] = record;
    this.sessionListValue = Object.freeze(sessions);
    return true;
  }

  /**
   * The record's modification journal, followed by any record the store holds
   * that the journal does not list yet.
   *
   * The journal is append-only — a modification changes status but is never
   * removed — so a held record missing from an incoming journal means the
   * incoming record predates the `instrumentation.ready` that reported it. For
   * a current record the result is exactly `record.modifications`.
   */
  private mergeModifications(
    journal: readonly ModificationRecord[],
  ): readonly ModificationRecord[] {
    const listed = new Set(journal.map((modification) => modification.id));
    const unlisted = this.modificationsValue.filter((held) => !listed.has(held.id));
    return unlisted.length === 0 ? journal : Object.freeze([...journal, ...unlisted]);
  }

  /**
   * `held` with every record of `incoming` upserted by id: an existing record
   * is replaced in place, a new one appended, preserving applied order.
   */
  private upsertModifications(
    held: readonly ModificationRecord[],
    incoming: readonly ModificationRecord[],
  ): readonly ModificationRecord[] {
    const merged = [...held];
    for (const modification of incoming) {
      const index = merged.findIndex((existing) => existing.id === modification.id);
      if (index === -1) {
        merged.push(modification);
      } else {
        merged[index] = modification;
      }
    }
    return Object.freeze(merged);
  }

  /**
   * The newer of two analyses of the active session by `analysisVersion`; on a
   * tie the first (the authoritative source at the call site) wins.
   */
  private newerAnalysis(
    candidate: AnalysisResult | undefined,
    held: AnalysisResult | undefined,
  ): AnalysisResult | undefined {
    if (candidate === undefined) {
      return held;
    }
    if (held === undefined) {
      return candidate;
    }
    return held.analysisVersion > candidate.analysisVersion ? held : candidate;
  }

  /**
   * The held panel summary, unless the record shows it has been superseded.
   *
   * A record carries panel ids only, so it can retire a summary but never build
   * one. A summary whose id the record lists but not as the newest is
   * superseded, and is dropped until the newer `panel.generated` arrives; a
   * summary the record does not list yet is newer than the record and is kept.
   */
  private panelStillCurrent(panelIds: readonly string[]): PanelSummary | undefined {
    const held = this.latestPanelValue;
    if (held === undefined) {
      return undefined;
    }
    const superseded = panelIds.includes(held.id) && panelIds.at(-1) !== held.id;
    return superseded ? undefined : held;
  }

  /**
   * The capture window the record describes, unless a push already knows more.
   *
   * A capture the host saw start or stop that the record does not list yet
   * means the record is older than that push, so the pushed window is kept. A
   * capture the host saw stop is never reopened by a record that still shows it
   * in flight. Otherwise the record's newest capture decides.
   */
  private mergeCapture(captures: readonly CaptureRecord[]): CaptureState {
    const held = this.captureValue;
    const heldId = held.captureId;
    const newest = captures.at(-1);
    if (heldId !== undefined && !recordHasCapture(captures, heldId)) {
      return held;
    }
    if (newest === undefined) {
      return IDLE_CAPTURE;
    }
    const fromRecord = captureFromRecord(newest);
    if (newest.id === heldId && !held.active && fromRecord.active) {
      return held;
    }
    return fromRecord;
  }

  /**
   * The record's cleanup state, unless the host already received this
   * session's `cleanup.completed` and the record still says `pending` — a
   * record older than that push. A finished cleanup never returns to pending.
   */
  private mergeCleanup(record: SessionRecord): SessionCleanupState {
    const held = this.cleanupValue;
    const staleRecord =
      this.cleanupSessionId === record.id &&
      held.status !== 'pending' &&
      record.cleanup.status === 'pending';
    return staleRecord ? held : record.cleanup;
  }

  /**
   * Adopts the record's target, or keeps a selection for this session that the
   * record does not reflect yet. A pending target selected before the session
   * existed is otherwise superseded: once a session is active the badge shows
   * that session's target, never an element it was not created with.
   */
  private applyRecordTarget(record: SessionRecord): void {
    if (record.target !== undefined) {
      this.targetValue = record.target;
      this.targetScope = 'session';
      return;
    }
    if (this.targetScope === 'session' && this.targetValue !== undefined) {
      return;
    }
    this.targetValue = undefined;
    this.targetScope = undefined;
  }

  // -------------------------------------------------------------------------
  // Private: pairing expiry
  // -------------------------------------------------------------------------

  /**
   * Arms a timer that notifies the views when the displayed code expires. The
   * timer is unreferenced so it never keeps the host process alive, and it
   * re-arms itself when the delay was clamped to the timer ceiling or the clock
   * has not yet reached the expiry.
   */
  private schedulePairingExpiry(): void {
    this.cancelPairingTimer();
    const pairing = this.pairingValue;
    if (pairing === undefined || this.isDisposed) {
      return;
    }
    const delay = Math.min(Math.max(pairing.expiresAt - this.now(), 0), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.pairingTimer = undefined;
      if (this.isDisposed || this.pairingValue !== pairing) {
        return;
      }
      if (pairing.expiresAt > this.now()) {
        this.schedulePairingExpiry();
        return;
      }
      this.pairingValue = undefined;
      this.markChanged();
    }, delay);
    timer.unref();
    this.pairingTimer = timer;
  }

  /** Cancels the pairing-expiry timer, if one is armed. */
  private cancelPairingTimer(): void {
    if (this.pairingTimer !== undefined) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = undefined;
    }
  }
}
