/**
 * The session manager: the module that owns a debugging session's life —
 * creating it, moving it through the pipeline's statuses, recording what each
 * stage produced, deciding who may capture, and ending it with cleanup.
 *
 * ## Three things only this module does
 *
 * - **It is the only writer of `SessionRecord.status`.** Every status change
 *   passes through one private applier, which asks `./state-machine.ts` whether
 *   the edge exists and whether its guard is satisfied, and propagates the
 *   state machine's refusal unchanged. An illegal transition is a typed `Err`
 *   and leaves the store untouched; it is never a silent no-op.
 * - **It is the only place capture exclusivity is decided.** At most one
 *   session may hold a capture on a project at a time (AAP §0.4.2). The
 *   decision is made synchronously against an in-memory owner index keyed by
 *   the normalised project root — rebuilt from the store's open `captures`
 *   rows by {@link SessionManager.hydrate} — so no `await` separates the check
 *   from the claim. {@link SessionManager.captureOwnerForProject} is the single
 *   answer `server-agent.config` names as the owner. A conflict is reported
 *   with `CAPTURE_ALREADY_ACTIVE` and `details.owningSessionId`, which
 *   {@link isCaptureConflict} recognises so the route can answer `409` with
 *   protocol's `captureStartConflictResponseSchema`.
 * - **It is the single emitter of `cleanup.completed` for a session.** See
 *   {@link SessionManager.recordCleanupOutcome}.
 *
 * ## Lifecycle-owned edges
 *
 * Three kinds of status change carry obligations beyond the status itself, so
 * each has exactly one path and {@link SessionManager.transitionTo} refuses to
 * take it directly (after the state machine has accepted the edge):
 *
 * | Edge | The one path | Why |
 * | --- | --- | --- |
 * | `* → capturing` | {@link SessionManager.startCapture} | a capture row must open and ownership must be claimed |
 * | `capturing → analyzing \| ready` | {@link SessionManager.stopCapture} | the capture row must close with its summary and ownership must be released |
 * | `* → ended` | {@link SessionManager.end} | cleanup must run first (AAP §0.5.1) |
 *
 * A transition into `failed` from `capturing` closes the open capture and
 * releases ownership in the same step, so a failed session never blocks its
 * project. It also emits the stage's `failed` progress row through
 * `./progress.ts` — protocol's `SessionRecord` has no failure field, so that
 * persisted row is how the failing stage reaches both user interfaces
 * (AAP §0.5.5).
 *
 * ## Layering
 *
 * This module imports the protocol, instrumentation, telemetry and shared
 * packages, its two siblings, the store repository and the service's config
 * and logging modules — and nothing from `hono`, `ws`, `node:*`,
 * `../server/**`, `../pipeline/**`, `../cleanup/**`, `../instrumentation/**` or
 * `../telemetry/**`. Transport and orchestration wire **into** this layer
 * through the two ports declared below, never the reverse, so the integration
 * suites (`session-lifecycle`, `followup`, `concurrency`, `binding`) drive it
 * in-process against a temporary store with no HTTP, no WebSocket and no model
 * provider.
 *
 * ## What this module never does
 *
 * - It never touches a file of the developer's project: cleanup is delegated
 *   to the injected {@link SessionCleanupRunner}, and the modification journal
 *   stays owned by `../store/modifications-repo.ts` and
 *   `@debuggen/instrumentation`.
 * - It never reads, logs or copies the per-session request-key secret
 *   (`SessionsRepo.getOrCreateRequestKeySecret`), which lives in the store
 *   only (AAP §0.5.2).
 * - It never inspects the developer's question or the project's name. Both are
 *   stored and forwarded, nothing more (AAP §0.5.4).
 * - It never logs a record, a question, a path, a URL or a message: log fields
 *   carry identifiers, statuses, error codes and counts only.
 *
 * Every expected failure is a `Result` `Err` carrying a {@link DebuggenError}
 * from the closed code vocabulary, a developer-facing message and a hint; no
 * method throws for an expected condition.
 *
 * @example
 * ```ts
 * const manager = createSessionManager({ sessions, broadcaster: clients, progress, cleanup, config, logger });
 * await manager.hydrate();
 *
 * const created = await manager.create({ projectRoot, question, devServerUrl });
 * if (!created.ok) return created;
 * const started = await manager.startCapture(created.value.id);
 * if (!started.ok && isCaptureConflict(started.error)) {
 *   // 409 { owningSessionId: started.error.details.owningSessionId }
 * }
 * ```
 *
 * @module
 */

import type {
  InstrumentationPlan,
  ModificationConflict,
  ModificationRecord,
  ProblemUnderstanding,
  SelectedTarget,
} from '@debuggen/instrumentation';
import {
  CAPTURE_CONFLICT_ERROR_CODE,
  createEnvelope,
  isCleanupStatus,
  parseSessionRecord,
  type AnalysisResult,
  type BoundTab,
  type CaptureRecord,
  type CleanupStatus,
  type ClientKind,
  type FollowUpRecord,
  type PromptVersions,
  type ProtocolMessage,
  type RelevantFile,
  type SessionCleanup,
  type SessionProvider,
  type SessionRecord,
  type SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  basenamePosix,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  newSessionId,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
  type CaptureId,
  type Logger,
  type Result,
  type SessionId,
} from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import { PROVIDER_REQUIREMENTS, type ServiceConfig } from '../config.js';
import { sessionLogger, subsystemLogger } from '../logging.js';
import {
  MAX_SESSION_LIST_LIMIT,
  type ListSessionsOptions,
  type SessionListItem,
  type SessionsRepo,
} from '../store/sessions-repo.js';
import type { ProgressBroadcaster, SessionProgress } from './progress.js';
import {
  isTerminalSessionStatus,
  statusForStage,
  transition,
  type SessionFailure,
  type SessionTransitionContext,
} from './state-machine.js';

// ---------------------------------------------------------------------------
// Section A — the two ports
// ---------------------------------------------------------------------------

/**
 * Delivers a finished protocol frame to the connected clients of one session.
 *
 * Declared here — the folder's decision, on the precedent of
 * `ModificationJournal`, which `packages/instrumentation` declares and
 * `../store/modifications-repo.ts` implements — and satisfied structurally by
 * the client registry in `apps/local-service/src/server/clients.ts`, which
 * restates this exact shape as its `SessionBroadcastPort` conformance target
 * rather than importing it, because the server layer sits above this one.
 *
 * `./progress.ts` does not import this interface: the manager depends on the
 * progress emitter, so an import back would close a cycle. It declares its own
 * one-method `ProgressBroadcaster` instead, and
 * {@link SessionBroadcasterSatisfiesProgressBroadcaster} proves at compile time
 * that every `SessionBroadcaster` is one — so the same registry object is
 * handed to both.
 *
 * Deliberately minimal: every method added here is a constraint on another
 * folder. Delivery is best effort and synchronous; this module treats a
 * throwing broadcaster as a transport fault, logs it and keeps the committed
 * state, which a client recovers through the reopen replay.
 */
export interface SessionBroadcaster {
  /** Sends `message` to every connected client of `sessionId`. */
  broadcast(sessionId: string, message: ProtocolMessage): void;
  /** Sends `message` to the connected clients of `sessionId` whose kind is in `kinds`. */
  broadcastToKinds(sessionId: string, kinds: readonly ClientKind[], message: ProtocolMessage): void;
}

/** Accepts only `true`, so an assertion that evaluates to `false` fails to compile. */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that a {@link SessionBroadcaster} can be handed to
 * `createSessionProgress` as its `ProgressBroadcaster`: if either port drifts,
 * this alias stops compiling.
 */
export type SessionBroadcasterSatisfiesProgressBroadcaster = AssertTrue<
  SessionBroadcaster extends ProgressBroadcaster ? true : false
>;

/**
 * What one session-scoped cleanup pass concluded.
 *
 * `status` is one of protocol's four cleanup statuses. A `conflict` is a
 * first-class result, not an error: the developer edited an instrumented file,
 * the tool did not overwrite it, and the original is still in the backup
 * directory (AAP §0.5.1). `completedAt` is when the pass (or, for `pending`,
 * the attempt) concluded, in Unix epoch milliseconds; the session record
 * stamps it only for a finished pass, because protocol keeps
 * `cleanup.completedAt` absent while the status is `pending`.
 */
export interface SessionCleanupOutcome {
  readonly status: CleanupStatus;
  readonly conflicts: readonly ModificationConflict[];
  readonly completedAt: number;
}

/**
 * Runs cleanup for one session: restores every non-reverted modification
 * record of it in reverse order and reports the verdict.
 *
 * Satisfied structurally by `apps/local-service/src/cleanup/cleanup.ts`. The
 * manager only awaits it and records what it says; it never inspects, writes
 * or restores a project file itself. A runner that answers `Err` leaves the
 * session un-ended, so ending it again retries cleanup.
 */
