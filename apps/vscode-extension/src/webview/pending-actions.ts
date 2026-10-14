/**
 * Pending-request correlation for the "Debug Generator" webview: which requests the host has not
 * yet answered, and — for the two text submissions — how each one ended.
 *
 * ## Request ids, and the one frame that settles a request
 *
 * Every webview intent the view waits on is a **request** (`WEBVIEW_REQUEST_TYPES` in
 * `../webview-messages`): it leaves carrying a `requestId` the view minted, and the host answers
 * it with exactly one `actionResult { requestId, action, status }`. That frame is the ONLY thing
 * that settles a pending request here, and only when both its `action` and its `requestId` match
 * the entry awaiting it.
 *
 * Snapshots, notices and pairing frames settle nothing. None of them names the request it answers:
 * a snapshot also moves for unrelated reasons (a progress row, the capture counter, another session
 * reopened from the Sessions tree, the session ended by another control), and a notice may belong
 * to another request, to a command run from the Command Palette or to a service event. So no such
 * frame re-enables, clears or fails a pending request: its control stays disabled and a pending
 * submission keeps its draft until the matching `actionResult` or the safety timeout settles it.
 *
 * `ready` and `openFile` wait on nothing, carry no id and never reach this reducer.
 *
 * ## One entry per request type
 *
 * A control is disabled while its request is pending, so at most one request of each type is in
 * flight. Should the same type be sent again anyway (the "Pair Chrome DevTools" action of the
 * binding guidance beside the pairing card's own), the newer request **supersedes** the older: the
 * entry is replaced, and the older request's late `actionResult` is ignored because its id no
 * longer matches.
 *
 * ## The safety timeout
 *
 * {@link PENDING_ACTION_TIMEOUT_MS} is a safety net for an acknowledgement that never arrives — a
 * host that was reloaded mid-request, or a frame lost with the view — never the expected way a
 * request ends. See the constant for why it is as long as it is.
 *
 * ## Submission outcomes
 *
 * `askQuestion` and `askFollowUp` carry text the developer typed. Their settlement is published as
 * a {@link SubmissionOutcome} — `{ seq, status }` — which `QuestionForm` and `FollowUp` apply once
 * per `seq`: `accepted` clears the kept draft, `failed` keeps it and offers a retry. A request the
 * host channel refused outright (`postToHost` returned `false`) creates no entry, but a submission's
 * failed outcome is still published, so its draft is kept with the same retry hint. A timed-out
 * submission is reported as `failed`: the forms need to know only whether the text was taken.
 *
 * ## Purity
 *
 * {@link pendingActionsReducer} is a pure function of its arguments: it never reads the clock (the
 * caller passes `now`) or any source of randomness (the caller mints the `requestId`), never mutates
 * its input and returns its input itself when an event changes nothing. React StrictMode may
 * therefore replay it freely, and an unchanged state keeps its identity for the effect that
 * schedules the next deadline.
 *
 * @example
 * ```tsx
 * const [pending, dispatch] = useReducer(pendingActionsReducer, INITIAL_PENDING_ACTIONS_STATE);
 * // In an event handler: mint the id there, never in the reducer.
 * const message = withRequestId({ type: 'askQuestion', question }, createRequestId());
 * if (postToHost(message)) {
 *   dispatch({ kind: 'begin', type: message.type, requestId: message.requestId, now: Date.now() });
 * } else {
 *   dispatch({ kind: 'undelivered', type: message.type });
 * }
 * // On the host's answer:
 * dispatch({ kind: 'result', requestId: frame.requestId, action: frame.action, status: frame.status });
 * // While rendering:
 * <QuestionForm pending={isPending(pending, 'askQuestion')} submission={pending.outcomes.askQuestion} />
 * ```
 *
 * @module apps/vscode-extension/src/webview/pending-actions
 */

import { assertNever } from '@debuggen/shared';

