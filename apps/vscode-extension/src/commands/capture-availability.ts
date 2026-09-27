/**
 * Whether the active session can start or stop a capture now, as the extension
 * host's store knows it, and the product copy the two capture commands show
 * when it cannot (AAP §0.4.2 `capture.start` / `capture.stop`, §0.5.5, §0.7.3).
 *
 * ## Why this exists
 *
 * `debuggen.startCapture` and `debuggen.stopCapture` are contributed to the
 * title bar of the `debuggen.session` view. A title action that is always
 * clickable invites a request the service can only refuse — on an ended
 * session that refusal used to reach the developer as the raw
 * `capture.start request failed (status 409)` failure. Three things close that
 * gap, and all of them live here so the two commands and the manifest cannot
 * drift apart:
 *
 * 1. **{@link captureAvailabilityOf}** reduces the store to four facts. Its
 *    rules are the webview's own (`src/webview/App.tsx`: "Start capture" needs
 *    an armed session that is not capturing, "Stop capture" needs a running
 *    capture), which are in turn the service's transition table
 *    (`ready → capturing`, `capturing → analyzing | ready`).
 * 2. **{@link bindCaptureContextKeys}** publishes `canStart` / `canStop` as the
 *    context keys {@link CAPTURE_CAN_START_CONTEXT_KEY} and
 *    {@link CAPTURE_CAN_STOP_CONTEXT_KEY}. The commands' `enablement` clauses in
 *    `apps/vscode-extension/package.json` name exactly these keys, so VS Code
 *    greys the title actions (and the Command Palette entries) whenever the
 *    action would be refused. `enablement` never blocks
 *    `vscode.commands.executeCommand`, so the webview's controls and the
 *    "Capture again" action keep dispatching the commands directly.
 * 3. **{@link endedSessionNotice}** and **{@link captureRefusalNotice}** are the
 *    developer-facing copy for the two cases the commands still meet: a session
 *    the store knows has ended (the command sends nothing), and a
 *    `SESSION_INVALID_STATE` refusal from the service (the host's projection
 *    was stale, or the session moved on elsewhere). Each notice says what
 *    happened and what to do next, in words that follow the session status.
 *
 * ## What it deliberately does not do
 *
 * - It never decides for the service. Apart from the ended session — terminal
 *   in the store (`ExtensionState.hasAcknowledgedEnd`) and in the service's
 *   state machine alike — nothing here stops a command from sending its
 *   request; availability only greys controls and chooses the wording of a
 *   refusal the service already made.
 * - It never inspects a refusal's message: the service scrubs it to a
 *   code-level summary, so the error code is the only signal
 *   ({@link isCaptureStateRefusal}).
 * - Copy is generic product vocabulary only (AAP §0.5.4): no project name,
 *   route, question text or session id appears in any notice.
 *
 * ## Module graph
 *
 * Extension-host code (Node + `vscode` types, no DOM). It imports **types
 * only** from `./index` and `../state`: the barrel imports the command
 * modules, which import this file at runtime, so a value import of the barrel
 * here would close a cycle.
 *
 * @example
 * ```ts
 * // In activate(), once the store exists:
 * context.subscriptions.push(
 *   bindCaptureContextKeys(
 *     state,
 *     (key, value) => vscode.commands.executeCommand('setContext', key, value),
 *     logger,
 *   ),
 * );
 *
 * // In a command, after its active-session guard:
 * if (captureAvailabilityOf(ctx.state, active.sessionId).ended) {
 *   await ctx.ui.notify(endedSessionNotice('start'));
 *   return;
 * }
 * ```
 *
 * @module
 */

import type { SessionStatus } from '@debuggen/protocol';
import { DebuggenError, assertNever } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger } from '@debuggen/shared';

import type { ExtensionState } from '../state';

import type { CommandNotice } from './index';

// ---------------------------------------------------------------------------
// Context keys
// ---------------------------------------------------------------------------

