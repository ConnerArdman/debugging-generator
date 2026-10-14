/**
 * The session state machine: the one explicit transition table every status
 * change of a debugging session passes through, and the guards that make the
 * product's most important safety property structural rather than hoped-for —
 * **a failure can never be dressed up as a successful analysis** (AAP §0.5.5).
 *
 * ## What this module owns, and what it borrows
 *
 * It owns the *adjacency* — which status may follow which, and what must exist
 * before a guarded edge is taken. It owns no vocabulary: the eleven session
 * statuses are `SESSION_STATUSES` from `@debuggen/protocol`
 * (`packages/protocol/src/session-record.ts`), the nine progress stages are
 * `PROGRESS_STAGES` from the same package (`messages/session.ts`), and the error
 * codes are `DEBUGGEN_ERROR_CODES` from `@debuggen/shared`. The table below is
 * keyed by those types, so a status added to the protocol vocabulary is a
 * compile error here until the table says where it may go.
 *
 * ## The edges, and why the non-obvious ones exist
 *
 * The forward path is the six-stage pipeline of AAP §0.4.2:
 * `created → understanding → investigating → planning → instrumenting → ready →
 * capturing → analyzing → generated`. Beyond it:
 *
 * - **`capturing → ready`** is the "Capture yielded nothing" row of AAP §0.5.5:
 *   analysis is skipped and the session returns to `ready`, so "Capture again"
 *   re-arms with the same plan. It is the reason `analyzing` is *not* entered
 *   for an empty capture — an analysis of nothing would be a fiction.
 * - **`generated → analyzing`** is the follow-up **existing-evidence** path of
 *   AAP §0.4.2 (`FollowUpDecision.needsNewCapture === false`): the analysis and
 *   panel are regenerated from the stored capture as versions `n+1`, and the
 *   session returns to `generated` only through the same guarded edge as the
 *   first time.
 * - **`generated → planning`** is the follow-up **new-capture** path
 *   (`needsNewCapture === true` or `additionalActions` non-empty): the session
 *   runs `planning → instrumenting → ready` with `planVersion n+1` = the
 *   previous plan plus additive actions, and the developer reproduces again.
 * - **`failed → {understanding, investigating, planning, instrumenting, ready,
 *   capturing, analyzing}`** is the retry surface of AAP §0.5.5 ("session status
 *   `failed` at the stage; retry action"): a retry re-enters the status that
 *   owns the failing stage ({@link retryTargetFor}). **`failed → generated`
 *   does not exist**, and {@link FailedNeverReachesGenerated} makes its absence
 *   a compile-time fact: a failed session reaches `generated` only by passing
 *   through `analyzing` and the artifact guard again.
 * - **Every non-terminal status may reach `ended`**, because AAP §0.5.1 requires
 *   cleanup to run on `session.end` whatever the owning session's status —
 *   including `instrumenting`, `capturing`, `failed` and mid-analysis.
 * - **`ended` has no outgoing edge.** It is terminal. A repeated end is not
 *   modelled as `ended → ended`: the session manager (`./manager.ts`)
 *   short-circuits an already-ended session idempotently before it consults
 *   this module, so a request here to leave `ended` is always a refusal.
 *
 * ## The three guards
 *
 * Guards are keyed by *edge* (`"from->to"`) in {@link SESSION_TRANSITION_GUARDS},
 * so the guarded edges are enumerable and an unguarded edge cannot silently
 * acquire one:
 *
 * - **A — `analyzing → generated`** requires a validated `AnalysisResult` *and*
 *   a validated `PanelSpec` in the context. A fallback panel
 *   (`meta.fallback === true`, AAP §0.5.3) is a legitimate success: it renders
 *   under a visible banner and is never presented as a model answer.
 * - **B — `instrumenting → ready`** requires `readinessSatisfied === true`, the
 *   verdict of `../instrumentation/readiness.ts`.
 * - **C — every `* → failed` edge** requires a {@link SessionFailure} naming a
 *   known progress stage, a known error code and a non-empty message, so that
 *   `failed` is always "a distinct status rendered by both UIs with the failing
 *   stage" (AAP §0.5.5).
 *
 * ## Contract
 *
 * An illegal or unguarded-but-refused transition is a typed `Err` carrying a
 * {@link DebuggenError} with code {@link SESSION_TRANSITION_ERROR_CODE} — never
 * a thrown exception and never a silent no-op — because it is an expected,
 * developer-facing outcome with a message a user interface renders
 * (`packages/shared/src/assert.ts` draws that line). The context is only read,
 * never mutated.
 *
 * The module is pure: it imports only the two package barrels above, reads no
 * clock, logs nothing, performs no I/O and holds no mutable state. Importing it
 * has no side effect beyond building its own frozen constants, which is what
 * lets its tests and the integration suites drive every edge exhaustively. It
 * sees statuses and stages only — never the developer's question, never a
 * project's symbols — so nothing here can encode knowledge of any particular
 * application (AAP §0.5.4).
 *
 * @example
 * ```ts
 * import { transition } from './state-machine.js';
 *
 * const next = transition(record.status, 'generated', { analysis, panel });
 * if (!next.ok) {
 *   // next.error.code === 'SESSION_INVALID_STATE'; next.error.details names
 *   // { from, to, allowed, reason } for the UI and the log.
 *   return next;
 * }
 * record = { ...record, status: next.value };
 * ```
 *
 * @module
 */

