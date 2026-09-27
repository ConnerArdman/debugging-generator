/**
 * `CaptureControls` — "Start capture / Stop capture" and the live event counter in the header of
 * the "Debug Generator" DevTools panel (AAP 0.7.3).
 *
 * Once a session's instrumentation is ready, the developer reproduces the issue inside a capture
 * window. This component offers the one action of that window that applies next and counts the
 * events the window has received. It holds no session state of its own: the composition root
 * reads the session status and the store's capture slice and passes them in, and binds the two
 * callbacks to the service worker's `capture.start` / `capture.stop` port requests (AAP 0.4.2).
 * What the control shows is therefore the session's real state, as the relayed `session.updated`,
 * `capture.started` and `capture.stopped` pushes report it — never an optimistic guess made here.
 *
 * ## The one guarantee: never ask for a forbidden transition
 *
 * The service's session state machine is the authority on transitions. Its table lets a session
 * enter `capturing` only from `ready` and leave it only by stopping, so this component keeps an
 * exhaustive capability table over every `SessionStatus` ({@link CAPTURE_CAPABILITY}) and asks for
 * a start only from `ready` and for a stop only from `capturing`. The table is keyed by the status
 * union itself, so a status added to the protocol is a compile error here rather than a silently
 * enabled control. The guarantee is enforced twice:
 *
 * - the control is marked unavailable (`aria-disabled`) with the reason in a `Tooltip`, and
 * - the click handler re-checks the table and returns without calling back when the transition is
 *   not permitted — an attribute alone would not stop a scripted or synthetic click.
 *
 * Two races are closed as well. A second activation while a request is in flight is refused both
 * by rendered state and by a synchronous guard, so a fast double click cannot send two starts.
 * And because the port response and the status push travel separate channels, a request that
 * resolved keeps the control waiting until the status or the capture id actually moves on; the
 * wait is bounded by {@link CONFIRMATION_GRACE_MS}, so a lost push can never leave a stuck
 * control — once the grace period passes the control is usable again and the service rejects
 * anything stale.
 *
 * ## One action slot: "Start capture / Stop capture"
 *
 * Starting and stopping are never both applicable, so the header shows the one that applies next
 * in a single slot: "Start capture" (the surface's main action, `primary`) in every status except
 * `capturing`, where it becomes "Stop capture" (`secondary`; stopping keeps the evidence, so it is
 * not a destructive `danger` action). The slot is one `Button` element whose label, variant and
 * action change in place, so the button a keyboard user just activated keeps focus when the
 * session moves from `ready` to `capturing` and back — no focus is lost to the document body.
 * The two actions are distinct, so the button never carries `aria-pressed`.
 *
 * ## States, in precedence order (disabled > loading > default)
 *
 *   explicit    `disabledReason` supplied by the composition root (no paired service, no bound
 *               tab, …): unavailable with that sentence as the reason.
 *   no session  no session status yet: unavailable, capture needs an active session.
 *   pending     a request this component raised is in flight or awaiting confirmation: the label
 *               becomes "Starting capture…" / "Stopping capture…" (the visible busy cue),
 *               unavailable with a waiting reason and `aria-busy`. A `busy` reported by the
 *               caller is the same state with the plain label and a generic waiting reason.
 *   status      the capability table decides; an unavailable action shows the table's reason.
 *
 * A capture that yields nothing returns the session to `ready` (AAP 0.5.5), so "Start capture"
 * becomes usable again with no special case. A failed request is never presented as success and
 * never swallowed: a callback that throws or rejects clears the pending state and `aria-busy` at
 * once, leaves the control operable for a retry, and hands the failure to the required
 * `onActionError` reporter with the action that failed. Nothing is re-raised — a rethrow from the
 * click handler or from the detached promise's rejection handler would reach no caller and
 * surface only as an uncaught error or an unhandled rejection. The composition root owns error
 * presentation (for example a capture already held by another session), so no competing error
 * block is rendered here. Should the reporter itself throw, that failure goes to the platform's
 * root reporter, `globalThis.reportError`, and the promise chain still ends handled.
 *
 * ## The live event counter
 *
 * While a capture id is present — the running capture's, or the last one's after it stopped — the
 * event count is shown beside the control through `Text` with tabular figures, so the row does
 * not jitter as the number climbs, and always with a visible unit word ("1 event", "1,204 events",
 * "0 events captured" after an empty capture). The counter is a labelled `group` stating what it
 * counts, and it is current on every render. The count arrives as a prop from the store's capture
 * slice, which the connection layer keeps at the service's count of the capture's **stored**
 * events — the per-capture tallies each `telemetry.tail` frame carries, and the summary's
 * `coverage.storedEvents` once `capture.stopped` arrives — so the number is what the capture holds,
 * not how many events the live tail happened to stream. Nothing is polled or counted here.
 *
 * ## The progress announcement
 *
 * The visible counter is deliberately NOT a live region: it can change many times per second and
 * would flood a screen reader. The capture's transitions reach assistive technology through a
 * second, visually hidden element instead — a polite, atomic `role="status"` region that is always
 * mounted (so it exists before its first sentence arrives). It never states the running count:
 * the visible counter is the panel's one running number, and a sampled second number would always
 * disagree with it.
 *
 *   capture starts       at once       "Capture running."
 *   capture stops        at once       "Capture stopped. 1,204 events captured."
 *   total corrected      at once       "1,206 events captured." (after a stop it announced)
 *   capture id cleared   at once       the sentence is cleared, so nothing stale remains
 *
 * "At once" is a zero-delay timer, so changes made in one task collapse into one sentence composed
 * from the latest count, and a superseded number is never spoken. A stopped capture's total moves
 * only when the service's stored count arrives after a stop the panel saw first, so the correction
 * cannot flood. A capture this component only ever saw stopped — a panel opened on a finished
 * session — is never announced, and a switch to such a capture clears the previous capture's
 * sentence. The schedule lives in {@link CaptureAnnouncer}; the region's text is React state set
 * only from its timer callback.
 *
 * ## Accessibility
 *
 * - An unavailable control stays focusable: it carries `aria-disabled="true"` and a guarded
 *   handler instead of the native `disabled` attribute, because a natively disabled button leaves
 *   the tab order, so the focus events the `Tooltip` needs never arrive and a keyboard user could
 *   never reach the reason. The reason reaches assistive technology through the `aria-describedby`
 *   the `Tooltip` merges onto the button, and appears on hover or focus.
 * - An available control carries no description: the `Tooltip` is disabled and describes nothing,
 *   so the button's name is heard without a stale reason.
 * - The bubble is placed below the control, because the header sits at the top edge of the panel.
 * - Every state is carried by text — the button's label and the counter's words — never by colour.
 * - The focus ring is the renderer's token ring on `:focus-visible`.
 * - Capture progress is announced politely, never assertively, and never moves focus: the
 *   `role="status"` region carries `aria-live="polite"` and `aria-atomic="true"` explicitly, so
 *   its one sentence is read whole and waits for the screen reader to finish speaking. The region
 *   is out of the visual flow and adds nothing a sighted reader sees; the visible counter keeps
 *   its `group` label and is not announced a second time.
 *
 * ## Design-system compliance (AAP 0.6.2, 0.6.4)
 *
 * Every visual value resolves through a renderer component — `Stack`, `Tooltip`, `Button` and
 * `Text` — and therefore through the `--dg-*` tokens behind them. This file writes no inline
 * style, no length, no colour and no class name of its own. The announcement region composes the
 * renderer's global `dg-visually-hidden` utility (`base.css`), exactly as `Header` and
 * `TargetPicker` do; it is absolutely positioned, so it takes no gap in the row.
 *
 * The renderer draws its disabled treatment for the native `disabled` attribute or `Button`'s
 * `dg-is-disabled` state class, never for `aria-disabled` alone, so an unavailable control
 * composes `dg-is-disabled` beside `aria-disabled`: it looks unavailable and stays focusable.
 *
 * ## Boundaries
 *
 * No transport of any kind, no store writes and no `chrome.*` API: the callbacks are the only way
 * out, and the component renders unchanged when the panel document is opened directly as an
 * extension page with `chrome.devtools` undefined. It renders no landmark and no status badge —
 * the header owns both. The copy is generic product vocabulary and names nothing from any
 * inspected application (AAP 0.5.4).
 *
 * @module apps/chrome-extension/src/panel/components/CaptureControls
 */
