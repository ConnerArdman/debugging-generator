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
 * | `* → ended` | {@link SessionManager.end} | cleanup must run first (AAP §0.5.1), then the dev servers launched for the session are released (AAP §0.7.1 Group 2) — an incomplete release reports the cleanup `partial` |
 *
 * A transition into `failed` closes the open capture window and commits the
 * `failed` status in **one store transaction**, then releases ownership, so a
 * failed session never blocks its project. When the window cannot be closed
 * the whole transition is refused: the status, the open window and the
 * project's ownership all stay as they were, no progress row is emitted, and
 * stopping or ending the session retries the closure. A committed transition
 * emits the stage's `failed` progress row through `./progress.ts` — protocol's
 * `SessionRecord` has no failure field, so that persisted row is how the
 * failing stage reaches both user interfaces (AAP §0.5.5).
 *
 * ## Store atomicity and ownership
 *
 * Every lifecycle-owned edge writes a capture window and a session record
 * together, and does so inside `SessionsRepo.transaction`: opening a window
 * with the move to `capturing`, closing one with the move to
 * `analyzing | ready | failed`, closing one with the record mirror before
 * cleanup on `end`. A refused second write rolls the first back, so no window
 * stays open for a start whose status was refused, and no window stays closed
 * for a stop or a failure whose status change was refused. (An `end` whose
 * cleanup fails after its closure committed leaves the session un-ended with
 * its window closed; the next stop or end picks that window up again.)
 * The in-memory owner index changes only **after** the store commits — claimed
 * after the start commits, released after the closure commits — and a frame
 * is broadcast only after that, so no client is told a capture started or
 * stopped that the store does not hold, and no competing session is admitted
 * to a project whose window is still open.
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
  followUpAttemptIdSchema,
  isCleanupStatus,
  isFollowUpAnswered,
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
import { describeException, guardLogger, sessionLogger, subsystemLogger } from '../logging.js';
import {
  MAX_SESSION_LIST_LIMIT,
  type ListSessionsOptions,
  type OpenCaptureWindow,
  type SessionListItem,
  type SessionsRepo,
} from '../store/sessions-repo.js';
import {
  authorProductText,
  isProductAuthoredText,
  type ProgressBroadcaster,
  type SessionProgress,
} from './progress.js';
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

/**
 * Releases the dev servers launched for a session when it ends — the "child
 * lifecycle tied to the session" of AAP §0.7.1 Group 2.
 *
 * Satisfied structurally by `apps/local-service/src/dev-server/launcher.ts`:
 * it stops every child that was launched for sessions and that no other live
 * session still relies on, and revokes that child's `server-agent` credential.
 * A dev server the developer launched without naming a session is not
 * touched, so the application keeps serving with the inert preload after the
 * session ends (AAP §0.5.1).
 *
 * The release runs once the project's files are restored and never stops the
 * session from ending. A release that reports a failure — typically a stopped
 * child whose credential could not be revoked yet — makes the session's
 * cleanup `partial` until {@link whenReleased} confirms the credential no
 * longer authenticates, when the cleanup report is completed. A service that
 * stops before then leaves the report `partial` in the store, and the next
 * start completes it ({@link SessionManager.settleIncompleteCleanups}) once
 * the leases of the stopped service are revoked.
 *
 * Only `end` releases. A `failed` session keeps its dev server: `failed` is
 * retryable (AAP §0.5.5), and the retry needs the server the session was
 * capturing from; ending the failed session releases it like any other, and
 * the service's shutdown stops every child it launched regardless.
 */
export interface SessionDevServerRelease {
  stopForSession(sessionId: string): Promise<Result<unknown, DebuggenError>>;
  /**
   * Resolves once the credentials of the dev servers {@link stopForSession}
   * stopped for the session no longer authenticate. Optional: without it an
   * incomplete release stays reported as `partial`.
   */
  whenReleased?(sessionId: string): Promise<void>;
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
  /**
   * Stops the dev servers launched for a session after it has ended. Absent
   * in unit contexts, which launch none.
   */
  readonly devServers?: SessionDevServerRelease | undefined;
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
 * Where one ask of a follow-up attempt goes on a session's ladder: a new
 * entry, or a retry in place of the entry at `index`.
 */
export type FollowUpAttemptPlacement =
  | { readonly kind: 'new' }
  | { readonly kind: 'retry'; readonly index: number; readonly previous: FollowUpRecord };

/** The `details.reason` of each refusal {@link placeFollowUpAttempt} can return. */
export const FOLLOW_UP_ATTEMPT_REFUSALS = Object.freeze({
  /** The attempt id is not an identifier protocol accepts. */
  invalid: 'follow-up-attempt-invalid',
  /** The attempt was answered already: asking it again would duplicate it. */
  answered: 'follow-up-attempt-answered',
  /** A later follow-up followed the attempt, so its outcome could not be linked to it. */
  superseded: 'follow-up-attempt-superseded',
} as const);

/**
 * Decides how {@link SessionManager.appendFollowUp} records an ask of
 * `attemptId` against `followUps`, without writing anything — the one
 * definition of the follow-up idempotency rule, applied by the manager when it
 * records the ask and by the pipeline orchestrator before it starts a
 * follow-up at all, so a refused ask runs nothing and files no failure.
 *
 * - No entry carries `attemptId` → `new`.
 * - The **latest** entry carries it and is unanswered (protocol's
 *   `isFollowUpAnswered`) → `retry` of that entry.
 * - An answered entry carries it → refused: the attempt already has its
 *   answer, and a second run would append a second analysis and panel to one
 *   question.
 * - An earlier, unanswered entry carries it → refused: outcome links are
 *   stamped on the latest follow-up, so reviving an earlier one would
 *   misassociate the next analysis and panel.
 *
 * Only identifiers are compared; the question text is never read (AAP §0.5.4).
 *
 * @param sessionId The session, for the refusal's details.
 * @param followUps The session's follow-up ladder.
 * @param attemptId The attempt the ask names.
 * @returns The placement, or `Err`: `PROTOCOL_INVALID_MESSAGE` for a malformed
 * id, `SESSION_INVALID_STATE` with a {@link FOLLOW_UP_ATTEMPT_REFUSALS} reason
 * for an answered or superseded attempt.
 *
 * @example
 * ```ts
 * const placed = placeFollowUpAttempt(session.id, session.followUps, attemptId);
 * if (!placed.ok) return placed;                 // 409: answered or superseded
 * placed.value.kind === 'retry';                 // the failed attempt, in place
 * ```
 */
export function placeFollowUpAttempt(
  sessionId: SessionId,
  followUps: readonly FollowUpRecord[],
  attemptId: string,
): Result<FollowUpAttemptPlacement, DebuggenError> {
  if (!followUpAttemptIdSchema.safeParse(attemptId).success) {
    return err(
      new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'The follow-up attempt id is malformed.', {
        hint: 'Send the follow-up again from the Debug Generator view; it mints a fresh attempt id.',
        details: { sessionId, reason: FOLLOW_UP_ATTEMPT_REFUSALS.invalid },
      }),
    );
  }