import {
  PROGRESS_STAGES,
  SESSION_STATUSES,
  type AnalysisResult,
  type PanelSpec,
  type ProgressStage,
  type SessionStatus,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  assertNever,
  err,
  ok,
  type DebuggenErrorCode,
  type Result,
} from '@debuggen/shared';

// ---------------------------------------------------------------------------
// Section A — the transition table
// ---------------------------------------------------------------------------

/**
 * Freezes a table and every edge list inside it, returning it with its literal
 * type intact.
 *
 * `as const` makes the table read-only to the compiler only; freezing makes it
 * read-only at run time too, so no consumer holding the array
 * {@link allowedTransitions} returns can widen the machine by pushing into it.
 * Freezing objects this module has just created is its only load-time work.
 */
function freezeTable<T extends Readonly<Record<string, readonly unknown[]>>>(
  table: T,
): Readonly<T> {
  for (const edges of Object.values(table)) {
    Object.freeze(edges);
  }
  return Object.freeze(table);
}

/**
 * The explicit session transition table: for every status, the statuses it may
 * move to, and nothing else.
 *
 * The `satisfies` clause is load-bearing — a status missing from the table, a
 * misspelled key or a target outside `SESSION_STATUSES` is a compile error.
 * The module documentation above explains every non-obvious edge; the guarded
 * edges are listed in {@link SESSION_TRANSITION_GUARDS}.
 */
export const SESSION_TRANSITIONS = freezeTable({
  created: ['understanding', 'ended', 'failed'],
  understanding: ['investigating', 'ended', 'failed'],
  investigating: ['planning', 'ended', 'failed'],
  planning: ['instrumenting', 'ended', 'failed'],
  // `ready` is guarded: the readiness verdict must be supplied (guard B).
  instrumenting: ['ready', 'ended', 'failed'],
  ready: ['capturing', 'ended', 'failed'],
  // `ready` here is the empty-capture edge of AAP §0.5.5, not a guarded one.
  capturing: ['analyzing', 'ready', 'ended', 'failed'],
  // `generated` is guarded: a validated analysis and panel must exist (guard A).
  analyzing: ['generated', 'ended', 'failed'],
  // The two follow-up paths of AAP §0.4.2: existing evidence, then new capture.
  generated: ['analyzing', 'planning', 'ended', 'failed'],
  // Terminal. A repeated end is short-circuited by the manager, not modelled.
  ended: [],
  // The retry surface of AAP §0.5.5. `generated` is deliberately absent.
  failed: [
    'understanding',
    'investigating',
    'planning',
    'instrumenting',
    'ready',
    'capturing',
    'analyzing',
    'ended',
  ],
} as const satisfies Readonly<Record<SessionStatus, readonly SessionStatus[]>>);

