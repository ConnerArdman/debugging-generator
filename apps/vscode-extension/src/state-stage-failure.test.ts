/**
 * Tests for `ExtensionState.applyProgressFailure` in `./state.ts`: how the
 * host learns a session's failing stage from the `failed` `session.progress`
 * row the service sends for it (AAP §0.5.5: `failed` is a distinct status
 * rendered by both UIs with the failing stage).
 *
 * The service composes every stage failure's row the same way
 * (`projectFailure` in `apps/local-service/src/sessions/progress.ts`): message
 * `‹stage title› failed: ‹summary›`, detail `‹hint› (error code: ‹CODE›, ref:
 * ‹ref›)` — or the suffix alone when there is no hint. Pinned here, through the
 * store's public API only:
 *
 *   - a stage failure's row becomes the store's failure — stage, code, message
 *     and hint — and reaches the webview snapshot;
 *   - a detail that is the suffix alone yields a failure without a hint;
 *   - a `failed` row without the suffix (a signal that could not be enabled)
 *     is not a stage failure and sets nothing;
 *   - a row of another session sets nothing, unless a creation window holds
 *     it for the session it then adopts;
 *   - a row of a session acknowledged as ended is ignored;
 *   - the failed stage's own header row starting again clears the failure,
 *     while a `running` row of another stage, a `running` notice within the
 *     failed stage and a `done` row do not;
 *   - replaying a history in order ends in the state the live frames left.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable package
 * provides it, so `vi.mock` registers a factory for the bare specifier. The
 * store reaches only `EventEmitter` (its change event) and the `Disposable`
 * contract, so the substitute carries exactly those two.
 *
 * Every payload and the session record are validated by `@debuggen/protocol`'s
 * own parsers before use, so no case can pass on a shape the service could
 * never send. The failure copy is the service's own for `MODEL_UNAVAILABLE`
 * (AAP §0.5.5); every other string is neutral vocabulary written for this
 * suite.
 */

import { describe, expect, it, vi } from 'vitest';

import { parseSessionProgressPayload, parseSessionRecord } from '@debuggen/protocol';
import type {
  ProgressStage,
  ProgressStatus,
  SessionProgressPayload,
  SessionRecord,
} from '@debuggen/protocol';

import { ExtensionState } from './state';

vi.mock('vscode', () => {
  /** The change-event emitter the store fires one snapshot per burst through. */
  class EventEmitter<T> {
    private listeners: ((value: T) => void)[] = [];

    readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((held) => held !== listener);
        },
      };
    };

    fire(value: T): void {
      for (const listener of [...this.listeners]) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners = [];
    }
  }

  /** The editor's disposable, for any consumer that constructs one. */
  class Disposable {
    constructor(private readonly onDispose: () => void) {}

    dispose(): void {
      this.onDispose();
    }
  }

  return { EventEmitter, Disposable };
});

/** The session every case activates. */
const SESSION_ID = 'ses_stage_failure_0001';

/** A session the store is not showing. */
const OTHER_SESSION_ID = 'ses_stage_failure_0002';

/** A third session, for a frame a creation window holds and then discards. */
const THIRD_SESSION_ID = 'ses_stage_failure_0003';

/** The service base URL the store is configured with, which owns the adopted session. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/** A fixed clock, so receipt times are deterministic. */
const FIXED_NOW = 1_760_000_000_000;

/** The `understand` stage's title — the message of its header row. */
const UNDERSTAND_TITLE = 'Understanding problem';

/** The `analyze` stage's title — the message of its header row. */
const ANALYZE_TITLE = 'Analyzing captured evidence';

/** The `cleanup` stage's title — the message of its header row. */
const CLEANUP_TITLE = 'Removing instrumentation';

/** The `understand` stage's failed row message for `MODEL_UNAVAILABLE`, as the service words it. */
const MODEL_UNAVAILABLE_MESSAGE = `${UNDERSTAND_TITLE} failed: Model provider unavailable (MODEL_UNAVAILABLE).`;

/** The `MODEL_UNAVAILABLE` hint, as the service words it (AAP §0.5.5). */
const MODEL_UNAVAILABLE_HINT = 'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.';