import { Button, Stack, Text, Tooltip } from '@debuggen/panel-renderer';
import type { SessionStatus } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** The label of the control that opens a capture window. */
const START_CAPTURE_LABEL = 'Start capture';

/** The label of the control that closes the running capture window. */
const STOP_CAPTURE_LABEL = 'Stop capture';

/** The shared second sentence of every pre-capture reason. */
const AVAILABLE_ONCE_READY = 'Capture becomes available once instrumentation is ready.';

/** The reason shown when the panel has no session status to act on. */
const NO_SESSION_REASON = 'Capture needs an active debugging session.';

/** The label while a start this component requested awaits its outcome — the visible busy cue. */
const STARTING_LABEL = 'Starting capture…';

/** The label while a stop this component requested awaits its outcome — the visible busy cue. */
const STOPPING_LABEL = 'Stopping capture…';

/** The reason shown while a start this component requested awaits its outcome. */
const STARTING_REASON = 'Waiting for the service to confirm that the capture has started.';

/** The reason shown while a stop this component requested awaits its outcome. */
const STOPPING_REASON = 'Waiting for the service to confirm that the capture has stopped.';

/** The reason shown while the caller reports a capture request in flight. */
const BUSY_REASON = 'Waiting for the current capture request to finish…';

/** The counter's accessible label while a capture is running. */
const LIVE_COUNTER_LABEL = 'Events received during the running capture';