/**
 * `true` while the active session is armed (`ready`) and no capture is
 * running. The `enablement` of `debuggen.startCapture` in `package.json`.
 */
export const CAPTURE_CAN_START_CONTEXT_KEY = 'debuggen.captureCanStart';

/**
 * `true` while the active session's capture is running. The `enablement` of
 * `debuggen.stopCapture` in `package.json`.
 */
export const CAPTURE_CAN_STOP_CONTEXT_KEY = 'debuggen.captureCanStop';

/** One of the two context keys {@link bindCaptureContextKeys} maintains. */
export type CaptureContextKey =
  typeof CAPTURE_CAN_START_CONTEXT_KEY | typeof CAPTURE_CAN_STOP_CONTEXT_KEY;

/** Both keys, in the order they are evaluated and reset. */
const CAPTURE_CONTEXT_KEYS: readonly CaptureContextKey[] = Object.freeze([
  CAPTURE_CAN_START_CONTEXT_KEY,
  CAPTURE_CAN_STOP_CONTEXT_KEY,
]);

/**
 * The value VS Code gives a context key nobody has set. A `when` or
 * `enablement` clause naming an unset key reads it as false, so a key that
 * would only ever be written `false` is never written at all.
 */
const UNSET_CONTEXT_VALUE = false;

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** The part of the store availability is computed from. */
export type CaptureAvailabilityState = Pick<
  ExtensionState,
  'activeSession' | 'activeSessionId' | 'captureState' | 'hasAcknowledgedEnd'
>;

/** What the store says the capture commands can do for one session now. */
export interface CaptureAvailability {
  /** The session is armed (`ready`), not ended, and no capture is running. */
  readonly canStart: boolean;
  /** The session's capture is running and the session has not ended. */
  readonly canStop: boolean;
  /**
   * The store has acknowledged the session as ended — its record says `ended`,
   * or `ExtensionState.hasAcknowledgedEnd` holds. Terminal: no later frame
   * makes the session capture again.
   */
  readonly ended: boolean;
  /**
   * The session's status, when the store holds its record — that is, when it
   * is the active session. `undefined` for no session, or for a session that is
   * no longer the one in view.
   */
  readonly status: SessionStatus | undefined;
}

/** Which capture command a notice is for. */
export type CaptureCommandKind = 'start' | 'stop';

/** No session, or a session the store no longer holds: nothing is possible. */
const NO_SESSION_AVAILABILITY: CaptureAvailability = Object.freeze({
  canStart: false,
  canStop: false,
  ended: false,
  status: undefined,
});

/**
 * Computes what the capture commands can do for `sessionId`, from the store.
 *
 * The rules mirror the webview's `CaptureControls` wiring in
 * `src/webview/App.tsx` (`canStart = armed && !capturing`,
 * `canStop = capturing`), with `ended` taking precedence over both:
 *
 * - `ended` — the record's status is `ended`, or the store has acknowledged the
 *   end (`hasAcknowledgedEnd`), which also covers a session no longer in view.
 * - `capturing` — the store's capture window is open (`capture.started`
 *   arrived) or the record's status is `capturing`; either may arrive first.
 * - `canStart` — not ended, status `ready`, not capturing.
 * - `canStop` — not ended, capturing.
 *
 * @param state The store (or any object with the same four members).
 * @param sessionId The session to ask about; defaults to the active session.
 *   A session other than the active one has no record in the store, so only
 *   its end can be known.
 * @returns A frozen availability; never throws.
 */
export function captureAvailabilityOf(
  state: CaptureAvailabilityState,
  sessionId: string | undefined = state.activeSessionId,
): CaptureAvailability {
  if (sessionId === undefined || sessionId === '') {
    return NO_SESSION_AVAILABILITY;
  }
  const record = state.activeSessionId === sessionId ? state.activeSession : undefined;
  const status = record?.status;
  if (status === 'ended' || state.hasAcknowledgedEnd(sessionId)) {
    return Object.freeze({ canStart: false, canStop: false, ended: true, status });
  }
  if (record === undefined) {
    return NO_SESSION_AVAILABILITY;
  }
  const capturing = state.captureState.active || status === 'capturing';
  return Object.freeze({
    canStart: status === 'ready' && !capturing,
    canStop: capturing,
    ended: false,
    status,
  });
}