/** The literal type of {@link SESSION_TRANSITIONS}. */
type SessionTransitionTable = typeof SESSION_TRANSITIONS;

/** The statuses `From` may move to, as a union. `never` for a terminal status. */
export type SessionTransitionTarget<From extends SessionStatus> =
  SessionTransitionTable[From][number];

/**
 * Every permitted edge of the machine, spelled `"from->to"`.
 *
 * Derived from the table, so it can never list an edge the table lacks. It is
 * the key type of {@link SESSION_TRANSITION_GUARDS}, which is what makes a
 * guard on a non-existent edge — `"failed->generated"`, say — a compile error.
 */
export type SessionTransitionEdge = {
  [From in SessionStatus]: `${From}->${SessionTransitionTarget<From>}`;
}[SessionStatus];

/** The statuses from which `To` is reachable in one step. */
type SessionTransitionSource<To extends SessionStatus> = {
  [From in SessionStatus]: To extends SessionTransitionTarget<From> ? From : never;
}[SessionStatus];

/** Compile-time assertion: only an argument of exactly `true` type-checks. */
type AssertTrue<T extends true> = T;

/**
 * The AAP §0.5.5 guarantee, proved by the compiler: `failed` has no edge to
 * `generated`. A retry must re-enter the pipeline and pass the artifact guard.
 */
export type FailedNeverReachesGenerated = AssertTrue<
  'generated' extends SessionTransitionTarget<'failed'> ? false : true
>;

/** `generated` is reachable from `analyzing` and from nowhere else. */
export type GeneratedOnlyFromAnalyzing = AssertTrue<
  [SessionTransitionSource<'generated'>] extends ['analyzing']
    ? ['analyzing'] extends [SessionTransitionSource<'generated'>]
      ? true
      : false
    : false
>;

/** `ended` is terminal, and every other status can reach it (AAP §0.5.1). */
export type EndedIsTerminalAndUniversallyReachable = AssertTrue<
  [SessionTransitionTarget<'ended'>] extends [never]
    ? [Exclude<Exclude<SessionStatus, 'ended'>, SessionTransitionSource<'ended'>>] extends [never]
      ? true
      : false
    : false
>;

/** The empty edge list returned for a status the table does not know. */
const NO_TRANSITIONS: readonly SessionStatus[] = Object.freeze([]);

/**
 * The table seen through a string index, for the total lookups below.
 *
 * A `SessionStatus` parameter is a compile-time promise; a status read back
 * from a store row or a peer built at another commit is not. Looking up through
 * this view makes the missing-key case an explicit `undefined` the functions
 * handle, rather than a non-null assertion that would hand `undefined` onward.
 */
const TRANSITION_LOOKUP: Readonly<Record<string, readonly SessionStatus[]>> = SESSION_TRANSITIONS;

/** Membership sets over the borrowed vocabularies, built once. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set<string>(SESSION_STATUSES);
const KNOWN_STAGES: ReadonlySet<string> = new Set<string>(PROGRESS_STAGES);
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>(DEBUGGEN_ERROR_CODES);

/**
 * The statuses a session can never leave — those whose edge list is empty.
 *
 * Derived from the table rather than declared, so it cannot drift from it;
 * today that is `ended` alone.
 */
export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = Object.freeze(
  SESSION_STATUSES.filter((status) => SESSION_TRANSITIONS[status].length === 0),
);

const TERMINAL_STATUS_SET: ReadonlySet<SessionStatus> = new Set(TERMINAL_SESSION_STATUSES);

/**
 * Whether `status` is terminal, meaning no transition out of it exists.
 *
 * @param status A session status.
 * @returns `true` for a status in {@link TERMINAL_SESSION_STATUSES}.
 */
