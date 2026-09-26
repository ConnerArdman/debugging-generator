/**
 * End-of-session cleanup and start-up reconciliation — the module that makes
 * "every modification is removed" (AAP §0.5.1, acceptance test 3 of §0.8.4) a
 * literal statement about the developer's working tree.
 *
 * ## Three triggers, two code paths
 *
 * AAP §0.5.1 names three moments at which instrumentation must come out:
 *
 * | Trigger ({@link CLEANUP_TRIGGERS}) | Reaches this module through | Entry point |
 * | --- | --- | --- |
 * | `session-end` | `POST /sessions/:id/end` → `SessionManager.end` | {@link SessionCleanup.run} |
 * | `deactivate` | VS Code `deactivate()` → the same `POST /sessions/:id/end` | {@link SessionCleanup.run} |
 * | `service-start` | `src/main.ts`, before the first client is served | {@link reconcileModificationsOnStartup}, then {@link settleInterruptedSessions} |
 *
 * Editor deactivation is deliberately **not** a second branch: the extension
 * ends its active session over HTTP, so it arrives here exactly as an explicit
 * end does. A second branch would be a second chance to get the order below
 * wrong.
 *
 * Service start has two halves, because a restart interrupts sessions as well
 * as leaving files patched. {@link reconcileModificationsOnStartup} restores
 * every open journal record; then, once `SessionManager.hydrate()` has rebuilt
 * the capture-owner index, {@link settleInterruptedSessions} decides every
 * session the previous process left `instrumenting`, `ready` or `capturing`:
 * an install cannot survive a restart, a session whose patches the first half
 * removed can no longer capture what its plan promised, and a capture whose
 * plan was runtime-only would be advertised before any producer had taken its
 * configuration, so all three are failed with a sentence saying so, and every
 * failed capture is released so its producers are owed their dormant
 * configuration. A session left `capturing` is recorded no better than
 * `partial` by the first half, and stays so until its producers are confirmed
 * dormant. Nothing is sent to a producer at start-up — none is connected yet —
 * and a surviving producer is reconciled by the instrumentation service when
 * it reconnects.
 *
 * ## What this module decides, and what it delegates
 *
 * The file restoration itself — chains unwound strictly last-applied-first,
 * each step verifying the file's current hash against *that* record's
 * `instrumentedHash`, the backup read back and checked against `originalHash`,
 * the conditional atomic replace, the post-write verification, the `reverted`
 * transition and only then the backup's deletion — is `@debuggen/instrumentation`'s
 * `cleanupSession` and `reconcileModifications`. So is the per-status
 * reconciliation table and the restore-versus-conflict verdict of
 * `detectConflict`, which is the only authority that may authorise a write.
 * This module restates none of it. What it owns is everything *around* those
 * calls, in the only order that is safe:
 *
 * ```text
 * run(sessionId)
 *   1. serialise per session            (an end racing a deactivation must not restore twice)
 *   2. stop the conflict watcher        (a restore write would otherwise look like a developer edit)
 *   3. disable the runtime hooks        (agent dormant, preload instrumentations disabled — by delegation,
 *                                        judged by the service's delivery receipt)
 *   4. build the cleanup context        (journal, the session's own backup store, logger, clock, signal)
 *   5. cleanupSession(...)              (the package restores, or refuses and reports)
 *   6. verify the end state             (independently re-hash what the pass claims)
 *   7. fold in the hooks' verdict       (unconfirmed dormancy makes the pass `partial`)
 *   8. return the outcome               (SessionManager records it and broadcasts the one completion message)
 * ```
 *
 * ## The invariants this module is judged by
 *
 * 1. **A developer-edited file is never overwritten.** This module performs no
 *    write of its own and passes no option that could relax the package's
 *    verification; a conflict leaves the file as the developer left it and the
 *    original in `$DEBUGGEN_HOME/backups`, reported as a `ModificationConflict`.
 * 2. **A reported restore is a verified restore.** {@link verifyCleanupEndState}
 *    re-hashes every file the pass says it restored against the recorded
 *    original and every conflicted file against what the pass promised to
 *    leave, and a failed check can only make the reported status worse.
 * 3. **Runtime hooks are disabled, not idled — and a disarm is confirmed, not
 *    assumed.** The dormant page-agent configuration and the capture-less
 *    dev-server preload configuration are built and sent by
 *    `../instrumentation/service.ts`; this module only asks for them and
 *    restates neither. What it does judge is the service's delivery receipt
 *    ({@link CleanupDisarmOutcome.pending}): a disarm that failed, that cannot
 *    say who received it, or that names producers which did not, leaves hooks
 *    that may still be live, so the pass reports `partial` — its files are
 *    restored all the same. When the only shortfall was a named producer and
 *    the files came back clean, the runner waits for the service to confirm
 *    that producer dormant (it replays the configuration when the producer
 *    reconnects) and then upgrades the session's verdict to `clean`.
 * 4. **Start-up reconciliation never filters by session status.** The record set
 *    is `ModificationsRepo.listAllOpen()` — every non-`reverted` record of every
 *    session, whatever state that session was left in.
 * 5. **No residue and no marker knowledge.** This module restores bytes; it does
 *    not parse, name or search for the instrumentation markers, whose single
 *    definition is `packages/instrumentation/src/patch/wrap-template.ts`.
 * 6. **One writer, one broadcaster.** `SessionManager` is the only module that
 *    writes a session's status and the only emitter of the cleanup-completed
 *    message.
 *    {@link SessionCleanup.run} therefore *returns* its outcome (the manager's
 *    `end` records it), while {@link SessionCleanup.reconcileAll} and a later
 *    dormancy upgrade — verdicts no `end` is waiting for — route each affected
 *    session through the injected {@link CleanupOutcomeSink}; without one they
 *    persist only the session's `cleanup` sub-object, never its status. A
 *    session that must be failed after a restart is failed through the
 *    manager's `fail` ({@link settleInterruptedSessions}), never written here.
 * 7. **Conflicts and partial passes are outcomes, not errors.** `run` answers
 *    `ok` for `partial` and `conflict`; `err` is reserved for a pass that could
 *    not be attempted at all, which leaves the session un-ended so ending it
 *    again retries.
 *
 * ## Shape
 *
 * A factory with injected dependencies returning an interface, like the rest
 * of this service: no module-load side effect, no environment read, no wall
 * clock except through the injected `now`. Every collaborator that does not
 * exist yet when `src/main.ts` reconciles — the session manager, the progress
 * emitter, the instrumentation service, the watcher — is optional, and the
 * ports they satisfy are declared here structurally so that this module imports
 * no transport and no runtime edge back to `../sessions/manager.ts`.
 *
 * ## Privacy
 *
 * Log records carry ids, project-relative paths, statuses, reasons, counts and
 * error codes — never file bytes, a diff, a backup's content or an absolute
 * path of the developer's machine (AAP §0.5.2).
 *
 * @module
 */