/** The counter's accessible label once the capture it counts has stopped. */
const LAST_COUNTER_LABEL = 'Events received by the last capture';

/** The lead of the sentence announced when a capture starts running. */
const CAPTURE_RUNNING_LEAD = 'Capture running.';

/** The lead of the sentence announced when the running capture stops. */
const CAPTURE_STOPPED_LEAD = 'Capture stopped.';

/**
 * The developer-facing message of the aggregate raised when the platform's own error reporter
 * throws while reporting a failure of the capture controls' error reporter.
 */
const PLATFORM_REPORTER_FAILED =
  'The platform error reporter failed while reporting a capture control error.';

/**
 * The renderer's global utility in `base.css` that keeps text in the accessibility tree while
 * painting nothing. Out of flow, so the announcement region takes no gap in the row.
 */
const VISUALLY_HIDDEN_CLASS = 'dg-visually-hidden';

// ---------------------------------------------------------------------------
// Behaviour constants
// ---------------------------------------------------------------------------

/**
 * The delay of every announcement (start, stop, corrected total, clear). Zero, but still a timer:
 * the region's text is state, and state is set only from timer callbacks — never synchronously in
 * an effect — which also guarantees the always-mounted region exists before its first sentence
 * arrives, and collapses changes made within one task into one sentence.
 */
const PROMPT_ANNOUNCE_DELAY_MS = 0;

/**
 * How long, in milliseconds, a request that resolved keeps the control waiting for the status or
 * capture id to move on. The port response and the relayed status push travel separate channels
 * and normally arrive within milliseconds of each other on the loopback interface; the bound only
 * exists so a push that never arrives cannot leave the control stuck.
 */
const CONFIRMATION_GRACE_MS = 5_000;

/** Whole-number formatting with the viewer's locale grouping, for the event counter. */
const EVENT_COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// The capability table
// ---------------------------------------------------------------------------

/**
 * What a session in one status permits this component to ask for.
 *
 * `reason` explains the action(s) that are NOT permitted in that status. It is required rather than
 * optional: every status has at least one unavailable action, so a status added without a reason
 * would ship an unavailable control with no explanation.
 */
interface CaptureCapability {
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly reason: string;
}

/**
 * The exhaustive capability table, one row per `SessionStatus`.
 *
 * It mirrors, and never widens, the service's transition table: `capturing` is entered only from
 * `ready` and left only by a stop, so `canStart` is true for `ready` alone and `canStop` for
 * `capturing` alone. A generated session captures again only after a follow-up has re-planned it
 * back to `ready`; an ended session never captures; a failed session is retried first. The
 * `satisfies` clause makes a missing or misspelled status a compile error.
 */
const CAPTURE_CAPABILITY: Readonly<Record<SessionStatus, CaptureCapability>> = Object.freeze({
  created: {
    canStart: false,
    canStop: false,
    reason: `The session is starting. ${AVAILABLE_ONCE_READY}`,
  },
  understanding: {
    canStart: false,
    canStop: false,
    reason: `Understanding the question. ${AVAILABLE_ONCE_READY}`,
  },
  investigating: {
    canStart: false,
    canStop: false,
    reason: `Investigating the code. ${AVAILABLE_ONCE_READY}`,
  },
  planning: {
    canStart: false,
    canStop: false,
    reason: `Planning instrumentation. ${AVAILABLE_ONCE_READY}`,
  },
  instrumenting: {
    canStart: false,
    canStop: false,
    reason: `Preparing instrumentation… ${AVAILABLE_ONCE_READY}`,
  },
  ready: {
    canStart: true,
    canStop: false,
    reason: 'No capture is running.',
  },
  capturing: {
    canStart: false,
    canStop: true,
    reason: 'A capture is already running.',
  },
  analyzing: {
    canStart: false,
    canStop: false,
    reason: 'Analysis in progress. Wait for the panel to be generated.',
  },
  generated: {
    canStart: false,
    canStop: false,
    reason: 'The panel is generated. Ask a follow-up in VS Code to capture again.',
  },
  ended: {
    canStart: false,
    canStop: false,
    reason: 'This session has ended. Start a new session in VS Code to capture again.',
  },
  failed: {
    canStart: false,
    canStop: false,
    reason: 'The session failed. Retry it before capturing again.',
  },
} satisfies Record<SessionStatus, CaptureCapability>);

