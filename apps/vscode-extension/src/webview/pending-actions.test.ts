/**
 * `webview/pending-actions` — the correlation of webview requests with the host's `actionResult`.
 *
 * What this suite protects:
 *
 *   - the vocabulary: the tracked requests are exactly the contract's `WEBVIEW_REQUEST_TYPES`, the
 *     submissions are the two text requests, and the safety timeout outlasts every host-side bound;
 *   - `begin` records one entry per request type with its id, sequence, send time and deadline,
 *     and a newer request of the same type supersedes the older one;
 *   - `result` settles only the entry of its `action` whose `requestId` matches, and returns the
 *     very same state for anything else — a wrong id, a wrong action, a superseded or already
 *     settled request, or nothing pending;
 *   - submission outcomes: `accepted` and `failed` carry the settled entry's own `seq`; every other
 *     request settles without an outcome;
 *   - the safety timeout: `expire(now)` fails an entry at its deadline and not a millisecond before,
 *     and the expired request's late result is ignored;
 *   - `undelivered`: a failed outcome with a fresh `seq` for a submission, nothing for any other type;
 *   - purity: the reducer never mutates its input, returns equal output for equal input (React
 *     StrictMode calls it twice) and keeps its input's identity when an event changes nothing;
 *   - the draft helpers App sends through: which drafts are requests, and that a completed request
 *     is exactly what the host's parser accepts.
 *
 * Request ids are 32 lowercase hex characters, as `App` mints them; the question and stage texts
 * are neutral and synthetic (AAP 0.5.4).
 */
import { describe, expect, it } from 'vitest';

import {
  WEBVIEW_REQUEST_TYPES,
  WEBVIEW_TO_HOST_MESSAGE_TYPES,
  parseWebviewToHostMessage,
} from '../webview-messages';
import type { ActionResultStatus, WebviewRequestType } from '../webview-messages';

import {
  INITIAL_PENDING_ACTIONS_STATE,
  PENDING_ACTION_TIMEOUT_MS,
  SUBMISSION_ACTION_TYPES,
  TRACKED_ACTION_TYPES,
  isPending,
  isSubmissionActionType,
  isTrackedActionType,
  isWebviewRequestDraft,
  nextDeadline,
  pendingActionsReducer,
  withRequestId,
} from './pending-actions';
import type {
  PendingActionsEvent,
  PendingActionsState,
  TrackedActionType,
  WebviewRequestDraft,
  WebviewToHostDraft,
} from './pending-actions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The instant every `begin` in this suite is sent at, in epoch milliseconds. */
const SENT_AT = 1_758_000_000_000;

/** The dev-server launch bound of `commands/launch-dev-server.ts`, the longest host-side bound. */
const DEV_SERVER_LAUNCH_BOUND_MS = 120_000;

/** Request ids in the shape `App` mints: 16 random bytes as 32 lowercase hex characters. */
const ID_1 = '5f0c2a9e7b1d4c3a8e6f2b0d9a7c1e4f';
const ID_2 = 'a3e91b07c46d25f8e0b7194c3d6a5f21';
const ID_3 = '0d7f4c2b9e1a6358f2c0b8e4a9d17c63';

/** Applies a sequence of events, left to right. */
function run(state: PendingActionsState, ...events: PendingActionsEvent[]): PendingActionsState {
  return events.reduce(pendingActionsReducer, state);
}

/** A `begin` event for `type` with `requestId`, at {@link SENT_AT} plus `offset` milliseconds. */
function begin(type: TrackedActionType, requestId: string, offset = 0): PendingActionsEvent {
  return { kind: 'begin', type, requestId, now: SENT_AT + offset };
}

/** The `result` event of the host's `actionResult { requestId, action, status }`. */
function result(
  action: TrackedActionType,
  requestId: string,
  status: ActionResultStatus,
): PendingActionsEvent {
  return { kind: 'result', requestId, action, status };
}

/** Every tracked type currently pending, in the module's order. */
function pendingTypes(state: PendingActionsState): TrackedActionType[] {
  return TRACKED_ACTION_TYPES.filter((type) => isPending(state, type));
}