import {
  cleanupSession,
  createBackupStore,
  reconcileModifications,
} from '@debuggen/instrumentation';
import type {
  BackupStore,
  CleanupContext,
  CleanupFailure,
  CleanupOutcome,
  InstrumentationPlan,
  ModificationConflict,
  ModificationRecord,
  ReconcileOutcome,
} from '@debuggen/instrumentation';
import { CLEANUP_STATUSES } from '@debuggen/protocol';
import type {
  CleanupStatus,
  ProgressStage,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  noopLogger,
  nowEpochMs,
  ok,
  resolveWithinProject,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';
import { readFileNoFollow, sha256Hex } from '@debuggen/shared/node';

import type { ServiceConfig } from '../config.js';
import { sessionLogger, subsystemLogger } from '../logging.js';
import type { SessionCleanupOutcome, SessionCleanupRunner } from '../sessions/manager.js';
import type { SessionProgress } from '../sessions/progress.js';
import type { SessionFailure } from '../sessions/state-machine.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import type { SessionListItem, SessionListPage, SessionsRepo } from '../store/sessions-repo.js';

// ---------------------------------------------------------------------------
// Section A — vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a cleanup pass ran, in the order AAP §0.5.1 lists the three moments.
 *
 * Bound on every log record of a pass as `trigger`. `session-end` and
 * `deactivate` share {@link SessionCleanup.run} — the editor's deactivation
 * ends its session over the same HTTP route — and a caller that knows which of
 * the two it is may say so through {@link SessionCleanupRunOptions.trigger};
 * `service-start` is {@link reconcileModificationsOnStartup}.
 */
export const CLEANUP_TRIGGERS = Object.freeze([
  'session-end',
  'deactivate',
  'service-start',
] as const);

/** One of {@link CLEANUP_TRIGGERS}. */
export type CleanupTrigger = (typeof CLEANUP_TRIGGERS)[number];

/** The progress stage every cleanup row is reported under. */
const CLEANUP_STAGE = 'cleanup' satisfies ProgressStage;

/** The logger subsystem binding, conventionally the source folder name. */
const LOG_SUBSYSTEM = 'cleanup';

/**
 * The most record ids a single log record lists. Ids are not sensitive, but a
 * journal with hundreds of unplaceable records must not produce a log line of
 * unbounded size.
 */
const MAX_LOGGED_RECORD_IDS = 50;

/**
 * The most sessions a runner remembers as "restored, but not yet confirmed
 * dormant" (see {@link SessionCleanup.run}). One entry per session ended while a
 * producer was unreachable, so the bound is never met in practice; it exists so
 * that a producer which never reconnects cannot grow the map for the service's
 * lifetime. The oldest entry is forgotten first, and its session simply stays
 * `partial` — the fail-safe answer.
 */
const MAX_AWAITING_DORMANCY = 1000;

/**
 * How long the first retry of a dormancy upgrade that could not be recorded
 * waits, in milliseconds; each later retry waits twice as long.
 */
const UPGRADE_RETRY_BASE_MS = 500;

/**
 * How many times a dormancy upgrade that could not be recorded is retried
 * before the session is left `partial` — the conservative verdict — and the
 * give-up is logged.
 */
const MAX_UPGRADE_ATTEMPTS = 6;

/** The status of a session whose capture window was open when its process ended. */
const CAPTURING_STATUS = 'capturing' satisfies SessionStatus;

/**
 * How bad each cleanup status is, for combining two verdicts about the same
 * pass without ever improving one.
 *
 * `clean` is the only good answer; `pending` (no pass has run) sits below
 * `partial` (a pass ran and left something open), and `conflict` is the most
 * severe because it is the one a developer must act on. Written as a record
 * over the protocol's status union, so a status added to `CLEANUP_STATUSES`
 * fails to compile here until it has a rank.
 */
const STATUS_SEVERITY: Readonly<Record<CleanupStatus, number>> = Object.freeze({
  clean: 0,
  pending: 1,
  partial: 2,
  conflict: 3,
});

/**
 * Compile-time guard: the engine's three verdicts are members of the protocol's
 * four-value session vocabulary, so an engine status can be reported verbatim.
 */
type AssertTrue<T extends true> = T;

/** Holds while `@debuggen/instrumentation`'s verdicts fit `session.cleanup.status`. */
export type EngineCleanupStatusFitsProtocol = AssertTrue<
  CleanupOutcome['status'] extends CleanupStatus
    ? ReconcileOutcome['status'] extends CleanupStatus
      ? true
      : false
    : false
>;

// ---------------------------------------------------------------------------
// Section B — consumer-side ports
// ---------------------------------------------------------------------------

/**
 * What a cleanup context is built from.
 *
 * `planVersion` is accepted so a fuller factory (one that also serves adapters)
 * can be passed unchanged; cleanup itself is plan-agnostic — a session is
 * cleaned up from its journal, with no plan in play.
 */
export interface CleanupContextRequest {
  /** The session whose records the context restores. */
  readonly sessionId: string;

  /** The session's absolute project root, from its stored record. */
  readonly projectRoot: string;

  /** The plan version in force, when the caller knows one. */
  readonly planVersion?: number | undefined;

  /** Cancellation, honoured by the engine between records. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Builds the context `cleanupSession` / `reconcileModifications` run against.
 *
 * The result is typed as the engine's `CleanupContext` — a structural subset of
 * `InstrumentationContext` — because that is all a restore needs: the journal,
 * the session's own backup store (rooted at `<debuggenHome>/backups/<sessionId>`),
 * a logger, a clock and a signal. Any factory that produces a full
 * `InstrumentationContext` satisfies this port unchanged.
 * {@link createCleanupContextFactory} is the default.
 */
export type InstrumentationContextFactory = (
  input: CleanupContextRequest,
) => Result<CleanupContext, DebuggenError> | Promise<Result<CleanupContext, DebuggenError>>;

/**
 * Where a session-scoped outcome is recorded and broadcast.
 *
 * Satisfied by `SessionManager.recordCleanupOutcome`, which persists
 * `session.cleanup` and broadcasts the cleanup-completed message
 * `{ sessionId, status, conflicts }` — the single emitter of it. Used by the
 * start-up reconciliation, once per affected session.
 *
 * {@link SessionCleanup.run} deliberately does **not** call it: `run` is invoked
 * by `SessionManager.end`, which records the returned outcome through this very
 * method itself, so a runner that also delivered it would put two identical
 * reports in front of the developer — the duplication the manager exists to
 * prevent.
 */
export interface CleanupOutcomeSink {
  recordCleanupOutcome(
    sessionId: string,
    outcome: SessionCleanupOutcome,
  ): Result<unknown, DebuggenError> | Promise<Result<unknown, DebuggenError>>;
}

/**
 * What {@link InstrumentationDisabler.disarmCapture} is asked.
 *
 * Carries no capture id on purpose: the instrumentation service addresses the
 * dormant page-agent configuration from the capture it armed itself, and the
 * open capture row belongs to `SessionManager`, which closes it before cleanup
 * runs. This module reads that row for its log context only.
 */
export interface CleanupDisarmRequest {
  /** The session whose producers are disarmed. */
  readonly sessionId: string;

  /** The project whose dev-server preload is disabled, for a session the service no longer tracks. */
  readonly projectRoot?: string | undefined;
}

/**
 * What {@link InstrumentationDisabler.disarmCapture} reports back: the delivery
 * receipt a pass judges the runtime hooks by.
 *
 * `sessionId` is required on purpose. A port whose members were all optional
 * would be a "weak type" any outcome object is compared against member by
 * member; with one required member the instrumentation service's own, richer
 * outcome type stays assignable as it grows, and this module reads only what it
 * names here.
 */
export interface CleanupDisarmOutcome {
  /** The session the disarm addressed. */
  readonly sessionId: string;

  /**
   * The producers the service had armed for the session that did **not**
   * receive their dormant configuration (`page-agent`, `server-agent`, or a
   * producer kind added later) — named by kind, never by address.
   *
   * Read fail-safe, because a disarm that nobody received leaves live hooks:
   *
   * | Value | Reading |
   * | --- | --- |
   * | `[]` | every armed producer received its dormant configuration: dormancy confirmed |
   * | non-empty | those producers may still be armed: not confirmed until the service says so |
   * | absent | the disabler cannot say who received it: not confirmed, ever, by this pass |
   */
  readonly pending?: readonly string[] | undefined;
}

/**
 * The runtime-hook half of cleanup, owned by `../instrumentation/service.ts`.
 *
 * Satisfied by `InstrumentationService`: `disarmCapture` sends the page agent a
 * configuration with every hook false and the dev-server preload one with no
 * capture, which returns the agent to dormant (listeners detached, the
 * fetch/XHR patch restored, the fiber hook unsubscribed) and makes the preload
 * disable its pg and Prisma instrumentations and remove the global tracer
 * provider, so no span is even created; its outcome's
 * {@link CleanupDisarmOutcome.pending} names the armed producers that did not
 * receive that configuration. `stopSession` releases the service's per-session
 * state. `isInstalling` lets a pass refuse to race an install that is still
 * writing files.
 *
 * `onDormancyConfirmed` is how a disarm that could not be delivered is settled
 * later: the service keeps the undelivered configurations, replays them when
 * the producer reconnects, and calls the listener with the session id once
 * every one of them has been delivered. It returns the unsubscribe function.
 */
export interface InstrumentationDisabler {
  disarmCapture(
    request: CleanupDisarmRequest,
  ):
    | Result<CleanupDisarmOutcome, DebuggenError>
    | Promise<Result<CleanupDisarmOutcome, DebuggenError>>;

  stopSession(sessionId: string): Promise<unknown> | void;

  isInstalling?(sessionId: string): boolean;

  onDormancyConfirmed?(listener: (sessionId: string) => void): (() => void) | void;
}

/**
 * The conflict watcher's release, satisfied by `InstrumentationWatcher`.
 *
 * The watcher's one mutation is `applied → conflict` whenever a watched file's
 * digest stops matching `instrumentedHash` — which is exactly what a restore
 * write does — so it is stopped for a session before any of its files is
 * touched.
 */
export interface InstrumentationSuspender {
  stopSession(sessionId: string): Promise<unknown> | void;
}

// ---------------------------------------------------------------------------
// Section C — what a pass reports
// ---------------------------------------------------------------------------

/**
 * The counts {@link aggregateCleanupStatus} reads. Each is a number of
 * modification records (or, for `failed`, of failures — a journal that would
 * not answer is one failure with no record behind it).
 */
export interface CleanupCounts {
  /** Records that ended `reverted`: restored from their backup, or closed without a write. */
  readonly restored: number;

  /** Outstanding conflicts: reports produced or re-reported, and refused chain forks. */
  readonly conflicts: number;

  /** Records deliberately left open: retained conflicts, records behind one, an aborted remainder. */
  readonly skipped: number;

  /** Records or checks that could not be finished, including failed end-state verifications. */
  readonly failed: number;
}

/**
 * The independent end-state checks of {@link verifyCleanupEndState}.
 *
 * - `restored-content` — a file the pass restored (or closed) no longer hashes
 *   to the original its chain recorded.
 * - `conflict-content` — a conflicted file holds bytes the pass promised not to
 *   leave: the recorded original where the developer's edit was, or (for a
 *   `content-changed` conflict) the instrumented bytes the conflict said were
 *   gone.
 * - `conflict-backup` — the backup a conflict points the developer at is gone.
 */
export const VERIFICATION_CHECKS = Object.freeze([
  'restored-content',
  'conflict-content',
  'conflict-backup',
] as const);

/** One of {@link VERIFICATION_CHECKS}. */
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];

/** One end-state check that did not hold. Ids, paths and codes only. */
export interface VerificationIssue {
  /** Which check failed. */
  readonly check: VerificationCheck;

  /** The record the check was about. */
  readonly recordId: string;

  /** Its project-relative file. */
  readonly file: string;

  /**
   * Why, in the kebab-case vocabulary of this module: `hash-mismatch`,
   * `file-missing`, `file-unreadable`, `path-refused`, `original-over-edit`,
   * `instrumented-content-present`, `backup-missing`, `backup-unreadable` or
   * `record-unknown`.
   */
  readonly reason: string;

  /** The error code behind a read or containment failure, when there was one. */
  readonly code?: string | undefined;
}

/** What {@link verifyCleanupEndState} found. */
export interface VerificationReport {
  /** How many checks ran. */
  readonly checked: number;

  /** Every check that did not hold, in the order they ran. */
  readonly issues: readonly VerificationIssue[];
}

/** One failure a reconciliation could not settle, as JSON: never a live error object. */
export interface CleanupErrorEntry {
  /** The session the failure belongs to; `''` when the journal itself would not answer. */
  readonly sessionId: string;

  /** The record the failure is about, when there is one. */
  readonly recordId?: string | undefined;

  /** The error's code. */
  readonly code: DebuggenErrorCode;

  /** The error's message. */
  readonly message: string;
}

/** What the start-up reconciliation did for one session. */
export interface SessionReconciliationSummary {
  /** The session. */
  readonly sessionId: string;

  /** The verdict recorded on the session's `cleanup.status`. */
  readonly status: CleanupStatus;

  /** Open records the journal listed for the session. */
  readonly scanned: number;

  /** Records restored from their backups and verified. */
  readonly restored: number;

  /** Records closed without a write: nothing had been written for them. */
  readonly closed: number;

  /** Distinct records carrying a conflict report after the pass. */
  readonly conflicts: number;

  /** Records the pass deliberately did not attempt. */
  readonly skipped: number;

  /** Records or checks the pass could not finish. */
  readonly failed: number;

  /** Records that could not be placed in a project, left exactly as they were. */
  readonly unresolved: number;
}

/**
 * What a start-up reconciliation did, across every session it examined.
 *
 * JSON-serialisable and deterministic: sessions are processed and listed in
 * sorted id order, counts are plain numbers, errors are plain entries, and
 * `completedAt` comes from the injected clock.
 */
export interface StartupReconciliationReport {
  /** The worst verdict across every session examined; `clean` when there was nothing to do. */
  readonly status: CleanupStatus;

  /** Every open record `listAllOpen()` returned, across all sessions. */
  readonly scanned: number;

  /** Records closed without a write. */
  readonly closed: number;

  /** Records restored from their backups and verified. */
  readonly restored: number;

  /** Distinct records carrying a conflict report after the pass. */
  readonly conflicts: number;

  /** Records whose session row is gone, so no project root can place them. */
  readonly unresolved: number;

  /** Records or checks the pass could not finish. */
  readonly failed: number;

  /** Records the pass deliberately did not attempt, including those left by an abort. */
  readonly skipped: number;

  /** Whether cancellation stopped the pass before every session was examined. */
  readonly aborted: boolean;

  /** Per-session summaries, keyed by session id in sorted order. */
  readonly bySession: Readonly<Record<string, SessionReconciliationSummary>>;

  /** Every failure the pass could not settle, in the order met. */
  readonly errors: readonly CleanupErrorEntry[];

  /** When the pass finished, in epoch milliseconds. */
  readonly completedAt: number;
}

// ---------------------------------------------------------------------------
// Section D — dependencies and the public surface
// ---------------------------------------------------------------------------

/**
 * What the start-up reconciliation needs: the two repositories and the state
 * directory, with everything else optional because `src/main.ts` runs it before
 * the session manager, the broadcaster and the instrumentation service exist.
 */
export interface StartupReconciliationDeps {
  /** The modification journal; its `listAllOpen()` is the reconciliation set. */
  readonly modifications: ModificationsRepo;

  /** The session store, for each session's `projectRoot` and its `cleanup` sub-object. */
  readonly sessions: Pick<SessionsRepo, 'get' | 'update' | 'getActiveCapture'>;

  /** Where `$DEBUGGEN_HOME` was resolved to. */
  readonly config: Pick<ServiceConfig, 'debuggenHome'>;

  /** The context factory. Defaults to {@link createCleanupContextFactory}. */
  readonly buildContext?: InstrumentationContextFactory | undefined;

  /** Where a per-session outcome is recorded and broadcast, once the manager exists. */
  readonly outcomeSink?: CleanupOutcomeSink | undefined;

  /** The conflict watcher, when one is running. */
  readonly watcher?: InstrumentationSuspender | undefined;

  /** The service logger; bound to `subsystem: "cleanup"`. Defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;

  /** The clock, in epoch milliseconds. Defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;

  /** Service-lifetime cancellation. */
  readonly signal?: AbortSignal | undefined;
}

/** Everything {@link createSessionCleanup} is given; all of it is injected. */
export interface SessionCleanupDeps extends StartupReconciliationDeps {
  /** The runtime-hook disabler, once the instrumentation service exists. */
  readonly instrumentation?: InstrumentationDisabler | undefined;

  /** The progress emitter; owns every display label of the `cleanup` stage. */
  readonly progress?: Pick<SessionProgress, 'stageStarted' | 'stageCompleted'> | undefined;
}

/** Options for {@link SessionCleanup.run}. */
export interface SessionCleanupRunOptions {
  /** Which of the two session-scoped triggers this is. Defaults to `session-end`. */
  readonly trigger?: Exclude<CleanupTrigger, 'service-start'> | undefined;
}

/** Options for a start-up reconciliation. */
export interface StartupReconciliationOptions {
  /**
   * Restrict the pass to these sessions — a retry after a partial pass. The
   * journal is still asked for every open record; only the sessions acted on
   * are narrowed.
   */
  readonly sessionIds?: readonly string[] | undefined;

  /** Cancellation for this pass, in addition to the service-lifetime signal. */
  readonly signal?: AbortSignal | undefined;
}

/** What {@link SessionCleanup.holdUntilDormant} is told about a released capture. */
export interface ReleasedCaptureVerdict {
  /**
   * The producers the release could not deliver a dormant configuration to, or
   * `undefined` when the release was refused or did not say who received it.
   */
  readonly pending: readonly string[] | undefined;

  /**
   * The files' own verdict from the start-up reconciliation, or `undefined`
   * when the session held no open modification record.
   */
  readonly files: CleanupStatus | undefined;
}

/**
 * The session cleanup runner.
 *
 * Satisfies `SessionCleanupRunner` from `../sessions/manager.ts` — see
 * {@link SessionCleanupSatisfiesRunner} — so it is passed to
 * `createSessionManager({ cleanup })` without an adapter.
 */
export interface SessionCleanup {
  /**
   * Cleans up one session: stops watching it, disables its runtime hooks and
   * restores every non-`reverted` modification record in strict reverse order,
   * then verifies the end state.
   *
   * Serialised per session — a concurrent call returns the first call's
   * result — and idempotent: a second call after a clean pass finds nothing
   * open, writes nothing and answers `clean`.
   *
   * The runtime hooks count: a pass is `clean` only when the instrumentation
   * service's delivery receipt confirms every producer it armed received its
   * dormant configuration. Otherwise the files are still restored and the pass
   * answers `partial`. When the only shortfall was a named producer that could
   * not be reached, the runner remembers the session, and when the service
   * later reports it dormant (after replaying the configuration on reconnect)
   * the session's verdict is upgraded to `clean` through the outcome sink —
   * once, as a new verdict, never as a second copy of this return value.
   *
   * @returns `ok(outcome)` for every pass that ran, `partial` and `conflict`
   * included; `err` only when cleanup could not be attempted at all, which
   * leaves the session un-ended so ending it again retries.
   */
  run(
    sessionId: string,
    options?: SessionCleanupRunOptions,
  ): Promise<Result<SessionCleanupOutcome, DebuggenError>>;

  /**
   * Reconciles every open record in the journal across all sessions — the
   * service-start path, also usable as a retry. Waits for session passes in
   * flight, and session passes started meanwhile wait for it.
   *
   * @returns The report, or `err` when the journal could not be read at all.
   */
  reconcileAll(
    options?: StartupReconciliationOptions,
  ): Promise<Result<StartupReconciliationReport, DebuggenError>>;

  /**
   * Keeps the cleanup verdict of a session a service restart failed at
   * `partial` while the producers of the capture it held are not known to be
   * dormant — the service-start path of {@link settleInterruptedSessions},
   * which calls it with what the release of that capture reported.
   *
   * The start-up reconciliation already records a session left `capturing` as
   * at best `partial`; a stored `clean` found here is recorded `partial` now.
   * When `release.pending` names the producers the release could not reach,
   * the session is remembered and upgraded to `clean` once the instrumentation
   * service confirms them dormant, exactly as a pass's own `partial` is; an
   * empty list is that confirmation already. `undefined` means the release was
   * refused or did not say who received it, so nothing can confirm it and the
   * `partial` stands until the session is ended again.
   *
   * Only a session whose files are clean is held or upgraded: a `conflict`
   * stands, and a session that held no record and was never cleaned stays
   * `pending`. A pass in flight for the session decides its own verdict.
   *
   * @returns `err` when the session could not be read or its `partial` verdict
   * could not be recorded — the caller must not serve a `clean` it could not
   * correct — and `ok` otherwise. Never rejects.
   */
  holdUntilDormant(
    sessionId: string,
    release: ReleasedCaptureVerdict,
  ): Promise<Result<void, DebuggenError>>;

  /**
   * Stops the runner: passes in flight stop before their next record (never
   * inside a write), later calls are refused, the dormancy subscription is
   * released and no remembered session is upgraded any more. Idempotent.
   */
  dispose(): void;
}

/** Holds while {@link SessionCleanup} can be injected as the manager's cleanup runner. */
export type SessionCleanupSatisfiesRunner = AssertTrue<
  SessionCleanup extends SessionCleanupRunner ? true : false
>;

// ---------------------------------------------------------------------------
// Section E — pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether a count says "some". Fail-safe: anything that is not a safe integer
 * at or below zero — `NaN`, an infinity, a fraction — counts as present, so a
 * broken count can make a verdict worse but never report a pass `clean`.
 */
function present(count: number): boolean {
  return !(Number.isSafeInteger(count) && count <= 0);
}

/**
 * Maps a pass's counts onto the session's cleanup verdict.
 *
 * Pure and total, and deliberately the same precedence the engine applies:
 *
 * ```text
 * any outstanding conflict             → conflict   (the developer must act; the tool refused to overwrite)
 * anything skipped or failed otherwise → partial    (a later pass can settle it)
 * nothing outstanding                  → clean      (every record reverted, every check held)
 * ```
 *
 * `restored` never changes the answer — the verdict describes the state a pass
 * leaves, not the work it did — and `pending` is never produced: it is the
 * state *before* a pass has run.
 *
 * @param counts What the pass left behind.
 * @returns One of the protocol's `CLEANUP_STATUSES`, never `pending`.
 */
export function aggregateCleanupStatus(counts: CleanupCounts): CleanupStatus {
  if (present(counts.conflicts)) {
    return 'conflict';
  }

  if (present(counts.skipped) || present(counts.failed)) {
    return 'partial';
  }

  return 'clean';
}

/**
 * Narrows a verdict that crossed a package boundary to the protocol's
 * vocabulary. An unknown value is read as `partial` — "something is
 * outstanding" — never as `clean`.
 */
function asCleanupStatus(value: string): CleanupStatus {
  return (CLEANUP_STATUSES as readonly string[]).includes(value)
    ? (value as CleanupStatus)
    : 'partial';
}

/** The more severe of two verdicts: combining never improves a pass's answer. */
function worstStatus(left: CleanupStatus, right: CleanupStatus): CleanupStatus {
  return STATUS_SEVERITY[right] > STATUS_SEVERITY[left] ? right : left;
}

/**
 * One conflict per record, in first-detection order, carrying the latest
 * report for that record — the one composed from the file as it stands now.
 */
function distinctConflicts(conflicts: readonly ModificationConflict[]): ModificationConflict[] {
  const byRecord = new Map<string, ModificationConflict>();

  for (const conflict of conflicts) {
    byRecord.set(conflict.recordId, conflict);
  }

  return [...byRecord.values()];
}

/** The errno code of a thrown filesystem error, when it carries one. */
function errnoCode(thrown: unknown): string | undefined {
  if (typeof thrown === 'object' && thrown !== null && 'code' in thrown) {
    const { code } = thrown as { readonly code: unknown };

    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

/** A bounded list of record ids for a log record. */
function loggedIds(records: readonly ModificationRecord[]): string[] {
  return records.slice(0, MAX_LOGGED_RECORD_IDS).map((record) => record.id);
}

/** The JSON form of a failure the pass could not settle. */
function toErrorEntry(
  sessionId: string,
  error: DebuggenError,
  recordId?: string,
): CleanupErrorEntry {
  return recordId === undefined || recordId.length === 0
    ? { sessionId, code: error.code, message: error.message }
    : { sessionId, recordId, code: error.code, message: error.message };
}

/** Whether a string is present and not blank. */
function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether an engine pass could not be attempted at all: the journal would not
 * answer, so every failure is the unattributed one and nothing else happened.
 */
function journalUnanswered(outcome: CleanupOutcome): DebuggenError | undefined {
  const [first] = outcome.failures;

  if (
    first === undefined ||
    outcome.restored.length > 0 ||
    outcome.conflicts.length > 0 ||
    outcome.skipped.length > 0 ||
    outcome.failures.some((failure) => failure.recordId.length > 0)
  ) {
    return undefined;
  }

  return first.error;
}

/** Runs `operation`, turning a throw into an `err` with `fallbackCode`. */
async function settle<T>(
  operation: () => Result<T, DebuggenError> | Promise<Result<T, DebuggenError>>,
  fallbackCode: DebuggenErrorCode,
): Promise<Result<T, DebuggenError>> {
  try {
    return await operation();
  } catch (thrown) {
    return err(DebuggenError.from(thrown, fallbackCode));
  }
}

// ---------------------------------------------------------------------------
// Section F — the default context factory
// ---------------------------------------------------------------------------

/** What {@link createCleanupContextFactory} is built from. */
export interface CleanupContextFactoryDeps {
  /** The modification journal every context hands the engine. */
  readonly modifications: ModificationsRepo;

  /** Where `$DEBUGGEN_HOME` was resolved to; backups live under its `backups/` directory. */
  readonly config: Pick<ServiceConfig, 'debuggenHome'>;

  /** The logger each context's session logger is derived from. */
  readonly logger?: Logger | undefined;

  /** The clock each context carries. */
  readonly now?: (() => number) | undefined;
}

/**
 * The default {@link InstrumentationContextFactory}: the journal repository and
 * the session's own content-addressed backup store at
 * `<debuggenHome>/backups/<sessionId>` — the same store the patcher filed the
 * originals in, so the engine's store-belongs-to-record check holds.
 *
 * Opening a store creates nothing on disk; it is a rooted path policy. A state
 * directory or session id the store refuses is answered as `err`, never thrown.
 */
export function createCleanupContextFactory(
  deps: CleanupContextFactoryDeps,
): InstrumentationContextFactory {
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);
  const now = deps.now ?? nowEpochMs;

  return (input: CleanupContextRequest): Result<CleanupContext, DebuggenError> => {
    if (!isNonBlank(input.sessionId) || !isNonBlank(input.projectRoot)) {
      return err(
        new DebuggenError(
          'SESSION_NOT_FOUND',
          'A cleanup context needs the session id and the project root of a stored session.',
          {
            hint: 'Pass the id and projectRoot of the session whose modifications are restored.',
            details: { reason: 'context-input-missing' },
          },
        ),
      );
    }

    const logger = sessionLogger(log, input.sessionId);
    let backups: BackupStore;

    try {
      backups = createBackupStore({
        debuggenHome: deps.config.debuggenHome,
        sessionId: input.sessionId,
        logger,
      });
    } catch (thrown) {
      return err(DebuggenError.from(thrown, 'FS_UNSAFE_PATH'));
    }

    return ok({
      projectRoot: input.projectRoot,
      backups,
      journal: deps.modifications,
      logger,
      now,
      signal: input.signal,
    });
  };
}

// ---------------------------------------------------------------------------
// Section G — independent end-state verification
// ---------------------------------------------------------------------------

/** What {@link verifyCleanupEndState} checks. */
export interface CleanupEndStateInput {
  /** The absolute project root every `record.file` is resolved and contained inside. */
  readonly projectRoot: string;

  /** The backup store of the session the records belong to. */
  readonly backups: BackupStore;

  /** Every record the pass ended `reverted` — restored from its backup, or closed without a write. */
  readonly finished: readonly ModificationRecord[];

  /** Every record the pass left open, which is where a conflict's record is normally found. */
  readonly open: readonly ModificationRecord[];

  /** Every conflict the pass reported. */
  readonly conflicts: readonly ModificationConflict[];

  /** Reads a record the two lists do not hold, by id. */
  readonly lookup?: ((recordId: string) => Promise<ModificationRecord | undefined>) | undefined;
}

/** What a file's bytes looked like when verification read them. */
type FileReading =
  | { readonly kind: 'present'; readonly hash: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly code: string | undefined }
  | { readonly kind: 'refused'; readonly code: string };

/**
 * Hashes one project file's raw bytes, refusing a path outside the project and
 * a symbolic link at the final component.
 *
 * The no-follow read is the same byte-exact SHA-256 as `sha256OfFile` —
 * `@debuggen/shared/node`'s `sha256Hex` over the file's own bytes, with no
 * newline or encoding normalisation — but answers for the bytes *at that
 * path*: a link planted after the restore must not be able to vouch for it with
 * somebody else's content.
 */
function readDigest(projectRoot: string, file: string): FileReading {
  const resolved = resolveWithinProject(projectRoot, file);

  if (isErr(resolved)) {
    return { kind: 'refused', code: resolved.error.code };
  }

  try {
    return { kind: 'present', hash: sha256Hex(readFileNoFollow(resolved.value)) };
  } catch (thrown) {
    const code = errnoCode(thrown);

    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'missing' }
      : { kind: 'unreadable', code };
  }
}

/** The reason word for a reading that is not the expected bytes. */
function readingReason(reading: Exclude<FileReading, { kind: 'present' }>): string {
  switch (reading.kind) {
    case 'missing':
      return 'file-missing';
    case 'unreadable':
      return 'file-unreadable';
    case 'refused':
      return 'path-refused';
  }
}

/**
 * The record whose `originalHash` a file should hold after its restored chain
 * was unwound: the one no other finished record of the file is layered under.
 *
 * Checking every finished record against its *own* `originalHash` would be
 * wrong for a chain — plan version *n + 1*'s original is plan version *n*'s
 * instrumented content, which the next step of the same pass replaced — so a
 * file is judged once, against its root-most finished record. Ties (which a
 * journal that refuses forks never produces) resolve by plan version, then
 * application time, then id, so the choice is deterministic.
 */
function rootMostRecord(records: readonly ModificationRecord[]): ModificationRecord | undefined {
  const ids = new Set(records.map((record) => record.id));
  const roots = records.filter(
    (record) => record.previousRecordId === undefined || !ids.has(record.previousRecordId),
  );
  const candidates = roots.length > 0 ? roots : records;

  return [...candidates].sort(
    (left, right) =>
      left.planVersion - right.planVersion ||
      left.appliedAt - right.appliedAt ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  )[0];
}

/** Groups records by their project-relative file, in first-seen order. */
function groupByFile(records: readonly ModificationRecord[]): Map<string, ModificationRecord[]> {
  const groups = new Map<string, ModificationRecord[]>();

  for (const record of records) {
    const group = groups.get(record.file);

    if (group === undefined) {
      groups.set(record.file, [record]);
    } else {
      group.push(record);
    }
  }

  return groups;
}

/** The `details.reason` of an error, when it carries a string one. */
function detailsReason(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];

  return typeof reason === 'string' ? reason : undefined;
}