import { WEBVIEW_REQUEST_TYPES, isWebviewRequestType } from '../webview-messages';
import type {
  ActionResultStatus,
  WebviewRequestMessage,
  WebviewRequestType,
  WebviewToHostMessage,
  WebviewToHostMessageType,
} from '../webview-messages';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * How long a request may wait for its `actionResult` before it is settled as failed: **150 s**.
 *
 * This is a safety net only, for an acknowledgement that never arrives. The host answers every
 * request it receives exactly once, and the operations behind the requests are legitimately long:
 * creating a session (`POST /sessions`), asking a follow-up, stopping a capture and ending a session
 * run without a client-side HTTP timeout in the host, because indexing the project and the model
 * stages can take a long time, and the dev-server launch is bounded at 120 s by
 * `commands/launch-dev-server.ts`. The timeout therefore sits above the longest host-side bound, so
 * every bounded host operation answers first.
 *
 * A shorter timeout would itself cause the duplicates it is meant to prevent: it would re-enable a
 * control while its request is still being carried out, the developer would press it again, and
 * the host would run the operation twice (two sessions for one question, two follow-ups).
 */
export const PENDING_ACTION_TIMEOUT_MS = 150_000;

/**
 * Every request that disables a control until the host answers it: exactly the contract's
 * `WEBVIEW_REQUEST_TYPES`, in whose fixed order every map of this module is built (so equal states
 * serialise identically).
 */
export const TRACKED_ACTION_TYPES: typeof WEBVIEW_REQUEST_TYPES = WEBVIEW_REQUEST_TYPES;

/** One of {@link TRACKED_ACTION_TYPES}: a webview-to-host member that carries a `requestId`. */
export type TrackedActionType = WebviewRequestType;

/** The two requests that carry developer-typed text, whose outcome the forms apply. */
export const SUBMISSION_ACTION_TYPES = [
  'askQuestion',
  'askFollowUp',
] as const satisfies readonly TrackedActionType[];

/** One of {@link SUBMISSION_ACTION_TYPES}. */
export type SubmissionActionType = (typeof SUBMISSION_ACTION_TYPES)[number];

/**
 * The settlement of one `askQuestion` or `askFollowUp`. `seq` is the settled submission's own
 * sequence number, so a form applies each outcome exactly once and a re-render that passes the
 * same object again changes nothing.
 */
export interface SubmissionOutcome {
  /** The sequence number of the submission this outcome settles; unique per state lifetime. */
  readonly seq: number;
  /**
   * `accepted`: the host took the text. `failed`: it did not — the host reported the request
   * failed, the host channel refused it, or it timed out.
   */
  readonly status: ActionResultStatus;
}

/** One request the host has not answered yet. */
export interface PendingEntry {
  /** The request's type. */
  readonly type: TrackedActionType;
  /** The id the request was sent with; only an `actionResult` echoing it settles this entry. */
  readonly requestId: string;
  /** Its sequence number, unique for the lifetime of the state. */
  readonly seq: number;
  /** When it was handed to the host, in epoch milliseconds (the caller's clock). */
  readonly sentAt: number;
  /** When it is settled as failed if nothing answered it: `sentAt + PENDING_ACTION_TIMEOUT_MS`. */
  readonly deadline: number;
}

/** The pending requests, at most one per type. */
export type PendingMap = Readonly<Partial<Record<TrackedActionType, PendingEntry>>>;

/** The latest settlement of each submission type. */
export type SubmissionOutcomes = Readonly<Partial<Record<SubmissionActionType, SubmissionOutcome>>>;

/** The reducer's state. */
export interface PendingActionsState {
  /** The requests awaiting their `actionResult`. */
  readonly pending: PendingMap;
  /** The sequence number the next `begin` or undelivered submission receives. */
  readonly nextSeq: number;
  /** The latest settlement of each submission type. */
  readonly outcomes: SubmissionOutcomes;
}

/**
 * What the reducer is told. Every value that depends on time or randomness — `now`, `requestId` —
 * is produced by the caller, which is what keeps the reducer pure.
 *
 * - `begin` — the request `type` with `requestId` was handed to the host at `now`.
 * - `result` — the host's `actionResult` for `requestId` arrived, reporting `status` for `action`.
 * - `expire` — the clock reached `now`; every entry whose deadline has passed fails.
 * - `undelivered` — `postToHost` refused a message of `type`; a submission records a failed outcome.
 */
export type PendingActionsEvent =
  | {
      readonly kind: 'begin';
      readonly type: TrackedActionType;
      readonly requestId: string;
      readonly now: number;
    }
  | {
      readonly kind: 'result';
      readonly requestId: string;
      readonly action: TrackedActionType;
      readonly status: ActionResultStatus;
    }
  | { readonly kind: 'expire'; readonly now: number }
  | { readonly kind: 'undelivered'; readonly type: WebviewToHostMessageType };