/** Freezes a value and everything reachable from it, so a mutation throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** One realistic draft of every request, as `App` composes them. */
const REQUEST_DRAFTS: Readonly<Record<WebviewRequestType, WebviewRequestDraft>> = {
  askQuestion: { type: 'askQuestion', question: 'Why does the list take so long to appear?' },
  askFollowUp: { type: 'askFollowUp', question: 'Why did that step run twice?' },
  startCapture: { type: 'startCapture' },
  stopCapture: { type: 'stopCapture' },
  endSession: { type: 'endSession' },
  requestTarget: { type: 'requestTarget' },
  pairChrome: { type: 'pairChrome' },
  dismissPairing: { type: 'dismissPairing' },
  launchDevServer: { type: 'launchDevServer' },
  retryStage: { type: 'retryStage', stage: 'investigate' },
  loadModifications: { type: 'loadModifications' },
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('pending-actions — vocabulary', () => {
  it('tracks exactly the contract’s requests, in the contract’s order', () => {
    expect(TRACKED_ACTION_TYPES).toBe(WEBVIEW_REQUEST_TYPES);
    expect([...TRACKED_ACTION_TYPES]).toEqual([...WEBVIEW_REQUEST_TYPES]);
  });

  it('classifies every webview-to-host type', () => {
    for (const type of WEBVIEW_TO_HOST_MESSAGE_TYPES) {
      expect(isTrackedActionType(type)).toBe(
        (WEBVIEW_REQUEST_TYPES as readonly string[]).includes(type),
      );
      expect(isSubmissionActionType(type)).toBe(
        (SUBMISSION_ACTION_TYPES as readonly string[]).includes(type),
      );
    }
    expect(isTrackedActionType('ready')).toBe(false);
    expect(isTrackedActionType('openFile')).toBe(false);
    expect([...SUBMISSION_ACTION_TYPES]).toEqual(['askQuestion', 'askFollowUp']);
  });

  it('waits 150 s, longer than the longest host-side bound', () => {
    expect(PENDING_ACTION_TIMEOUT_MS).toBe(150_000);
    expect(PENDING_ACTION_TIMEOUT_MS).toBeGreaterThan(DEV_SERVER_LAUNCH_BOUND_MS);
  });
});

// ---------------------------------------------------------------------------
// begin
// ---------------------------------------------------------------------------

describe('pending-actions — initial state and begin', () => {
  it('starts with nothing pending, no outcome and no deadline', () => {
    expect(pendingTypes(INITIAL_PENDING_ACTIONS_STATE)).toEqual([]);
    expect(INITIAL_PENDING_ACTIONS_STATE.outcomes).toEqual({});
    expect(INITIAL_PENDING_ACTIONS_STATE.nextSeq).toBe(1);
    expect(nextDeadline(INITIAL_PENDING_ACTIONS_STATE)).toBeUndefined();
  });

  it('records an entry with its request id, sequence, send time and deadline', () => {
    const state = run(INITIAL_PENDING_ACTIONS_STATE, begin('startCapture', ID_1));

    expect(isPending(state, 'startCapture')).toBe(true);
    expect(state.pending.startCapture).toEqual({
      type: 'startCapture',
      requestId: ID_1,
      seq: 1,
      sentAt: SENT_AT,
      deadline: SENT_AT + 150_000,
    });
    expect(state.nextSeq).toBe(2);
    expect(nextDeadline(state)).toBe(SENT_AT + 150_000);
    // Beginning a request publishes no outcome.
    expect(state.outcomes).toBe(INITIAL_PENDING_ACTIONS_STATE.outcomes);
  });

  it('gives every begin a fresh sequence number and reports the earliest deadline', () => {
    const state = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('askFollowUp', ID_1),
      begin('endSession', ID_2, 500),
    );

    expect(state.pending.askFollowUp?.seq).toBe(1);
    expect(state.pending.endSession?.seq).toBe(2);
    expect(nextDeadline(state)).toBe(SENT_AT + PENDING_ACTION_TIMEOUT_MS);
  });

  it('keeps the pending map in the contract’s order whatever the order of sending', () => {
    const state = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('retryStage', ID_1),
      begin('askQuestion', ID_2, 10),
      begin('requestTarget', ID_3, 20),
    );

    expect(Object.keys(state.pending)).toEqual(['askQuestion', 'requestTarget', 'retryStage']);
  });

  it('supersedes a pending request of the same type, whose late result is then ignored', () => {
    const first = run(INITIAL_PENDING_ACTIONS_STATE, begin('pairChrome', ID_1));
    const second = run(first, begin('pairChrome', ID_2, 1_000));

    expect(pendingTypes(second)).toEqual(['pairChrome']);
    expect(second.pending.pairChrome).toEqual({
      type: 'pairChrome',
      requestId: ID_2,
      seq: 2,
      sentAt: SENT_AT + 1_000,
      deadline: SENT_AT + 1_000 + PENDING_ACTION_TIMEOUT_MS,
    });

    // The superseded request's answer settles nothing.
    expect(pendingActionsReducer(second, result('pairChrome', ID_1, 'accepted'))).toBe(second);
    // The newer request's answer settles it.
    expect(pendingTypes(run(second, result('pairChrome', ID_2, 'accepted')))).toEqual([]);
  });

  it('supersedes a pending submission so only the newer submission’s result publishes an outcome', () => {
    const state = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('askQuestion', ID_1),
      begin('askQuestion', ID_2, 5),
    );

    const stale = pendingActionsReducer(state, result('askQuestion', ID_1, 'accepted'));
    expect(stale).toBe(state);
    expect(stale.outcomes.askQuestion).toBeUndefined();

    const settled = run(state, result('askQuestion', ID_2, 'failed'));
    expect(settled.outcomes.askQuestion).toEqual({ seq: 2, status: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

describe('pending-actions — result', () => {
  it('settles only the entry whose action and request id both match', () => {
    const busy = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('stopCapture', ID_1),
      begin('requestTarget', ID_2, 100),
    );

    const answered = run(busy, result('requestTarget', ID_2, 'accepted'));

    expect(pendingTypes(answered)).toEqual(['stopCapture']);
    expect(answered.pending.stopCapture).toBe(busy.pending.stopCapture);
  });

  it('returns the same state for a result with another request’s id', () => {
    const busy = run(INITIAL_PENDING_ACTIONS_STATE, begin('stopCapture', ID_1));
    expect(pendingActionsReducer(busy, result('stopCapture', ID_2, 'accepted'))).toBe(busy);
  });

  it('returns the same state for a result naming another action with the pending id', () => {
    const busy = run(INITIAL_PENDING_ACTIONS_STATE, begin('stopCapture', ID_1));
    expect(pendingActionsReducer(busy, result('requestTarget', ID_1, 'accepted'))).toBe(busy);
    expect(pendingActionsReducer(busy, result('startCapture', ID_1, 'failed'))).toBe(busy);
  });

  it('returns the same state for a result with nothing pending', () => {
    expect(
      pendingActionsReducer(INITIAL_PENDING_ACTIONS_STATE, result('askQuestion', ID_1, 'accepted')),
    ).toBe(INITIAL_PENDING_ACTIONS_STATE);
  });

  it('returns the same state for a second result of a request already settled', () => {
    const settled = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('askQuestion', ID_1),
      result('askQuestion', ID_1, 'failed'),
    );
    expect(pendingActionsReducer(settled, result('askQuestion', ID_1, 'accepted'))).toBe(settled);
    expect(settled.outcomes.askQuestion).toEqual({ seq: 1, status: 'failed' });
  });

  it('publishes an accepted submission outcome carrying the entry’s own sequence', () => {
    const state = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('startCapture', ID_1),
      begin('askQuestion', ID_2, 10),
      begin('endSession', ID_3, 20),
      result('askQuestion', ID_2, 'accepted'),
    );

    expect(isPending(state, 'askQuestion')).toBe(false);
    expect(state.outcomes.askQuestion).toEqual({ seq: 2, status: 'accepted' });
    expect(pendingTypes(state)).toEqual(['startCapture', 'endSession']);
    expect(state.nextSeq).toBe(4);
  });

  it('publishes a failed submission outcome for the follow-up', () => {
    const state = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('askFollowUp', ID_1),
      result('askFollowUp', ID_1, 'failed'),
    );

    expect(isPending(state, 'askFollowUp')).toBe(false);
    expect(state.outcomes).toEqual({ askFollowUp: { seq: 1, status: 'failed' } });
  });

  it('settles every other request, accepted or failed, without publishing an outcome', () => {
    for (const type of TRACKED_ACTION_TYPES) {
      if (isSubmissionActionType(type)) {
        continue;
      }
      for (const status of ['accepted', 'failed'] as const) {
        const busy = run(INITIAL_PENDING_ACTIONS_STATE, begin(type, ID_1));
        const settled = run(busy, result(type, ID_1, status));

        expect(pendingTypes(settled)).toEqual([]);
        expect(settled.outcomes).toBe(busy.outcomes);
        expect(settled.outcomes).toEqual({});
      }
    }
  });

  it('never reuses a settled submission’s sequence, and keeps the last outcome until the next settles', () => {
    const first = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('askQuestion', ID_1),
      result('askQuestion', ID_1, 'failed'),
    );
    const second = run(first, begin('askQuestion', ID_2, 1_000));

    expect(second.pending.askQuestion?.seq).toBe(2);
    expect(second.outcomes.askQuestion).toEqual({ seq: 1, status: 'failed' });

    const accepted = run(second, result('askQuestion', ID_2, 'accepted'));
    expect(accepted.outcomes.askQuestion).toEqual({ seq: 2, status: 'accepted' });
  });
});