/** Whether the backup a conflict points at can still be read. */
async function backupIssue(
  backups: BackupStore,
  conflict: ModificationConflict,
  record: ModificationRecord,
): Promise<VerificationIssue | undefined> {
  let read: Result<unknown, DebuggenError>;

  try {
    read = await backups.readRecorded(conflict.backupPath, record.originalHash);
  } catch (thrown) {
    return {
      check: 'conflict-backup',
      recordId: record.id,
      file: record.file,
      reason: 'backup-unreadable',
      code: errnoCode(thrown) ?? DebuggenError.from(thrown, 'STORE_ERROR').code,
    };
  }

  if (!isErr(read)) {
    return undefined;
  }

  return {
    check: 'conflict-backup',
    recordId: record.id,
    file: record.file,
    reason: detailsReason(read.error) === 'backup-missing' ? 'backup-missing' : 'backup-unreadable',
    code: read.error.code,
  };
}

/** Whether a conflicted file holds bytes the pass promised not to leave there. */
function conflictContentIssue(
  projectRoot: string,
  conflict: ModificationConflict,
  record: ModificationRecord,
): VerificationIssue | undefined {
  const reading = readDigest(projectRoot, record.file);
  const base = { check: 'conflict-content', recordId: record.id, file: record.file } as const;

  if (reading.kind === 'missing') {
    // Nothing is at the path, so nothing was written over the developer's bytes.
    return undefined;
  }

  if (reading.kind !== 'present') {
    return { ...base, reason: readingReason(reading), code: reading.code };
  }

  if (
    conflict.actualHash !== undefined &&
    reading.hash !== conflict.actualHash &&
    reading.hash === record.originalHash
  ) {
    // The pass observed the developer's bytes and the recorded original is there
    // now: exactly the overwrite invariant 1 forbids.
    return { ...base, reason: 'original-over-edit' };
  }

  if (conflict.reason === 'content-changed' && reading.hash === record.instrumentedHash) {
    // The conflict says the instrumented bytes are gone; they are not.
    return { ...base, reason: 'instrumented-content-present' };
  }

  return undefined;
}

/**
 * Re-checks what a cleanup pass claims, independently of the engine that made
 * the claim.
 *
 * - Every file the pass restored or closed must hash to the recorded original
 *   of its root-most finished record (see {@link rootMostRecord}).
 * - Every conflicted file must still be as the pass found it: the recorded
 *   original must not have appeared over bytes the pass observed to differ, and
 *   a `content-changed` file must not hold the instrumented bytes again.
 * - Every conflict's backup must still exist — except for a `backup-missing`
 *   conflict, whose definition is its absence — because it is the copy the
 *   developer is pointed at.
 *
 * Reads only; writes nothing, deletes nothing and throws nothing. A failed check
 * is an issue in the report, which a caller turns into a worse verdict — never a
 * better one.
 *
 * @param input The project, the session's backup store and what the pass reported.
 * @returns How many checks ran and which of them did not hold.
 */