  const index = followUps.findIndex((entry) => entry.attemptId === attemptId);
  const previous = followUps[index];

  if (index === -1 || previous === undefined) {
    return ok({ kind: 'new' });
  }

  if (isFollowUpAnswered(previous)) {
    return err(
      invalidState(
        'This follow-up was already answered, so it is not asked again.',
        'Its answer is in the session. To ask something more, send it as a new follow-up question.',
        { sessionId, reason: FOLLOW_UP_ATTEMPT_REFUSALS.answered },
      ),
    );
  }

  if (index !== followUps.length - 1) {
    return err(
      invalidState(
        'A later follow-up was asked after this one, so this one can no longer be retried.',
        'Ask the question again as a new follow-up.',
        { sessionId, reason: FOLLOW_UP_ATTEMPT_REFUSALS.superseded },
      ),
    );
  }

  return ok({ kind: 'retry', index, previous });
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
   * a second call rebuilds the same index.
   *
   * The open windows are read in one indexed statement; no session without an
   * open window is read, paged or probed. An open window on a session that is
   * not `capturing` is the orphan of an interrupted start or stop and is closed
   * together with its record mirror rather than indexed — unless the store
   * refuses to close it, in which case its session is indexed as the project's
   * owner so no competing capture starts until the window is verifiably
   * closed. The index is also built lazily on first use, so a caller that
   * never hydrates still gets a correct answer, and a start is refused while
   * it cannot be built.
   *
   * @returns `ok` once every open window was indexed or closed; the first
   * store error that kept an orphan open (with the index in place); or the
   * store error that kept the open windows from being read, in which case the
   * previous index is kept.
   */
  hydrate(): Promise<Result<void, DebuggenError>>;

  /**
   * Settles the cleanup report of every ended session the previous service
   * left `partial` — typically because a stopped dev server's credential was
   * still authenticating when that service stopped, so the report could never
   * be completed in memory (see {@link SessionDevServerRelease}).
   *
   * Called once by `src/main.ts` at start-up, after modification
   * reconciliation and after the access boundary revoked every lease no
   * running service holds — the two things an ended session's `partial` can
   * wait for. Each such session's cleanup runner is run again (idempotent:
   * restored records stay restored) and its verdict replaces the report when
   * it knows more than `partial`; a session the runner still reports
   * `partial`, or cannot run for, keeps its report.
   *
   * @returns How many reports were settled, or the store error that stopped the
   * pass (after settling everything read before it).
   */
  settleIncompleteCleanups(): Promise<Result<number, DebuggenError>>;

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
   * `context.failure`; it closes an open capture window and commits `failed`
   * in one store transaction, then releases the project's capture ownership
   * and emits that stage's `failed` progress row. When the window cannot be
   * closed (or the status cannot be stored) the transition is refused with
   * the store's error and nothing changes: the status, the open window and
   * the ownership stay, and no progress row is emitted. Broadcasts
   * `session.updated` after the commit.
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
   *
   * The plan row and the record that mirrors it are written in one transaction
   * (`SessionsRepo.insertPlanWithRecord`), so an `Err` from the store or the
   * session contract means neither was written. Only a failure after that
   * commit — none is expected — can answer `Err` with the plan recorded.
   */
  recordPlan(
    sessionId: SessionId,
    plan: RecordPlanInput,
  ): Promise<Result<RecordedPlan, DebuggenError>>;