export interface SessionCleanupRunner {
  run(sessionId: string): Promise<Result<SessionCleanupOutcome, DebuggenError>>;
}

// ---------------------------------------------------------------------------
// Section B — inputs, outputs and the manager's public surface
// ---------------------------------------------------------------------------

/** Everything {@link createSessionManager} is given; all of it is injected. */
export interface SessionManagerDeps {
  /** The session store's repository: the authority for records, plans, captures and follow-ups. */
  readonly sessions: SessionsRepo;
  /** Where finished frames go; the client registry in production. */
  readonly broadcaster: SessionBroadcaster;
  /** The progress emitter; the manager uses it for the `failed` row of a failing stage. */
  readonly progress: SessionProgress;
  /** Runs cleanup on `end`. Absent in unit contexts, where cleanup is honestly reported `pending`. */
  readonly cleanup?: SessionCleanupRunner | undefined;
  /** The provider provenance a session defaults to when its creator names none. */
  readonly config?: Pick<ServiceConfig, 'provider' | 'model'> | ServiceConfig | undefined;
  /** The service logger; defaults to `noopLogger`. Bound to `subsystem: "sessions"`. */
  readonly logger?: Logger | undefined;
  /** The clock records and frames are stamped with; defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
  /** The session id factory; defaults to `newSessionId`. */
  readonly newId?: (() => string) | undefined;
}

/**
 * What a new session is created from: protocol's `session.create` body
 * (`{ projectRoot, question, target? }`) plus the service-side context the
 * route resolved.
 */
export interface CreateSessionInput {
  /** The project's root; normalised to POSIX and required to be absolute. */
  readonly projectRoot: string;
  /** The developer's question, stored verbatim and never inspected here. */
  readonly question: string;
  /** The element the developer had selected, when they had. */
  readonly target?: SelectedTarget | undefined;
  /**
   * The project's dev-server URL, probed or launched by the route. Required by
   * the session contract: a create without one is refused with
   * `DEV_SERVER_UNAVAILABLE` rather than stored with an invented address.
   */
  readonly devServerUrl?: string | undefined;
  /** The display name; defaults to the project root's final segment. */
  readonly projectName?: string | undefined;
  /** The provider provenance; defaults to the injected configuration's. */
  readonly provider?: SessionProvider | undefined;
  /** The prompt versions already resolved; defaults to `{}`. */
  readonly promptVersions?: PromptVersions | undefined;
}

/**
 * The typed partial update for the non-status fields the pipeline produces.
 *
 * An absent key leaves its field unchanged. For the three optional record
 * fields — `target`, `understanding`, `boundTab` — a key present with
 * `undefined` removes the field. `status` and `cleanup` are deliberately not
 * patchable (their paths are {@link SessionManager.transitionTo} and
 * {@link SessionManager.recordCleanupOutcome}), and neither are the identity
 * fields or the append-only ladders (`plans`, `captures`, `followUps`), which
 * have their own methods. A patch naming any other key is refused at run time
 * too, for a caller the compiler did not check.
 */
export interface SessionPatch {
  readonly understanding?: ProblemUnderstanding | undefined;
  readonly relevantFiles?: readonly RelevantFile[];
  readonly target?: SelectedTarget | undefined;
  readonly devServerUrl?: string;
  readonly boundTab?: BoundTab | undefined;
  readonly modifications?: readonly ModificationRecord[];
  readonly panelIds?: readonly string[];
  readonly analyses?: readonly AnalysisResult[];
  readonly promptVersions?: PromptVersions;
  readonly provider?: SessionProvider;
}

/**
 * A normalised plan offered for recording. `sessionId` and `planVersion` may
 * be omitted: the manager stamps the session and the next version of its
 * ladder. When present, they must name this session and exactly that next
 * version — the ladder is append-only and gap-free.
 */
export type RecordPlanInput = Omit<InstrumentationPlan, 'planVersion' | 'sessionId'> & {
  readonly planVersion?: number | undefined;
  readonly sessionId?: string | undefined;
};

/** What {@link SessionManager.recordPlan} stored. */
export interface RecordedPlan {
  readonly session: SessionRecord;
  readonly plan: InstrumentationPlan;
}

/**
 * The outcome links a follow-up acquires after it was asked: the decision, and
 * the plan version, capture, analysis and panel that answered it.
 */
export type FollowUpOutcome = Partial<
  Pick<FollowUpRecord, 'needsNewCapture' | 'planVersion' | 'captureId' | 'analysisId' | 'panelId'>
>;

/** The session's capture owner on a project: who holds it, and which capture window. */
export interface CaptureOwner {
  readonly sessionId: SessionId;
  readonly captureId: CaptureId;
}

/** Where a stopped capture sends the session. */
export type CaptureStopNext = 'analyzing' | 'ready';

/** What {@link SessionManager.stopCapture} is told by the capture stage. */
export interface StopCaptureOptions {
  /** The aggregate `@debuggen/telemetry` computed for the capture window. */
  readonly summary: CaptureSummary;
  /**
   * `analyzing` when the capture holds evidence, `ready` for AAP §0.5.5's
   * "Capture yielded nothing" path. Decided by `pipeline/stages/capture.ts`,
   * never here.
   */
  readonly next: CaptureStopNext;
}

/** What {@link SessionManager.end} concluded. */
export interface SessionEndResult {
  readonly session: SessionRecord;
  readonly cleanup: SessionCleanupOutcome;
}

/**
 * A capture-ownership conflict: another session holds the capture on this
 * session's project. The route answers `409` with protocol's
 * `captureStartConflictResponseSchema`, reading `details.owningSessionId`.
 */
export type CaptureConflictError = DebuggenError & {
  readonly details: Readonly<Record<string, unknown>> & {
    readonly owningSessionId: string;
  };
};

/**
 * Whether `error` is the capture-ownership conflict {@link SessionManager.startCapture}
 * reports: code `CAPTURE_ALREADY_ACTIVE` with a string `details.owningSessionId`.
 *
 * A session asking for a second capture of its own is *not* this conflict: it
 * is reported as `SESSION_INVALID_STATE` without an owning session, exactly as
 * `packages/protocol/src/http.ts` describes, and parses as a plain error body.
 *
 * @param error Any value, typically the `error` of a failed `startCapture`.
 * @returns `true` when the route may answer `409 { owningSessionId }`.
 */
export function isCaptureConflict(error: unknown): error is CaptureConflictError {
  return (
    DebuggenError.is(error) &&
    error.code === CAPTURE_CONFLICT_ERROR_CODE &&
    typeof error.details?.['owningSessionId'] === 'string'
  );
}

/**
 * The session manager of one service process.
 *
 * Every method answers with a `Result`; none throws for an expected condition.
 * Every successful mutation is persisted through the store before anything is
 * broadcast, and every broadcast carries the record as stored.
 */
export interface SessionManager {
  /**
   * Rebuilds the capture-owner index from the store's open `captures` rows.
   *
   * Called once by `src/main.ts` at the wiring step of its start-up order —
   * after the store is migrated and modification reconciliation has run — so a
   * service restart can neither lose nor duplicate a capture owner. Idempotent:
   * a second call rebuilds the same index. An open row on a session that is
   * not `capturing` is the orphan of an interrupted start and is closed rather
   * than indexed. The index is also built lazily on first use, so a caller that
   * never hydrates still gets a correct answer.
   *
   * @returns `ok` once every readable session was indexed, or the first store
   * error (after indexing everything that could be read).
   */
  hydrate(): Promise<Result<void, DebuggenError>>;

  /**
   * Creates a session in status `created` and broadcasts `session.created`.
   * Emits no progress row: the pipeline owns stage events.
   */
  create(input: CreateSessionInput): Promise<Result<SessionRecord, DebuggenError>>;

  /** Reads one session; `ok(undefined)` when none has this id. */
  get(sessionId: SessionId): Result<SessionRecord | undefined, DebuggenError>;

  /**
   * Lists sessions from their indexed projections, most recently updated
   * first — the rows `GET /sessions` and the editor's Sessions tree render.
   */
  list(options?: ListSessionsOptions): Result<readonly SessionListItem[], DebuggenError>;