/** The capability of "no session": nothing may be asked for. */
const NO_SESSION_CAPABILITY: CaptureCapability = Object.freeze({
  canStart: false,
  canStop: false,
  reason: NO_SESSION_REASON,
});

/**
 * The capability row for a status, with an absent status handled explicitly.
 *
 * The own-property check also covers a status string from a newer service than this extension,
 * which the type cannot express: such a status permits nothing rather than crashing the header.
 */
function capabilityFor(status: SessionStatus | undefined): CaptureCapability {
  if (status === undefined || !Object.hasOwn(CAPTURE_CAPABILITY, status)) {
    return NO_SESSION_CAPABILITY;
  }
  return CAPTURE_CAPABILITY[status];
}

/** Whether `status` permits asking for `action`, straight from the capability table. */
function isPermitted(action: CaptureAction, status: SessionStatus | undefined): boolean {
  const capability = capabilityFor(status);
  return action === 'start' ? capability.canStart : capability.canStop;
}

// ---------------------------------------------------------------------------
// Request tracking and slot resolution
// ---------------------------------------------------------------------------

/**
 * The two requests this component can raise. Exported because {@link CaptureControlsProps}'
 * `onActionError` names the action whose request failed.
 */
export type CaptureAction = 'start' | 'stop';

/**
 * A request this component raised, from activation until the session visibly moves on.
 *
 * `in-flight` lasts until the callback's promise settles. `awaiting-confirmation` follows a
 * successful settle (or a callback that returned no promise) and lasts until the session status or
 * capture id differs from the values recorded at activation, or the grace period passes.
 */
interface CaptureRequest {
  readonly action: CaptureAction;
  readonly phase: 'in-flight' | 'awaiting-confirmation';
  readonly fromStatus: SessionStatus;
  readonly fromCaptureId: string | undefined;
}

/** Everything the action slot renders, resolved from the props and the tracked request. */
interface CaptureSlot {
  readonly action: CaptureAction;
  readonly label: string;
  readonly variant: 'primary' | 'secondary';
  /** Whether activating the slot asks for its action. */
  readonly available: boolean;
  /** The sentence explaining an unavailable slot; `undefined` exactly when `available`. */
  readonly reason: string | undefined;
  /** Whether a capture request is pending, which `aria-busy` reports. */
  readonly busy: boolean;
}

/**
 * The tracked request that still holds the control, or `undefined`.
 *
 * An in-flight request always holds it. An awaiting request holds it only while the session is
 * exactly where it was at activation; once the status or the capture id moves on, the outcome has
 * arrived and the request is spent, whether or not the grace timer has cleared it yet.
 */
function holdingRequest(
  request: CaptureRequest | undefined,
  status: SessionStatus | undefined,
  captureId: string | undefined,
): CaptureRequest | undefined {
  if (request === undefined || request.phase === 'in-flight') {
    return request;
  }
  return request.fromStatus === status && request.fromCaptureId === captureId ? request : undefined;
}