  /**
   * Records one ask of a follow-up **attempt** — in the store's `followups`
   * table and on the record — and broadcasts `session.updated`. The question is
   * stored, never inspected.
   *
   * The attempt is identified by `attemptId` (protocol's
   * `followUpAttemptIdSchema`) and by nothing else: never by the question's
   * text (AAP §0.5.4), its time, the session's status or the entry's position.
   * {@link placeFollowUpAttempt} decides, against the session's ladder:
   *
   * | `attemptId` names … | Recorded as … |
   * | --- | --- |
   * | no entry | a new entry appended, `attempt: 1`, and one new `followups` row |
   * | the latest entry, unanswered | a retry **in place**: the same entry and the same `followups` row (`SessionsRepo.replaceFollowUpAttempt`), `attempt + 1`, this ask's question and `askedAt` |
   * | an answered entry | refused, `SESSION_INVALID_STATE`, reason `follow-up-attempt-answered` |
   * | an unanswered entry a later one followed | refused, `SESSION_INVALID_STATE`, reason `follow-up-attempt-superseded` |
   *
   * So the ladder and the table hold one entry and one row per question asked,
   * however many times it is retried, and a caller detects that this ask was
   * recorded by the entry's `attempt` counter growing — never by the ladder's
   * length or a timestamp, which two asks in one millisecond share.
   *
   * @param sessionId The session.
   * @param question The question as the developer asked it this time.
   * @param attemptId The attempt's identity: fresh for a new question, the
   *   failed attempt's own for a retry.
   */
  appendFollowUp(
    sessionId: SessionId,
    question: string,
    attemptId: string,
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
   * Opens a capture window and moves the session to `capturing` in one store
   * transaction, then claims the project's capture ownership; broadcasts
   * `session.updated` then `capture.started`.
   *
   * The window is opened with the store's own project-exclusivity check, so a
   * window another session holds on the project — one the owner index has not
   * seen — refuses the start too, and that session becomes the indexed owner.
   * A refused status commit rolls the window back: no orphan window and no
   * owner is left behind. When the owner index cannot be read from the store
   * the start is refused: refusing a capture is recoverable, a second
   * concurrent capture on the project is not.
   *
   * @returns The new capture's id, or `Err`: a {@link CaptureConflictError}
   * when another session owns the project's capture; `SESSION_INVALID_STATE`
   * when this session already holds one (with its `captureId` in `details`),
   * has no plan, or may not move to `capturing` from its status; the store's
   * error when the index, the window or the status cannot be read or written.
   */
  startCapture(
    sessionId: SessionId,
  ): Promise<Result<{ readonly captureId: CaptureId }, DebuggenError>>;

  /**
   * Closes the session's capture window with its summary and moves the
   * session to `options.next` in one store transaction; only after that
   * commit does it release the project's ownership, broadcast
   * `capture.stopped` and then `session.updated`.
   *
   * When either write is refused nothing changes: the window stays open, the
   * status stays `capturing`, the project stays owned by this session, no
   * frame is sent, and the store's error is returned — so stopping again
   * retries the whole step.
   */
  stopCapture(
    sessionId: SessionId,
    options: StopCaptureOptions,
  ): Promise<Result<CaptureRecord, DebuggenError>>;

  /**
   * Ends a session: closes any open capture window together with the record
   * that mirrors it (one store transaction) and releases the project's
   * ownership, runs cleanup, records its outcome and moves the session to
   * `ended`. When the window cannot be closed the end is refused before
   * cleanup runs, with ownership retained, so ending again retries.
   * Idempotent — ending an ended session returns its stored record and
   * cleanup without re-running anything — and concurrent calls share one run.
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
   * row. A stage failure surfaces this way, never as a partial success. The
   * same guarantees as {@link SessionManager.transitionTo} into `failed`: an
   * open capture window that cannot be closed refuses the move, and the
   * session keeps its status, its window and its project's ownership.
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

/** The message an incomplete dev-server release falls back to when its error carried none. */
const DEV_SERVER_RELEASE_FAILURE_FALLBACK =
  'The dev server launched for this session could not be fully released.';

/** The hint an incomplete dev-server release falls back to when its error carried none. */
const DEV_SERVER_RELEASE_FAILURE_HINT =
  'Stop the dev server from its terminal, or restart the Debug Generator service; the service log holds the reason.';

/**
 * The cleanup outcome of a session whose files are restored but whose stopped
 * dev server's credential still authenticates: a `clean` outcome becomes
 * `partial`, because not everything the session set up is undone yet. A
 * `conflict` (an edited file left in place) or `pending` outcome says more and
 * is kept.
 */
function withIncompleteRelease(outcome: SessionCleanupOutcome): SessionCleanupOutcome {
  return outcome.status === 'clean' ? { ...outcome, status: 'partial' } : outcome;
}

/**
 * The next step a cleanup failure's `failed` row shows when the failure
 * carried no hint `./progress.ts` can prove the product wrote
 * (`isProductAuthoredText`): cleanup leaves the session open, so ending it
 * again is always the retry.
 *
 * Registered through `authorProductText` each time a failure is filed with it
 * rather than once at load, so the row's projection recognises it however many
 * texts other builders registered in between.
 */
const CLEANUP_RETRY_HINT = 'End the session again to retry cleanup.';

/**
 * The hint of a cleanup outcome outside the cleanup vocabulary: a product
 * sentence, registered where the failure is built so its row may show it.
 */
const INVALID_CLEANUP_OUTCOME_HINT =
  'End the session again to retry cleanup; the modification journal still holds every change.';

/**
 * The capture-owner index key of a project root: POSIX separators, lexically
 * normalised. A created session's `projectRoot` is already in this form, so
 * applying it again is the identity; a caller's argument is brought to it.
 */
function projectKey(projectRoot: string): string {
  return normalizePosix(toPosix(projectRoot));
}

/**
 * The refusal for an id that names no stored session. Its sentences are
 * registered with `authorProductText`, so a failure surface proves them
 * product copy and shows them verbatim.
 */
function sessionNotFound(sessionId: SessionId): DebuggenError {
  return new DebuggenError(
    'SESSION_NOT_FOUND',
    authorProductText('No debugging session with this id exists.'),
    {
      hint: authorProductText(
        'Reopen the session from the Sessions view or start a new one; a session older than the retention window is purged.',
      ),
      details: { sessionId },
    },
  );
}

/**
 * A request the session's current state does not admit. `reason` is the
 * machine-readable cause a caller or a test tells refusals apart by.
 *
 * Every caller passes sentences this module composed from its own literals
 * and closed values (a session status, an operation name), so both are
 * registered with `authorProductText` here: an HTTP refusal or a failed row
 * then proves them product copy and shows them as written. Never pass text a
 * collaborator or an exception supplied.
 */
function invalidState(
  message: string,
  hint: string,
  details: Readonly<Record<string, unknown>> & { readonly reason: string },
): DebuggenError {
  return new DebuggenError('SESSION_INVALID_STATE', authorProductText(message), {
    hint: authorProductText(hint),
    details,
  });
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

/**
 * The conflict another session's capture on the same project produces —
 * whether the owner index or the store's own project check found it.
 */
function captureConflict(
  sessionId: SessionId,
  owningSessionId: SessionId,
  projectRoot: string,
): CaptureConflictError {
  return new DebuggenError(
    CAPTURE_CONFLICT_ERROR_CODE,
    'Another debugging session is already capturing this project.',
    {
      hint: 'Stop or end the capture in the other session, then start this capture again.',
      details: {
        sessionId,
        owningSessionId,
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
  // Guarded before the child is derived, so no record written here — the
  // clock fallback's included — can throw into a session change.
  const log = subsystemLogger(guardLogger(deps.logger ?? noopLogger), LOG_SUBSYSTEM);

  /**
   * The capture-owner index: normalised project root → the session holding
   * the open capture window there. The store's open `captures` rows are the
   * authority; this map is the synchronous index the exclusivity decision is
   * made against, so that no `await` separates checking from claiming.
   *
   * The map follows the store and never leads it. An entry is claimed only
   * after `startCapture`'s window-and-status transaction has committed, and
   * released on **every** exit path — `stopCapture`, `end`, a transition into
   * `failed` — only after the transaction that closes the window has
   * committed. A closure the store refuses leaves the entry in place, so a
   * window that is still open keeps refusing competing captures on its
   * project until it is verifiably closed; a refused start leaves no entry
   * because its window was rolled back with it.
   * `apps/local-service/test/integration/concurrency.test.ts` proves both
   * halves, including with the store's closure blocked.
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
    } catch (thrown) {
      // An injected clock is a test seam, and its failure must not cost the
      // developer a session change: the wall clock stamps it instead, and the
      // substitution is recorded by the thrown value's closed class only.
      log.debug('the injected clock threw; the wall clock stamps this change', {
        ...describeException(thrown),
      });
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

  /** A status change the store has committed and nobody has been told about yet. */
  interface CommittedTransition {
    /** The status the session left. */
    readonly from: SessionStatus;
    /** The record as stored, carrying the new status. */
    readonly session: SessionRecord;
    /** The evidence the transition was judged against; carries a `failed` edge's failure. */
    readonly context: SessionTransitionContext;
    /** The manager operation that made the change, for the log line. */
    readonly operation: string;
  }

  /**
   * The commit half of the one status applier every status change goes
   * through: the state machine decides and `commit` persists the status
   * together with `changes`. It emits no progress row and broadcasts no frame,
   * so it can run inside a `SessionsRepo.transaction` whose rollback must
   * leave nothing behind but a log line.
   */
  function commitTransition(
    record: SessionRecord,
    to: SessionStatus,
    context: SessionTransitionContext,
    changes: Partial<Omit<SessionRecord, 'id' | 'status' | 'createdAt'>>,
    operation: string,
  ): Result<CommittedTransition, DebuggenError> {
    const verdict = transition(record.status, to, context);

    if (isErr(verdict)) {
      return verdict;
    }

    const stored = commit(
      { ...record, ...changes, status: verdict.value, updatedAt: nextStamp(record) },
      operation,
    );

    return isErr(stored)
      ? stored
      : ok({ from: record.status, session: stored.value, context, operation });
  }

  /**
   * The announce half, run only once the change is committed: the failing
   * stage's progress row for a transition into `failed`, the status log line,
   * and `session.updated` last.
   *
   * @returns The record as stored.
   */
  function announceTransition(committed: CommittedTransition): SessionRecord {
    const { session, context } = committed;
    const logger = scoped(session.id);

    if (session.status === 'failed' && context.failure !== undefined) {
      const row = progress.stageFailed(session.id, context.failure);

      if (isErr(row)) {
        logger.error('the failing stage could not be reported as a progress row', {
          stage: context.failure.stage,
          code: row.error.code,
        });
      }
    }

    logger.info('session status changed', {
      operation: committed.operation,
      from: committed.from,
      to: session.status,
    });
    announceUpdated(session);

    return session;
  }

  /**
   * The status applier for an edge that writes nothing but the record:
   * {@link commitTransition}, then {@link announceTransition}.
   */
  function applyTransition(
    record: SessionRecord,
    to: SessionStatus,
    context: SessionTransitionContext,
    changes: Partial<Omit<SessionRecord, 'id' | 'status' | 'createdAt'>>,
    operation: string,
  ): Result<SessionRecord, DebuggenError> {
    const committed = commitTransition(record, to, context, changes, operation);

    return isErr(committed) ? committed : ok(announceTransition(committed.value));
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

  /** A capture window {@link closeOpenCapture} closed, inside its caller's transaction. */
  interface ClosedWindow {
    /** The window that closed. */
    readonly captureId: CaptureId;
    /** The record's captures with the closed window mirrored. */
    readonly captures: CaptureRecord[];
  }

  /** A committed status change that closed a capture window in the same transaction. */
  interface WindowClosingTransition {
    /** The committed status change, still to be announced. */
    readonly transition: CommittedTransition;
    /** The window the transaction closed; absent when none was open. */
    readonly closedCaptureId: CaptureId | undefined;
  }

  /**
   * Closes the session's open capture window, if it has one, without a
   * summary — the way into `failed` and `ended`, where none exists.
   *
   * Runs inside the caller's `SessionsRepo.transaction` and never touches the
   * owner index: ownership is released by the caller only once this closure
   * and the record change that goes with it have committed together, and a
   * closure that fails leaves the window open and its session the owner.
   *
   * @returns The closed window, `ok(undefined)` when none was open, or the
   * store error that kept it open — the read or the close.
   */
  function closeOpenCapture(
    record: SessionRecord,
    operation: string,
  ): Result<ClosedWindow | undefined, DebuggenError> {
    const active = sessions.getActiveCapture(record.id);

    if (isErr(active)) {
      scoped(record.id).warn('the open capture window could not be read', {
        operation,
        code: active.error.code,
      });
      return active;
    }

    if (active.value === undefined) {
      return ok(undefined);
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
      return stopped;
    }

    return ok({
      captureId: open.id,
      captures: mirrorCapture(record.captures, stopped.value.capture),
    });
  }

  /** One index entry under construction, with the start time ties are broken by. */
  interface IndexedOwner {
    readonly owner: CaptureOwner;
    readonly startedAt: number;
  }

  /**
   * Indexes the open window of a `capturing` session into `index`. Two such
   * windows on one project, which the manager never produces, are logged as
   * the defect they are, and the earlier-started window keeps ownership.
   */
  function indexCapturingWindow(window: OpenCaptureWindow, index: Map<string, IndexedOwner>): void {
    const key = projectKey(window.projectRoot);
    const existing = index.get(key);

    if (existing !== undefined) {
      scoped(window.sessionId, window.captureId).error(
        'two sessions hold an open capture window on one project',
        { owningSessionId: existing.owner.sessionId },
      );

      if (window.startedAt >= existing.startedAt) {
        return;
      }
    }

    index.set(key, {
      owner: Object.freeze({ sessionId: window.sessionId, captureId: window.captureId }),
      startedAt: window.startedAt,
    });
  }

  /**
   * Indexes an orphan window whose close the store refused: its session owns
   * the project — refusing competing captures — until the window is
   * verifiably closed. A `capturing` session already indexed on the project
   * keeps ownership, since it refuses competitors just the same and is the
   * one actually capturing; the second open window is logged.
   */
  function indexUnclosedOrphan(window: OpenCaptureWindow, index: Map<string, IndexedOwner>): void {
    const key = projectKey(window.projectRoot);
    const existing = index.get(key);

    if (existing !== undefined) {
      scoped(window.sessionId, window.captureId).error(
        'two sessions hold an open capture window on one project',
        { owningSessionId: existing.owner.sessionId },
      );
      return;
    }

    index.set(key, {
      owner: Object.freeze({ sessionId: window.sessionId, captureId: window.captureId }),
      startedAt: window.startedAt,
    });
  }

  /**
   * Closes the open window of a session that is not `capturing` — the orphan
   * of a start or stop interrupted by a crash, or left by an earlier build —
   * together with the session record that mirrors it, in one store
   * transaction, so the record and the `captures` row never disagree. A
   * record that cannot be read cannot mirror anything and does not keep the
   * window open: the window closes alone, and the unreadable record is logged.
   *
   * @returns `ok` once the window is closed, or the store error that kept it
   * open — in which case the caller indexes its session as the project's owner.
   */
  function closeOrphanWindow(window: OpenCaptureWindow): Result<void, DebuggenError> {
    const logger = scoped(window.sessionId, window.captureId);
    const closed = sessions.transaction((): Result<void, DebuggenError> => {
      const stopped = sessions.stopCapture({
        captureId: window.captureId,
        stoppedAt: Math.max(stamp(), window.startedAt),
      });

      if (isErr(stopped)) {
        return stopped;
      }

      const read = sessions.get(window.sessionId);

      if (isErr(read)) {
        logger.warn('the record of an orphaned capture window could not be read to mirror it', {
          code: read.error.code,
        });
        return ok(undefined);
      }

      const current = read.value;

      if (current === undefined || !hasCapture(current.captures, window.captureId)) {
        return ok(undefined);
      }

      const mirrored = commit(
        {
          ...current,
          captures: mirrorCapture(current.captures, stopped.value.capture),
          updatedAt: nextStamp(current),
        },
        'hydrate',
      );

      return isErr(mirrored) ? mirrored : ok(undefined);
    });

    if (isErr(closed)) {
      logger.error(
        'an orphaned capture window could not be closed; its session keeps the project until it is',
        { status: window.sessionStatus, code: closed.error.code },
      );
      return closed;
    }

    logger.warn('an orphaned capture window was closed', { status: window.sessionStatus });

    return ok(undefined);
  }

  /**
   * Logs every `capturing` session that holds no open capture window — a
   * closure whose status change was lost to a crash, or an `end` whose cleanup
   * failed after its closure committed — which `stopCapture` or `end`
   * recovers. Pages the `capturing` sessions only, never the whole store. A
   * read failure is logged and not fatal: this is a diagnostic, and it changes
   * nobody's ownership.
   *
   * @param withWindow The sessions that hold an open window.
   */
  function reportCapturingWithoutWindow(withWindow: ReadonlySet<SessionId>): void {
    for (let offset = 0; ;) {
      const page = sessions.list({
        statuses: ['capturing'],
        limit: MAX_SESSION_LIST_LIMIT,
        offset,
      });

      if (isErr(page)) {
        log.warn('capturing sessions could not be listed to check their capture windows', {
          code: page.error.code,
        });
        return;
      }

      for (const item of page.value.items) {
        if (!withWindow.has(item.id)) {
          scoped(item.id).warn(
            'a capturing session has no open capture window; stop or end it',
            {},
          );
        }
      }

      offset += page.value.items.length;

      if (page.value.items.length === 0 || offset >= page.value.total) {
        return;
      }
    }
  }

  /** What one rebuild of the owner index concluded, once an index exists. */
  interface IndexRebuild {
    /**
     * The first store error that kept an orphan window open, whose session is
     * then indexed as its project's owner; absent when every orphan closed.
     */
    readonly closeFailure: DebuggenError | undefined;
  }

  /**
   * Rebuilds the owner index from the store's open capture windows, read in
   * one indexed statement (`SessionsRepo.listOpenCaptureWindows`) — no session
   * is paged, hydrated or probed one by one, so the cost follows the handful
   * of open windows rather than the number of stored sessions.
   *
   * - A window on a `capturing` session is indexed; the earliest-started one
   *   wins a project two of them share.
   * - A window on any other session is an orphan and is closed with its record
   *   mirror; one the store refuses to close is indexed as its project's owner
   *   instead, and its error is returned once the index is in place.
   * - A `capturing` session with no open window is logged for recovery.
   *
   * The new index replaces the old one in one step. When the open windows
   * cannot be read at all, nothing is replaced: the previous index is kept,
   * `indexed` is not set — so before the first successful build every use
   * retries, and a start is refused meanwhile — and the store error is
   * returned.
   */
  function rebuildIndex(): Result<IndexRebuild, DebuggenError> {
    const listed = sessions.listOpenCaptureWindows();

    if (isErr(listed)) {
      log.warn('the capture-owner index could not be rebuilt; the previous index is kept', {
        code: listed.error.code,
        owners: owners.size,
      });
      return listed;
    }

    const index = new Map<string, IndexedOwner>();
    const unclosed: OpenCaptureWindow[] = [];
    let closeFailure: DebuggenError | undefined;
    let orphansClosed = 0;

    for (const window of listed.value) {
      if (window.sessionStatus === 'capturing') {
        indexCapturingWindow(window, index);
        continue;
      }

      const closed = closeOrphanWindow(window);

      if (isErr(closed)) {
        closeFailure ??= closed.error;
        unclosed.push(window);
      } else {
        orphansClosed += 1;
      }
    }

    // After every capturing window, so a capturing session keeps a project an
    // unclosable orphan shares with it.
    for (const window of unclosed) {
      indexUnclosedOrphan(window, index);
    }

    reportCapturingWithoutWindow(new Set(listed.value.map((window) => window.sessionId)));

    owners.clear();
    for (const [key, entry] of index) {
      owners.set(key, entry.owner);
    }
    indexed = true;

    log.info('capture-owner index rebuilt', {
      windows: listed.value.length,
      owners: owners.size,
      orphansClosed,
      orphansOpen: unclosed.length,
      complete: closeFailure === undefined,
    });

    return ok({ closeFailure });
  }

  /**
   * Builds the index on first use for a caller that never hydrated.
   *
   * @returns `ok` once an index exists — one holding an orphan whose close the
   * store refused included, because that orphan's session then blocks its
   * project exactly as it should — or the store error that kept the open
   * windows from being read, after which the next use retries.
   */
  function ensureIndexed(): Result<void, DebuggenError> {
    if (indexed) {
      return ok(undefined);
    }

    const rebuilt = rebuildIndex();

    return isErr(rebuilt) ? rebuilt : ok(undefined);
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
    const rebuilt = rebuildIndex();

    if (isErr(rebuilt)) {
      return rebuilt;
    }

    const { closeFailure } = rebuilt.value;

    return closeFailure === undefined ? ok(undefined) : err(closeFailure);
  }

  function create(input: CreateSessionInput): Result<SessionRecord, DebuggenError> {
    const posix = typeof input.projectRoot === 'string' ? toPosix(input.projectRoot) : '';

    if (posix.length === 0 || isWindowsAbsolute(posix) || !isAbsolutePosix(posix)) {
      return err(
        new DebuggenError(
          'PROJECT_NOT_FOUND',
          authorProductText('The project root must be an absolute path.'),
          {
            hint: authorProductText(
              'Start the session from a workspace folder opened in VS Code, whose absolute path identifies the project.',
            ),
            details: { reason: 'project-root-not-absolute' },
          },
        ),
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
      return failWithCaptureClosed(record, context);
    }

    return applyTransition(record, to, context, {}, 'transitionTo');
  }

  /**
   * The move into `failed`: the open capture window closes and `failed` is
   * committed in one store transaction, so a window that cannot be closed
   * refuses the whole move — status, window and ownership all unchanged, no
   * progress row — rather than leaving a failed session holding an open window
   * nobody owns. Ownership is released only after the commit, then the
   * transition is announced.
   */
  function failWithCaptureClosed(
    record: SessionRecord,
    context: SessionTransitionContext,
  ): Result<SessionRecord, DebuggenError> {
    const operation = 'transitionTo';
    const committed = sessions.transaction((): Result<WindowClosingTransition, DebuggenError> => {
      const closed = closeOpenCapture(record, operation);

      if (isErr(closed)) {
        return closed;
      }

      const moved = commitTransition(
        record,
        'failed',
        context,
        closed.value === undefined ? {} : { captures: closed.value.captures },
        operation,
      );

      return isErr(moved)
        ? moved
        : ok({ transition: moved.value, closedCaptureId: closed.value?.captureId });
    });

    if (isErr(committed)) {
      scoped(record.id).warn(
        'the move to failed was not stored; the session keeps its status, capture window and project ownership',
        { from: record.status, code: committed.error.code },
      );
      return committed;
    }

    const { transition: moved, closedCaptureId } = committed.value;

    if (closedCaptureId !== undefined) {
      scoped(record.id, closedCaptureId).info('open capture window closed', { operation });
    }

    releaseOwnership(record);

    return ok(announceTransition(moved));
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

    // The plan row and the record that mirrors it are one transaction: the
    // mirror is validated against the session contract inside it (what
    // `commit` does), so a refusal at any step rolls the plan row back too.
    const stored = sessions.insertPlanWithRecord(candidate, (inserted) => {
      const mirrored = parseSessionRecord({
        ...record,
        plans: [...record.plans, inserted],
        updatedAt: nextStamp(record),
      });

      if (isErr(mirrored)) {
        scoped(sessionId).error('a session change was rejected by the session contract', {
          operation: 'recordPlan',
          code: mirrored.error.code,
        });
      }

      return mirrored;
    });

    if (isErr(stored)) {
      scoped(sessionId).error(
        'a plan could not be recorded; neither it nor its mirror was stored',
        {
          planVersion,
          code: stored.error.code,
        },
      );
      return stored;
    }

    scoped(sessionId).info('plan recorded', {
      planVersion,
      actions: stored.value.plan.instrumentationTargets.length,
    });
    announceUpdated(stored.value.session);

    return ok({ session: stored.value.session, plan: stored.value.plan });
  }

  function appendFollowUp(
    sessionId: SessionId,
    question: string,
    attemptId: string,
  ): Result<SessionRecord, DebuggenError> {
    const loaded = load(sessionId);

    if (isErr(loaded)) {
      return loaded;
    }

    const record = loaded.value;

    if (isTerminalSessionStatus(record.status)) {
      return err(sessionEnded(sessionId, 'appendFollowUp'));
    }

    // The attempt id alone decides between a new entry and a retry in place;
    // the question is stored and forwarded, never read (AAP §0.5.4).
    const placement = placeFollowUpAttempt(sessionId, record.followUps, attemptId);

    if (isErr(placement)) {
      const reason = placement.error.details?.['reason'];
      scoped(sessionId).info('a follow-up attempt was refused', {
        code: placement.error.code,
        ...(typeof reason === 'string' ? { reason } : {}),
      });
      return placement;
    }

    const retry = placement.value.kind === 'retry' ? placement.value : undefined;
    const followUp: FollowUpRecord = {
      question,
      askedAt: stamp(),
      attemptId,
      // An identified entry always carries its counter; `1` covers a writer
      // that set only the id.
      attempt: retry === undefined ? 1 : (retry.previous.attempt ?? 1) + 1,
    };
    const ladder =
      retry === undefined
        ? [...record.followUps, followUp]
        : record.followUps.map((entry, index) => (index === retry.index ? followUp : entry));
    const preview = parseSessionRecord({ ...record, followUps: ladder });

    if (isErr(preview)) {
      scoped(sessionId).warn(
        'a follow-up was rejected by the session contract and was not stored',
        {
          code: preview.error.code,
          retry: retry !== undefined,
        },
      );
      return preview;
    }

    // One `followups` row per attempt: a retry rewrites the row the attempt
    // was first recorded in, so the log never gains a duplicate.
    const written =
      retry === undefined
        ? sessions.appendFollowUp(sessionId, followUp)
        : sessions.replaceFollowUpAttempt(sessionId, followUp);

    if (isErr(written)) {
      return written;
    }

    const storedFollowUp = written.value;
    const stored = commit(
      {
        ...record,
        followUps:
          retry === undefined
            ? [...record.followUps, storedFollowUp]
            : record.followUps.map((entry, index) =>
                index === retry.index ? storedFollowUp : entry,
              ),
        updatedAt: nextStamp(record),
      },
      'appendFollowUp',
    );

    if (isErr(stored)) {
      scoped(sessionId).error('a follow-up was stored but the session record could not mirror it', {
        code: stored.error.code,
        retry: retry !== undefined,
      });
      return stored;
    }

    scoped(sessionId).info(
      retry === undefined ? 'follow-up recorded' : 'follow-up attempt retried in place',
      { followUps: stored.value.followUps.length, attempt: storedFollowUp.attempt ?? 1 },
    );
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

    const ready = ensureIndexed();

    if (isErr(ready)) {
      log.warn(
        'the capture owner was answered from the current index: the store could not rebuild it',
        {
          code: ready.error.code,
        },
      );
    }

    const owner = liveOwner(projectKey(projectRoot));

    return owner === undefined
      ? undefined
      : Object.freeze({ sessionId: owner.sessionId, captureId: owner.captureId });
  }

  /**
   * The answer to a start the store refused, after its transaction rolled
   * back.
   *
   * A `CAPTURE_ALREADY_ACTIVE` naming another session is the store's project
   * check finding an open window the owner index did not hold: that session
   * becomes the indexed owner, so the next caller is refused without a store
   * write, and the refusal is the typed conflict the route answers `409` with.
   * One naming no other session is this session's own open window. Every other
   * refusal — a status commit the store refused included, whose window was
   * rolled back with it — travels unchanged; the repository and `commit`
   * already logged it.
   */
  function startRefusal(record: SessionRecord, key: string, error: DebuggenError): DebuggenError {
    if (error.code !== CAPTURE_CONFLICT_ERROR_CODE) {
      return error;
    }

    const owningSessionId = error.details?.['owningSessionId'];
    const activeCaptureId = error.details?.['activeCaptureId'];
    const heldCaptureId = typeof activeCaptureId === 'string' ? activeCaptureId : undefined;

    if (typeof owningSessionId === 'string' && owningSessionId !== record.id) {
      if (heldCaptureId !== undefined) {
        owners.set(key, Object.freeze({ sessionId: owningSessionId, captureId: heldCaptureId }));
      }

      scoped(record.id).warn(
        "capture refused: the store holds another session's open window on the project",
        { owningSessionId },
      );
      return captureConflict(record.id, owningSessionId, record.projectRoot);
    }

    return ownCaptureActive(record.id, heldCaptureId);
  }

  function startCapture(
    sessionId: SessionId,
  ): Result<{ readonly captureId: CaptureId }, DebuggenError> {
    // Everything from the ownership check to the claim below is synchronous:
    // no other call can interleave between deciding and claiming. Without an
    // index there is nothing to decide against, so the start is refused:
    // refusing a capture is recoverable, a second concurrent capture is not.
    const ready = ensureIndexed();

    if (isErr(ready)) {
      scoped(sessionId).warn('capture refused: the capture-owner index could not be built', {
        code: ready.error.code,
      });
      return err(
        new DebuggenError(
          'STORE_ERROR',
          'The session store could not be read to decide who may capture this project, so no capture was started.',
          {
            hint: 'Start the capture again. If it keeps failing, check the service log for the store error and restart the service.',
            details: { sessionId, reason: 'capture-index-unavailable' },
            cause: ready.error,
          },
        ),
      );
    }

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
      return err(captureConflict(sessionId, owner.sessionId, record.projectRoot));
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

    // 3. Open the window and move to `capturing` as one store transaction. The
    // window is opened with the store's own project check, and a refused
    // status commit rolls the window back, so no orphan window is left behind.
    const planVersion = latestPlan.value;
    const opened = sessions.transaction(
      (): Result<
        { readonly capture: CaptureRecord; readonly moved: CommittedTransition },
        DebuggenError
      > => {
        const window = sessions.startCapture({
          sessionId,
          planVersion,
          startedAt: stamp(),
          projectRoot: record.projectRoot,
        });

        if (isErr(window)) {
          return window;
        }

        const capture = window.value.capture;
        const moved = commitTransition(
          record,
          'capturing',
          {},
          { captures: mirrorCapture(record.captures, capture) },
          'startCapture',
        );

        return isErr(moved) ? moved : ok({ capture, moved: moved.value });
      },
    );

    if (isErr(opened)) {
      return err(startRefusal(record, key, opened.error));
    }

    // 4. The claim, only now that the store holds the window and the status —
    // still in the same synchronous turn as the check above.
    const { capture, moved } = opened.value;
    owners.set(key, Object.freeze({ sessionId, captureId: capture.id }));
    announceTransition(moved);

    // 5. The announcement, last.
    send(sessionId, 'capture.started', () =>
      createEnvelope('capture.started', { sessionId, captureId: capture.id }, { ts: stamp() }),
    );
    scoped(sessionId, capture.id).info('capture started', { planVersion: capture.planVersion });

    return ok({ captureId: capture.id });
  }

  /**
   * The capture window `stopCapture` closes, inside its transaction — or one
   * already closed while the session stayed `capturing`, which `stopCapture`
   * itself can no longer leave behind (its closure and status commit are one
   * transaction) but an `end` whose cleanup failed after its closure
   * committed, or a store written by an earlier build, can: that window is
   * picked up again so the session is never stuck in `capturing`.
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

    // The window closes with its summary and the session moves to
    // `options.next` in one store transaction. A refused status commit rolls
    // the closure back: the window stays open, the status stays `capturing`,
    // the project stays owned and no frame is sent, so stopping again retries
    // the whole step instead of finding a half-stopped capture.
    const committed = sessions.transaction(
      (): Result<
        { readonly capture: CaptureRecord; readonly moved: CommittedTransition },
        DebuggenError
      > => {
        const closed = closeForStop(record, options.summary);

        if (isErr(closed)) {
          return closed;
        }

        const eventCount = options.summary.eventCount;
        const capture: CaptureRecord =
          Number.isSafeInteger(eventCount) && eventCount >= 0
            ? { ...closed.value, eventCount }
            : closed.value;
        const moved = commitTransition(
          record,
          options.next,
          {},
          { captures: mirrorCapture(record.captures, capture) },
          'stopCapture',
        );

        return isErr(moved) ? moved : ok({ capture, moved: moved.value });
      },
    );

    if (isErr(committed)) {
      scoped(sessionId).info('capture stop refused; the capture keeps running', {
        next: options.next,
        code: committed.error.code,
      });
      return committed;
    }

    // Only once the store holds both: the project is released, then clients
    // hear `capture.stopped` and, last, the `session.updated` of the move.
    const { capture, moved } = committed.value;
    releaseOwnership(record);

    send(sessionId, 'capture.stopped', () =>
      createEnvelope(
        'capture.stopped',
        { sessionId, captureId: capture.id, summary: options.summary },
        { ts: stamp() },
      ),
    );
    announceTransition(moved);

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
            hint: authorProductText(INVALID_CLEANUP_OUTCOME_HINT),
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

      // The row shows the failure's own hint only when the product wrote it.
      // A hint the runner propagated from a collaborator — the backup store, a
      // filesystem call, a thrown error `DebuggenError.from` salvaged — may
      // quote a path or a value, so the product's retry step is passed in its
      // place (CWE-209); the failure's message still reaches the progress
      // emitter's `debug` diagnostic under the row's reference.
      const row = progress.stageFailed(sessionId, {
        stage: 'cleanup',
        code: error.code,
        message: error.message.trim().length > 0 ? error.message : CLEANUP_FAILURE_FALLBACK,
        hint: isProductAuthoredText(error.hint)
          ? error.hint
          : authorProductText(CLEANUP_RETRY_HINT),
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

    // 2. Close any open capture window together with the record that mirrors
    // it, as one store transaction, and release the project only once both are
    // stored. A window that cannot be closed refuses the end before cleanup
    // runs, with ownership retained, so ending again retries the closure.
    const mirrored = sessions.transaction(
      (): Result<
        { readonly session: SessionRecord; readonly captureId: CaptureId } | undefined,
        DebuggenError
      > => {
        const closed = closeOpenCapture(record, 'end');

        if (isErr(closed)) {
          return closed;
        }

        if (closed.value === undefined) {
          return ok(undefined);
        }

        const stored = commit(
          { ...record, captures: closed.value.captures, updatedAt: nextStamp(record) },
          'end',
        );

        return isErr(stored)
          ? stored
          : ok({ session: stored.value, captureId: closed.value.captureId });
      },
    );

    if (isErr(mirrored)) {
      scoped(sessionId).warn(
        'the session was not ended: its capture window could not be closed; ending it again retries',
        { code: mirrored.error.code },
      );
      return mirrored;
    }

    releaseOwnership(record);

    if (mirrored.value !== undefined) {
      scoped(sessionId, mirrored.value.captureId).info('open capture window closed', {
        operation: 'end',
      });
      announceUpdated(mirrored.value.session);
    }

    // 3. Cleanup, whatever the session's status (AAP §0.5.1).
    const outcome = await runCleanup(sessionId);

    if (isErr(outcome)) {
      return outcome;
    }

    // 4. The dev servers launched for the session go with it (AAP §0.7.1
    // Group 2), once its files are restored. A stopped child whose credential
    // still authenticates leaves the cleanup incomplete.
    const released = await releaseDevServers(sessionId);
    const reported = released ? outcome.value : withIncompleteRelease(outcome.value);

    // 5. The one cleanup report.
    const recorded = recordOutcome(sessionId, reported, 'end');

    if (isErr(recorded)) {
      return recorded;
    }

    // 6. The terminal transition — legal from every non-terminal status. The
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

    if (reported !== outcome.value) {
      completeWhenReleased(sessionId, outcome.value);
    }

    scoped(sessionId).info('session ended', { cleanup: reported.status });

    return ok({ session: moved.value, cleanup: reported });
  }

  /**
   * Once the release port confirms that the credentials of the session's
   * stopped dev servers no longer authenticate, completes the cleanup report
   * an incomplete release had left `partial`: the files' own outcome is
   * recorded (and broadcast as `cleanup.completed`) again. A report that
   * changed meanwhile is left as it is.
   */
  function completeWhenReleased(sessionId: SessionId, filesOutcome: SessionCleanupOutcome): void {
    const whenReleased = deps.devServers?.whenReleased?.bind(deps.devServers);

    if (whenReleased === undefined) {
      return;
    }

    void whenReleased(sessionId).then(
      () => {
        const loaded = load(sessionId);

        if (isErr(loaded) || loaded.value.cleanup.status !== 'partial') {
          return;
        }

        const completed = recordOutcome(
          sessionId,
          { ...filesOutcome, completedAt: stamp() },
          'end',
        );

        if (isErr(completed)) {
          scoped(sessionId).warn('the completed cleanup report could not be recorded', {
            code: completed.error.code,
          });
          return;
        }

        scoped(sessionId).info('the dev servers of the ended session are fully released', {
          cleanup: completed.value.cleanup.status,
        });
      },
      (error: unknown) => {
        scoped(sessionId).warn('waiting for the dev servers of the ended session failed', {
          code: DebuggenError.from(error).code,
        });
      },
    );
  }

  /**
   * Asks the injected release port to stop the ending session's dev servers.
   *
   * Never fails the end — the session's files are restored — but never hides
   * an incomplete release either: a refusal (typically `CLEANUP_PARTIAL`, a
   * stopped child whose credential could not be revoked yet) or a rejection is
   * logged by code and reported to both user interfaces as a `failed` cleanup
   * progress row carrying the port's message and hint, and the caller records
   * the cleanup as `partial`. The port itself keeps retrying the revocation,
   * and the credential lapses with its lease at the latest.
   *
   * @returns `true` when the release completed (or there is no port), `false`
   *   when it did not.
   */
  async function releaseDevServers(sessionId: SessionId): Promise<boolean> {
    const release = deps.devServers;

    if (release === undefined) {
      return true;
    }

    let failure: DebuggenError | undefined;

    try {
      const released = await release.stopForSession(sessionId);

      if (isErr(released)) {
        failure = released.error;
        scoped(sessionId).warn('the dev servers of the ended session were not fully released', {
          code: failure.code,
        });
      }
    } catch (error) {
      failure = DebuggenError.from(error);
      scoped(sessionId).error('releasing the dev servers of the ended session failed', {
        code: failure.code,
      });
    }

    if (failure === undefined) {
      return true;
    }

    const row = progress.stageFailed(sessionId, {
      stage: 'cleanup',
      code: failure.code,
      message:
        failure.message.trim().length > 0 ? failure.message : DEV_SERVER_RELEASE_FAILURE_FALLBACK,
      hint: failure.hint ?? DEV_SERVER_RELEASE_FAILURE_HINT,
    });

    if (isErr(row)) {
      scoped(sessionId).error('the incomplete dev-server release could not be reported', {
        code: row.error.code,
      });
    }

    return false;
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

  /** Page size of {@link settleIncompleteCleanups}'s walk over ended sessions. */
  const SETTLE_PAGE_SIZE = 200;

  async function settleIncompleteCleanups(): Promise<Result<number, DebuggenError>> {
    const runner = deps.cleanup;

    if (runner === undefined) {
      return ok(0);
    }

    // Collected first, so the reports this pass writes (which move a session's
    // `updatedAt`) cannot reorder the pages it is still walking.
    const partial: SessionId[] = [];

    for (let offset = 0; ;) {
      const page = sessions.list({ statuses: ['ended'], limit: SETTLE_PAGE_SIZE, offset });

      if (isErr(page)) {
        return page;
      }

      for (const item of page.value.items) {
        const loaded = load(item.id);

        if (!isErr(loaded) && loaded.value.cleanup.status === 'partial') {
          partial.push(item.id);
        }
      }

      offset += page.value.items.length;

      if (page.value.items.length === 0 || offset >= page.value.total) {
        break;
      }
    }

    let settledCount = 0;

    for (const sessionId of partial) {
      let outcome: Result<SessionCleanupOutcome, DebuggenError>;

      try {
        outcome = await runner.run(sessionId);
      } catch (thrown) {
        outcome = err(DebuggenError.from(thrown, 'INTERNAL'));
      }

      if (
        isErr(outcome) ||
        !isCleanupStatus(outcome.value.status) ||
        outcome.value.status === 'partial' ||
        outcome.value.status === 'pending'
      ) {
        scoped(sessionId).info('the partial cleanup of an ended session stays partial', {
          ...(isErr(outcome) ? { code: outcome.error.code } : { cleanup: outcome.value.status }),
        });
        continue;
      }

      const recorded = recordOutcome(sessionId, outcome.value, 'settleIncompleteCleanups');

      if (isErr(recorded)) {
        return recorded;
      }

      settledCount += 1;
      scoped(sessionId).info('settled the partial cleanup of an ended session', {
        cleanup: recorded.value.cleanup.status,
      });
    }

    return ok(settledCount);
  }

  // The store is synchronous, so every operation but `end` completes in one
  // turn; `settle` gives each the asynchronous contract the interface states,
  // so a caller's code does not change if one of them ever gains an await.
  return Object.freeze({
    hydrate: () => settle(hydrate),
    settleIncompleteCleanups,
    create: (input) => settle(() => create(input)),
    get,
    list,
    transitionTo: (sessionId, to, context) => settle(() => transitionTo(sessionId, to, context)),
    patch: (sessionId, changes) => settle(() => patch(sessionId, changes)),
    recordPlan: (sessionId, plan) => settle(() => recordPlan(sessionId, plan)),
    appendFollowUp: (sessionId, question, attemptId) =>
      settle(() => appendFollowUp(sessionId, question, attemptId)),
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