// ---------------------------------------------------------------------------
// expire
// ---------------------------------------------------------------------------

describe('pending-actions — safety timeout', () => {
  it('fails a request at its deadline and not a millisecond before', () => {
    const asking = run(INITIAL_PENDING_ACTIONS_STATE, begin('askQuestion', ID_1));
    const deadline = SENT_AT + PENDING_ACTION_TIMEOUT_MS;

    const early = pendingActionsReducer(asking, { kind: 'expire', now: deadline - 1 });
    expect(early).toBe(asking);
    expect(isPending(early, 'askQuestion')).toBe(true);

    const expired = pendingActionsReducer(asking, { kind: 'expire', now: deadline });
    expect(isPending(expired, 'askQuestion')).toBe(false);
    expect(expired.outcomes.askQuestion).toEqual({ seq: 1, status: 'failed' });
  });

  it('ignores the late result of a request that timed out', () => {
    const expired = run(INITIAL_PENDING_ACTIONS_STATE, begin('askFollowUp', ID_1), {
      kind: 'expire',
      now: SENT_AT + PENDING_ACTION_TIMEOUT_MS,
    });

    expect(pendingActionsReducer(expired, result('askFollowUp', ID_1, 'accepted'))).toBe(expired);
    expect(expired.outcomes.askFollowUp).toEqual({ seq: 1, status: 'failed' });
  });

  it('fails only the requests whose deadline has passed, with no outcome for non-submissions', () => {
    const busy = run(
      INITIAL_PENDING_ACTIONS_STATE,
      begin('launchDevServer', ID_1),
      begin('requestTarget', ID_2, 10_000),
    );
    const expired = run(busy, { kind: 'expire', now: SENT_AT + PENDING_ACTION_TIMEOUT_MS });

    expect(pendingTypes(expired)).toEqual(['requestTarget']);
    expect(nextDeadline(expired)).toBe(SENT_AT + 10_000 + PENDING_ACTION_TIMEOUT_MS);
    expect(expired.outcomes).toBe(busy.outcomes);
  });

  it('changes nothing when nothing is pending', () => {
    expect(
      pendingActionsReducer(INITIAL_PENDING_ACTIONS_STATE, { kind: 'expire', now: SENT_AT }),
    ).toBe(INITIAL_PENDING_ACTIONS_STATE);
  });
});