  /**
   * Moves a session to `to`: the only public status writer.
   *
   * The state machine's refusal is propagated unchanged. A lifecycle-owned
   * edge (see the module overview) is refused with `SESSION_INVALID_STATE`
   * naming the method that owns it. A transition into `failed` requires
   * `context.failure`, emits that stage's `failed` progress row and closes an
   * open capture. Broadcasts `session.updated`.
   */
  transitionTo(
    sessionId: SessionId,
    to: SessionStatus,
    context?: SessionTransitionContext,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * Applies a {@link SessionPatch}: merged immutably, re-validated against the
   * session contract, persisted, broadcast as `session.updated`.
   */
  patch(sessionId: SessionId, patch: SessionPatch): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * Appends one version to the session's plan ladder — in the store's `plans`
   * table and on the record — and broadcasts `session.updated`. Plans are
   * append-only; computing a follow-up delta is `pipeline/stages/followup.ts`'s
   * job, not this method's.
   */
  recordPlan(
    sessionId: SessionId,
    plan: RecordPlanInput,
  ): Promise<Result<RecordedPlan, DebuggenError>>;

  /**
   * Records a follow-up question — in the store's `followups` table and on the
   * record — and broadcasts `session.updated`. The question is stored, never
   * inspected.
   */
  appendFollowUp(
    sessionId: SessionId,
    question: string,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * Stamps the outcome links onto the session's most recent follow-up. Only
   * the defined members of `outcome` change; the question and its time never
   * do.
   */
  recordFollowUpOutcome(
    sessionId: SessionId,
    outcome: FollowUpOutcome,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * Mirrors the tab binding onto the record (`undefined` clears it) and
   * broadcasts `session.updated`. Binding policy — origin matching, the
   * tab-to-session index and the `session.bound` announcements — belongs to
   * `src/server/routes/binding.ts`; this is only the record mutation it calls.
   */
  setBoundTab(
    sessionId: SessionId,
    boundTab: BoundTab | undefined,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * The session holding the capture on `projectRoot`, if any — the single
   * answer `server-agent.config` names as the owner, consumed by
   * `src/instrumentation/service.ts` and `src/dev-server/**`. The argument is
   * normalised exactly as a created session's root is.
   */
  captureOwnerForProject(projectRoot: string): CaptureOwner | undefined;

  /**
   * Opens a capture window, claims the project's capture ownership and moves
   * the session to `capturing`; broadcasts `session.updated` then
   * `capture.started`.
   *
   * @returns The new capture's id, or `Err`: a {@link CaptureConflictError}
   * when another session owns the project's capture; `SESSION_INVALID_STATE`
   * when this session already holds one (with its `captureId` in `details`),
   * has no plan, or may not move to `capturing` from its status.
   */
  startCapture(
    sessionId: SessionId,
  ): Promise<Result<{ readonly captureId: CaptureId }, DebuggenError>>;

  /**
   * Closes the session's capture window with its summary, releases the
   * project's ownership, broadcasts `capture.stopped` and moves the session to
   * `options.next` (broadcasting `session.updated`).
   */
  stopCapture(
    sessionId: SessionId,
    options: StopCaptureOptions,
  ): Promise<Result<CaptureRecord, DebuggenError>>;

  /**
   * Ends a session: closes any open capture, runs cleanup, records its
   * outcome and moves the session to `ended`. Idempotent — ending an ended
   * session returns its stored record and cleanup without re-running
   * anything — and concurrent calls share one run.
   */
  end(sessionId: SessionId): Promise<Result<SessionEndResult, DebuggenError>>;

  /**
   * Writes a cleanup outcome onto the session and broadcasts `session.updated`
   * and `cleanup.completed`.
   *
   * **The single emitter of `cleanup.completed` for a session-scoped cleanup.**
   * Addressed to `apps/local-service/src/cleanup/cleanup.ts`: route every
   * session-scoped result through this method instead of broadcasting
   * directly — including the start-up reconciliation across all sessions,
   * which calls it once per affected session — so a developer never sees a
   * duplicated or contradictory cleanup report. Permitted on an ended session,
   * because reconciliation runs whatever the owning session's status.
   */
  recordCleanupOutcome(
    sessionId: SessionId,
    outcome: SessionCleanupOutcome,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * Moves the session to `failed` for `failure` — the stage, code, message and
   * hint both user interfaces render — emitting that stage's `failed` progress
   * row. A stage failure surfaces this way, never as a partial success.
   */
  fail(
    sessionId: SessionId,
    failure: SessionFailure,
  ): Promise<Result<SessionRecord, DebuggenError>>;

  /**
   * Re-enters the status that owns the failing stage (`statusForStage`), from
   * `failed` only. A capture-stage retry reopens a capture through
   * {@link SessionManager.startCapture}. There is no path from `failed` to
   * `generated`; a stage that owns no status (`followup`, `cleanup`) is refused
   * with a hint naming its own retry.
   */
  retry(
    sessionId: SessionId,
    failure: Pick<SessionFailure, 'stage'>,
  ): Promise<Result<SessionRecord, DebuggenError>>;
}

// ---------------------------------------------------------------------------
// Section C — module-private vocabulary and error builders
// ---------------------------------------------------------------------------

/** The `subsystem` binding every record from this module carries, as `./progress.ts` does. */
const LOG_SUBSYSTEM = 'sessions';

/** The keys a {@link SessionPatch} may carry; anything else is refused at run time. */
const PATCHABLE_FIELDS: ReadonlySet<string> = new Set<keyof SessionPatch>([
  'understanding',
  'relevantFiles',
  'target',
  'devServerUrl',
  'boundTab',
  'modifications',
  'panelIds',
  'analyses',
  'promptVersions',
  'provider',
]);

/**
 * The optional record fields a patch may remove by naming them with
 * `undefined`. Every other patchable field is required on the record, so an
 * `undefined` for it means "unchanged".
 */
const REMOVABLE_FIELDS = ['target', 'understanding', 'boundTab'] as const;

/** The two statuses a stopped capture may send its session to. */
const CAPTURE_STOP_TARGETS: ReadonlySet<string> = new Set<CaptureStopNext>(['analyzing', 'ready']);

/** The message a stage failure falls back to when a caught error carried none. */
const CLEANUP_FAILURE_FALLBACK = 'Cleanup could not finish for this session.';

/**
 * The capture-owner index key of a project root: POSIX separators, lexically
 * normalised. A created session's `projectRoot` is already in this form, so
 * applying it again is the identity; a caller's argument is brought to it.
 */
function projectKey(projectRoot: string): string {
  return normalizePosix(toPosix(projectRoot));
}

/** The refusal for an id that names no stored session. */
function sessionNotFound(sessionId: SessionId): DebuggenError {
  return new DebuggenError('SESSION_NOT_FOUND', 'No debugging session with this id exists.', {
    hint: 'Reopen the session from the Sessions view or start a new one; a session older than the retention window is purged.',
    details: { sessionId },
  });
}

/**
 * A request the session's current state does not admit. `reason` is the
 * machine-readable cause a caller or a test tells refusals apart by.
 */
function invalidState(
  message: string,
  hint: string,
  details: Readonly<Record<string, unknown>> & { readonly reason: string },
): DebuggenError {
  return new DebuggenError('SESSION_INVALID_STATE', message, { hint, details });
}

/** The refusal for a mutation of a session that has ended. */
function sessionEnded(sessionId: SessionId, operation: string): DebuggenError {
  return invalidState(
    'This session has ended and can no longer change.',
    'Start a new session to keep debugging; the ended one stays available to reopen.',
    { sessionId, operation, reason: 'session-ended' },
  );
}

/**
 * The refusal for a status change that has exactly one owning method (see the
 * module overview's table), taken through `transitionTo` instead.
 */
function lifecycleOwned(from: SessionStatus, to: SessionStatus, via: string): DebuggenError {
  const hints: Readonly<Record<string, string>> = {
    startCapture:
      'Start the capture instead: it opens the capture window and claims the project before the session moves to "capturing".',
    stopCapture:
      'Stop the capture instead: it closes the capture window with its summary and releases the project first.',
    end: 'End the session instead: cleanup has to run before a session is marked "ended".',
  };

  return invalidState(
    `The session's move from "${from}" to "${to}" is made by ${via}(), not by a direct status change.`,
    hints[via] ?? 'Use the session operation that owns this status change.',
    { from, to, via, reason: 'lifecycle-owned-transition' },
  );
}

/** Whether `captures` holds a capture with this id. */
function hasCapture(captures: readonly CaptureRecord[], captureId: CaptureId): boolean {
  return captures.some((capture) => capture.id === captureId);
}

/**
 * `captures` with `capture` in place of the element sharing its id, or with
 * it appended when none does — order preserved, input untouched.
 */
function mirrorCapture(
  captures: readonly CaptureRecord[],
  capture: CaptureRecord,
): CaptureRecord[] {
  return hasCapture(captures, capture.id)
    ? captures.map((existing) => (existing.id === capture.id ? capture : existing))
    : [...captures, capture];
}

/** The newest capture on the record that is still in flight, if any. */
function inFlightCapture(record: SessionRecord): CaptureRecord | undefined {
  for (let index = record.captures.length - 1; index >= 0; index -= 1) {
    const capture = record.captures[index];

    if (capture !== undefined && capture.stoppedAt === undefined) {
      return capture;
    }
  }

  return undefined;
}

/**
 * The record with the optional field `key` removed — a fresh object, so the
 * loaded record is never mutated and the stored JSON carries an absent key
 * rather than a present `undefined`.
 */
function withoutField(
  record: SessionRecord,
  key: (typeof REMOVABLE_FIELDS)[number],
): SessionRecord {
  const copy: Partial<SessionRecord> = { ...record };
  delete copy[key];
  return copy as SessionRecord;
}

/** The outcome a stored cleanup state describes, for an already-ended session. */
function outcomeOf(cleanup: SessionCleanup, fallbackTime: number): SessionCleanupOutcome {
  return {
    status: cleanup.status,
    conflicts: cleanup.conflicts,
    completedAt: cleanup.completedAt ?? fallbackTime,
  };
}

/** The session-record form of a cleanup outcome: `completedAt` only for a finished pass. */
function toSessionCleanup(outcome: SessionCleanupOutcome, fallbackTime: number): SessionCleanup {
  const conflicts = [...outcome.conflicts];

  if (outcome.status === 'pending') {
    return { status: outcome.status, conflicts };
  }

  const completedAt =
    Number.isFinite(outcome.completedAt) && outcome.completedAt > 0
      ? outcome.completedAt
      : fallbackTime;

  return { status: outcome.status, completedAt, conflicts };
}

/**
 * The provider provenance the injected configuration describes: its provider,
 * and its model only when that provider is one that runs a model — the
 * deterministic provider has none, and recording one would make the session's
 * provenance untrue.
 */
function providerFromConfig(
  config: Pick<ServiceConfig, 'provider' | 'model'> | undefined,
): SessionProvider | undefined {
  if (config === undefined) {
    return undefined;
  }

  const usesModel = PROVIDER_REQUIREMENTS[config.provider].includes('DEBUGGEN_MODEL');

  return usesModel && config.model !== undefined
    ? { id: config.provider, model: config.model }
    : { id: config.provider };
}

/**
 * The owning method of a lifecycle-owned edge, or `undefined` for an edge
 * {@link SessionManager.transitionTo} may take directly.
 */
function lifecycleOwnerOf(from: SessionStatus, to: SessionStatus): string | undefined {
  if (to === 'capturing') {
    return 'startCapture';
  }
  if (to === 'ended') {
    return 'end';
  }
  if (from === 'capturing' && CAPTURE_STOP_TARGETS.has(to)) {
    return 'stopCapture';
  }
  return undefined;
}

/** The conflict another session's capture on the same project produces. */
function captureConflict(
  sessionId: SessionId,
  owner: CaptureOwner,
  projectRoot: string,
): CaptureConflictError {
  return new DebuggenError(
    CAPTURE_CONFLICT_ERROR_CODE,
    'Another debugging session is already capturing this project.',
    {
      hint: 'Stop or end the capture in the other session, then start this capture again.',
      details: {
        sessionId,
        owningSessionId: owner.sessionId,
        projectRoot,
        reason: 'project-capture-owned',
      },
    },
  ) as CaptureConflictError;
}

/** The refusal for a second capture of a session that already holds one. */
function ownCaptureActive(sessionId: SessionId, captureId: CaptureId | undefined): DebuggenError {
  return invalidState(
    'This session already has a capture running.',
    'Stop the running capture before starting another one.',
    {
      sessionId,
      ...(captureId === undefined ? {} : { captureId }),
      reason: 'capture-already-active',
    },
  );
}

/**
 * Runs `body` as a promise: its value resolves the promise and a throw rejects
 * it, exactly as the body of an `async` function would — without claiming an
 * `await` the body does not have.
 */
function settle<T>(body: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(body());
  });
}

// ---------------------------------------------------------------------------
// Section D — the manager
// ---------------------------------------------------------------------------

/**
 * Creates the session manager.
 *
 * @param deps The store repository, the broadcaster, the progress emitter and,
 * optionally, the cleanup runner, configuration, logger, clock and id factory.
 * @returns The manager. Its only state is the capture-owner index and the set
 * of `end` calls in flight; everything else lives in the store.
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { sessions, broadcaster, progress } = deps;
  const clock = deps.now ?? nowEpochMs;
  const mintId = deps.newId ?? newSessionId;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);

  /**
   * The capture-owner index: normalised project root → the session holding
   * the open capture window there. The store's open `captures` rows are the
   * authority; this map is the synchronous index the exclusivity decision is
   * made against, so that no `await` separates checking from claiming.
   *
   * Ownership is released on **every** exit path — `stopCapture`, `end`, a
   * transition into `failed`, and a `startCapture` whose transition could not
   * be applied — which `apps/local-service/test/integration/concurrency.test.ts`
   * proves.
   */
  const owners = new Map<string, CaptureOwner>();
  let indexed = false;

  /** `end` calls in flight, so concurrent calls share one cleanup run. */
  const endsInFlight = new Map<SessionId, Promise<Result<SessionEndResult, DebuggenError>>>();

  /**
   * The injected clock's reading. A clock that throws or answers something
   * other than a positive finite number is replaced by the wall clock rather
   * than allowed to fail a write.
   */
  function stamp(): number {
    try {
      const value = clock();

      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    } catch {
      // Fall through: an injected clock is a test seam, and its failure must
      // not cost the developer a session change.
    }

    return nowEpochMs();
  }

  /** The `updatedAt` of the next version of `record`: never earlier than the current one. */
  function nextStamp(record: SessionRecord): number {
    return Math.max(record.updatedAt, stamp());
  }

  /** The logger for one session's work, with `captureId` bound when one is active. */
  function scoped(sessionId: SessionId, captureId?: CaptureId): Logger {
    return sessionLogger(log, sessionId, captureId);
  }

  /**
   * Builds and broadcasts one frame to the session's clients. A builder or
   * broadcaster that throws is a transport fault: logged with the frame type
   * and the error code only, never allowed to undo committed state.
   */
  function send(sessionId: SessionId, type: string, build: () => ProtocolMessage): void {
    try {
      broadcaster.broadcast(sessionId, build());
    } catch (thrown) {
      scoped(sessionId).warn('a frame could not be broadcast; clients recover it on replay', {
        type,
        code: DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED').code,
      });
    }
  }

  /** Broadcasts `session.updated` carrying the record as stored. */
  function announceUpdated(session: SessionRecord): void {
    send(session.id, 'session.updated', () =>
      createEnvelope('session.updated', { session }, { ts: stamp() }),
    );
  }

  /** Reads a session that must exist: `SESSION_NOT_FOUND` when it does not. */
  function load(sessionId: SessionId): Result<SessionRecord, DebuggenError> {
    const read = sessions.get(sessionId);

    if (isErr(read)) {
      return read;
    }

    return read.value === undefined ? err(sessionNotFound(sessionId)) : ok(read.value);
  }

  /**
   * Validates `next` against the session contract and persists it through
   * `SessionsRepo.update`, which rewrites the document and its status
   * projection in one transaction — so a status and the change that goes with
   * it (a capture appended, a cleanup outcome) are one write a crash cannot
   * separate. A record the schema rejects is a product defect: logged at
   * `error` with its code only, never stored.
   */
  function commit(next: SessionRecord, operation: string): Result<SessionRecord, DebuggenError> {
    const parsed = parseSessionRecord(next);

    if (isErr(parsed)) {
      scoped(next.id).error('a session change was rejected by the session contract', {
        operation,
        code: parsed.error.code,
      });
      return parsed;
    }

    const stored = sessions.update(parsed.value);

    if (isErr(stored)) {
      scoped(next.id).warn('a session change could not be stored', {
        operation,
        code: stored.error.code,
      });
    }

    return stored;
  }

  /**
   * The one status applier every status change goes through: the state
   * machine decides, `commit` persists the status together with `changes`,
   * the failing stage's progress row is emitted for a transition into
   * `failed`, and `session.updated` is broadcast last.
   */
  function applyTransition(
    record: SessionRecord,
    to: SessionStatus,
    context: SessionTransitionContext,
    changes: Partial<Omit<SessionRecord, 'id' | 'status' | 'createdAt'>>,
    operation: string,
  ): Result<SessionRecord, DebuggenError> {
    const verdict = transition(record.status, to, context);

    if (isErr(verdict)) {
      return verdict;
    }

    const stored = commit(
      { ...record, ...changes, status: verdict.value, updatedAt: nextStamp(record) },
      operation,
    );

    if (isErr(stored)) {
      return stored;
    }

    const session = stored.value;
    const logger = scoped(session.id);

    if (verdict.value === 'failed' && context.failure !== undefined) {
      const row = progress.stageFailed(session.id, context.failure);

      if (isErr(row)) {
        logger.error('the failing stage could not be reported as a progress row', {
          stage: context.failure.stage,
          code: row.error.code,
        });
      }
    }

    logger.info('session status changed', { operation, from: record.status, to: session.status });
    announceUpdated(session);

    return ok(session);
  }

  // -------------------------------------------------------------------------
  // The capture-owner index
  // -------------------------------------------------------------------------

  /** Removes the project's owner entry when, and only when, it names this session. */
  function releaseOwnership(record: SessionRecord): void {
    const key = projectKey(record.projectRoot);

    if (owners.get(key)?.sessionId === record.id) {
      owners.delete(key);
    }
  }

  /**
   * Closes the session's open capture window, if it has one, and releases its
   * ownership. Used on the way into `failed` and `ended`, where no summary
   * exists: the window closes without one.
   *
   * @returns The record's captures with the closed window mirrored, or
   * `undefined` when nothing was closed.
   */
  function closeOpenCapture(record: SessionRecord, operation: string): CaptureRecord[] | undefined {
    releaseOwnership(record);

    const logger = scoped(record.id);
    const active = sessions.getActiveCapture(record.id);

    if (isErr(active)) {
      logger.warn('the open capture window could not be read', {
        operation,
        code: active.error.code,
      });
      return undefined;
    }

    if (active.value === undefined) {
      return undefined;
    }

    const open = active.value.capture;
    const stopped = sessions.stopCapture({
      captureId: open.id,
      stoppedAt: Math.max(stamp(), open.startedAt),
    });

    if (isErr(stopped)) {
      scoped(record.id, open.id).warn('the open capture window could not be closed', {
        operation,
        code: stopped.error.code,
      });
      return undefined;
    }

    scoped(record.id, open.id).info('open capture window closed', { operation });

    return mirrorCapture(record.captures, stopped.value.capture);
  }

  /** One index entry under construction, with the start time ties are broken by. */
  interface IndexedOwner {
    readonly owner: CaptureOwner;
    readonly startedAt: number;
  }

  /**
   * Indexes one session's open capture window into `index`.
   *
   * - No open window: nothing to index. A `capturing` session in this state
   *   lost its window's close to a crash; it is logged, and `stopCapture` or
   *   `end` recovers it.
   * - An open window on a session that is not `capturing`: the orphan of a
   *   start interrupted between opening the row and committing the status.
   *   Closed rather than indexed, so it cannot block the project.
   * - Two `capturing` sessions with open windows on one project, which the
   *   manager never produces: the earlier-started window keeps ownership.
   */
  function indexSession(
    item: SessionListItem,
    index: Map<string, IndexedOwner>,
  ): Result<void, DebuggenError> {
    const active = sessions.getActiveCapture(item.id);

    if (isErr(active)) {
      scoped(item.id).warn('an open capture window could not be read while indexing', {
        code: active.error.code,
      });
      return active;
    }

    const open = active.value?.capture;

    if (open === undefined) {
      if (item.status === 'capturing') {
        scoped(item.id).warn('a capturing session has no open capture window; stop or end it', {});
      }
      return ok(undefined);
    }

    if (item.status !== 'capturing') {
      const stopped = sessions.stopCapture({
        captureId: open.id,
        stoppedAt: Math.max(stamp(), open.startedAt),
      });

      if (isErr(stopped)) {
        return stopped;
      }

      const record = sessions.get(item.id);

      if (
        !isErr(record) &&
        record.value !== undefined &&
        hasCapture(record.value.captures, open.id)
      ) {
        const current = record.value;
        commit(
          {
            ...current,
            captures: mirrorCapture(current.captures, stopped.value.capture),
            updatedAt: nextStamp(current),
          },
          'hydrate',
        );
      }

      scoped(item.id, open.id).warn('an orphaned capture window was closed', {
        status: item.status,
      });
      return ok(undefined);
    }

    const key = projectKey(item.projectRoot);
    const existing = index.get(key);

    if (existing !== undefined) {
      scoped(item.id, open.id).error('two sessions hold an open capture window on one project', {
        owningSessionId: existing.owner.sessionId,
      });

      if (open.startedAt >= existing.startedAt) {
        return ok(undefined);
      }
    }

    index.set(key, {
      owner: Object.freeze({ sessionId: item.id, captureId: open.id }),
      startedAt: open.startedAt,
    });

    return ok(undefined);
  }

  /**
   * Rebuilds the owner index from the store. Every session is read first and
   * processed second, because closing an orphaned window rewrites its record
   * and would otherwise reorder the most-recently-updated listing underneath
   * the paging. The new index replaces the old one in one step.
   */
  function rebuildIndex(): Result<void, DebuggenError> {
    const items: SessionListItem[] = [];
    let firstError: DebuggenError | undefined;

    for (let offset = 0; ;) {
      const page = sessions.list({ limit: MAX_SESSION_LIST_LIMIT, offset });

      if (isErr(page)) {
        firstError = page.error;
        break;
      }

      items.push(...page.value.items);
      offset += page.value.items.length;

      if (page.value.items.length === 0 || offset >= page.value.total) {
        break;
      }
    }

    const index = new Map<string, IndexedOwner>();

    for (const item of items) {
      const indexedOne = indexSession(item, index);

      if (isErr(indexedOne)) {
        firstError ??= indexedOne.error;
      }
    }

    owners.clear();
    for (const [key, entry] of index) {
      owners.set(key, entry.owner);
    }
    indexed = true;

    log.info('capture-owner index rebuilt', {
      sessions: items.length,
      owners: owners.size,
      complete: firstError === undefined,
    });

    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  /** Builds the index on first use for a caller that never hydrated. */
  function ensureIndexed(): void {
    if (indexed) {
      return;
    }

    const rebuilt = rebuildIndex();

    if (isErr(rebuilt)) {
      log.warn('the capture-owner index was built from a partial read of the store', {
        code: rebuilt.error.code,
      });
    }
  }

  /**
   * The project's owner, verified against the store: an entry whose session
   * no longer holds that open window — its session purged, or the window
   * closed outside this manager — is dropped rather than allowed to block the
   * project. When the store cannot be read the entry is kept: refusing a
   * capture is recoverable, a second concurrent capture is not.
   */
  function liveOwner(key: string): CaptureOwner | undefined {
    const owner = owners.get(key);

    if (owner === undefined) {
      return undefined;
    }

    const active = sessions.getActiveCapture(owner.sessionId);

    if (isErr(active)) {
      return owner;
    }

    const open = active.value?.capture;

    if (open === undefined) {
      owners.delete(key);
      scoped(owner.sessionId, owner.captureId).warn('a stale capture owner was dropped', {});
      return undefined;
    }

    if (open.id !== owner.captureId) {
      const refreshed = Object.freeze({ sessionId: owner.sessionId, captureId: open.id });
      owners.set(key, refreshed);
      return refreshed;
    }

    return owner;
  }

  // -------------------------------------------------------------------------
  // Session CRUD and transitions
  // -------------------------------------------------------------------------

  function hydrate(): Result<void, DebuggenError> {
    return rebuildIndex();
  }

  function create(input: CreateSessionInput): Result<SessionRecord, DebuggenError> {
    const posix = typeof input.projectRoot === 'string' ? toPosix(input.projectRoot) : '';

    if (posix.length === 0 || isWindowsAbsolute(posix) || !isAbsolutePosix(posix)) {
      return err(
        new DebuggenError('PROJECT_NOT_FOUND', 'The project root must be an absolute path.', {
          hint: 'Start the session from a workspace folder opened in VS Code, whose absolute path identifies the project.',
          details: { reason: 'project-root-not-absolute' },
        }),
      );
    }

    const devServerUrl = input.devServerUrl;

    if (devServerUrl === undefined || devServerUrl.length === 0) {
      return err(
        new DebuggenError(
          'DEV_SERVER_UNAVAILABLE',
          "A session needs the project's dev-server URL, and none was found.",
          {
            hint: "Start the project's dev server, or launch it from Debug Generator, then start the session again.",
            details: { reason: 'dev-server-url-missing' },
          },
        ),
      );
    }

    const provider = input.provider ?? providerFromConfig(deps.config);

    if (provider === undefined) {
      return err(
        new DebuggenError('CONFIG_INVALID', 'No model provider is configured for new sessions.', {
          hint: 'Set DEBUGGEN_PROVIDER (and, for a provider that runs a model, DEBUGGEN_MODEL), then restart the service.',
          details: { reason: 'provider-missing' },
        }),
      );
    }

    const projectRoot = normalizePosix(posix);
    const basename = basenamePosix(projectRoot);
    const createdAt = stamp();
    const candidate: SessionRecord = {
      id: mintId(),
      projectRoot,
      projectName: input.projectName ?? (basename.length > 0 ? basename : projectRoot),
      devServerUrl,
      createdAt,
      updatedAt: createdAt,
      status: 'created',
      question: input.question,
      followUps: [],
      ...(input.target === undefined ? {} : { target: input.target }),
      relevantFiles: [],
      plans: [],
      modifications: [],
      captures: [],
      panelIds: [],
      analyses: [],
      cleanup: { status: 'pending', conflicts: [] },
      promptVersions: input.promptVersions ?? {},
      provider,
    };

    const parsed = parseSessionRecord(candidate);

    if (isErr(parsed)) {
      log.warn('a new session was rejected by the session contract and was not stored', {
        code: parsed.error.code,
      });
      return parsed;
    }

    const stored = sessions.insert(parsed.value);

    if (isErr(stored)) {
      return stored;
    }

    const session = stored.value;
    scoped(session.id).info('session created', { status: session.status });
    send(session.id, 'session.created', () =>
      createEnvelope('session.created', { session }, { ts: stamp() }),
    );

    return ok(session);
  }

  function get(sessionId: SessionId): Result<SessionRecord | undefined, DebuggenError> {
    return sessions.get(sessionId);
  }

  function list(options?: ListSessionsOptions): Result<readonly SessionListItem[], DebuggenError> {
    const page = sessions.list(options);
    return isErr(page) ? page : ok(page.value.items);
  }

  function transitionTo(
    sessionId: SessionId,
    to: SessionStatus,
    context: SessionTransitionContext = {},
  ): Result<SessionRecord, DebuggenError> {
    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    // The state machine speaks first, and its refusal travels unchanged.
    const verdict = transition(record.status, to, context);

    if (isErr(verdict)) {
      return verdict;
    }

    const owner = lifecycleOwnerOf(record.status, to);

    if (owner !== undefined) {
      return err(lifecycleOwned(record.status, to, owner));
    }

    if (to === 'failed') {
      const captures = closeOpenCapture(record, 'transitionTo');
      return applyTransition(
        record,
        to,
        context,
        captures === undefined ? {} : { captures },
        'transitionTo',
      );
    }

    return applyTransition(record, to, context, {}, 'transitionTo');
  }

  function patch(
    sessionId: SessionId,
    changes: SessionPatch,
  ): Result<SessionRecord, DebuggenError> {
    if (typeof changes !== 'object' || changes === null) {
      return err(
        invalidState('A session patch must be an object of fields.', 'Pass the fields to change.', {
          sessionId,
          reason: 'invalid-patch',
        }),
      );
    }

    const refused = Object.keys(changes).filter((key) => !PATCHABLE_FIELDS.has(key));

    if (refused.length > 0) {
      return err(
        invalidState(
          'A session patch named fields that a patch may not change.',
          'Change the status with transitionTo() and the cleanup state with recordCleanupOutcome(); plans, captures and follow-ups have their own methods, and identity fields never change.',
          { sessionId, fields: refused, reason: 'field-not-patchable' },
        ),
      );
    }

    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    if (isTerminalSessionStatus(record.status)) {
      return err(sessionEnded(sessionId, 'patch'));
    }

    let base = record;

    for (const key of REMOVABLE_FIELDS) {
      if (Object.hasOwn(changes, key) && changes[key] === undefined) {
        base = withoutField(base, key);
      }
    }

    const next: SessionRecord = {
      ...base,
      ...(changes.understanding === undefined ? {} : { understanding: changes.understanding }),
      ...(changes.target === undefined ? {} : { target: changes.target }),
      ...(changes.boundTab === undefined ? {} : { boundTab: changes.boundTab }),
      ...(changes.relevantFiles === undefined ? {} : { relevantFiles: [...changes.relevantFiles] }),
      ...(changes.devServerUrl === undefined ? {} : { devServerUrl: changes.devServerUrl }),
      ...(changes.modifications === undefined ? {} : { modifications: [...changes.modifications] }),
      ...(changes.panelIds === undefined ? {} : { panelIds: [...changes.panelIds] }),
      ...(changes.analyses === undefined ? {} : { analyses: [...changes.analyses] }),
      ...(changes.promptVersions === undefined
        ? {}
        : { promptVersions: { ...changes.promptVersions } }),
      ...(changes.provider === undefined ? {} : { provider: changes.provider }),
      updatedAt: nextStamp(record),
    };

    const stored = commit(next, 'patch');

    if (isErr(stored)) {
      return stored;
    }

    scoped(sessionId).debug('session patched', { fields: Object.keys(changes) });
    announceUpdated(stored.value);

    return stored;
  }

  function recordPlan(
    sessionId: SessionId,
    plan: RecordPlanInput,
  ): Result<RecordedPlan, DebuggenError> {
    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    if (isTerminalSessionStatus(record.status)) {
      return err(sessionEnded(sessionId, 'recordPlan'));
    }

    if (plan.sessionId !== undefined && plan.sessionId !== sessionId) {
      return err(
        new DebuggenError('PLAN_INVALID', 'The plan names a different session.', {
          hint: 'Record a plan on the session it was normalised for.',
          details: { sessionId, reason: 'plan-session-mismatch' },
        }),
      );
    }

    const expected = sessions.nextPlanVersion(sessionId);

    if (isErr(expected)) {
      return expected;
    }

    const planVersion = plan.planVersion ?? expected.value;

    if (planVersion !== expected.value) {
      return err(
        new DebuggenError(
          'PLAN_INVALID',
          "The plan's version does not extend the session's plan ladder.",
          {
            hint: 'A new plan carries the next version of the ladder: one more than the newest stored plan.',
            details: {
              sessionId,
              expected: expected.value,
              reason: 'plan-version-out-of-sequence',
            },
          },
        ),
      );
    }

    const candidate: InstrumentationPlan = { ...plan, sessionId, planVersion };

    // Validated against the session contract before the first write, so a plan
    // the record cannot hold (past its plan-count bound, say) is refused while
    // the store is still untouched.
    const preview = parseSessionRecord({ ...record, plans: [...record.plans, candidate] });

    if (isErr(preview)) {
      scoped(sessionId).warn('a plan was rejected by the session contract and was not stored', {
        planVersion,
        code: preview.error.code,
      });
      return preview;
    }

    const inserted = sessions.insertPlan(candidate);

    if (isErr(inserted)) {
      return inserted;
    }

    const stored = commit(
      { ...record, plans: [...record.plans, inserted.value], updatedAt: nextStamp(record) },
      'recordPlan',
    );

    if (isErr(stored)) {
      scoped(sessionId).error('a plan was stored but the session record could not mirror it', {
        planVersion,
        code: stored.error.code,
      });
      return stored;
    }

    scoped(sessionId).info('plan recorded', {
      planVersion,
      actions: inserted.value.instrumentationTargets.length,
    });
    announceUpdated(stored.value);

    return ok({ session: stored.value, plan: inserted.value });
  }

  function appendFollowUp(
    sessionId: SessionId,
    question: string,
  ): Result<SessionRecord, DebuggenError> {
    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    if (isTerminalSessionStatus(record.status)) {
      return err(sessionEnded(sessionId, 'appendFollowUp'));
    }

    // The question is stored and forwarded, never read: no branch here
    // depends on its content (AAP §0.5.4).
    const followUp: FollowUpRecord = { question, askedAt: stamp() };
    const preview = parseSessionRecord({ ...record, followUps: [...record.followUps, followUp] });

    if (isErr(preview)) {
      scoped(sessionId).warn(
        'a follow-up was rejected by the session contract and was not stored',
        {
          code: preview.error.code,
        },
      );
      return preview;
    }

    const appended = sessions.appendFollowUp(sessionId, followUp);

    if (isErr(appended)) {
      return appended;
    }

    const stored = commit(
      {
        ...record,
        followUps: [...record.followUps, appended.value],
        updatedAt: nextStamp(record),
      },
      'appendFollowUp',
    );

    if (isErr(stored)) {
      return stored;
    }

    scoped(sessionId).info('follow-up recorded', { followUps: stored.value.followUps.length });
    announceUpdated(stored.value);

    return stored;
  }

  function recordFollowUpOutcome(
    sessionId: SessionId,
    outcome: FollowUpOutcome,
  ): Result<SessionRecord, DebuggenError> {
    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    if (isTerminalSessionStatus(record.status)) {
      return err(sessionEnded(sessionId, 'recordFollowUpOutcome'));
    }

    const latestIndex = record.followUps.length - 1;
    const latest = record.followUps[latestIndex];

    if (latest === undefined) {
      return err(
        invalidState(
          'This session has no follow-up to record an outcome for.',
          'Record the follow-up question before the outcome that answered it.',
          { sessionId, reason: 'no-follow-up' },
        ),
      );
    }

    const updated: FollowUpRecord = {
      ...latest,
      ...(outcome.needsNewCapture === undefined
        ? {}
        : { needsNewCapture: outcome.needsNewCapture }),
      ...(outcome.planVersion === undefined ? {} : { planVersion: outcome.planVersion }),
      ...(outcome.captureId === undefined ? {} : { captureId: outcome.captureId }),
      ...(outcome.analysisId === undefined ? {} : { analysisId: outcome.analysisId }),
      ...(outcome.panelId === undefined ? {} : { panelId: outcome.panelId }),
    };

    const stored = commit(
      {
        ...record,
        followUps: record.followUps.map((followUp, index) =>
          index === latestIndex ? updated : followUp,
        ),
        updatedAt: nextStamp(record),
      },
      'recordFollowUpOutcome',
    );

    if (isErr(stored)) {
      return stored;
    }

    announceUpdated(stored.value);

    return stored;
  }

  function setBoundTab(
    sessionId: SessionId,
    boundTab: BoundTab | undefined,
  ): Result<SessionRecord, DebuggenError> {
    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    if (boundTab === undefined && record.boundTab === undefined) {
      return ok(record);
    }

    // An ended session may lose its tab but never gain one.
    if (boundTab !== undefined && isTerminalSessionStatus(record.status)) {
      return err(sessionEnded(sessionId, 'setBoundTab'));
    }

    const base = withoutField(record, 'boundTab');
    const stored = commit(
      {
        ...(boundTab === undefined ? base : { ...base, boundTab }),
        updatedAt: nextStamp(record),
      },
      'setBoundTab',
    );

    if (isErr(stored)) {
      return stored;
    }

    scoped(sessionId).debug('bound tab recorded', { bound: boundTab !== undefined });
    announceUpdated(stored.value);

    return stored;
  }

  // -------------------------------------------------------------------------
  // Capture exclusivity (AAP §0.4.2: one capture per project at a time)
  // -------------------------------------------------------------------------

  function captureOwnerForProject(projectRoot: string): CaptureOwner | undefined {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      return undefined;
    }

    ensureIndexed();

    const owner = liveOwner(projectKey(projectRoot));

    return owner === undefined
      ? undefined
      : Object.freeze({ sessionId: owner.sessionId, captureId: owner.captureId });
  }

  function startCapture(
    sessionId: SessionId,
  ): Result<{ readonly captureId: CaptureId }, DebuggenError> {
    // Everything from the ownership check to the claim below is synchronous:
    // no other call can interleave between deciding and claiming.
    ensureIndexed();

    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;
    const logger = scoped(sessionId);
    const key = projectKey(record.projectRoot);
    const owner = liveOwner(key);

    // 1. Exclusivity, before any store write.
    if (owner !== undefined && owner.sessionId !== sessionId) {
      logger.info('capture refused: another session holds the project', {
        owningSessionId: owner.sessionId,
      });
      return err(captureConflict(sessionId, owner, record.projectRoot));
    }

    if (owner !== undefined) {
      return err(ownCaptureActive(sessionId, owner.captureId));
    }

    const active = sessions.getActiveCapture(sessionId);

    if (isErr(active)) {
      return active;
    }

    if (active.value !== undefined) {
      return err(ownCaptureActive(sessionId, active.value.capture.id));
    }

    // 2. The state machine, before any store write.
    const verdict = transition(record.status, 'capturing');

    if (isErr(verdict)) {
      return verdict;
    }

    const latestPlan = sessions.latestPlanVersion(sessionId);

    if (isErr(latestPlan)) {
      return latestPlan;
    }

    if (latestPlan.value === undefined) {
      return err(
        invalidState(
          'This session has no instrumentation plan to capture under.',
          'Let planning and instrumentation finish, then start the capture.',
          { sessionId, reason: 'no-plan' },
        ),
      );
    }

    // 3. Open the window and claim the project.
    const opened = sessions.startCapture({
      sessionId,
      planVersion: latestPlan.value,
      startedAt: stamp(),
    });

    if (isErr(opened)) {
      if (opened.error.code === CAPTURE_CONFLICT_ERROR_CODE) {
        const activeCaptureId = opened.error.details?.['activeCaptureId'];
        return err(
          ownCaptureActive(
            sessionId,
            typeof activeCaptureId === 'string' ? activeCaptureId : undefined,
          ),
        );
      }
      return opened;
    }

    const capture = opened.value.capture;
    owners.set(key, Object.freeze({ sessionId, captureId: capture.id }));

    // 4. The transition. If it cannot be applied, the claim and the window are
    // both released so no phantom owner is left behind.
    const moved = applyTransition(
      record,
      'capturing',
      {},
      { captures: mirrorCapture(record.captures, capture) },
      'startCapture',
    );

    if (isErr(moved)) {
      releaseOwnership(record);

      const closed = sessions.stopCapture({ captureId: capture.id, stoppedAt: capture.startedAt });

      if (isErr(closed)) {
        scoped(sessionId, capture.id).error(
          'a capture window opened for a refused start stays open',
          {
            code: closed.error.code,
          },
        );
      }

      return moved;
    }

    // 5. The announcement, last.
    send(sessionId, 'capture.started', () =>
      createEnvelope('capture.started', { sessionId, captureId: capture.id }, { ts: stamp() }),
    );
    scoped(sessionId, capture.id).info('capture started', { planVersion: capture.planVersion });

    return ok({ captureId: capture.id });
  }

  /**
   * The capture window `stopCapture` closes, or the one an earlier stop
   * already closed without moving the session on (the store's window was
   * closed, then the status commit failed): that window is picked up again
   * so the session is never stuck in `capturing`.
   */
  function closeForStop(
    record: SessionRecord,
    summary: CaptureSummary,
  ): Result<CaptureRecord, DebuggenError> {
    const sessionId = record.id;
    const active = sessions.getActiveCapture(sessionId);

    if (isErr(active)) {
      return active;
    }

    const summaryMismatch = (captureId: CaptureId): DebuggenError =>
      invalidState(
        'The capture summary describes a different capture window.',
        'Summarise the capture window being stopped.',
        { sessionId, captureId, reason: 'summary-capture-mismatch' },
      );

    const open = active.value?.capture;

    if (open !== undefined) {
      if (summary.captureId !== open.id) {
        return err(summaryMismatch(open.id));
      }

      const stopped = sessions.stopCapture({
        captureId: open.id,
        stoppedAt: Math.max(stamp(), open.startedAt),
        summary,
      });

      return isErr(stopped) ? stopped : ok(stopped.value.capture);
    }

    const pending = inFlightCapture(record);
    const stored = pending === undefined ? undefined : sessions.getCapture(pending.id);

    if (stored !== undefined && isErr(stored)) {
      return stored;
    }

    const closed = stored?.value?.capture;

    if (closed === undefined || closed.stoppedAt === undefined) {
      return err(
        invalidState(
          'This session has no open capture window to stop.',
          'End the session, or start a new capture once it is ready again.',
          { sessionId, reason: 'no-active-capture' },
        ),
      );
    }

    if (summary.captureId !== closed.id) {
      return err(summaryMismatch(closed.id));
    }

    scoped(sessionId, closed.id).warn('an already-closed capture window was picked up again', {});

    return ok(closed.summary === undefined ? { ...closed, summary } : closed);
  }

  function stopCapture(
    sessionId: SessionId,
    options: StopCaptureOptions,
  ): Result<CaptureRecord, DebuggenError> {
    // Whether the capture holds evidence is the capture stage's decision: it
    // passes `next: 'ready'` for AAP §0.5.5's "Capture yielded nothing" path
    // and `next: 'analyzing'` otherwise. Nothing here inspects the summary to
    // second-guess it.
    if (!CAPTURE_STOP_TARGETS.has(options.next)) {
      return err(
        invalidState(
          'A stopped capture can only move its session to "analyzing" or "ready".',
          'Pass "analyzing" when the capture holds evidence and "ready" when it collected nothing.',
          { sessionId, reason: 'invalid-stop-target' },
        ),
      );
    }

    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    if (record.status !== 'capturing') {
      return err(
        invalidState('This session is not capturing.', 'Start a capture before stopping one.', {
          sessionId,
          status: record.status,
          reason: 'not-capturing',
        }),
      );
    }

    const verdict = transition(record.status, options.next);

    if (isErr(verdict)) {
      return verdict;
    }

    const closed = closeForStop(record, options.summary);

    if (isErr(closed)) {
      return closed;
    }

    const eventCount = options.summary.eventCount;
    const capture: CaptureRecord =
      Number.isSafeInteger(eventCount) && eventCount >= 0
        ? { ...closed.value, eventCount }
        : closed.value;

    releaseOwnership(record);

    send(sessionId, 'capture.stopped', () =>
      createEnvelope(
        'capture.stopped',
        { sessionId, captureId: capture.id, summary: options.summary },
        { ts: stamp() },
      ),
    );

    const moved = applyTransition(
      record,
      options.next,
      {},
      { captures: mirrorCapture(record.captures, capture) },
      'stopCapture',
    );

    if (isErr(moved)) {
      return moved;
    }

    scoped(sessionId, capture.id).info('capture stopped', { next: options.next });

    return ok(capture);
  }

  // -------------------------------------------------------------------------
  // Ending a session and cleanup reporting
  // -------------------------------------------------------------------------

  /**
   * Runs the injected cleanup, or reports honestly that none ran.
   *
   * With no runner the outcome is `pending` — never `clean`: a cleanup that
   * did not happen is never reported as successful (AAP §0.5.5). A runner that
   * fails leaves the session un-ended and reports the `cleanup` stage's
   * `failed` progress row, so ending again retries.
   */
  async function runCleanup(
    sessionId: SessionId,
  ): Promise<Result<SessionCleanupOutcome, DebuggenError>> {
    const logger = scoped(sessionId);
    const runner = deps.cleanup;

    if (runner === undefined) {
      logger.warn('no cleanup runner is wired; the session ends with cleanup pending', {});
      return ok({ status: 'pending', conflicts: [], completedAt: stamp() });
    }

    let result: Result<SessionCleanupOutcome, DebuggenError>;

    try {
      result = await runner.run(sessionId);
    } catch (thrown) {
      result = err(DebuggenError.from(thrown, 'INTERNAL'));
    }

    if (
      !isErr(result) &&
      (!isCleanupStatus(result.value.status) || !Array.isArray(result.value.conflicts))
    ) {
      result = err(
        new DebuggenError(
          'INTERNAL',
          'Cleanup reported an outcome outside the cleanup vocabulary.',
          {
            hint: 'End the session again to retry cleanup; the modification journal still holds every change.',
            details: { sessionId, reason: 'invalid-cleanup-outcome' },
          },
        ),
      );
    }

    if (isErr(result)) {
      const error = result.error;
      logger.warn('cleanup did not finish; the session stays open so ending it again retries', {
        code: error.code,
      });

      const row = progress.stageFailed(sessionId, {
        stage: 'cleanup',
        code: error.code,
        message: error.message.trim().length > 0 ? error.message : CLEANUP_FAILURE_FALLBACK,
        hint: error.hint ?? 'End the session again to retry cleanup.',
      });

      if (isErr(row)) {
        logger.error('the cleanup failure could not be reported as a progress row', {
          code: row.error.code,
        });
      }
    }

    return result;
  }

  /** The body of {@link SessionManager.recordCleanupOutcome}, shared with `end`. */
  function recordOutcome(
    sessionId: SessionId,
    outcome: SessionCleanupOutcome,
    operation: string,
  ): Result<SessionRecord, DebuggenError> {
    if (!isCleanupStatus(outcome.status) || !Array.isArray(outcome.conflicts)) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'A cleanup outcome outside the cleanup vocabulary was offered.',
          {
            hint: 'Report one of "pending", "clean", "partial" or "conflict" with its conflicts.',
            details: { sessionId, reason: 'invalid-cleanup-outcome' },
          },
        ),
      );
    }

    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;
    const cleanup = toSessionCleanup(outcome, stamp());
    const stored = commit({ ...record, cleanup, updatedAt: nextStamp(record) }, operation);