export async function verifyCleanupEndState(
  input: CleanupEndStateInput,
): Promise<VerificationReport> {
  const issues: VerificationIssue[] = [];
  let checked = 0;

  for (const [file, records] of groupByFile(input.finished)) {
    const root = rootMostRecord(records);

    if (root === undefined) {
      continue;
    }

    checked += 1;
    const reading = readDigest(input.projectRoot, file);

    if (reading.kind !== 'present') {
      issues.push({
        check: 'restored-content',
        recordId: root.id,
        file,
        reason: readingReason(reading),
        code: reading.kind === 'missing' ? undefined : reading.code,
      });
    } else if (reading.hash !== root.originalHash) {
      issues.push({ check: 'restored-content', recordId: root.id, file, reason: 'hash-mismatch' });
    }
  }

  const known = new Map<string, ModificationRecord>();

  for (const record of [...input.finished, ...input.open]) {
    known.set(record.id, record);
  }

  for (const conflict of distinctConflicts(input.conflicts)) {
    const record = known.get(conflict.recordId) ?? (await input.lookup?.(conflict.recordId));

    checked += 1;

    if (record === undefined) {
      issues.push({
        check: 'conflict-backup',
        recordId: conflict.recordId,
        file: conflict.file,
        reason: 'record-unknown',
      });
      continue;
    }

    const content = conflictContentIssue(input.projectRoot, conflict, record);

    if (content !== undefined) {
      issues.push(content);
    }

    if (conflict.reason !== 'backup-missing' && record.sessionId === input.backups.sessionId) {
      checked += 1;
      const backup = await backupIssue(input.backups, conflict, record);

      if (backup !== undefined) {
        issues.push(backup);
      }
    }
  }

  return { checked, issues };
}

// ---------------------------------------------------------------------------
// Section H — steps shared by both paths
// ---------------------------------------------------------------------------

/**
 * Stops the conflict watcher for a session, before any of its files is
 * written. Its one mutation is `applied → conflict` on a digest mismatch, and a
 * restore write *is* a digest mismatch: restoring first would manufacture a
 * phantom conflict for every file this pass puts back. A watcher that fails to
 * stop is logged, not fatal — the record the engine marks `reverted` refuses a
 * late `conflict` transition anyway.
 */
async function stopWatching(
  watcher: InstrumentationSuspender | undefined,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  if (watcher === undefined) {
    return;
  }

  try {
    await watcher.stopSession(sessionId);
  } catch (thrown) {
    logger.warn('the conflict watcher could not be stopped before cleanup', {
      code: DebuggenError.from(thrown, 'INTERNAL').code,
    });
  }
}

/**
 * Builds a session's cleanup context and checks it is that session's: a
 * context whose backup store belongs to another session would make the engine
 * refuse every record, so the wiring fault is reported once, here, instead.
 */
async function contextFor(
  buildContext: InstrumentationContextFactory,
  request: CleanupContextRequest,
  logger: Logger,
): Promise<Result<CleanupContext, DebuggenError>> {
  const built = await settle(() => buildContext(request), 'INTERNAL');

  if (isErr(built)) {
    logger.error('the cleanup context could not be built', {
      code: built.error.code,
      reason: detailsReason(built.error),
    });

    return built;
  }

  if (built.value.backups.sessionId !== request.sessionId) {
    logger.error('the cleanup context carries another session’s backup store', {
      storeSessionId: built.value.backups.sessionId,
    });

    return err(
      new DebuggenError(
        'INTERNAL',
        'The cleanup context was built with a backup store that belongs to another session.',
        {
          hint: 'Build the context with the backup store rooted at <debuggenHome>/backups/<sessionId> for the session being cleaned up.',
          details: { sessionId: request.sessionId, reason: 'backup-store-session-mismatch' },
        },
      ),
    );
  }

  return built;
}

/** A `Result`-returning journal read of one record, for conflict lookups. */
function recordLookup(
  modifications: ModificationsRepo,
): (recordId: string) => Promise<ModificationRecord | undefined> {
  return async (recordId: string) => {
    const found = await settle(() => modifications.get(recordId), 'STORE_ERROR');

    return isErr(found) ? undefined : found.value;
  };
}

/** Logs the records a pass could not finish, by id, file and code only. */
function logFailures(logger: Logger, failures: readonly CleanupFailure[]): void {
  if (failures.length === 0) {
    return;
  }

  logger.warn('cleanup could not finish some records; they stay open for the next pass', {
    failures: failures.slice(0, MAX_LOGGED_RECORD_IDS).map((failure) => ({
      recordId: failure.recordId,
      file: failure.file,
      code: failure.error.code,
    })),
    count: failures.length,
  });
}

/** Logs the end-state checks that did not hold. */
function logVerification(logger: Logger, report: VerificationReport): void {
  if (report.issues.length === 0) {
    logger.debug('cleanup end state verified', { checked: report.checked });

    return;
  }

  logger.error('cleanup end-state verification found files not in the state the pass reported', {
    checked: report.checked,
    issues: report.issues.slice(0, MAX_LOGGED_RECORD_IDS),
    count: report.issues.length,
  });
}

/** The service-lifetime and per-call signals as one, when there are any. */
function combinedSignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);

  if (present.length === 0) {
    return undefined;
  }

  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

/** Whether a stored `cleanup` sub-object already says what `next` says. */
function cleanupUnchanged(stored: SessionRecord['cleanup'], next: SessionCleanupOutcome): boolean {
  if (stored.status !== next.status || stored.conflicts.length !== next.conflicts.length) {
    return false;
  }

  return stored.conflicts.every(
    (conflict, index) => conflict.recordId === next.conflicts[index]?.recordId,
  );
}

/** The session-record form of an outcome: `completedAt` only for a finished pass. */
function toStoredCleanup(outcome: SessionCleanupOutcome): SessionRecord['cleanup'] {
  const conflicts = [...outcome.conflicts];

  return outcome.status === 'pending'
    ? { status: outcome.status, conflicts }
    : { status: outcome.status, completedAt: outcome.completedAt, conflicts };
}

// ---------------------------------------------------------------------------
// Section I — the start-up reconciliation
// ---------------------------------------------------------------------------

/** A per-session summary with every count at zero, for the early exits. */
function emptySummary(
  sessionId: string,
  status: CleanupStatus,
  scanned: number,
): SessionReconciliationSummary {
  return {
    sessionId,
    status,
    scanned,
    restored: 0,
    closed: 0,
    conflicts: 0,
    skipped: 0,
    failed: 0,
    unresolved: 0,
  };
}

/** What one session's reconciliation contributes to the report. */
interface SessionPass {
  readonly summary: SessionReconciliationSummary;
  readonly errors: readonly CleanupErrorEntry[];
}

/** Everything the per-session reconciliation step is run with. */
interface ReconcileRuntime {
  readonly deps: StartupReconciliationDeps;
  readonly buildContext: InstrumentationContextFactory;
  readonly logger: Logger;
  readonly signal: AbortSignal | undefined;
}

/**
 * Records one session's cleanup verdict that no `SessionManager.end` is
 * waiting to record — a start-up reconciliation's, or a dormancy upgrade's —
 * through the manager when it exists, otherwise as the `cleanup` sub-object
 * alone (never the status, which only the manager writes). A verdict the
 * session already carries is not written again, which is what keeps a second
 * start over a reconciled store silent.
 */
async function deliverVerdict(
  deps: Pick<StartupReconciliationDeps, 'sessions' | 'outcomeSink'>,
  record: SessionRecord,
  outcome: SessionCleanupOutcome,
  logger: Logger,
): Promise<DebuggenError | undefined> {
  if (cleanupUnchanged(record.cleanup, outcome)) {
    logger.debug('the session already carries this cleanup verdict', { cleanup: outcome.status });

    return undefined;
  }

  const sink = deps.outcomeSink;
  const delivered =
    sink === undefined
      ? await settle(
          () => deps.sessions.update({ ...record, cleanup: toStoredCleanup(outcome) }),
          'STORE_ERROR',
        )
      : await settle(() => sink.recordCleanupOutcome(record.id, outcome), 'STORE_ERROR');

  if (isErr(delivered)) {
    logger.error('the cleanup verdict could not be recorded on the session', {
      code: delivered.error.code,
      cleanup: outcome.status,
    });

    return delivered.error;
  }

  return undefined;
}

/** Reconciles one session's open records and verifies what the engine reports. */
async function reconcileSession(
  runtime: ReconcileRuntime,
  sessionId: string,
  records: readonly ModificationRecord[],
): Promise<SessionPass> {
  const logger = sessionLogger(runtime.logger, sessionId);
  const scanned = records.length;
  const loaded = await settle(() => runtime.deps.sessions.get(sessionId), 'STORE_ERROR');

  if (isErr(loaded)) {
    logger.error('the owning session could not be read; its records stay open', {
      code: loaded.error.code,
      recordIds: loggedIds(records),
    });

    return {
      summary: { ...emptySummary(sessionId, 'partial', scanned), failed: scanned },
      errors: [toErrorEntry(sessionId, loaded.error)],
    };
  }

  const session = loaded.value;

  if (session === undefined) {
    // No session row, so no project root: guessing an absolute path would risk
    // writing one project's original into another. The files and the backups
    // are left exactly as they are, and retention's grace period governs the
    // backups from here.
    logger.warn(
      'open modification records belong to a session that no longer exists; left untouched',
      {
        recordIds: loggedIds(records),
        count: scanned,
      },
    );

    return {
      summary: { ...emptySummary(sessionId, 'partial', scanned), unresolved: scanned },
      errors: [],
    };
  }

  // The watcher is not running before the service serves, so this is a no-op at
  // start-up; on a later retry it keeps restore writes from reading as edits.
  //
  // No runtime hook is disarmed here, and none can be: this runs before the
  // service serves, so no page agent or dev-server preload is connected to
  // receive a configuration, and this process has armed nothing. A producer
  // that outlived the previous process may still hold that process's hooks. It
  // is reconciled when it reconnects, by `../instrumentation/service.ts`: a
  // reconnecting preload is sent the authoritative configuration for its
  // project (armed for the capture that is open there, capture-less otherwise),
  // and a re-bound tab's page agent is returned to dormant unless its session
  // holds an open capture. Which sessions still hold one after a restart is
  // settled first, by `settleInterruptedSessions`, from this pass's report.
  await stopWatching(runtime.deps.watcher, sessionId, logger);

  const context = await contextFor(
    runtime.buildContext,
    { sessionId, projectRoot: session.projectRoot, signal: runtime.signal },
    logger,
  );

  if (isErr(context)) {
    return {
      summary: { ...emptySummary(sessionId, 'partial', scanned), failed: scanned },
      errors: [toErrorEntry(sessionId, context.error)],
    };
  }

  let outcome: ReconcileOutcome;

  try {
    // The engine applies the per-status table to every open record of this
    // session; it is handed the complete set, never a pre-filtered one.
    outcome = await reconcileModifications(context.value, { sessionIds: [sessionId] });
  } catch (thrown) {
    const error = DebuggenError.from(thrown, 'CLEANUP_PARTIAL');

    logger.error('reconciliation of the session failed', { code: error.code });

    return {
      summary: { ...emptySummary(sessionId, 'partial', scanned), failed: scanned },
      errors: [toErrorEntry(sessionId, error)],
    };
  }

  const conflicts = distinctConflicts(outcome.conflicts);
  const verification = await verifyCleanupEndState({
    projectRoot: session.projectRoot,
    backups: context.value.backups,
    finished: [...outcome.restored, ...outcome.closed],
    open: [...outcome.retained, ...outcome.skipped],
    conflicts,
    lookup: recordLookup(runtime.deps.modifications),
  });

  logFailures(logger, outcome.failures);
  logVerification(logger, verification);

  const failed = outcome.failures.length + verification.issues.length;
  const status = worstStatus(
    asCleanupStatus(outcome.status),
    aggregateCleanupStatus({
      restored: outcome.restored.length + outcome.closed.length,
      conflicts: conflicts.length + outcome.forks.length,
      skipped: outcome.retained.length + outcome.skipped.length,
      failed,
    }),
  );
  const errors = outcome.failures.map((failure) =>
    toErrorEntry(sessionId, failure.error, failure.recordId),
  );
  // A session left `capturing` had its capture armed in producers that may
  // have outlived the process that armed them: its files say `status`, but its
  // runtime hooks are not known dormant, so the verdict recorded on it — in the
  // same write as the files' own — is never better than `partial` (AAP §0.5.1:
  // runtime hooks are disabled, not merely idled). `settleInterruptedSessions`
  // then releases that capture, and the cleanup runner upgrades the verdict
  // once its producers take their dormant configuration. The summary keeps the
  // files' own verdict.
  const recorded = session.status === CAPTURING_STATUS ? worstStatus(status, 'partial') : status;
  const delivery = await deliverVerdict(
    runtime.deps,
    session,
    { status: recorded, conflicts, completedAt: outcome.completedAt },
    logger,
  );

  if (delivery !== undefined) {
    errors.push(toErrorEntry(sessionId, delivery));
  }

  return {
    summary: {
      sessionId,
      status,
      scanned,
      restored: outcome.restored.length,
      closed: outcome.closed.length,
      conflicts: conflicts.length,
      skipped: outcome.retained.length + outcome.skipped.length,
      failed,
      unresolved: 0,
    },
    errors,
  };
}