/** A diagnostic reference of the shape the service mints (`msg_…`). */
const REF = 'msg_0123456789abcdef';

/**
 * The suffix the service closes a stage failure's detail with.
 *
 * @param code The error code.
 * @returns `(error code: ‹code›, ref: ‹ref›)`.
 */
function suffix(code: string): string {
  return `(error code: ${code}, ref: ${REF})`;
}

/**
 * A stored session, validated by the protocol's own schema.
 *
 * @param id The session id.
 * @returns The record, of a session still understanding its question.
 */
function sessionRecord(id: string): SessionRecord {
  const parsed = parseSessionRecord({
    id,
    projectRoot: '/workspace/sample-project',
    projectName: 'sample-project',
    devServerUrl: 'http://127.0.0.1:3000/',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    status: 'understanding',
    question: 'Why is this interaction slow?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/**
 * One `session.progress` payload, validated by the protocol's own parser.
 *
 * @param row The row's stage, status, message and optional detail.
 * @param sessionId The session it belongs to; the active one by default.
 * @returns The payload.
 */
function progress(
  row: {
    readonly stage: ProgressStage;
    readonly status: ProgressStatus;
    readonly message: string;
    readonly detail?: string;
  },
  sessionId: string = SESSION_ID,
): SessionProgressPayload {
  const parsed = parseSessionProgressPayload({ sessionId, ...row });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/** The `understand` stage's header row, opening the stage. */
function understandStarted(sessionId: string = SESSION_ID): SessionProgressPayload {
  return progress({ stage: 'understand', status: 'running', message: UNDERSTAND_TITLE }, sessionId);
}

/** The `understand` stage's header row, closing the stage. */
function understandCompleted(sessionId: string = SESSION_ID): SessionProgressPayload {
  return progress({ stage: 'understand', status: 'done', message: UNDERSTAND_TITLE }, sessionId);
}

/** The `understand` stage's failed row for `MODEL_UNAVAILABLE`, with the hint and the suffix. */
function modelUnavailable(sessionId: string = SESSION_ID): SessionProgressPayload {
  return progress(
    {
      stage: 'understand',
      status: 'failed',
      message: MODEL_UNAVAILABLE_MESSAGE,
      detail: `${MODEL_UNAVAILABLE_HINT} ${suffix('MODEL_UNAVAILABLE')}`,
    },
    sessionId,
  );
}

/** The failure {@link modelUnavailable} reports, as the store holds it. */
const MODEL_UNAVAILABLE_FAILURE = {
  stage: 'understand',
  code: 'MODEL_UNAVAILABLE',
  message: MODEL_UNAVAILABLE_MESSAGE,
  hint: MODEL_UNAVAILABLE_HINT,
} as const;

/**
 * A store with the fixture session active.
 *
 * The session is made active the only way the store allows —
 * `adoptSession`, as the commands do with the service's answer — because a
 * pushed record never becomes the active session on its own.
 *
 * @returns The store; each case disposes it.
 */
function activeState(): ExtensionState {
  const state = new ExtensionState({
    serviceUrl: SERVICE_URL,
    provider: 'deterministic',
    now: () => FIXED_NOW,
  });
  state.adoptSession(sessionRecord(SESSION_ID), SERVICE_URL);
  return state;
}

/**
 * Applies payloads in order, as the host does for every `session.progress`
 * frame: the row first, then the failure it may report.
 *
 * @param state The store.
 * @param payloads The frames, in arrival order.
 */
function applyAll(state: ExtensionState, payloads: readonly SessionProgressPayload[]): void {
  for (const payload of payloads) {
    state.applyProgress(payload);
    state.applyProgressFailure(payload);
  }
}

describe('ExtensionState.applyProgressFailure — setting the failure', () => {
  it('records a stage failure row as the failing stage, with its code, message and hint', () => {
    const state = activeState();

    applyAll(state, [understandStarted(), modelUnavailable()]);

    expect(state.failure).toEqual(MODEL_UNAVAILABLE_FAILURE);
    expect(state.toWebviewState().failure).toEqual(MODEL_UNAVAILABLE_FAILURE);
    // The row itself is still in the progress list, verbatim.
    expect(state.progress.at(-1)?.detail).toBe(
      `${MODEL_UNAVAILABLE_HINT} ${suffix('MODEL_UNAVAILABLE')}`,
    );
    state.dispose();
  });

  it('notifies the views once for the burst that reports the failure', async () => {
    const state = activeState();
    await Promise.resolve();
    const snapshots: unknown[] = [];
    state.onDidChange((snapshot) => snapshots.push(snapshot.failure));

    applyAll(state, [modelUnavailable()]);
    await Promise.resolve();

    expect(snapshots).toEqual([MODEL_UNAVAILABLE_FAILURE]);
    state.dispose();
  });

  it('records no hint when the detail is the suffix alone', () => {
    const state = activeState();

    state.applyProgressFailure(
      progress({
        stage: 'analyze',
        status: 'failed',
        message: `${ANALYZE_TITLE} failed: An unexpected error stopped this step.`,
        detail: suffix('INTERNAL'),
      }),
    );

    expect(state.failure).toEqual({
      stage: 'analyze',
      code: 'INTERNAL',
      message: `${ANALYZE_TITLE} failed: An unexpected error stopped this step.`,
    });
    expect(state.failure !== undefined && 'hint' in state.failure).toBe(false);
    state.dispose();
  });

  it('records a cleanup failure, whose retry ends the session again', () => {
    const state = activeState();

    state.applyProgressFailure(
      progress({
        stage: 'cleanup',
        status: 'failed',
        message: `${CLEANUP_TITLE} failed: Some instrumentation could not be removed.`,
        detail: `Review the modifications list, then end the session again to retry cleanup. ${suffix('CLEANUP_PARTIAL')}`,
      }),
    );

    expect(state.failure).toEqual({
      stage: 'cleanup',
      code: 'CLEANUP_PARTIAL',
      message: `${CLEANUP_TITLE} failed: Some instrumentation could not be removed.`,
      hint: 'Review the modifications list, then end the session again to retry cleanup.',
    });
    state.dispose();
  });

  it('ignores a failed row without the suffix: a signal that could not be enabled is not a stage failure', () => {
    const state = activeState();

    applyAll(state, [
      progress({
        stage: 'instrument',
        status: 'failed',
        message: 'Could not enable Server spans: the dev server was not started with the preload.',
        detail: 'Continuing with: Browser performance, Network tracing.',
      }),
      progress({
        stage: 'instrument',
        status: 'failed',
        message: 'Could not enable React renders.',
      }),
    ]);

    expect(state.failure).toBeUndefined();
    expect(state.toWebviewState().failure).toBeUndefined();
    // The rows are still shown as the failed rows they are.
    expect(state.progress.map((row) => row.status)).toEqual(['failed', 'failed']);
    state.dispose();
  });

  it('reads the suffix only where it closes the detail, and only with an upper-case code', () => {
    const state = activeState();

    applyAll(state, [
      progress({
        stage: 'analyze',
        status: 'failed',
        message: 'A quoted suffix is not a stage failure',
        detail: `${suffix('INTERNAL')} and then more text`,
      }),
      progress({
        stage: 'analyze',
        status: 'failed',
        message: 'A lower-case code is not a stage failure',
        detail: `(error code: internal, ref: ${REF})`,
      }),
      progress({
        stage: 'analyze',
        status: 'failed',
        message: 'A reference with a space is not a stage failure',
        detail: '(error code: INTERNAL, ref: two words)',
      }),
    ]);

    expect(state.failure).toBeUndefined();
    state.dispose();
  });

  it('ignores a stage failure of another session', () => {
    const state = activeState();

    applyAll(state, [modelUnavailable(OTHER_SESSION_ID)]);

    expect(state.failure).toBeUndefined();
    state.dispose();
  });

  it('replays a stage failure a creation window held once its session is adopted', () => {
    const state = activeState();
    const creation = state.beginSessionCreation();

    applyAll(state, [
      understandStarted(OTHER_SESSION_ID),
      modelUnavailable(OTHER_SESSION_ID),
      progress(
        {
          stage: 'analyze',
          status: 'failed',
          message: `${ANALYZE_TITLE} failed: The model's output failed validation.`,
          detail: suffix('MODEL_OUTPUT_INVALID'),
        },
        THIRD_SESSION_ID,
      ),
    ]);
    // Held, not applied: the session shown is still the first one.
    expect(state.failure).toBeUndefined();

    creation.adopt(sessionRecord(OTHER_SESSION_ID), SERVICE_URL);

    expect(state.activeSessionId).toBe(OTHER_SESSION_ID);
    // The held failure of the adopted session applies; the third session's is discarded.
    expect(state.failure).toEqual(MODEL_UNAVAILABLE_FAILURE);
    state.dispose();
  });

  it('ignores a stage failure of a session acknowledged as ended', () => {
    const state = activeState();
    state.applySessionEnded(SESSION_ID, { cleanup: 'clean' });
    expect(state.hasAcknowledgedEnd(SESSION_ID)).toBe(true);

    applyAll(state, [modelUnavailable()]);

    expect(state.failure).toBeUndefined();
    state.dispose();
  });

  it('does nothing once the store is disposed', () => {
    const state = activeState();
    state.dispose();

    state.applyProgressFailure(modelUnavailable());

    expect(state.failure).toBeUndefined();
  });
});

describe('ExtensionState.applyProgressFailure — clearing the failure', () => {
  it('clears the failure when the failed stage starts again', () => {
    const state = activeState();
    applyAll(state, [understandStarted(), modelUnavailable()]);

    applyAll(state, [understandStarted()]);

    expect(state.failure).toBeUndefined();
    expect(state.toWebviewState().failure).toBeUndefined();
    state.dispose();
  });

  it('keeps the failure when another stage reports running', () => {
    const state = activeState();
    applyAll(state, [modelUnavailable()]);

    applyAll(state, [progress({ stage: 'analyze', status: 'running', message: ANALYZE_TITLE })]);

    expect(state.failure).toEqual(MODEL_UNAVAILABLE_FAILURE);
    state.dispose();
  });

  it('keeps the failure for a running notice of the failed stage that is not its header', () => {
    const state = activeState();
    applyAll(state, [
      progress({
        stage: 'instrument',
        status: 'failed',
        message: 'Preparing instrumentation failed: Instrumentation could not be installed.',
        detail: suffix('INSTRUMENTATION_INSTALL_FAILED'),
      }),
    ]);

    applyAll(state, [
      progress({
        stage: 'instrument',
        status: 'running',
        message: 'A sample file was edited while instrumented.',
      }),
    ]);

    expect(state.failure?.stage).toBe('instrument');
    expect(state.failure?.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    state.dispose();
  });

  it('keeps the failure for a done row, even of the failed stage', () => {
    const state = activeState();
    applyAll(state, [modelUnavailable()]);

    applyAll(state, [understandCompleted()]);

    expect(state.failure).toEqual(MODEL_UNAVAILABLE_FAILURE);
    state.dispose();
  });

  it('keeps the failure when the header row names another session', () => {
    const state = activeState();
    applyAll(state, [modelUnavailable()]);

    applyAll(state, [understandStarted(OTHER_SESSION_ID)]);

    expect(state.failure).toEqual(MODEL_UNAVAILABLE_FAILURE);
    state.dispose();
  });
});

describe('ExtensionState.applyProgressFailure — replays', () => {
  it('ends a replayed history in the state the live frames left', () => {
    const retried: readonly SessionProgressPayload[] = [
      understandStarted(),
      modelUnavailable(),
      understandStarted(),
      understandCompleted(),
    ];
    const unretried: readonly SessionProgressPayload[] = [understandStarted(), modelUnavailable()];

    const retriedState = activeState();
    applyAll(retriedState, retried);
    expect(retriedState.failure).toBeUndefined();
    // The service replays stored history on reopen and on every (re)bind.
    applyAll(retriedState, retried);
    expect(retriedState.failure).toBeUndefined();
    retriedState.dispose();

    const unretriedState = activeState();
    applyAll(unretriedState, unretried);
    applyAll(unretriedState, unretried);
    expect(unretriedState.failure).toEqual(MODEL_UNAVAILABLE_FAILURE);
    unretriedState.dispose();
  });
});