// ---------------------------------------------------------------------------
// Initial state and read helpers
// ---------------------------------------------------------------------------

/** The reducer's initial state: nothing pending, no outcome, sequence numbers from 1. */
export const INITIAL_PENDING_ACTIONS_STATE: PendingActionsState = Object.freeze({
  pending: Object.freeze({}),
  nextSeq: 1,
  outcomes: Object.freeze({}),
});

/**
 * Whether a request of `type` has been sent and not yet answered.
 *
 * @param state The reducer's state.
 * @param type The request type.
 * @returns `true` while its entry exists.
 */
export function isPending(state: PendingActionsState, type: TrackedActionType): boolean {
  return state.pending[type] !== undefined;
}

/**
 * The earliest deadline among the pending requests — the one moment a timer needs to fire.
 *
 * @param state The reducer's state.
 * @returns That deadline in epoch milliseconds, or `undefined` when nothing is pending.
 */
export function nextDeadline(state: PendingActionsState): number | undefined {
  let earliest: number | undefined;
  for (const type of TRACKED_ACTION_TYPES) {
    const entry = state.pending[type];
    if (entry !== undefined && (earliest === undefined || entry.deadline < earliest)) {
      earliest = entry.deadline;
    }
  }
  return earliest;
}

/**
 * Whether `type` is one of {@link TRACKED_ACTION_TYPES}: a request, answered by one
 * `actionResult`.
 *
 * @param type Any webview-to-host message type.
 * @returns `true` for a type that disables a control until answered.
 */
export function isTrackedActionType(type: WebviewToHostMessageType): type is TrackedActionType {
  return isWebviewRequestType(type);
}

/**
 * Whether `type` is one of {@link SUBMISSION_ACTION_TYPES}.
 *
 * @param type Any webview-to-host message type.
 * @returns `true` for `askQuestion` and `askFollowUp`.
 */
export function isSubmissionActionType(
  type: WebviewToHostMessageType,
): type is SubmissionActionType {
  return (SUBMISSION_ACTION_TYPES as readonly WebviewToHostMessageType[]).includes(type);
}

// ---------------------------------------------------------------------------
// Drafts: the messages App composes before a request id is attached
// ---------------------------------------------------------------------------

/**
 * Removes `requestId` from each member of a union separately. Distributive, so every member keeps
 * its own `type` literal and its own fields: `Omit` applied to the whole union would collapse it to
 * the keys all members share.
 */
type WithoutRequestId<M> = M extends { readonly requestId: string } ? Omit<M, 'requestId'> : M;

/**
 * A webview-to-host message as `App` composes it: every request without its `requestId`, which
 * `App` mints when the message is sent; `ready` and `openFile` exactly as they are posted.
 *
 * @example
 * ```ts
 * const draft: WebviewToHostDraft = { type: 'retryStage', stage: 'investigate' };
 * ```
 */
export type WebviewToHostDraft = WithoutRequestId<WebviewToHostMessage>;

/** A {@link WebviewToHostDraft} of a request: a member that will carry a `requestId`. */
export type WebviewRequestDraft = WithoutRequestId<WebviewRequestMessage>;

/**
 * Whether a draft is a request, which must be given a `requestId` before it is posted and is then
 * tracked until its `actionResult` arrives.
 *
 * @param draft A draft composed by the view.
 * @returns `true` for a member of {@link TRACKED_ACTION_TYPES}; `false` for `ready` and `openFile`.
 */
export function isWebviewRequestDraft(draft: WebviewToHostDraft): draft is WebviewRequestDraft {
  return isWebviewRequestType(draft.type);
}

/**
 * Completes a request draft with the id the host will echo in its `actionResult`.
 *
 * @param draft The request, without its id.
 * @param requestId An id of 1 to `MAX_WEBVIEW_REQUEST_ID_LENGTH` characters from `[A-Za-z0-9_-]`,
 *   minted by the caller.
 * @returns A new message; the draft is not modified.
 */