// ---------------------------------------------------------------------------
// Context-key binding
// ---------------------------------------------------------------------------

/** What {@link bindCaptureContextKeys} reads and subscribes to. */
export type CaptureContextBindingState = CaptureAvailabilityState &
  Pick<ExtensionState, 'onDidChange'>;

/**
 * Writes one context key. In production this is
 * `(key, value) => vscode.commands.executeCommand('setContext', key, value)`;
 * a returned thenable is observed so a rejected write is logged, never left
 * unhandled.
 */
export type CaptureContextSetter = (key: CaptureContextKey, value: boolean) => unknown;

/** Whether `value` is a thenable whose rejection must be observed. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

/**
 * Keeps {@link CAPTURE_CAN_START_CONTEXT_KEY} and
 * {@link CAPTURE_CAN_STOP_CONTEXT_KEY} equal to the active session's
 * {@link captureAvailabilityOf}, so the commands' `enablement` clauses grey the
 * view-title actions whenever the service would refuse them.
 *
 * Evaluates once when called and again on every `state.onDidChange` (one per
 * coalesced burst of store mutations). It remembers the value last written to
 * each key — initially VS Code's unset value, `false` — and calls `setContext`
 * only when a key's value changes, so binding while nothing is capturable
 * writes nothing at all.
 *
 * A write that throws or rejects is logged by error code and the key's value
 * is then treated as unknown, so the next evaluation writes it again; a newer
 * write that already superseded the failed one is left alone. Nothing here
 * throws into the store's change event.
 *
 * @param state The store.
 * @param setContext Writes one context key.
 * @param logger Receives one `warn` per failed write; optional.
 * @returns A disposable that unsubscribes and resets every key that may be
 *   `true` back to `false`, so no title action stays enabled after the
 *   binding ends. Idempotent.
 */