export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

/**
 * The statuses `from` may move to, before any guard is consulted.
 *
 * Total: a status the table does not know yields an empty list rather than
 * `undefined` or an exception. The returned array is frozen.
 *
 * @param from The current status.
 * @returns The permitted targets, in table order.
 */
export function allowedTransitions(from: SessionStatus): readonly SessionStatus[] {
  if (!Object.hasOwn(TRANSITION_LOOKUP, from)) {
    return NO_TRANSITIONS;
  }
  return TRANSITION_LOOKUP[from] ?? NO_TRANSITIONS;
}

// ---------------------------------------------------------------------------
// Section B — the guard context and the refusal vocabulary
// ---------------------------------------------------------------------------

/**
 * What failed, carried with every transition into `failed` (guard C).
 *
 * **Where this goes after the transition.** Protocol's `SessionRecord` has no
 * `failure` field, and none may be invented for it. The failing stage reaches
 * both user interfaces through the persisted `session_progress` row with
 * `status: "failed"` that `./progress.ts` writes — and `./reopen.ts` replays
 * when a session is reopened — plus the `error` / `instrumentation.failed`
 * messages the caller sends with the same code, message and hint. This module
 * only insists that the caller *has* those facts before the status changes.
 */
export interface SessionFailure {
  /** The pipeline stage that failed, from `PROGRESS_STAGES`. */
  readonly stage: ProgressStage;
  /** The failure's code, from the closed `DEBUGGEN_ERROR_CODES` vocabulary. */
  readonly code: DebuggenErrorCode;
  /** A complete, non-empty sentence describing the failure, safe to display. */
  readonly message: string;
  /** The developer's next step, when one applies. */
  readonly hint?: string | undefined;
}

/**
 * The evidence a guarded transition is judged against. Every member is
 * optional; an absent member simply fails the guard that needs it. The context
 * is read, never mutated.
 */
export interface SessionTransitionContext {
  /** Present when a validated `AnalysisResult` exists for the session's latest capture. */
  readonly analysis?: AnalysisResult | undefined;
  /** Present when a validated `PanelSpec` exists (a spec carrying `meta.fallback === true` counts). */
  readonly panel?: PanelSpec | undefined;
  /** True only when `../instrumentation/readiness.ts` reports the session ready to capture. */
  readonly readinessSatisfied?: boolean | undefined;
  /** Required when transitioning to `failed`: names the pipeline stage that failed. */
  readonly failure?: SessionFailure | undefined;
}

/**
 * The code of every refused transition: the session-lifecycle code of the
 * closed vocabulary that names a request the session's current state does not
 * admit. The specific cause travels in `details.reason`, the message and the
 * hint, never in an invented code.
 */
export const SESSION_TRANSITION_ERROR_CODE = 'SESSION_INVALID_STATE' satisfies DebuggenErrorCode;

/**
 * Why a transition was refused, carried as `details.reason` so a caller or a
 * test can tell the causes apart without parsing a message:
 *
 * - `unknown-status` — `from` or `to` is not one of `SESSION_STATUSES` (a value
 *   read from outside the type system);
 * - `not-permitted` — the table has no such edge;
 * - `artifacts-missing` — guard A: the validated analysis or panel is absent;
 * - `readiness-unsatisfied` — guard B: readiness was not confirmed;
 * - `failure-missing` — guard C: no {@link SessionFailure} was supplied;
 * - `failure-invalid` — guard C: the failure names an unknown stage or code, or
 *   carries no message.
 */
export const SESSION_TRANSITION_REFUSAL_REASONS = Object.freeze([
  'unknown-status',
  'not-permitted',
  'artifacts-missing',
  'readiness-unsatisfied',
  'failure-missing',
  'failure-invalid',
] as const);

/** One of {@link SESSION_TRANSITION_REFUSAL_REASONS}. */
export type SessionTransitionRefusalReason = (typeof SESSION_TRANSITION_REFUSAL_REASONS)[number];