/** A supplied reason with surrounding whitespace removed; blank or absent is `undefined`. */
function explicitReason(disabledReason: string | undefined): string | undefined {
  const trimmed = disabledReason?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Resolves the action slot, in the documented precedence: explicit reason, no session, pending,
 * then the capability table.
 */
function resolveSlot(
  status: SessionStatus | undefined,
  request: CaptureRequest | undefined,
  busy: boolean,
  disabledReason: string | undefined,
): CaptureSlot {
  const capability = capabilityFor(status);
  // A pending request keeps its own action until it is spent, and its label becomes the progress
  // wording ("Starting capture…"): the visible busy cue, carried by text rather than by a colour
  // the renderer does not have for this state. Otherwise the slot shows the action that applies
  // next. A `busy` reported by the caller keeps the plain label: which action it concerns is not
  // known here.
  const action: CaptureAction = request?.action ?? (capability.canStop ? 'stop' : 'start');
  const pending = request !== undefined || busy;
  const idleLabel = action === 'start' ? START_CAPTURE_LABEL : STOP_CAPTURE_LABEL;
  const progressLabel = action === 'start' ? STARTING_LABEL : STOPPING_LABEL;
  const base = {
    action,
    label: request === undefined ? idleLabel : progressLabel,
    variant: action === 'start' ? 'primary' : 'secondary',
    busy: pending,
  } as const;

  const unavailable = (reason: string): CaptureSlot => ({ ...base, available: false, reason });

  const explicit = explicitReason(disabledReason);
  if (explicit !== undefined) {
    return unavailable(explicit);
  }
  if (status === undefined) {
    return unavailable(NO_SESSION_REASON);
  }
  if (request !== undefined) {
    return unavailable(request.action === 'start' ? STARTING_REASON : STOPPING_REASON);
  }
  if (busy) {
    return unavailable(BUSY_REASON);
  }
  return isPermitted(action, status)
    ? { ...base, available: true, reason: undefined }
    : unavailable(capability.reason);
}

/** Whether a callback's return value is a promise-like that settles later. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

/**
 * Hands a failure no reporter of the caller's could take to the platform's root error reporter.
 *
 * `globalThis.reportError` reports an error to the global `error` event and the console exactly
 * as an uncaught exception would, without unwinding any caller. Every Chrome this extension
 * supports has it (the manifest's minimum version is far past its introduction). A host without
 * it gets the failure rethrown on a fresh task instead ({@link throwOnFreshTask}), and a
 * non-conforming `reportError` that throws gets both errors delivered that way together, so
 * neither is dropped.
 *
 * @param failure What the caller's reporter threw.
 */
function reportToPlatform(failure: unknown): void {
  const platformReporter: unknown = Reflect.get(globalThis, 'reportError');
  if (typeof platformReporter !== 'function') {
    throwOnFreshTask(failure);
    return;
  }
  try {
    Reflect.apply(platformReporter, globalThis, [failure]);
  } catch (platformFailure: unknown) {
    throwOnFreshTask(new AggregateError([failure, platformFailure], PLATFORM_REPORTER_FAILED));
  }
}

/**
 * Rethrows `failure` from a timer callback: the idiom that predates `reportError` and reaches the
 * same global error handler. Being outside every promise chain and every caller's stack, it can
 * neither unwind the click that caused it nor surface as an unhandled rejection.
 */
function throwOnFreshTask(failure: unknown): void {
  setTimeout(() => {
    throw failure;
  }, 0);
}

/**
 * Delivers a failed capture request to the caller's reporter, and ends there: nothing is
 * re-raised. A reporter that throws is itself handed to {@link reportToPlatform}, so calling this
 * from a promise's rejection handler always settles that handler normally — the chain ends
 * handled whatever the reporter does.
 *
 * @param report The caller's {@link CaptureControlsProps.onActionError}.
 * @param error What the capture callback threw or rejected with, unchanged.
 * @param action The request that failed.
 */
function reportActionError(
  report: CaptureControlsProps['onActionError'],
  error: unknown,
  action: CaptureAction,
): void {
  try {
    report(error, action);
  } catch (reporterFailure: unknown) {
    reportToPlatform(reporterFailure);
  }
}

// ---------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------

/** A count safe to display: a non-negative whole number, never `NaN` or a fraction. */
function displayableCount(eventCount: number): number {
  return Number.isFinite(eventCount) && eventCount > 0 ? Math.floor(eventCount) : 0;
}

/**
 * The counter's visible text: the grouped number and its unit word, with "captured" appended
 * once the capture it counts has stopped, so a frozen number never reads as a live one.
 */
function counterText(eventCount: number, live: boolean): string {
  const count = displayableCount(eventCount);
  const unit = count === 1 ? 'event' : 'events';
  const formatted = `${EVENT_COUNT_FORMAT.format(count)} ${unit}`;
  return live ? formatted : `${formatted} captured`;
}

// ---------------------------------------------------------------------------
// The progress announcement
// ---------------------------------------------------------------------------

/**
 * The sentence announced when a capture starts: "Capture running." It states no count: the
 * visible counter is the one running number, and a count spoken here would be stale the moment
 * the next frame arrived — a second, different number beside it.
 */
function startSentence(): string {
  return CAPTURE_RUNNING_LEAD;
}

/** The sentence announced when the capture stops: "Capture stopped. 1,204 events captured." */
function stopSentence(count: number): string {
  return `${CAPTURE_STOPPED_LEAD} ${counterText(count, false)}.`;
}

/**
 * The sentence for a stopped capture's total corrected after its stop was announced — the
 * service's stored count arriving after a stop the panel saw first: "1,206 events captured."
 */
function totalSentence(count: number): string {
  return `${counterText(count, false)}.`;
}

/** The capture the announcer follows, as it was last observed. */
interface FollowedCapture {
  readonly captureId: string;
  /** Whether the capture was running at the last observation. */
  readonly live: boolean;
  /** Whether it was ever observed running; a capture seen only stopped is never announced. */
  readonly seenLive: boolean;
}

/**
 * An announcement: the capture started or stopped, a stopped capture's total was corrected, or
 * the sentence is cleared.
 */
type Announcement = 'start' | 'stop' | 'total' | 'clear';

/**
 * The schedule behind the progress announcement: it observes the capture on every change and
 * decides what the live region says, and when (the table in the module header).
 *
 * A plain object rather than more hooks, so the whole schedule and its timer are owned in one
 * place: the component creates it in a mount effect, feeds it from an effect keyed on the
 * capture, and disposes of it on unmount, which cancels the pending timer. `announce` is invoked
 * only from a timer callback, never synchronously from {@link CaptureAnnouncer.observe}, so the
 * component's state is never set in an effect body.
 *
 * Invariants:
 * - at most one timer is pending, and scheduling an announcement cancels it — the latest change
 *   supersedes whatever was about to be said;
 * - a running capture's climbing count is never spoken: the visible counter is the only running
 *   number, so the region can never state a different one;
 * - every sentence is composed when its timer fires, from the latest observed count, so a
 *   superseded number is never spoken.
 */
class CaptureAnnouncer {
  readonly #announce: (sentence: string) => void;

  #followed: FollowedCapture | undefined = undefined;

  /** The latest observed count of the followed capture. */
  #count = 0;

  /** The count the last stop or total sentence stated; `undefined` before one. */
  #spokenCount: number | undefined = undefined;

  #timer: ReturnType<typeof setTimeout> | undefined = undefined;

  /** @param announce Replaces the live region's sentence; `''` empties it. */
  constructor(announce: (sentence: string) => void) {
    this.#announce = announce;
  }

  /**
   * Records the capture as the component now renders it and schedules what the change warrants.
   *
   * @param captureId The running or last capture's id; `undefined` before the first capture.
   * @param live Whether the session is capturing.
   * @param count The capture's displayable event count.
   */
  observe(captureId: string | undefined, live: boolean, count: number): void {
    this.#count = count;
    const previous = this.#followed;

    if (captureId === undefined) {
      this.#followed = undefined;
      if (previous !== undefined) {
        this.#schedule('clear');
      }
      return;
    }

    if (previous?.captureId !== captureId) {
      // A capture seen for the first time is announced only when it is seen running. A switch to
      // one seen stopped clears what the region said about the previous capture.
      this.#followed = { captureId, live, seenLive: live };
      this.#spokenCount = undefined;
      if (live) {
        this.#schedule('start');
      } else if (previous !== undefined) {
        this.#schedule('clear');
      }
      return;
    }

    if (live !== previous.live) {
      // The same capture started or stopped; either way it has now been seen running.
      this.#followed = { captureId, live, seenLive: true };
      this.#schedule(live ? 'start' : 'stop');
      return;
    }

    // A stopped capture whose total moved after its stop sentence — the stored count arriving
    // after the stop — is stated again, so the region and the counter agree. A pending stop
    // sentence composes the latest count itself, so it is not superseded.
    if (!live && previous.seenLive && this.#timer === undefined && count !== this.#spokenCount) {
      this.#schedule('total');
    }
  }

  /** Cancels the pending announcement; the component calls it on unmount. */
  dispose(): void {
    this.#cancel();
  }

  /** Replaces anything pending with an announcement of `kind`. */
  #schedule(kind: Announcement): void {
    this.#cancel();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      switch (kind) {
        case 'clear':
          this.#spokenCount = undefined;
          this.#announce('');
          return;
        case 'start':
          this.#spokenCount = undefined;
          this.#announce(startSentence());
          return;
        case 'stop':
        case 'total': {
          const count = this.#count;
          this.#spokenCount = count;
          this.#announce(kind === 'stop' ? stopSentence(count) : totalSentence(count));
          return;
        }
        default:
          assertNever(kind, 'Unhandled capture announcement');
      }
    }, PROMPT_ANNOUNCE_DELAY_MS);
  }

  #cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * The progress announcement's current sentence, driven by a {@link CaptureAnnouncer} for the life
 * of the component.
 *
 * @param captureId The running or last capture's id.
 * @param live Whether the session is capturing.
 * @param count The capture's displayable event count.
 * @returns The sentence the live region holds; `''` when there is nothing to say.
 */