/** The whole start-up pass, shared by the standalone function and `reconcileAll`. */
async function reconcileAcross(
  deps: StartupReconciliationDeps,
  options: StartupReconciliationOptions,
  lifetime: AbortSignal | undefined,
): Promise<Result<StartupReconciliationReport, DebuggenError>> {
  const logger = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM).child({
    trigger: 'service-start' satisfies CleanupTrigger,
  });
  const now = deps.now ?? nowEpochMs;
  const signal = combinedSignal(lifetime, deps.signal, options.signal);
  const runtime: ReconcileRuntime = {
    deps,
    buildContext:
      deps.buildContext ??
      createCleanupContextFactory({
        modifications: deps.modifications,
        config: deps.config,
        logger: deps.logger,
        now,
      }),
    logger,
    signal,
  };

  // Invariant 4. The reconciliation set is every non-`reverted` record of every
  // session, whatever state that session was left in — `instrumenting`,
  // `ready`, `capturing`, `analyzing`, `generated`, `failed` or halfway through
  // its own cleanup. Narrowing this set by session status is precisely the bug
  // the crash-recovery guarantee exists to prevent: a session that crashed
  // mid-capture would keep its patched files forever.
  const listed = await settle(() => deps.modifications.listAllOpen(), 'STORE_ERROR');

  if (isErr(listed)) {
    logger.error('start-up reconciliation could not read the modification journal', {
      code: listed.error.code,
    });

    return err(listed.error);
  }

  const wanted = options.sessionIds === undefined ? undefined : new Set(options.sessionIds);
  const groups = new Map<string, ModificationRecord[]>();

  for (const record of listed.value) {
    if (wanted !== undefined && !wanted.has(record.sessionId)) {
      continue;
    }

    const group = groups.get(record.sessionId);

    if (group === undefined) {
      groups.set(record.sessionId, [record]);
    } else {
      group.push(record);
    }
  }

  const bySession: Record<string, SessionReconciliationSummary> = {};
  const errors: CleanupErrorEntry[] = [];
  let status: CleanupStatus = 'clean';
  let aborted = false;
  const totals = {
    scanned: 0,
    closed: 0,
    restored: 0,
    conflicts: 0,
    unresolved: 0,
    failed: 0,
    skipped: 0,
  };

  for (const sessionId of [...groups.keys()].sort()) {
    const records = groups.get(sessionId) ?? [];
    let summary: SessionReconciliationSummary;

    if (signal?.aborted === true) {
      // Stop starting new work; what was already done stays reported.
      aborted = true;
      summary = { ...emptySummary(sessionId, 'partial', records.length), skipped: records.length };
    } else {
      const pass = await reconcileSession(runtime, sessionId, records);

      summary = pass.summary;
      errors.push(...pass.errors);
    }

    bySession[sessionId] = summary;
    status = worstStatus(status, summary.status);
    totals.scanned += summary.scanned;
    totals.closed += summary.closed;
    totals.restored += summary.restored;
    totals.conflicts += summary.conflicts;
    totals.unresolved += summary.unresolved;
    totals.failed += summary.failed;
    totals.skipped += summary.skipped;
  }

  const report: StartupReconciliationReport = {
    status,
    ...totals,
    aborted,
    bySession,
    errors,
    completedAt: now(),
  };

  logger.info('start-up modification reconciliation finished', {
    status,
    ...totals,
    aborted,
    sessions: groups.size,
    errors: errors.length,
  });

  return ok(report);
}

/**
 * Reconciles every open modification record across all sessions — the
 * service-start half of AAP §0.5.1, callable from `src/main.ts` before the
 * session manager, the broadcaster and the instrumentation service exist.
 *
 * Records are grouped by session; each session's `projectRoot` is read from its
 * row, a context is built with that session's own backup store, and the
 * engine's `reconcileModifications` applies the per-status table. A record
 * whose session row is gone is left untouched and counted `unresolved`. Each
 * affected session's verdict is recorded through `outcomeSink` when given, or
 * as its `cleanup` sub-object alone. Idempotent: a second run over a reconciled
 * store restores nothing and writes nothing.
 *
 * It sends nothing to any producer (none is connected before the service
 * serves) and changes no session's status. Hand its report to
 * {@link settleInterruptedSessions} once the session manager has hydrated:
 * `bySession` is what says which interrupted sessions lost their patches.
 *
 * @param deps The repositories, the state directory and the optional collaborators.
 * @param options An optional session filter and cancellation signal.
 * @returns The report, or `err` when the journal could not be read at all.
 *
 * @example
 * ```ts
 * const reconciled = await reconcileModificationsOnStartup({ modifications, sessions, config, logger });
 * if (isErr(reconciled)) return reconciled;
 * ```
 */
export function reconcileModificationsOnStartup(
  deps: StartupReconciliationDeps,
  options: StartupReconciliationOptions = {},
): Promise<Result<StartupReconciliationReport, DebuggenError>> {
  return reconcileAcross(deps, options, undefined);
}

// ---------------------------------------------------------------------------
// Section J — the session cleanup runner
// ---------------------------------------------------------------------------

/**
 * What a pass established about the session's runtime hooks.
 *
 * - `no-instrumentation` — no instrumentation service is wired into this
 *   process, so nothing in it armed a producer: confirmed.
 * - `delivered` — the disarm reported an empty `pending` list: confirmed.
 * - `disarm-failed` — the disarm answered `err` or threw: unknown, so not
 *   confirmed.
 * - `delivery-unreported` — the disarm answered without a `pending` list: it
 *   cannot say who received the dormant configuration, so not confirmed.
 * - `delivery-pending` — named producers did not receive it: not confirmed
 *   until the service reports them dormant.
 */
interface DormancyVerdict {
  readonly confirmed: boolean;
  readonly reason:
    | 'no-instrumentation'
    | 'delivered'
    | 'disarm-failed'
    | 'delivery-unreported'
    | 'delivery-pending';

  /** The producer kinds known not to have received it, deduplicated and sorted; empty otherwise. */
  readonly pending: readonly string[];
}

/**
 * A session whose files a pass restored cleanly but whose runtime hooks were
 * not confirmed dormant, so it was reported `partial`. Kept until the service
 * confirms dormancy, when the verdict is upgraded to `clean`.
 */
interface AwaitingDormancy {
  /** The file-level verdict of the pass: always `clean`, or the session would not be remembered. */
  readonly fileStatus: CleanupStatus;

  /** The conflicts the pass reported, carried into the upgraded verdict unchanged. */
  readonly conflicts: readonly ModificationConflict[];

  /** The producers that had not received their dormant configuration, for the log. */
  readonly pending: readonly string[];

  /** Which trigger ran the pass, bound on the upgrade's log records. */
  readonly trigger: CleanupTrigger;
}

/**
 * The producers a disarm's answer names as not having received their dormant
 * configuration — deduplicated and sorted, a member that is not a non-blank
 * string counted as `unnamed-producer` — or `undefined` when the answer does
 * not say who received it.
 *
 * Read fail-safe, because the value crossed a module boundary: anything but an
 * array is "cannot say", and an array with any member at all — even a
 * malformed one — is "not delivered".
 */
function reportedPendingProducers(outcome: unknown): readonly string[] | undefined {
  const reported: unknown =
    typeof outcome === 'object' && outcome !== null && 'pending' in outcome
      ? outcome.pending
      : undefined;

  if (!Array.isArray(reported)) {
    return undefined;
  }

  const members: readonly unknown[] = reported;

  return [...new Set(members.map((kind) => (isNonBlank(kind) ? kind : 'unnamed-producer')))].sort();
}

/** The refusal every call answers once the runner is disposed or the service is stopping. */
function stoppedError(sessionId: string): DebuggenError {
  return new DebuggenError(
    'CLEANUP_PARTIAL',
    'Cleanup did not run because the service is shutting down.',
    {
      hint: 'The modification journal still holds every change; the next service start restores it, or end the session again once the service is back.',
      details: { sessionId, reason: 'cleanup-stopped' },
    },
  );
}

/**
 * Creates the session cleanup runner.
 *
 * @param deps The repositories and state directory, plus whichever of the
 * watcher, instrumentation service, progress emitter and outcome sink exist.
 * Pass the outcome sink (late-bound to `SessionManager.recordCleanupOutcome`
 * when the manager is created after the runner) so that a dormancy upgrade is
 * broadcast as well as persisted.
 * @returns The runner. Constructing it touches nothing: no file, no socket, no
 * timer — it only subscribes to the instrumentation service's dormancy
 * confirmations, which {@link SessionCleanup.dispose} releases.
 *
 * @example Wiring it as the manager's cleanup runner
 * ```ts
 * const cleanup = createSessionCleanup({ modifications, sessions, config, instrumentation, watcher, progress, logger });
 * const manager = createSessionManager({ sessions, broadcaster: clients, progress, cleanup, config, logger });
 * ```
 */