/** The parts of a refusal that differ between causes. */
interface Refusal {
  readonly reason: SessionTransitionRefusalReason;
  readonly message: string;
  readonly hint: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Whether `value` is a non-null object — the "was it supplied" test of the guards. */
function isPresentObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Renders a status for a message: quoted when it is a known status, and a
 * fixed phrase otherwise, so an arbitrary value read from outside the type
 * system never reaches a message or a log verbatim.
 */
function quoteStatus(status: SessionStatus): string {
  return KNOWN_STATUSES.has(status) ? `"${status}"` : 'an unrecognised status';
}

/** A known status as given, or `null` for a value outside the vocabulary. */
function statusDetail(status: SessionStatus): SessionStatus | null {
  return KNOWN_STATUSES.has(status) ? status : null;
}

/**
 * Builds the typed refusal every failed transition returns.
 *
 * `details` always carries `{ from, to, allowed, reason }` — `allowed` is a copy
 * of {@link allowedTransitions}`(from)` — plus any cause-specific fields. It
 * holds statuses, stage names and field names only: nothing a developer typed,
 * nothing captured, nothing secret.
 */
function refuse(
  from: SessionStatus,
  to: SessionStatus,
  refusal: Refusal,
): Result<never, DebuggenError> {
  return err(
    new DebuggenError(SESSION_TRANSITION_ERROR_CODE, refusal.message, {
      hint: refusal.hint,
      details: {
        from: statusDetail(from),
        to: statusDetail(to),
        allowed: [...allowedTransitions(from)],
        reason: refusal.reason,
        ...refusal.extra,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Section C — the guards and their registry
// ---------------------------------------------------------------------------

/**
 * A guard on one edge: `ok` to let the transition through, or the refusal.
 * Guards are pure and only read the context.
 */
export type SessionTransitionGuard = (
  from: SessionStatus,
  to: SessionStatus,
  context: SessionTransitionContext,
) => Result<void, DebuggenError>;

/**
 * Guard A — `analyzing → generated`, the headline guarantee of AAP §0.5.5.
 *
 * Asserts only that the *validated* artifacts were supplied; it does not
 * re-validate their internals, because that is already done where each artifact
 * is produced: `packages/panel-schema/src/validate.ts` (syntactic) and
 * `semantic.ts` (evidence against the capture) for the panel, and
 * `packages/protocol/src/analysis.ts` for the analysis. A second, weaker copy of
 * those checks here would be a place for the two to disagree. A fallback panel
 * (`meta.fallback === true`, AAP §0.5.3) is a validated panel and passes: it is
 * rendered under a visible banner, never as a model answer.
 */
function requireValidatedArtifacts(
  from: SessionStatus,
  to: SessionStatus,
  context: SessionTransitionContext,
): Result<void, DebuggenError> {
  const missing: ('analysis' | 'panel')[] = [];
  if (!isPresentObject(context.analysis)) {
    missing.push('analysis');
  }
  if (!isPresentObject(context.panel)) {
    missing.push('panel');
  }
  if (missing.length === 0) {
    return ok(undefined);
  }
  return refuse(from, to, {
    reason: 'artifacts-missing',
    message: `The session cannot move from ${quoteStatus(from)} to ${quoteStatus(to)} without a validated ${missing.join(' and a validated ')}.`,
    hint: 'The session stays in "analyzing" until a validated analysis and a validated panel both exist; retry the analysis or end the session.',
    extra: { missing },
  });
}

/**
 * Guard B — `instrumenting → ready`.
 *
 * The *determination* belongs to `../instrumentation/readiness.ts`, which
 * requires a relayed `agent.ready` for the bound tab's current document with
 * `installedBeforeReact === true`, plus a connected server agent when server
 * signals are planned. This guard only refuses the edge when that verdict is
 * absent or negative, so "Ready to capture" is never shown before it is true.
 */
function requireReadiness(
  from: SessionStatus,
  to: SessionStatus,
  context: SessionTransitionContext,
): Result<void, DebuggenError> {
  if (context.readinessSatisfied === true) {
    return ok(undefined);
  }
  return refuse(from, to, {
    reason: 'readiness-unsatisfied',
    message: `The session cannot move from ${quoteStatus(from)} to ${quoteStatus(to)} before readiness to capture is confirmed.`,
    hint: 'Wait for the page agent to report in from the current page (reload it if asked) and, when server signals are planned, for the instrumented dev server to connect.',
  });
}

/**
 * The problems with a supplied failure, as field names; empty when it is
 * usable. Checked at run time as well as by the compiler because a failure may
 * be assembled from a caught error or a replayed row.
 */
function failureProblems(failure: SessionFailure): ('stage' | 'code' | 'message' | 'hint')[] {
  const problems: ('stage' | 'code' | 'message' | 'hint')[] = [];
  if (!KNOWN_STAGES.has(failure.stage)) {
    problems.push('stage');
  }
  if (!KNOWN_ERROR_CODES.has(failure.code)) {
    problems.push('code');
  }
  if (typeof failure.message !== 'string' || failure.message.trim().length === 0) {
    problems.push('message');
  }
  if (failure.hint !== undefined && typeof failure.hint !== 'string') {
    problems.push('hint');
  }
  return problems;
}

/**
 * Guard C — every `* → failed` edge.
 *
 * Structurally enforces AAP §0.5.5's "`failed` is a distinct status rendered by
 * both UIs with the failing stage": no session becomes `failed` without a known
 * stage, a known code and a message to render. See {@link SessionFailure} for
 * how those facts reach the user interfaces.
 */
function requireFailure(
  from: SessionStatus,
  to: SessionStatus,
  context: SessionTransitionContext,
): Result<void, DebuggenError> {
  const failure = context.failure;
  if (!isPresentObject(failure)) {
    return refuse(from, to, {
      reason: 'failure-missing',
      message: `The session cannot move from ${quoteStatus(from)} to ${quoteStatus(to)} without naming the stage that failed.`,
      hint: 'Report the failing stage, its error code and a message with the transition.',
    });
  }
  const invalid = failureProblems(failure);
  if (invalid.length > 0) {
    return refuse(from, to, {
      reason: 'failure-invalid',
      message: `The session cannot move from ${quoteStatus(from)} to ${quoteStatus(to)}: the reported failure has an invalid ${invalid.join(', ')}.`,
      hint: `Report one of the ${String(PROGRESS_STAGES.length)} progress stages, a known error code and a non-empty message.`,
      extra: { invalid },
    });
  }
  return ok(undefined);
}

/**
 * The guard registry, keyed by edge. An edge absent from this map is
 * unguarded: the table alone decides it.
 *
 * The key type is {@link SessionTransitionEdge}, so a guard on an edge the
 * table does not have is a compile error, and
 * {@link GuardedEdgesCoverGeneratedAndFailed} fails to compile if an edge into
 * `generated` or `failed` is ever added to the table without its guard. The
 * nine `* → failed` entries are listed one by one rather than generated, so a
 * reviewer reads the complete guard set here.
 */
export const SESSION_TRANSITION_GUARDS = Object.freeze({
  'analyzing->generated': requireValidatedArtifacts,
  'instrumenting->ready': requireReadiness,
  'created->failed': requireFailure,
  'understanding->failed': requireFailure,
  'investigating->failed': requireFailure,
  'planning->failed': requireFailure,
  'instrumenting->failed': requireFailure,
  'ready->failed': requireFailure,
  'capturing->failed': requireFailure,
  'analyzing->failed': requireFailure,
  'generated->failed': requireFailure,
} as const satisfies Readonly<Partial<Record<SessionTransitionEdge, SessionTransitionGuard>>>);

/** The edges that carry a guard. */
export type GuardedSessionTransition = keyof typeof SESSION_TRANSITION_GUARDS;

/** Every edge into `generated` and every edge into `failed` is guarded. */
export type GuardedEdgesCoverGeneratedAndFailed = AssertTrue<
  [
    Exclude<
      Extract<SessionTransitionEdge, `${string}->generated` | `${string}->failed`>,
      GuardedSessionTransition
    >,
  ] extends [never]
    ? true
    : false
>;

/** The registry seen through a string index, for the edge lookup below. */
const GUARD_LOOKUP: Readonly<Record<string, SessionTransitionGuard>> = SESSION_TRANSITION_GUARDS;

/** The guard on `from → to`, if that edge has one. */
function guardFor(from: SessionStatus, to: SessionStatus): SessionTransitionGuard | undefined {
  const edge = `${from}->${to}`;
  return Object.hasOwn(GUARD_LOOKUP, edge) ? GUARD_LOOKUP[edge] : undefined;
}

// ---------------------------------------------------------------------------
// Section D — the public API
// ---------------------------------------------------------------------------

/** The context used when a caller supplies none: every guard then refuses. */
const NO_CONTEXT: SessionTransitionContext = Object.freeze({});

/**
 * Renders a list of statuses as prose: `"a"`, `"a" or "b"`, `"a", "b" or "c"`.
 */
function listStatuses(statuses: readonly SessionStatus[]): string {
  const quoted = statuses.map((status) => `"${status}"`);
  const last = quoted.pop();
  if (last === undefined) {
    return 'nowhere';
  }
  return quoted.length === 0 ? last : `${quoted.join(', ')} or ${last}`;
}

/**
 * The developer's next step when the table has no edge from `from` to `to`.
 *
 * The switch is exhaustive over `SessionStatus` and ends in `assertNever`, so a
 * twelfth status added to the protocol vocabulary stops this module compiling
 * until it says what a developer should do from there. {@link transition} only
 * calls it for a known status, so the `default` branch is unreachable at run
 * time as well as at compile time.
 */
function illegalTransitionHint(from: SessionStatus, to: SessionStatus): string {
  if (to === 'generated') {
    return 'A session is marked "generated" only from "analyzing", once a validated analysis and a validated panel both exist.';
  }
  switch (from) {
    case 'created':
      return 'Let problem understanding start for this session, or end it.';
    case 'understanding':
    case 'investigating':
    case 'planning':
      return 'Wait for the current pipeline stage to finish, or end the session.';
    case 'instrumenting':
      return 'Wait for instrumentation to finish and readiness to be confirmed, or end the session.';
    case 'ready':
      return 'Start a capture and reproduce the issue, or end the session.';
    case 'capturing':
      return 'Stop the capture so what was recorded can be analyzed, or end the session.';
    case 'analyzing':
      return 'Wait for analysis and panel generation to finish, or end the session.';
    case 'generated':
      return 'Ask a follow-up, or end the session.';
    case 'ended':
      return 'This session has ended and can no longer change; start a new session.';
    case 'failed':
      return 'Retry the stage that failed, or end the session.';
    default:
      return assertNever(from, 'Unhandled session status');
  }
}

/**
 * Attempts one transition: the table first, then the edge's guard, if any.
 *
 * Returns `ok(to)` when the edge exists and its guard (if any) accepts the
 * context. Otherwise returns an `Err` whose {@link DebuggenError} has code
 * {@link SESSION_TRANSITION_ERROR_CODE}, a message naming both statuses, a
 * developer-facing hint, and `details` of `{ from, to, allowed, reason, … }`.
 * Never throws, never mutates `context`, and never succeeds silently for an
 * edge that does not exist.
 *
 * @param from The session's current status.
 * @param to The requested status.
 * @param context The evidence guarded edges are judged against.
 * @returns The new status, or the refusal.
 */
export function transition(
  from: SessionStatus,
  to: SessionStatus,
  context: SessionTransitionContext = NO_CONTEXT,
): Result<SessionStatus, DebuggenError> {
  if (!KNOWN_STATUSES.has(from) || !KNOWN_STATUSES.has(to)) {
    return refuse(from, to, {
      reason: 'unknown-status',
      message: `The session cannot move from ${quoteStatus(from)} to ${quoteStatus(to)}: only the ${String(SESSION_STATUSES.length)} session statuses are recognised.`,
      hint: 'Reload the session; its stored status may come from an incompatible version of Debug Generator.',
    });
  }
  const allowed = allowedTransitions(from);
  if (!allowed.includes(to)) {
    const onward =
      allowed.length === 0
        ? 'it cannot move at all'
        : `it may only move to ${listStatuses(allowed)}`;
    return refuse(from, to, {
      reason: 'not-permitted',
      message: `The session cannot move from "${from}" to "${to}"; from "${from}" ${onward}.`,
      hint: illegalTransitionHint(from, to),
    });
  }
  const guard = guardFor(from, to);
  if (guard !== undefined) {
    const verdict = guard(from, to, context);
    if (!verdict.ok) {
      return verdict;
    }
  }
  return ok(to);
}

/**
 * Whether {@link transition} would succeed — the table plus the edge's guard.
 *
 * @param from The session's current status.
 * @param to The requested status.
 * @param context The evidence guarded edges are judged against.
 * @returns `true` when the transition is permitted with this context.
 */
export function canTransition(
  from: SessionStatus,
  to: SessionStatus,
  context?: SessionTransitionContext,
): boolean {
  return transition(from, to, context).ok;
}

/**
 * The session status each progress stage runs under — covering all nine stages
 * explicitly, so a stage added to `PROGRESS_STAGES` is a compile error here.
 *
 * - `generate-panel` maps to `analyzing`: the session stays there until guard A
 *   admits `generated`.
 * - `followup` and `cleanup` own no single status. The follow-up decision runs
 *   while the session is still `generated` and branches to `analyzing` or
 *   `planning`; cleanup runs on the way into `ended`, from whatever status the
 *   session held.
 */
export const STAGE_STATUS = Object.freeze({
  understand: 'understanding',
  investigate: 'investigating',
  plan: 'planning',
  instrument: 'instrumenting',
  capture: 'capturing',
  analyze: 'analyzing',
  'generate-panel': 'analyzing',
  followup: undefined,
  cleanup: undefined,
} as const satisfies Readonly<Record<ProgressStage, SessionStatus | undefined>>);

/** Every status a stage owns is a retry target of `failed` (AAP §0.5.5). */
export type EveryStageStatusIsARetryTarget = AssertTrue<
  [
    Exclude<
      Exclude<(typeof STAGE_STATUS)[ProgressStage], undefined>,
      SessionTransitionTarget<'failed'>
    >,
  ] extends [never]
    ? true
    : false
>;

/** The stage map seen through a string index, for the total lookup below. */
const STAGE_LOOKUP: Readonly<Record<string, SessionStatus | undefined>> = STAGE_STATUS;

/**
 * The session status `stage` runs under, or `undefined` for a stage that owns
 * none (`followup`, `cleanup`) or is not a known stage.
 *
 * @param stage A progress stage.
 * @returns The owning status, per {@link STAGE_STATUS}.
 */
export function statusForStage(stage: ProgressStage): SessionStatus | undefined {
  return Object.hasOwn(STAGE_LOOKUP, stage) ? STAGE_LOOKUP[stage] : undefined;
}

/**
 * The status a retry of `failure` re-enters from `failed`: the status that owns
 * the failing stage, or `undefined` when that stage owns none and the manager
 * must decide (a failed follow-up returns to the pipeline it chose; a failed
 * cleanup is retried by ending the session again).
 *
 * @param failure The failure the session is in.
 * @returns The retry target, per {@link STAGE_STATUS}.
 */
export function retryTargetFor(failure: SessionFailure): SessionStatus | undefined {
  return statusForStage(failure.stage);
}