export function bindCaptureContextKeys(
  state: CaptureContextBindingState,
  setContext: CaptureContextSetter,
  logger?: Logger,
): { dispose(): void } {
  /** The value last written per key; `undefined` after a failed write. */
  const written = new Map<CaptureContextKey, boolean | undefined>(
    CAPTURE_CONTEXT_KEYS.map((key) => [key, UNSET_CONTEXT_VALUE]),
  );
  /** A per-key counter, so a late failure never forgets a newer write. */
  const generations = new Map<CaptureContextKey, number>(
    CAPTURE_CONTEXT_KEYS.map((key) => [key, 0]),
  );
  let disposed = false;

  const reportFailure = (key: CaptureContextKey, generation: number, error: unknown): void => {
    if (generations.get(key) === generation) {
      written.set(key, undefined);
    }
    logger?.warn('Capture context key could not be set', {
      contextKey: key,
      code: DebuggenError.from(error).code,
    });
  };

  const write = (key: CaptureContextKey, value: boolean): void => {
    if (written.get(key) === value) {
      return;
    }
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    written.set(key, value);
    try {
      const result = setContext(key, value);
      if (isThenable(result)) {
        Promise.resolve(result).then(undefined, (error: unknown) => {
          reportFailure(key, generation, error);
        });
      }
    } catch (error) {
      reportFailure(key, generation, error);
    }
  };

  const evaluate = (): void => {
    if (disposed) {
      return;
    }
    const availability = captureAvailabilityOf(state);
    write(CAPTURE_CAN_START_CONTEXT_KEY, availability.canStart);
    write(CAPTURE_CAN_STOP_CONTEXT_KEY, availability.canStop);
  };

  evaluate();
  const subscription = state.onDidChange(() => {
    evaluate();
  });

  return {
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      subscription.dispose();
      for (const key of CAPTURE_CONTEXT_KEYS) {
        if (written.get(key) !== UNSET_CONTEXT_VALUE) {
          write(key, UNSET_CONTEXT_VALUE);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * The code of every refusal the capture routes answer when the session's state
 * does not allow the step: a second start of the session's own capture, a
 * stop with no capture running, a start outside `ready`, a session that ended.
 * The ownership conflict of AAP §0.4.2 is a different code
 * (`CAPTURE_ALREADY_ACTIVE`, with `details.owningSessionId`).
 */
const STATE_REFUSAL_CODE = 'SESSION_INVALID_STATE' satisfies DebuggenErrorCode;

/**
 * Whether `error` is the service refusing a capture step because of the
 * session's state — the one failure {@link captureRefusalNotice} explains.
 *
 * @param error The typed failure of `capture.start` or `capture.stop`.
 */
export function isCaptureStateRefusal(error: DebuggenError): boolean {
  return error.code === STATE_REFUSAL_CODE;
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** The next step once a session has ended, shared by both ended notices. */
const NEW_SESSION_DETAIL =
  'Ask a new question in the Debug Generator view to start another session.';

/** The ended-session notice of each command. */
const ENDED_NOTICES: Readonly<Record<CaptureCommandKind, CommandNotice>> = Object.freeze({
  start: Object.freeze({
    level: 'info',
    message: 'This session has ended, so it cannot capture again.',
    detail: NEW_SESSION_DETAIL,
  }),
  stop: Object.freeze({
    level: 'info',
    message: 'This session has ended; its capture is already closed.',
    detail: NEW_SESSION_DETAIL,
  }),
});

/** A refusal notice: always a warning, with the next step as its detail. */
function refusal(message: string, detail: string): CommandNotice {
  return Object.freeze({ level: 'warning', message, detail });
}

/*
 * The next steps shared by both commands. Each follows the session lifecycle
 * the webview's capture card describes, in the same product vocabulary.
 */

/** Before the session is armed. */
const INSTRUMENTATION_PENDING_DETAIL = 'Capture opens once instrumentation is ready.';

/** While the capture is analyzed. */
const ANALYSIS_PENDING_DETAIL = 'The result appears in the Debug Generator view when it is ready.';

/** Once a result exists (AAP §0.4.2: a new-capture follow-up re-arms the session). */
const FOLLOW_UP_DETAIL = 'Ask a follow-up question; if it needs new evidence, capture opens again.';

/** Once a stage has failed (AAP §0.5.5 retry surface). */
const FAILED_DETAIL = 'Retry the failed stage from the Debug Generator view, or end the session.';

/** For a session that is no longer the active one. */
const NO_ACTIVE_SESSION_DETAIL = 'Ask a question in the Debug Generator view to start a session.';

/** `capture.start` refused while the session already captures. */
const CAPTURE_RUNNING = refusal(
  'A capture is already running.',
  'Stop it to analyze what it recorded.',
);

/** `capture.stop` refused while the host still showed a running capture. */
const CAPTURE_ALREADY_STOPPED = refusal(
  'This capture has already stopped.',
  'The Debug Generator view updates when the local service reports what it recorded.',
);

/** `capture.start` refused for a session that is no longer in view. */
const START_WITHOUT_SESSION = refusal(
  'This session is no longer active, so no capture was started.',
  NO_ACTIVE_SESSION_DETAIL,
);

/** `capture.stop` refused for a session that is no longer in view. */
const STOP_WITHOUT_SESSION = refusal(
  'This session is no longer active, so there is no capture to stop.',
  NO_ACTIVE_SESSION_DETAIL,
);

/**
 * The refusal of `capture.start` for a session in `status` that is not
 * capturing. Exhaustive over {@link SessionStatus}.
 */
function startRefusalFor(status: SessionStatus): CommandNotice {
  switch (status) {
    case 'created':
    case 'understanding':
    case 'investigating':
    case 'planning':
    case 'instrumenting':
      return refusal('Capture is not available yet.', INSTRUMENTATION_PENDING_DETAIL);
    case 'ready':
      // The host showed an armed session; the service's state had already moved on.
      return refusal(
        "The local service did not start a capture in the session's current state.",
        "Wait for the Debug Generator view to show the session's latest step, then start the capture again if it is still offered.",
      );
    case 'capturing':
      return CAPTURE_RUNNING;
    case 'analyzing':
      return refusal(
        'Capture is not available while the last capture is analyzed.',
        ANALYSIS_PENDING_DETAIL,
      );
    case 'generated':
      return refusal(
        'Capture is not available while the session shows a generated result.',
        FOLLOW_UP_DETAIL,
      );
    case 'ended':
      return ENDED_NOTICES.start;
    case 'failed':
      return refusal('Capture is not available because the session failed.', FAILED_DETAIL);
    default:
      return assertNever(status, 'Unhandled session status');
  }
}

/**
 * The refusal of `capture.stop` for a session in `status` that is not
 * capturing. Exhaustive over {@link SessionStatus}.
 */
function stopRefusalFor(status: SessionStatus): CommandNotice {
  switch (status) {
    case 'created':
    case 'understanding':
    case 'investigating':
    case 'planning':
    case 'instrumenting':
      return refusal('No capture is running for this session.', INSTRUMENTATION_PENDING_DETAIL);
    case 'ready':
      return refusal(
        'No capture is running for this session.',
        'Start a capture, reproduce the issue, then stop it.',
      );
    case 'capturing':
      return CAPTURE_ALREADY_STOPPED;
    case 'analyzing':
      return refusal(
        'No capture is running; the last one is being analyzed.',
        ANALYSIS_PENDING_DETAIL,
      );
    case 'generated':
      return refusal('No capture is running for this session.', FOLLOW_UP_DETAIL);
    case 'ended':
      return ENDED_NOTICES.stop;
    case 'failed':
      return refusal('No capture is running because the session failed.', FAILED_DETAIL);
    default:
      return assertNever(status, 'Unhandled session status');
  }
}

/**
 * The notice a capture command shows for a session the store knows has ended.
 * The command sends no request: an ended session is terminal in the store and
 * in the service's state machine, so the service could only refuse it.
 *
 * @param kind Which command is asking.
 * @returns An informational notice with the next step as its detail.
 */
export function endedSessionNotice(kind: CaptureCommandKind): CommandNotice {
  return ENDED_NOTICES[kind];
}

/**
 * The notice a capture command shows when the service refused the step with
 * `SESSION_INVALID_STATE` ({@link isCaptureStateRefusal}), worded from the
 * session's availability as the store reads it once the refusal arrived.
 *
 * Precedence: an ended session gets {@link endedSessionNotice}; a session no
 * longer in view says so; a running capture (start) or a capture the host
 * still showed as running (stop) is named as such; otherwise the session's
 * status chooses the headline and the next step.
 *
 * @param kind Which command was refused.
 * @param availability {@link captureAvailabilityOf} for the refused session.
 * @returns One notice — a warning, or the informational ended notice.
 */
export function captureRefusalNotice(
  kind: CaptureCommandKind,
  availability: CaptureAvailability,
): CommandNotice {
  if (availability.ended) {
    return endedSessionNotice(kind);
  }
  const { status } = availability;
  if (status === undefined) {
    return kind === 'start' ? START_WITHOUT_SESSION : STOP_WITHOUT_SESSION;
  }
  if (availability.canStop) {
    return kind === 'start' ? CAPTURE_RUNNING : CAPTURE_ALREADY_STOPPED;
  }
  return kind === 'start' ? startRefusalFor(status) : stopRefusalFor(status);
}