// ---------------------------------------------------------------------------
// undelivered
// ---------------------------------------------------------------------------

describe('pending-actions — undelivered', () => {
  it('records a failed outcome with a fresh sequence for a refused submission, and no entry', () => {
    const refused = run(INITIAL_PENDING_ACTIONS_STATE, {
      kind: 'undelivered',
      type: 'askQuestion',
    });

    expect(pendingTypes(refused)).toEqual([]);
    expect(refused.outcomes.askQuestion).toEqual({ seq: 1, status: 'failed' });
    expect(refused.nextSeq).toBe(2);

    const again = run(refused, { kind: 'undelivered', type: 'askQuestion' });
    expect(again.outcomes.askQuestion).toEqual({ seq: 2, status: 'failed' });

    const followUp = run(INITIAL_PENDING_ACTIONS_STATE, {
      kind: 'undelivered',
      type: 'askFollowUp',
    });
    expect(followUp.outcomes.askFollowUp).toEqual({ seq: 1, status: 'failed' });
  });

  it('changes nothing for a refused message that carries no text', () => {
    const idle = INITIAL_PENDING_ACTIONS_STATE;
    expect(pendingActionsReducer(idle, { kind: 'undelivered', type: 'startCapture' })).toBe(idle);
    expect(pendingActionsReducer(idle, { kind: 'undelivered', type: 'openFile' })).toBe(idle);
    expect(pendingActionsReducer(idle, { kind: 'undelivered', type: 'ready' })).toBe(idle);
  });

  it('leaves another pending request untouched', () => {
    const capturing = run(INITIAL_PENDING_ACTIONS_STATE, begin('stopCapture', ID_1));
    const refused = run(capturing, { kind: 'undelivered', type: 'askFollowUp' });

    expect(refused.pending).toBe(capturing.pending);
    expect(refused.outcomes.askFollowUp).toEqual({ seq: 2, status: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('pending-actions — purity', () => {
  it('returns equal output for equal input and never mutates what it is given', () => {
    const events: PendingActionsEvent[] = [
      begin('askFollowUp', ID_1),
      begin('endSession', ID_2, 5),
      result('endSession', ID_2, 'accepted'),
      result('askFollowUp', ID_3, 'accepted'),
      begin('askQuestion', ID_3, 10),
      begin('stopCapture', ID_2, 15),
      { kind: 'expire', now: SENT_AT + PENDING_ACTION_TIMEOUT_MS + 10 },
      { kind: 'undelivered', type: 'askFollowUp' },
      result('stopCapture', ID_2, 'failed'),
    ];

    let state: PendingActionsState = INITIAL_PENDING_ACTIONS_STATE;
    for (const event of events) {
      const frozenState = deepFreeze(state);
      const frozenEvent = deepFreeze(event);
      const snapshotBefore = JSON.stringify(frozenState);

      // React StrictMode calls a reducer twice with the same arguments.
      const first = pendingActionsReducer(frozenState, frozenEvent);
      const second = pendingActionsReducer(frozenState, frozenEvent);

      expect(second).toEqual(first);
      expect(JSON.stringify(frozenState)).toBe(snapshotBefore);
      state = first;
    }
    expect(pendingTypes(state)).toEqual([]);
    expect(state.outcomes).toEqual({
      askQuestion: { seq: 3, status: 'failed' },
      askFollowUp: { seq: 5, status: 'failed' },
    });
  });

  it('keeps the pending map’s identity for everything a settlement does not touch', () => {
    const busy = run(INITIAL_PENDING_ACTIONS_STATE, begin('askQuestion', ID_1));
    const refused = run(busy, { kind: 'undelivered', type: 'askFollowUp' });
    expect(refused.pending).toBe(busy.pending);
    expect(refused).not.toBe(busy);
  });
});

// ---------------------------------------------------------------------------
// Draft helpers
// ---------------------------------------------------------------------------

describe('pending-actions — drafts', () => {
  it('recognises every request draft, and neither ready nor openFile', () => {
    for (const type of WEBVIEW_REQUEST_TYPES) {
      expect(isWebviewRequestDraft(REQUEST_DRAFTS[type])).toBe(true);
    }
    const ready: WebviewToHostDraft = { type: 'ready' };
    const openFile: WebviewToHostDraft = {
      type: 'openFile',
      location: {
        file: 'src/lib/task-runner.ts',
        line: 1,
        column: 1,
        resolvedBy: 'code-graph',
        confidence: 0.8,
      },
    };
    expect(isWebviewRequestDraft(ready)).toBe(false);
    expect(isWebviewRequestDraft(openFile)).toBe(false);
  });

  it('completes every request draft into a message the host’s parser accepts, without touching the draft', () => {
    for (const type of WEBVIEW_REQUEST_TYPES) {
      const draft = deepFreeze({ ...REQUEST_DRAFTS[type] });
      const message = withRequestId(draft, ID_1);

      expect(message).toEqual({ ...draft, requestId: ID_1 });
      expect(message).not.toBe(draft);
      expect(draft).not.toHaveProperty('requestId');
      expect(parseWebviewToHostMessage(message)).toEqual({ ok: true, message });
    }
  });

  it('does not compile a request id onto a draft that waits on nothing', () => {
    const openFile = {
      type: 'openFile',
      location: {
        file: 'src/lib/task-runner.ts',
        line: 1,
        column: 1,
        resolvedBy: 'code-graph',
        confidence: 0.8,
      },
    } as const;
    // @ts-expect-error -- `openFile` is not a request, so it has no request draft.
    const message = withRequestId(openFile, ID_1);
    // At run time the helper is a plain spread; the host would refuse the extra key.
    expect(parseWebviewToHostMessage(message).ok).toBe(false);
  });
});