export function createSessionCleanup(deps: SessionCleanupDeps): SessionCleanup {
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);
  const now = deps.now ?? nowEpochMs;
  const buildContext =
    deps.buildContext ??
    createCleanupContextFactory({
      modifications: deps.modifications,
      config: deps.config,
      logger: deps.logger,
      now,
    });
  const reconcileDeps: StartupReconciliationDeps = { ...deps, buildContext, now };

  // Every pass runs under this signal: `dispose()` aborts it, and so does the
  // service-lifetime signal. The engine honours it between records, never
  // inside a write.
  const lifetime = new AbortController();
  const forwardAbort = (): void => {
    lifetime.abort();
  };

  if (deps.signal?.aborted === true) {
    lifetime.abort();
  } else {
    deps.signal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const inFlight = new Map<string, Promise<Result<SessionCleanupOutcome, DebuggenError>>>();
  let reconciling: Promise<Result<StartupReconciliationReport, DebuggenError>> | undefined;
  let disposed = false;

  // Sessions reported `partial` only because a producer had not received its
  // dormant configuration, in the order they were remembered (see
  // `MAX_AWAITING_DORMANCY`). In memory on purpose: after a restart no
  // producer has been armed by the new process, the files were verified
  // restored, and a surviving producer is reconciled by the instrumentation
  // service when it reconnects — the stored `partial` then stays the truthful
  // record of what this process could establish.
  const awaitingDormancy = new Map<string, AwaitingDormancy>();

  // Sessions the service confirmed dormant while a pass of theirs was in
  // flight. A producer can reconnect, and its outstanding configuration be
  // replayed, while the pass is still restoring files after its disarm; the
  // pass counts that confirmation instead of waiting for one already given.
  // Cleared when a pass disarms (an earlier confirmation is about an earlier
  // disarm) and when it settles.
  const confirmedWhileRunning = new Set<string>();

  // Sessions whose verdict `holdUntilDormant` is recording right now, and those
  // of them the service confirmed dormant meanwhile: the hold then records the
  // upgrade itself instead of remembering a session already confirmed.
  const holding = new Set<string>();
  const confirmedWhileHolding = new Set<string>();

  // The scheduled retry of each confirmed upgrade that could not be recorded.
  const upgradeRetries = new Map<string, ReturnType<typeof setTimeout>>();
  let unsubscribeDormancy: (() => void) | undefined;

  /** The `cleanup` stage's rows, through the emitter that owns their labels. */
  function progressRow(sessionId: string, kind: 'started' | 'completed', logger: Logger): void {
    const progress = deps.progress;

    if (progress === undefined) {
      return;
    }

    try {
      const sent =
        kind === 'started'
          ? progress.stageStarted(sessionId, CLEANUP_STAGE)
          : progress.stageCompleted(sessionId, CLEANUP_STAGE);

      if (isErr(sent)) {
        logger.warn('a cleanup progress row could not be sent', { code: sent.error.code, kind });
      }
    } catch (thrown) {
      logger.warn('a cleanup progress row could not be sent', {
        code: DebuggenError.from(thrown, 'INTERNAL').code,
        kind,
      });
    }
  }

  /**
   * The id of the session's open capture, read for the log context only: the
   * capture row belongs to `SessionManager`, which closes it; cleanup never
   * stops, reopens or rewrites it.
   */
  function openCaptureId(sessionId: string, logger: Logger): string | undefined {
    try {
      const active = deps.sessions.getActiveCapture(sessionId);

      if (isErr(active)) {
        logger.debug('the open capture of the session could not be read', {
          code: active.error.code,
        });

        return undefined;
      }

      return active.value?.capture.id;
    } catch (thrown) {
      logger.debug('the open capture of the session could not be read', {
        code: DebuggenError.from(thrown, 'STORE_ERROR').code,
      });

      return undefined;
    }
  }

  /**
   * Disables the session's runtime hooks by delegation: the instrumentation
   * service owns the dormant page-agent configuration and the capture-less
   * preload configuration, and this module never builds either. Done before
   * any file is restored — which is safe because a patched wrapper branches on
   * the span helper's *availability*, so with the helper gone the original body
   * still runs exactly once. A producer that cannot be reached is never a
   * reason to leave the files patched — but neither is it a disarm: the
   * returned verdict is confirmed only by the service's delivery receipt, and a
   * pass whose hooks are not confirmed dormant reports `partial` (AAP §0.5.1:
   * runtime hooks are disabled, not merely idled).
   *
   * @returns Whether every producer armed for the session is known to have
   * received its dormant configuration, and which ones are known not to have.
   */
  async function disableRuntimeHooks(
    sessionId: string,
    projectRoot: string | undefined,
    logger: Logger,
  ): Promise<DormancyVerdict> {
    const instrumentation = deps.instrumentation;

    if (instrumentation === undefined) {
      logger.debug('no instrumentation service is wired, so no runtime hook is armed to disable');

      return { confirmed: true, reason: 'no-instrumentation', pending: [] };
    }

    const request: CleanupDisarmRequest =
      projectRoot === undefined ? { sessionId } : { sessionId, projectRoot };
    const disarmed = await settle(
      () => instrumentation.disarmCapture(request),
      'TRANSPORT_DISCONNECTED',
    );
    let verdict: DormancyVerdict;

    if (isErr(disarmed)) {
      logger.warn('the runtime hooks could not be disarmed; file restoration continues', {
        code: disarmed.error.code,
      });
      verdict = { confirmed: false, reason: 'disarm-failed', pending: [] };
    } else {
      const pending = reportedPendingProducers(disarmed.value);

      if (pending === undefined) {
        logger.warn(
          'the disarm did not report which producers received the dormant configuration; cleanup is reported partial',
        );
        verdict = { confirmed: false, reason: 'delivery-unreported', pending: [] };
      } else if (pending.length > 0) {
        logger.warn(
          'some producers did not receive the dormant configuration; cleanup is reported partial until the service confirms them dormant',
          { pendingProducers: pending.slice(0, MAX_LOGGED_RECORD_IDS), count: pending.length },
        );
        verdict = { confirmed: false, reason: 'delivery-pending', pending };
      } else {
        logger.debug('every armed producer received the dormant configuration');
        verdict = { confirmed: true, reason: 'delivered', pending: [] };
      }
    }

    try {
      await instrumentation.stopSession(sessionId);
    } catch (thrown) {
      logger.warn('the instrumentation state of the session could not be released', {
        code: DebuggenError.from(thrown, 'INTERNAL').code,
      });
    }

    return verdict;
  }

  /** Remembers a session awaiting its dormancy confirmation, forgetting the oldest past the bound. */
  function awaitDormancy(sessionId: string, entry: AwaitingDormancy, logger: Logger): void {
    cancelUpgradeRetry(sessionId);
    awaitingDormancy.delete(sessionId);
    awaitingDormancy.set(sessionId, entry);

    while (awaitingDormancy.size > MAX_AWAITING_DORMANCY) {
      const [oldest] = awaitingDormancy.keys();

      if (oldest === undefined) {
        break;
      }

      awaitingDormancy.delete(oldest);
      logger.warn('too many sessions await a dormancy confirmation; the oldest stays partial', {
        forgottenSessionId: oldest,
        limit: MAX_AWAITING_DORMANCY,
      });
    }
  }

  /**
   * Upgrades a remembered session's `partial` verdict to `clean` once the
   * service has delivered every dormant configuration it was missing.
   *
   * Recorded like a start-up verdict (see {@link deliverVerdict}): through the
   * outcome sink — `SessionManager.recordCleanupOutcome`, the single emitter of
   * the cleanup-completed message — or, without one, as the `cleanup`
   * sub-object alone. `SessionManager.end` has always recorded the pass's own
   * `partial` by now: it records synchronously after `run` settles, while a
   * confirmation arrives with a later producer message. A verdict worse than
   * `partial` found on the session belongs to a later pass and is left alone.
   *
   * @returns `true` when nothing is left to do — the upgrade was recorded, or
   * there is no verdict to upgrade — and `false` when the session could not be
   * read or the verdict could not be recorded, so the upgrade is worth
   * retrying.
   */
  async function upgradeToClean(sessionId: string, entry: AwaitingDormancy): Promise<boolean> {
    const logger = sessionLogger(log, sessionId).child({ trigger: entry.trigger });
    const loaded = await settle(() => deps.sessions.get(sessionId), 'STORE_ERROR');

    if (isErr(loaded)) {
      logger.error('the session could not be read, so its cleanup stays partial for now', {
        code: loaded.error.code,
      });

      return false;
    }

    const record = loaded.value;

    if (record === undefined) {
      logger.debug('the session no longer exists, so there is no cleanup verdict to upgrade');

      return true;
    }

    if (STATUS_SEVERITY[record.cleanup.status] > STATUS_SEVERITY.partial) {
      logger.info('the session carries a later, worse cleanup verdict; it is left as it is', {
        cleanup: record.cleanup.status,
      });

      return true;
    }

    // With the hooks confirmed dormant, the verdict is what the files alone
    // said — `clean`, or the session would not have been remembered.
    const failure = await deliverVerdict(
      deps,
      record,
      { status: entry.fileStatus, conflicts: entry.conflicts, completedAt: now() },
      logger,
    );

    if (failure !== undefined) {
      return false;
    }

    logger.info('the runtime hooks were confirmed dormant; the cleanup verdict is upgraded', {
      cleanup: entry.fileStatus,
      confirmedProducers: entry.pending.slice(0, MAX_LOGGED_RECORD_IDS),
    });

    return true;
  }

  /** Cancels a scheduled retry of a session's dormancy upgrade: a newer verdict decides. */
  function cancelUpgradeRetry(sessionId: string): void {
    const timer = upgradeRetries.get(sessionId);

    if (timer !== undefined) {
      clearTimeout(timer);
      upgradeRetries.delete(sessionId);
    }
  }

  /**
   * Records a confirmed dormancy upgrade, retrying with exponential backoff —
   * {@link UPGRADE_RETRY_BASE_MS}, doubling, at most
   * {@link MAX_UPGRADE_ATTEMPTS} attempts — while the session cannot be read or
   * the verdict cannot be recorded: no second confirmation will come for a
   * disarm already delivered. A pass or a hold for the session cancels the
   * retry, because its own verdict supersedes this one; so does `dispose`. The
   * last failure leaves the session `partial`, the conservative verdict.
   */
  function recordUpgrade(sessionId: string, entry: AwaitingDormancy, attempt: number): void {
    cancelUpgradeRetry(sessionId);

    const retryOrGiveUp = (): void => {
      if (disposed || lifetime.signal.aborted) {
        return;
      }

      const logger = sessionLogger(log, sessionId).child({ trigger: entry.trigger });

      if (attempt + 1 >= MAX_UPGRADE_ATTEMPTS) {
        logger.error(
          'the confirmed dormancy could not be recorded after every retry; the cleanup verdict stays partial',
          { attempts: attempt + 1 },
        );

        return;
      }

      const delayMs = UPGRADE_RETRY_BASE_MS * 2 ** attempt;
      const timer = setTimeout(() => {
        upgradeRetries.delete(sessionId);
        recordUpgrade(sessionId, entry, attempt + 1);
      }, delayMs);

      // A retry never keeps the service process alive on its own.
      timer.unref();
      upgradeRetries.set(sessionId, timer);
      logger.warn('the confirmed dormancy could not be recorded yet; the upgrade is retried', {
        attempt: attempt + 1,
        delayMs,
      });
    };

    upgradeToClean(sessionId, entry).then(
      (recorded) => {
        if (!recorded) {
          retryOrGiveUp();
        }
      },
      (thrown: unknown) => {
        sessionLogger(log, sessionId).error('the cleanup verdict could not be upgraded', {
          code: DebuggenError.from(thrown, 'INTERNAL').code,
        });
        retryOrGiveUp();
      },
    );
  }

  /** The listener handed to {@link InstrumentationDisabler.onDormancyConfirmed}. */
  function dormancyConfirmed(sessionId: string): void {
    if (disposed || lifetime.signal.aborted) {
      return;
    }

    if (inFlight.has(sessionId)) {
      // A pass for the session is running: it decides its own verdict, and
      // counts this confirmation if it arrived after that pass's disarm.
      confirmedWhileRunning.add(sessionId);

      return;
    }

    if (holding.has(sessionId)) {
      // The hold is still recording `partial`; it upgrades once that is stored.
      confirmedWhileHolding.add(sessionId);

      return;
    }

    const entry = awaitingDormancy.get(sessionId);

    if (entry === undefined) {
      return;
    }

    awaitingDormancy.delete(sessionId);
    recordUpgrade(sessionId, entry, 0);
  }

  /** The body of {@link SessionCleanup.holdUntilDormant}. */
  async function holdVerdict(
    sessionId: string,
    release: ReleasedCaptureVerdict,
  ): Promise<Result<void, DebuggenError>> {
    const logger = sessionLogger(log, sessionId).child({
      trigger: 'service-start' satisfies CleanupTrigger,
    });

    if (disposed || lifetime.signal.aborted) {
      logger.debug('the runner is stopped, so the cleanup verdict is not held');

      return ok(undefined);
    }

    if (inFlight.has(sessionId) || holding.has(sessionId)) {
      // A pass (or another hold) for the session is deciding its verdict already.
      logger.debug('the session’s cleanup verdict is being decided by a pass in flight');

      return ok(undefined);
    }

    holding.add(sessionId);
    cancelUpgradeRetry(sessionId);

    try {
      const loaded = await settle(() => deps.sessions.get(sessionId), 'STORE_ERROR');

      if (isErr(loaded)) {
        logger.error('the session could not be read, so its cleanup verdict could not be held', {
          code: loaded.error.code,
        });

        return err(loaded.error);
      }

      const record = loaded.value;

      if (record === undefined) {
        logger.debug('the session no longer exists, so there is no cleanup verdict to hold');

        return ok(undefined);
      }

      const stored = record.cleanup.status;
      // Only a session whose files are clean can ever be clean again: the
      // reconciliation's own verdict when it held records, else the stored one.
      const files = release.files ?? (stored === 'clean' ? 'clean' : undefined);

      if (files !== 'clean' || STATUS_SEVERITY[stored] > STATUS_SEVERITY.partial) {
        logger.debug('the session’s cleanup verdict cannot become clean; it is left as it is', {
          cleanup: stored,
        });

        return ok(undefined);
      }

      const { pending } = release;
      const conflicts = record.cleanup.conflicts;
      const entry = (confirmed: readonly string[]): AwaitingDormancy => ({
        fileStatus: 'clean',
        conflicts,
        pending: confirmed,
        trigger: 'service-start',
      });

      if (pending !== undefined && pending.length === 0) {
        // Every producer took its dormant configuration with the release.
        if (stored !== 'clean') {
          recordUpgrade(sessionId, entry(pending), 0);
        }

        return ok(undefined);
      }

      if (stored === 'clean') {
        const failure = await deliverVerdict(
          deps,
          record,
          { status: 'partial', conflicts, completedAt: now() },
          logger,
        );

        if (failure !== undefined) {
          return err(failure);
        }
      }

      logger.warn(
        'the producers of the capture a restart ended may still hold it; cleanup is reported partial until they are confirmed dormant',
        {
          pendingProducers: (pending ?? []).slice(0, MAX_LOGGED_RECORD_IDS),
          producersKnown: pending !== undefined,
        },
      );

      if (pending === undefined) {
        // Nothing names who still holds the capture, so nothing can confirm it:
        // the stored `partial` stands until the session is ended again.
        return ok(undefined);
      }

      if (confirmedWhileHolding.has(sessionId)) {
        recordUpgrade(sessionId, entry(pending), 0);
      } else if (!disposed) {
        awaitDormancy(sessionId, entry(pending), logger);
      }

      return ok(undefined);
    } finally {
      holding.delete(sessionId);
      confirmedWhileHolding.delete(sessionId);
    }
  }

  function holdUntilDormant(
    sessionId: string,
    release: ReleasedCaptureVerdict,
  ): Promise<Result<void, DebuggenError>> {
    return holdVerdict(sessionId, release).catch((thrown: unknown) => {
      const error = DebuggenError.from(thrown, 'INTERNAL');

      sessionLogger(log, sessionId).error('the cleanup verdict could not be held at partial', {
        code: error.code,
      });

      return err(error);
    });
  }

  /** One session-scoped pass, in the order the module overview sets out. */
  async function runOnce(
    sessionId: string,
    trigger: CleanupTrigger,
  ): Promise<Result<SessionCleanupOutcome, DebuggenError>> {
    const logger = sessionLogger(log, sessionId).child({ trigger });

    if (disposed || lifetime.signal.aborted) {
      return err(stoppedError(sessionId));
    }

    // An install still writing files would race the restore; the journal would
    // settle it, but refusing is cheaper than a spurious conflict, and an `err`
    // leaves the session un-ended so ending it again retries.
    if (deps.instrumentation?.isInstalling?.(sessionId) === true) {
      logger.info('cleanup deferred: an instrumentation install is still in progress');

      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'Instrumentation is still being installed for this session, so it cannot be removed yet.',
          {
            hint: 'End the session again once the install has finished; nothing has been restored or removed yet.',
            details: { sessionId, reason: 'install-in-progress' },
          },
        ),
      );
    }

    // Reads only: the project root comes from the stored record, and the open
    // capture (which the session manager owns and closes) only names the log
    // context.
    const loaded = await settle(() => deps.sessions.get(sessionId), 'STORE_ERROR');

    if (isErr(loaded)) {
      logger.error('the session could not be read, so cleanup was not attempted', {
        code: loaded.error.code,
      });

      return loaded;
    }

    const session = loaded.value;
    const captureId = openCaptureId(sessionId, logger);
    const scoped = captureId === undefined ? logger : logger.child({ captureId });

    // 1. Stop watching before a single byte is touched.
    await stopWatching(deps.watcher, sessionId, scoped);

    // 2. Disable the runtime hooks, then restore files. This pass's disarm
    // supersedes whatever an earlier pass of the session was still waiting for,
    // and whatever confirmation an earlier disarm received.
    awaitingDormancy.delete(sessionId);
    confirmedWhileRunning.delete(sessionId);
    const dormancy = await disableRuntimeHooks(sessionId, session?.projectRoot, scoped);

    if (session === undefined) {
      scoped.warn('cleanup was asked for a session that does not exist; nothing was restored');

      return err(
        new DebuggenError(
          'SESSION_NOT_FOUND',
          'No such session exists, so there is nothing to clean up.',
          {
            hint: 'Any modification it left is restored by the next service start’s reconciliation.',
            details: { sessionId },
          },
        ),
      );
    }

    // 3. The context: the journal, this session's own backup store, a logger,
    // the clock and the lifetime signal.
    const context = await contextFor(
      buildContext,
      { sessionId, projectRoot: session.projectRoot, signal: lifetime.signal },
      scoped,
    );

    if (isErr(context)) {
      return context;
    }

    // 4. Restore. The engine unwinds every chain strictly last-applied-first,
    // verifying each step against that record's own `instrumentedHash`, and
    // writes nothing a `detectConflict` verdict has not authorised.
    progressRow(sessionId, 'started', scoped);

    let outcome: CleanupOutcome;

    try {
      outcome = await cleanupSession(sessionId, context.value);
    } catch (thrown) {
      const error = DebuggenError.from(thrown, 'CLEANUP_PARTIAL');

      scoped.error('the cleanup pass failed', { code: error.code });

      return err(error);
    }

    const unanswered = journalUnanswered(outcome);

    if (unanswered !== undefined) {
      // Nothing could be attempted: an `err` keeps the session open, so ending
      // it again retries against a journal that answers.
      return err(unanswered);
    }

    if (lifetime.signal.aborted && outcome.skipped.length > 0 && outcome.conflicts.length === 0) {
      // Stopped between records by a shutdown: what was done is journaled, the
      // rest is picked up by the next start, and the session stays open.
      scoped.warn('cleanup stopped part-way because the service is shutting down', {
        restored: outcome.restored.length,
        remaining: outcome.skipped.length,
      });

      return err(stoppedError(sessionId));
    }

    // 5. Verify, independently, what the engine claims.
    const conflicts = distinctConflicts(outcome.conflicts);
    const verification = await verifyCleanupEndState({
      projectRoot: session.projectRoot,
      backups: context.value.backups,
      finished: outcome.restored,
      open: outcome.skipped,
      conflicts,
      lookup: recordLookup(deps.modifications),
    });

    logFailures(scoped, outcome.failures);
    logVerification(scoped, verification);

    const fileStatus = worstStatus(
      asCleanupStatus(outcome.status),
      aggregateCleanupStatus({
        restored: outcome.restored.length,
        conflicts: conflicts.length + outcome.forks.length,
        skipped: outcome.skipped.length,
        failed: outcome.failures.length + verification.issues.length,
      }),
    );

    // 6. Runtime hooks that are not confirmed dormant make the pass `partial`
    // whatever the files say: a restored tree with a live page agent or preload
    // hook is not a clean end (invariant 3). A named shortfall is settled by the
    // service's dormancy confirmation — already, when it arrived while this
    // pass was restoring, or later for clean files; an unknown one stays
    // `partial`, and a worse file verdict governs itself.
    const hooksDormant =
      dormancy.confirmed ||
      (dormancy.reason === 'delivery-pending' && confirmedWhileRunning.has(sessionId));
    const status = hooksDormant ? fileStatus : worstStatus(fileStatus, 'partial');

    if (!hooksDormant && dormancy.reason === 'delivery-pending' && fileStatus === 'clean') {
      awaitDormancy(
        sessionId,
        { fileStatus, conflicts, pending: dormancy.pending, trigger },
        scoped,
      );
    }

    progressRow(sessionId, 'completed', scoped);
    scoped.info('session cleanup finished', {
      cleanup: status,
      files: fileStatus,
      hooksDormant,
      restored: outcome.restored.length,
      conflicts: conflicts.length,
      skipped: outcome.skipped.length,
      failures: outcome.failures.length,
      verificationIssues: verification.issues.length,
      conflictRecordIds: conflicts.slice(0, MAX_LOGGED_RECORD_IDS).map((c) => c.recordId),
    });

    // 7. Returned, not broadcast: `SessionManager.end` records this outcome and
    // emits the one cleanup-completed message (see `CleanupOutcomeSink`).
    return ok({ status, conflicts, completedAt: outcome.completedAt });
  }

  function run(
    sessionId: string,
    options: SessionCleanupRunOptions = {},
  ): Promise<Result<SessionCleanupOutcome, DebuggenError>> {
    const running = inFlight.get(sessionId);

    if (running !== undefined) {
      return running;
    }

    const trigger = options.trigger ?? 'session-end';
    // This pass decides the session's verdict; an earlier upgrade still being
    // retried would only overwrite it.
    cancelUpgradeRetry(sessionId);
    const task = (async (): Promise<Result<SessionCleanupOutcome, DebuggenError>> => {
      // A start-up reconciliation in flight owns every open record; wait for it.
      const pending = reconciling;

      if (pending !== undefined) {
        await pending;
      }

      try {
        return await runOnce(sessionId, trigger);
      } catch (thrown) {
        return err(DebuggenError.from(thrown, 'CLEANUP_PARTIAL'));
      }
    })().finally(() => {
      inFlight.delete(sessionId);
      confirmedWhileRunning.delete(sessionId);
    });

    inFlight.set(sessionId, task);

    return task;
  }

  function reconcileAll(
    options: StartupReconciliationOptions = {},
  ): Promise<Result<StartupReconciliationReport, DebuggenError>> {
    if (reconciling !== undefined) {
      return reconciling;
    }

    if (disposed || lifetime.signal.aborted) {
      return Promise.resolve(err(stoppedError('')));
    }

    const task = (async (): Promise<Result<StartupReconciliationReport, DebuggenError>> => {
      // Session passes already running finish first; passes started from here on
      // wait for this one (see `run`).
      await Promise.allSettled([...inFlight.values()]);

      try {
        return await reconcileAcross(reconcileDeps, options, lifetime.signal);
      } catch (thrown) {
        return err(DebuggenError.from(thrown, 'CLEANUP_PARTIAL'));
      }
    })().finally(() => {
      reconciling = undefined;
    });

    reconciling = task;

    return task;
  }

  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;
    deps.signal?.removeEventListener('abort', forwardAbort);
    lifetime.abort();

    const unsubscribe = unsubscribeDormancy;
    unsubscribeDormancy = undefined;
    awaitingDormancy.clear();
    confirmedWhileRunning.clear();
    confirmedWhileHolding.clear();

    for (const timer of upgradeRetries.values()) {
      clearTimeout(timer);
    }

    upgradeRetries.clear();

    if (unsubscribe !== undefined) {
      try {
        unsubscribe();
      } catch (thrown) {
        log.warn('the dormancy confirmations could not be unsubscribed from', {
          code: DebuggenError.from(thrown, 'INTERNAL').code,
        });
      }
    }
  }

  // Subscribed last, once every piece of state the listener reads exists. A
  // disabler without the hook simply never upgrades a `partial` verdict.
  if (!lifetime.signal.aborted) {
    try {
      const unsubscribe = deps.instrumentation?.onDormancyConfirmed?.(dormancyConfirmed);

      unsubscribeDormancy = typeof unsubscribe === 'function' ? unsubscribe : undefined;
    } catch (thrown) {
      log.warn(
        'the dormancy confirmations could not be subscribed to; an unconfirmed disarm stays partial',
        { code: DebuggenError.from(thrown, 'INTERNAL').code },
      );
    }
  }

  return Object.freeze({ run, reconcileAll, holdUntilDormant, dispose });
}