export function withRequestId(
  draft: WebviewRequestDraft,
  requestId: string,
): WebviewRequestMessage {
  return { ...draft, requestId };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * Adds or replaces the entry of `entry.type`, keeping the map in {@link TRACKED_ACTION_TYPES}
 * order. A replaced entry is superseded: the newer request is the one whose result is awaited.
 *
 * @param pending The current map.
 * @param entry The new entry.
 * @returns A new map.
 */
function withEntry(pending: PendingMap, entry: PendingEntry): PendingMap {
  const next: Partial<Record<TrackedActionType, PendingEntry>> = {};
  for (const type of TRACKED_ACTION_TYPES) {
    const current = type === entry.type ? entry : pending[type];
    if (current !== undefined) {
      next[type] = current;
    }
  }
  return next;
}

/**
 * Settles every pending entry `decide` resolves and publishes the submissions' outcomes. Returns
 * `state` itself when nothing settled, and keeps the `outcomes` map's identity when only requests
 * without an outcome (everything but the two submissions) settled.
 *
 * @param state The current state.
 * @param decide The settlement of one entry, or `undefined` to leave it pending.
 * @returns The next state.
 */
function settle(
  state: PendingActionsState,
  decide: (entry: PendingEntry) => ActionResultStatus | undefined,
): PendingActionsState {
  const remaining: Partial<Record<TrackedActionType, PendingEntry>> = {};
  let outcomes: Partial<Record<SubmissionActionType, SubmissionOutcome>> | undefined;
  let settledAny = false;

  for (const type of TRACKED_ACTION_TYPES) {
    const entry = state.pending[type];
    if (entry === undefined) {
      continue;
    }
    const status = decide(entry);
    if (status === undefined) {
      remaining[type] = entry;
      continue;
    }
    settledAny = true;
    if (isSubmissionActionType(type)) {
      outcomes ??= { ...state.outcomes };
      outcomes[type] = { seq: entry.seq, status };
    }
  }

  if (!settledAny) {
    return state;
  }
  return { pending: remaining, nextSeq: state.nextSeq, outcomes: outcomes ?? state.outcomes };
}

/**
 * The pending-request reducer, for `useReducer`. Pure: see the module note.
 *
 * - `begin` records a new entry with a fresh `seq` and `deadline = now + PENDING_ACTION_TIMEOUT_MS`,
 *   superseding any pending entry of the same type.
 * - `result` settles `pending[action]` only when its `requestId` equals the event's. A result for
 *   another id (a superseded or already settled request), for another action, or with nothing
 *   pending changes nothing.
 * - `expire` settles every entry whose deadline is at or before `now` as failed.
 * - `undelivered` publishes a failed outcome with a fresh `seq` for a submission; any other type
 *   changes nothing, because the host never saw it and nothing became pending.
 *
 * @param state The current state.
 * @param event What happened.
 * @returns The next state; `state` itself when the event changed nothing.
 */
export function pendingActionsReducer(
  state: PendingActionsState,
  event: PendingActionsEvent,
): PendingActionsState {
  switch (event.kind) {
    case 'begin': {
      const entry: PendingEntry = {
        type: event.type,
        requestId: event.requestId,
        seq: state.nextSeq,
        sentAt: event.now,
        deadline: event.now + PENDING_ACTION_TIMEOUT_MS,
      };
      return {
        pending: withEntry(state.pending, entry),
        nextSeq: state.nextSeq + 1,
        outcomes: state.outcomes,
      };
    }
    case 'result': {
      const { action, requestId, status } = event;
      const awaited = state.pending[action];
      if (awaited === undefined || awaited.requestId !== requestId) {
        return state;
      }
      return settle(state, (entry) => (entry === awaited ? status : undefined));
    }
    case 'expire': {
      const { now } = event;
      return settle(state, (entry) => (entry.deadline <= now ? 'failed' : undefined));
    }
    case 'undelivered': {
      if (!isSubmissionActionType(event.type)) {
        // The host never saw it, so nothing is pending; the view's notice reports the refusal.
        return state;
      }
      const outcomes: Partial<Record<SubmissionActionType, SubmissionOutcome>> = {
        ...state.outcomes,
      };
      outcomes[event.type] = { seq: state.nextSeq, status: 'failed' };
      return { pending: state.pending, nextSeq: state.nextSeq + 1, outcomes };
    }
    default:
      return assertNever(event, 'Unhandled pending-action event');
  }
}