function useCaptureAnnouncement(
  captureId: string | undefined,
  live: boolean,
  count: number,
): string {
  const [announcement, setAnnouncement] = useState('');
  const announcerRef = useRef<CaptureAnnouncer | undefined>(undefined);

  // Declared before the observing effect, so the announcer exists when that effect first runs;
  // its cleanup cancels every pending timer on unmount. A remount (React's development
  // double-invocation included) starts a fresh announcer that the observing effect feeds again.
  useEffect(() => {
    const announcer = new CaptureAnnouncer(setAnnouncement);
    announcerRef.current = announcer;
    return () => {
      announcer.dispose();
      announcerRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    announcerRef.current?.observe(captureId, live, count);
  }, [captureId, live, count]);

  return announcement;
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

/**
 * Props of {@link CaptureControls}.
 *
 * Every optional member states `| undefined` explicitly because `exactOptionalPropertyTypes` is on
 * repository-wide and a caller forwarding a value it may not have must stay legal.
 */
export interface CaptureControlsProps {
  /** The bound session's status, or `undefined` while the panel has no session. */
  sessionStatus: SessionStatus | undefined;

  /**
   * The running capture's id, or the last capture's after it stopped; `undefined` before the
   * session's first capture. The counter is shown only while it is present.
   */
  captureId: string | undefined;

  /** Events received by the capture `captureId` names, from the store's capture slice. */
  eventCount: number;

  /**
   * Asks the service to open a capture window. Called only when the session is `ready`. A
   * returned promise holds the control busy until it settles. A synchronous throw or a rejection
   * releases the control at once and is handed to {@link CaptureControlsProps.onActionError}
   * with the action `'start'` — never re-raised and never swallowed.
   */
  onStartCapture: () => Promise<void> | void;

  /**
   * Asks the service to close the running capture window. Called only when the session is
   * `capturing`, with the same promise and failure handling as
   * {@link CaptureControlsProps.onStartCapture}; a failure is reported with the action `'stop'`.
   */
  onStopCapture: () => Promise<void> | void;

  /**
   * The root reporter of a failed capture request: receives, unchanged, whatever
   * `onStartCapture` or `onStopCapture` threw or rejected with, and the action that failed. It is
   * the only exit for that failure — this component re-raises nothing, because a rethrow from a
   * click handler or a detached promise reaches no caller — so it is required rather than
   * optional. The composition root routes it into the panel's non-blocking error notice.
   *
   * Called at most once per activation, after the control has been released for a retry. The
   * reporter current at activation receives that activation's failure, even if the component has
   * since re-rendered or unmounted. A reporter that itself throws is not re-raised either: its
   * error goes to the platform's root reporter, `globalThis.reportError`.
   *
   * @example
   * <CaptureControls
   *   // …
   *   onActionError={(error, action) => {
   *     presentFailure(action === 'start' ? 'Could not start the capture' : 'Could not stop it', error);
   *   }}
   * />
   */
  onActionError: (error: unknown, action: CaptureAction) => void;

  /**
   * True while the caller knows of a capture request this component did not raise. The control
   * is then unavailable and reports `aria-busy`.
   */
  busy?: boolean | undefined;

  /**
   * A sentence explaining why capture cannot be used at all right now — for example while the
   * panel is not connected to the service. When supplied (and not blank) the control is
   * unavailable and this sentence replaces the capability table's reason.
   */
  disabledReason?: string | undefined;

  /**
   * Extra classes for the outermost element, forwarded to the `Stack`. Composition only: any
   * class named here is a renderer class defined against the `--dg-*` tokens.
   */
  className?: string | undefined;
}

/**
 * Renders the capture action slot — "Start capture" or "Stop capture", with its unavailable
 * reason in a `Tooltip` — followed by the live event counter while a capture id is present, and
 * the always-mounted, visually hidden progress announcement.
 *
 * @param props The props documented on {@link CaptureControlsProps}.
 * @returns The horizontal row holding the control, the counter when applicable, and the
 *   announcement region.
 *
 * @example
 * // The composition root, with the store's capture slice and the port requests:
 * <CaptureControls
 *   sessionStatus={session?.status}
 *   captureId={capture.captureId}
 *   eventCount={capture.eventCount}
 *   onStartCapture={startCapture}
 *   onStopCapture={stopCapture}
 *   onActionError={reportCaptureFailure}
 * />
 */
export function CaptureControls(props: CaptureControlsProps): ReactElement {
  const {
    sessionStatus,
    captureId,
    eventCount,
    onStartCapture,
    onStopCapture,
    onActionError,
    busy = false,
    disabledReason,
    className,
  } = props;

  const [request, setRequest] = useState<CaptureRequest | undefined>(undefined);
  // Synchronous re-entry guard: set before a callback runs and cleared when it settles, so a
  // second activation dispatched before the pending render commits is refused as well.
  const inFlightRef = useRef(false);

  // Bound the wait for confirmation: an awaiting request that nothing has spent is released after
  // the grace period. The state update happens in the timer callback, never in the effect body.
  useEffect(() => {
    if (request === undefined || request.phase !== 'awaiting-confirmation') {
      return undefined;
    }
    const timer = setTimeout(() => {
      setRequest((current) => (current === request ? undefined : current));
    }, CONFIRMATION_GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [request]);

  const live = sessionStatus === 'capturing';
  // The transition sentence of the always-mounted live region (see "The progress announcement").
  const announcement = useCaptureAnnouncement(captureId, live, displayableCount(eventCount));

  const holding = holdingRequest(request, sessionStatus, captureId);
  const slot = resolveSlot(sessionStatus, holding, busy, disabledReason);

  const handleActivate = (): void => {
    // The guard the AAP asks for, independent of the rendered attribute: re-check everything the
    // slot was resolved from, then the capability table itself, and do nothing when not permitted.
    if (inFlightRef.current || !slot.available || sessionStatus === undefined) {
      return;
    }
    if (!isPermitted(slot.action, sessionStatus)) {
      return;
    }

    const pending: CaptureRequest = {
      action: slot.action,
      phase: 'in-flight',
      fromStatus: sessionStatus,
      fromCaptureId: captureId,
    };
    const action = slot.action;
    const callback = action === 'start' ? onStartCapture : onStopCapture;

    inFlightRef.current = true;
    let outcome: unknown;
    try {
      outcome = callback();
    } catch (error: unknown) {
      // A synchronous throw: nothing was requested, so nothing is held. The failure goes to the
      // explicit reporter and ends there — rethrown from a click handler it would reach no caller.
      inFlightRef.current = false;
      reportActionError(onActionError, error, action);
      return;
    }

    if (!isThenable(outcome)) {
      // A fire-and-forget request: hold the control until the session reports the outcome.
      inFlightRef.current = false;
      setRequest({ ...pending, phase: 'awaiting-confirmation' });
      return;
    }

    setRequest(pending);
    void Promise.resolve(outcome).then(
      () => {
        inFlightRef.current = false;
        setRequest((current) =>
          current === pending ? { ...pending, phase: 'awaiting-confirmation' } : current,
        );
      },
      (reason: unknown) => {
        // Never presented as success and never swallowed: release the control for a retry, clear
        // `aria-busy` (only while this request is still the tracked one), and hand the rejection
        // to the explicit reporter. Nothing is rethrown, so this chain always ends handled.
        inFlightRef.current = false;
        setRequest((current) => (current === pending ? undefined : current));
        reportActionError(onActionError, reason, action);
      },
    );
  };

  return (
    <Stack direction="horizontal" gap={2} align="center" wrap className={className}>
      <Tooltip
        content={slot.reason ?? ''}
        placement="bottom"
        disabled={slot.available}
        describesTrigger={!slot.available}
      >
        <Button
          variant={slot.variant}
          size="sm"
          aria-disabled={slot.available ? undefined : true}
          aria-busy={slot.busy ? true : undefined}
          // The design system's disabled treatment, coupled to the real
          // `aria-disabled` state: `Button`'s declared `dg-is-disabled` state
          // class (`.dg-button.dg-is-disabled`), so an unavailable control
          // never looks operable while staying focusable for its tooltip.
          className={slot.available ? undefined : 'dg-is-disabled'}
          onClick={handleActivate}
        >
          {slot.label}
        </Button>
      </Tooltip>
      {captureId !== undefined ? (
        <Text
          size="sm"
          tone="secondary"
          numeric
          role="group"
          aria-label={live ? LIVE_COUNTER_LABEL : LAST_COUNTER_LABEL}
        >
          {counterText(eventCount, live)}
        </Text>
      ) : null}
      {/* Always mounted, even before the first capture, so the region exists before its text
          changes; visually hidden and out of flow, so the row looks exactly as without it. */}
      <Text role="status" aria-live="polite" aria-atomic="true" className={VISUALLY_HIDDEN_CLASS}>
        {announcement}
      </Text>
    </Stack>
  );
}