// ---------------------------------------------------------------------------
// Section K — settling the sessions a restart interrupted
// ---------------------------------------------------------------------------

/**
 * The session statuses whose meaning rests on instrumentation state the
 * previous process held: an install it was running, the patches it had
 * installed, the capture it had armed. A session in any other status depends on
 * none of that, so {@link settleInterruptedSessions} leaves it to its owners.
 */
const INTERRUPTIBLE_SESSION_STATUSES = Object.freeze([
  'instrumenting',
  'ready',
  'capturing',
] as const satisfies readonly SessionStatus[]);

/**
 * The page size {@link settleInterruptedSessions} lists sessions with — well
 * inside the store's largest page (`MAX_SESSION_LIST_LIMIT`, 1000), so the
 * request is never refused, and large enough that a developer's whole history
 * is one or two reads.
 */
const INTERRUPTED_SESSIONS_PAGE_SIZE = 200;

/** The progress-stage a restart failure is reported under, by what it interrupted. */
const INSTRUMENT_STAGE = 'instrument' satisfies ProgressStage;

/** The progress-stage an interrupted capture is failed at. */
const CAPTURE_STAGE = 'capture' satisfies ProgressStage;

/** The code every restart failure carries: the instrumentation the session needs is not there. */
const INTERRUPTED_SESSION_CODE = 'INSTRUMENTATION_UNAVAILABLE' satisfies DebuggenErrorCode;

/** The developer's next step after an interrupted session is failed. */
const INTERRUPTED_SESSION_HINT = 'Ask your question again in a new session, or end this one.';

/**
 * Why {@link settleInterruptedSessions} failed a session.
 *
 * - `install-interrupted` — the session was `instrumenting`: an install cannot
 *   survive the process that ran it.
 * - `instrumentation-removed` — the start-up reconciliation restored the
 *   session's patched files, so its plan's patch-mode signals are gone.
 * - `instrumentation-unsettled` — the reconciliation held open records for the
 *   session and could not settle all of them (a conflict, a failure or an
 *   abort), so its patches are neither intact nor known to be gone.
 * - `capture-interrupted` — the session was `capturing` with a plan that left
 *   nothing in the files: its capture window is closed rather than continued,
 *   because no producer has taken its configuration from this process, and a
 *   capture is never advertised before one has.
 */
export type InterruptedSessionReason =
  | 'install-interrupted'
  | 'instrumentation-removed'
  | 'instrumentation-unsettled'
  | 'capture-interrupted';

/**
 * What {@link CaptureReleaser.releaseInterruptedCapture} is told about the
 * capture window of a `capturing` session a restart failed.
 */
export interface CaptureReleaseRequest {
  /** The session that was failed. */
  readonly sessionId: string;

  /** The capture window it held open before it was failed. */
  readonly captureId: string;

  /** The session's absolute project root, from its stored record. */
  readonly projectRoot: string;

  /** The stored plan whose version the capture was opened with, when the session holds it. */
  readonly plan?: InstrumentationPlan | undefined;
}

/**
 * The restart half of the instrumentation service, satisfied by
 * `ProducerReconciler.releaseInterruptedCapture`.
 *
 * `releaseInterruptedCapture` disarms the capture of a session the restart
 * failed: the producers the previous process armed may still hold it, so each
 * is owed its dormant configuration — remembered as outstanding when no
 * connection takes it (none is connected before the service serves), replayed
 * when the producer reconnects, and reported `pending` by the session's next
 * cleanup until then. Its answer names those producers in `pending`.
 */
export interface CaptureReleaser {
  releaseInterruptedCapture(input: CaptureReleaseRequest): Result<unknown, DebuggenError>;
}

/**
 * The status writer, satisfied by `SessionManager.fail`: moves the session to
 * `failed` with the stage, code, message and hint both user interfaces render,
 * emits that stage's `failed` progress row and closes an open capture window.
 */
export interface SessionFailer {
  fail(
    sessionId: string,
    failure: SessionFailure,
  ): Result<unknown, DebuggenError> | Promise<Result<unknown, DebuggenError>>;
}

/**
 * Keeps a released capture's session from claiming a `clean` cleanup while its
 * producers may still hold that capture. Satisfied by
 * {@link SessionCleanup.holdUntilDormant}.
 */
export interface CleanupVerdictHold {
  holdUntilDormant(
    sessionId: string,
    release: ReleasedCaptureVerdict,
  ): Promise<Result<unknown, DebuggenError>>;
}

/** Everything {@link settleInterruptedSessions} is given; all of it is injected. */
export interface InterruptedSessionDeps {
  /** The session store: the listing of interrupted sessions, each record and its open capture. */
  readonly sessions: Pick<SessionsRepo, 'list' | 'get' | 'getActiveCapture'>;

  /** The only status writer. */
  readonly manager: SessionFailer;

  /**
   * The instrumentation service; without it a failed capture is not released,
   * and its producers are reconciled only when they reconnect.
   */
  readonly instrumentation?: CaptureReleaser | undefined;

  /**
   * The cleanup runner, told what each released capture's disarm reported so
   * that the session's verdict stays `partial` until its producers are
   * confirmed dormant, then becomes `clean`. Omitted, the verdict is left as
   * the reconciliation recorded it.
   */
  readonly verdicts?: CleanupVerdictHold | undefined;

  /** The service logger; bound to `subsystem: "cleanup"`. Defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;

  /** The clock `completedAt` is read from, in epoch milliseconds. Defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
}

/** Options for {@link settleInterruptedSessions}. */
export interface InterruptedSessionOptions {
  /** Cancellation, honoured before the listing and between sessions, never inside one. */
  readonly signal?: AbortSignal | undefined;
}

/** One session {@link settleInterruptedSessions} failed. */
export interface InterruptedSessionFailure {
  /** The session. */
  readonly sessionId: string;

  /** The status the previous process left it in. */
  readonly status: SessionStatus;

  /** Why it could not continue. */
  readonly reason: InterruptedSessionReason;
}

/**
 * What {@link settleInterruptedSessions} did. JSON-serialisable and
 * deterministic: sessions are decided and listed in sorted id order, and
 * `completedAt` comes from the injected clock.
 */
export interface InterruptedSessionsReport {
  /** How many `instrumenting`, `ready` or `capturing` sessions the listing found. */
  readonly examined: number;

  /** The sessions moved to `failed`, in sorted id order. */
  readonly failed: readonly InterruptedSessionFailure[];

  /**
   * Every session that could not be settled — its `fail` was refused, or its
   * cleanup verdict could not be kept from claiming `clean` — in the order met.
   * The service must not serve while any is listed.
   */
  readonly errors: readonly CleanupErrorEntry[];

  /** Whether cancellation stopped the pass before every session was decided. */
  readonly aborted: boolean;