    if (isErr(stored)) {
      return stored;
    }

    const session = stored.value;
    announceUpdated(session);
    send(sessionId, 'cleanup.completed', () =>
      createEnvelope(
        'cleanup.completed',
        { sessionId, status: session.cleanup.status, conflicts: session.cleanup.conflicts },
        { ts: stamp() },
      ),
    );
    scoped(sessionId).info('cleanup outcome recorded', {
      cleanup: session.cleanup.status,
      conflicts: session.cleanup.conflicts.length,
    });

    return ok(session);
  }

  function recordCleanupOutcome(
    sessionId: SessionId,
    outcome: SessionCleanupOutcome,
  ): Result<SessionRecord, DebuggenError> {
    return recordOutcome(sessionId, outcome, 'recordCleanupOutcome');
  }

  async function endOnce(sessionId: SessionId): Promise<Result<SessionEndResult, DebuggenError>> {
    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    // 1. Idempotency first. `./state-machine.ts` deliberately has no
    // `ended → ended` edge, so a repeated end is answered here from the stored
    // record — without re-running cleanup and without consulting the machine.
    if (record.status === 'ended') {
      return ok({ session: record, cleanup: outcomeOf(record.cleanup, record.updatedAt) });
    }

    // 2. Close any open capture window and release the project.
    const captures = closeOpenCapture(record, 'end');

    if (captures !== undefined) {
      const mirrored = commit({ ...record, captures, updatedAt: nextStamp(record) }, 'end');

      if (isErr(mirrored)) {
        return mirrored;
      }

      announceUpdated(mirrored.value);
    }

    // 3. Cleanup, whatever the session's status (AAP §0.5.1).
    const outcome = await runCleanup(sessionId);

    if (isErr(outcome)) {
      return outcome;
    }

    // 4. The one cleanup report.
    const recorded = recordOutcome(sessionId, outcome.value, 'end');

    if (isErr(recorded)) {
      return recorded;
    }

    // 5. The terminal transition — legal from every non-terminal status. The
    // tab binding goes with it: an ended session is no recipient.
    const moved = applyTransition(withoutField(recorded.value, 'boundTab'), 'ended', {}, {}, 'end');

    if (isErr(moved)) {
      return moved;
    }

    const unbound = sessions.deleteBindingsForSession(sessionId);

    if (isErr(unbound)) {
      scoped(sessionId).warn('the tab binding of the ended session could not be removed', {
        code: unbound.error.code,
      });
    }

    scoped(sessionId).info('session ended', { cleanup: outcome.value.status });

    return ok({ session: moved.value, cleanup: outcome.value });
  }

  function end(sessionId: SessionId): Promise<Result<SessionEndResult, DebuggenError>> {
    const running = endsInFlight.get(sessionId);

    if (running !== undefined) {
      return running;
    }

    const run = endOnce(sessionId).finally(() => {
      endsInFlight.delete(sessionId);
    });
    endsInFlight.set(sessionId, run);

    return run;
  }

  // -------------------------------------------------------------------------
  // Failure discipline (AAP §0.5.5)
  // -------------------------------------------------------------------------

  function fail(
    sessionId: SessionId,
    failure: SessionFailure,
  ): Result<SessionRecord, DebuggenError> {
    return transitionTo(sessionId, 'failed', { failure });
  }

  function retry(
    sessionId: SessionId,
    failure: Pick<SessionFailure, 'stage'>,
  ): Result<SessionRecord, DebuggenError> {
    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    if (record.status !== 'failed') {
      return err(
        invalidState(
          'Only a failed session can be retried.',
          'Continue the session from its current status instead.',
          { sessionId, status: record.status, reason: 'not-failed' },
        ),
      );
    }

    const target = statusForStage(failure.stage);

    if (target === undefined) {
      return err(
        invalidState(
          'The failed stage owns no session status to re-enter.',
          'Retry a failed cleanup by ending the session again, and a failed follow-up by asking it again.',
          { sessionId, reason: 'no-retry-target' },
        ),
      );
    }

    if (target === 'capturing') {
      const started = startCapture(sessionId);
      return isErr(started) ? started : load(sessionId);
    }

    return applyTransition(record, target, {}, {}, 'retry');
  }

  // The store is synchronous, so every operation but `end` completes in one
  // turn; `settle` gives each the asynchronous contract the interface states,
  // so a caller's code does not change if one of them ever gains an await.
  return Object.freeze({
    hydrate: () => settle(hydrate),
    create: (input) => settle(() => create(input)),
    get,
    list,
    transitionTo: (sessionId, to, context) => settle(() => transitionTo(sessionId, to, context)),
    patch: (sessionId, changes) => settle(() => patch(sessionId, changes)),
    recordPlan: (sessionId, plan) => settle(() => recordPlan(sessionId, plan)),
    appendFollowUp: (sessionId, question) => settle(() => appendFollowUp(sessionId, question)),
    recordFollowUpOutcome: (sessionId, outcome) =>
      settle(() => recordFollowUpOutcome(sessionId, outcome)),
    setBoundTab: (sessionId, boundTab) => settle(() => setBoundTab(sessionId, boundTab)),
    captureOwnerForProject,
    startCapture: (sessionId) => settle(() => startCapture(sessionId)),
    stopCapture: (sessionId, options) => settle(() => stopCapture(sessionId, options)),
    end,
    recordCleanupOutcome: (sessionId, outcome) =>
      settle(() => recordCleanupOutcome(sessionId, outcome)),
    fail: (sessionId, failure) => settle(() => fail(sessionId, failure)),
    retry: (sessionId, failure) => settle(() => retry(sessionId, failure)),
  } satisfies SessionManager);
}