  /** When the pass finished, in epoch milliseconds. */
  readonly completedAt: number;
}

/** What one session's settlement decided. */
type InterruptedDecision =
  | { readonly kind: 'keep' }
  | {
      readonly kind: 'fail';
      readonly stage: ProgressStage;
      readonly reason: InterruptedSessionReason;
    };

/**
 * The failure a session is moved to `failed` with. Complete, developer-facing
 * sentences chosen by what the restart did to the session — never by what the
 * session asked, and naming no project, file or path.
 */
function interruptedFailure(
  stage: ProgressStage,
  reason: InterruptedSessionReason,
): SessionFailure {
  switch (reason) {
    case 'install-interrupted':
      return {
        stage,
        code: INTERRUPTED_SESSION_CODE,
        message:
          'The Debug Generator service restarted while this session’s instrumentation was being installed, so the install could not finish.',
        hint: INTERRUPTED_SESSION_HINT,
      };
    case 'instrumentation-removed':
      return {
        stage,
        code: INTERRUPTED_SESSION_CODE,
        message:
          'The Debug Generator service restarted and removed the instrumentation this session had added to your files, so it can no longer capture.',
        hint: INTERRUPTED_SESSION_HINT,
      };
    case 'instrumentation-unsettled':
      return {
        stage,
        code: INTERRUPTED_SESSION_CODE,
        message:
          'The Debug Generator service restarted and could not fully remove the instrumentation this session had added to your files, so it can no longer capture.',
        hint: 'End this session to see which files need your attention in its cleanup report, then ask your question again in a new session.',
      };
    case 'capture-interrupted':
      return {
        stage,
        code: INTERRUPTED_SESSION_CODE,
        message:
          'The Debug Generator service restarted during this session’s capture, so the capture was closed.',
        hint: INTERRUPTED_SESSION_HINT,
      };
  }
}

/** Orders list items by id, so every run decides the same sessions in the same order. */
function byItemId(left: SessionListItem, right: SessionListItem): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Every interrupted session, read to the last page before anything is acted
 * on: failing a session takes it out of the filtered set, so acting while
 * paging would shift every later page and skip sessions.
 */
function collectInterrupted(
  sessions: Pick<SessionsRepo, 'list'>,
  logger: Logger,
): Result<SessionListItem[], DebuggenError> {
  const byId = new Map<string, SessionListItem>();
  let offset = 0;

  for (;;) {
    let page: Result<SessionListPage, DebuggenError>;

    try {
      page = sessions.list({
        statuses: INTERRUPTIBLE_SESSION_STATUSES,
        limit: INTERRUPTED_SESSIONS_PAGE_SIZE,
        offset,
      });
    } catch (thrown) {
      page = err(DebuggenError.from(thrown, 'STORE_ERROR'));
    }

    if (isErr(page)) {
      logger.error('the interrupted sessions could not be listed', {
        code: page.error.code,
        offset,
      });

      return page;
    }

    const { items, total } = page.value;

    for (const item of items) {
      byId.set(item.id, item);
    }

    offset += items.length;

    // Read on until the count is reached. A page shorter than asked for is not
    // taken as the last one — a store may serve less than the limit — but an
    // empty page is, whatever `total` says, so a listing that disagrees with
    // its own count cannot loop.
    if (items.length === 0 || offset >= total) {
      break;
    }
  }

  return ok([...byId.values()].sort(byItemId));
}

/**
 * The capture window a `capturing` session holds open, with the plan it was
 * opened with — read before the session is failed, because failing it closes
 * the window. `undefined` when there is no window or it cannot be read: a
 * capture whose id is unknown has no dormant configuration to address.
 */
async function interruptedCaptureOf(
  deps: InterruptedSessionDeps,
  sessionId: string,
  logger: Logger,
): Promise<CaptureReleaseRequest | undefined> {
  const active = await settle(() => deps.sessions.getActiveCapture(sessionId), 'STORE_ERROR');

  if (isErr(active)) {
    logger.warn('the open capture of a failing session could not be read; it cannot be released', {
      code: active.error.code,
    });

    return undefined;
  }

  if (active.value === undefined) {
    return undefined;
  }

  const loaded = await settle(() => deps.sessions.get(sessionId), 'STORE_ERROR');

  if (isErr(loaded) || loaded.value === undefined) {
    logger.warn('a failing session could not be read; its capture cannot be released', {
      ...(isErr(loaded) ? { code: loaded.error.code } : {}),
    });

    return undefined;
  }

  const record = loaded.value;
  const { id: captureId, planVersion } = active.value.capture;
  const plan = record.plans.find((candidate) => candidate.planVersion === planVersion);

  return {
    sessionId,
    captureId,
    projectRoot: record.projectRoot,
    ...(plan === undefined ? {} : { plan }),
  };
}

/** What releasing a failed session's capture established. */
interface InterruptedRelease {
  /** Whether the instrumentation service accepted the release. */
  readonly accepted: boolean;

  /**
   * The producers the release could not deliver a dormant configuration to,
   * or `undefined` when the release was refused or did not say.
   */
  readonly pending: readonly string[] | undefined;
}

/**
 * Releases the capture of a session the restart failed, through the
 * instrumentation service. Contained: a refusal or a throw is logged, never
 * propagated, because the session's status is already settled.
 *
 * @returns Whether the service accepted the release, and which producers it
 * reported still owed their dormant configuration.
 */
async function releaseInterrupted(
  releaser: CaptureReleaser,
  request: CaptureReleaseRequest,
  logger: Logger,
): Promise<InterruptedRelease> {
  const { captureId } = request;
  const released = await settle(() => releaser.releaseInterruptedCapture(request), 'INTERNAL');

  if (isErr(released)) {
    logger.warn('the capture of a failed session could not be released', {
      captureId,
      code: released.error.code,
    });

    return { accepted: false, pending: undefined };
  }

  const pending = reportedPendingProducers(released.value);

  logger.info('the capture of a failed session was released; its producers are owed dormancy', {
    captureId,
    planKnown: request.plan !== undefined,
    pendingProducers: (pending ?? []).slice(0, MAX_LOGGED_RECORD_IDS),
    producersKnown: pending !== undefined,
  });

  return { accepted: true, pending };
}

/**
 * Tells the cleanup runner what a released capture's disarm reported, so the
 * session's verdict stays `partial` until its producers are confirmed dormant.
 *
 * @returns The error when the verdict could not be kept from claiming `clean`
 * — refused, or thrown by a port that should not throw — else `undefined`.
 */
async function holdInterruptedVerdict(
  hold: CleanupVerdictHold,
  sessionId: string,
  release: ReleasedCaptureVerdict,
  logger: Logger,
): Promise<DebuggenError | undefined> {
  const held = await settle(() => hold.holdUntilDormant(sessionId, release), 'INTERNAL');

  if (isErr(held)) {
    logger.error('the cleanup verdict of a failed session could not be held at partial', {
      code: held.error.code,
    });

    return held.error;
  }

  return undefined;
}

/** The files' own verdict the start-up reconciliation reached for a session, if it held records. */
function reconciledFilesOf(
  reconciliation: StartupReconciliationReport,
  sessionId: string,
): CleanupStatus | undefined {
  return Object.hasOwn(reconciliation.bySession, sessionId)
    ? reconciliation.bySession[sessionId]?.status
    : undefined;
}

/** Decides one interrupted session from its status and what the reconciliation did to it. */
function decideInterrupted(
  reconciliation: StartupReconciliationReport,
  item: SessionListItem,
  logger: Logger,
): InterruptedDecision {
  if (item.status === 'instrumenting') {
    return { kind: 'fail', stage: INSTRUMENT_STAGE, reason: 'install-interrupted' };
  }

  // The journal held open records for the session, so the reconciliation
  // removed its patches or left them in conflict: the plan it would capture
  // with is no longer what is in the files.
  const reconciled = Object.hasOwn(reconciliation.bySession, item.id)
    ? reconciliation.bySession[item.id]
    : undefined;

  if (reconciled !== undefined) {
    return {
      kind: 'fail',
      stage: INSTRUMENT_STAGE,
      reason:
        reconciled.status === 'clean' ? 'instrumentation-removed' : 'instrumentation-unsettled',
    };
  }

  if (item.status === 'ready') {
    // Nothing of it was in the files, and nothing is armed while no capture is
    // open: the next capture start recomputes its arming from the stored plan.
    logger.debug('an interrupted ready session needs nothing; its next capture arms from its plan');

    return { kind: 'keep' };
  }

  // A capture whose plan left nothing in the files is not continued: no
  // producer has taken its configuration from this process, and a capture is
  // never advertised before one has. It is closed, and its producers owed
  // their dormant configuration.
  return { kind: 'fail', stage: CAPTURE_STAGE, reason: 'capture-interrupted' };
}

/**
 * Settles every session a service restart interrupted — the second half of
 * the service-start trigger, run by `src/main.ts` after
 * {@link reconcileModificationsOnStartup} and `SessionManager.hydrate()`, and
 * before the first client is served.
 *
 * Every `instrumenting`, `ready` and `capturing` session is first collected,
 * to the last page of the listing; then each is decided in sorted id order:
 *
 * | Left in | Reconciliation held its records | Decision |
 * | --- | --- | --- |
 * | `instrumenting` | either | failed at `instrument`: an install cannot survive a restart |
 * | `ready` or `capturing` | yes | failed at `instrument`: its patches were removed, or left in conflict |
 * | `capturing` | no (runtime-only plan) | failed at `capture`: the capture window is closed rather than continued |
 * | `ready` | no | left as it is: arming is recomputed from the stored plan when a capture starts |
 *
 * No capture survives a restart. Resuming one would advertise `capturing`
 * before any producer had taken its configuration from this process, and AAP
 * §0.4.2 has no frame a producer confirms a configuration with; a capture the
 * developer starts again is armed afresh and judged by its delivery receipts.
 *
 * A session is failed through the injected manager — the only status writer,
 * which also closes its open capture — with code `INSTRUMENTATION_UNAVAILABLE`
 * and a sentence saying what the restart did. A failed `capturing` session's
 * producers may still hold the capture the previous process armed, so its
 * window is read before the failure closes it and then released through
 * `releaseInterruptedCapture`: no producer is connected yet, so each dormant
 * configuration it is owed stays outstanding until the instrumentation service
 * replays it on reconnect. What the release reported is handed to the cleanup
 * runner (`verdicts`), which keeps the session's verdict `partial` — the
 * reconciliation already recorded it no better than that — until those
 * producers are confirmed dormant, then records `clean`. Every other producer
 * is reconciled on reconnect against the state this pass leaves.
 *
 * Failures are contained per session — logged, recorded in `errors` — and the
 * pass moves on; cancellation is honoured before the listing and between
 * sessions. A session in `errors` could not be failed, or could not be kept
 * from claiming a clean cleanup, so the caller must not serve: `src/main.ts`
 * refuses the start, and the next start settles it again.
 *
 * @param deps The session store, the manager, the instrumentation service and
 * the cleanup runner when wired, the logger and the clock.
 * @param reconciliation The report of the start-up reconciliation that ran first.
 * @param options Cancellation.
 * @returns The report, or `err` only when the interrupted sessions could not be
 * listed at all.
 *
 * @example
 * ```ts
 * const hydrated = await sessionManager.hydrate();
 * if (isErr(hydrated)) return refuse(hydrated.error);
 * const settled = await settleInterruptedSessions(
 *   { sessions: repos.sessions, manager: sessionManager, instrumentation, verdicts: cleanup, logger: root },
 *   reconciled.value,
 * );
 * if (isErr(settled)) return refuse(settled.error);
 * ```
 */
export async function settleInterruptedSessions(
  deps: InterruptedSessionDeps,
  reconciliation: StartupReconciliationReport,
  options: InterruptedSessionOptions = {},
): Promise<Result<InterruptedSessionsReport, DebuggenError>> {
  const logger = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM).child({
    trigger: 'service-start' satisfies CleanupTrigger,
  });
  const now = deps.now ?? nowEpochMs;
  const signal = options.signal;
  const failed: InterruptedSessionFailure[] = [];
  const errors: CleanupErrorEntry[] = [];
  let examined = 0;
  let kept = 0;
  let released = 0;
  let aborted = signal?.aborted === true;

  if (!aborted) {
    const collected = collectInterrupted(deps.sessions, logger);

    if (isErr(collected)) {
      return collected;
    }

    examined = collected.value.length;

    for (const item of collected.value) {
      if (signal?.aborted === true) {
        // Stop starting new work; what was already decided stays reported.
        aborted = true;
        break;
      }

      const sessionId = item.id;
      const scoped = sessionLogger(logger, sessionId);
      const decision = decideInterrupted(reconciliation, item, scoped);

      if (decision.kind === 'keep') {
        kept += 1;
      } else {
        const failure = interruptedFailure(decision.stage, decision.reason);
        const releaser = deps.instrumentation;
        // Read before the failure closes it: the window a failed capture held
        // is what its producers are owed a dormant configuration for.
        const interrupted =
          item.status === CAPTURING_STATUS && releaser !== undefined
            ? await interruptedCaptureOf(deps, sessionId, scoped)
            : undefined;
        const moved = await settle(() => deps.manager.fail(sessionId, failure), 'INTERNAL');

        if (isErr(moved)) {
          scoped.error('an interrupted session could not be failed', {
            code: moved.error.code,
            status: item.status,
            reason: decision.reason,
          });
          errors.push(toErrorEntry(sessionId, moved.error));
        } else {
          scoped.warn('an interrupted session was failed: it cannot continue after the restart', {
            status: item.status,
            reason: decision.reason,
            stage: decision.stage,
          });
          failed.push({ sessionId, status: item.status, reason: decision.reason });

          if (releaser !== undefined && interrupted !== undefined) {
            const release = await releaseInterrupted(releaser, interrupted, scoped);

            if (release.accepted) {
              released += 1;
            }

            const held =
              deps.verdicts === undefined
                ? undefined
                : await holdInterruptedVerdict(
                    deps.verdicts,
                    sessionId,
                    {
                      pending: release.pending,
                      files: reconciledFilesOf(reconciliation, sessionId),
                    },
                    scoped,
                  );

            if (held !== undefined) {
              errors.push(toErrorEntry(sessionId, held));
            }
          }
        }
      }
    }
  }

  const report: InterruptedSessionsReport = {
    examined,
    failed,
    errors,
    aborted,
    completedAt: now(),
  };

  logger.info('interrupted sessions settled', {
    examined,
    failed: failed.length,
    released,
    kept,
    errors: errors.length,
    aborted,
  });

  return ok(report);
}
