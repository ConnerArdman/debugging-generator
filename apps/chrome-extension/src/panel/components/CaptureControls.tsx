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
 * becomes usable again with no special case. A failed request is never presented as success: a
 * rejected callback clears the pending state and `aria-busy` at once, leaves the control operable
 * for a retry, and re-raises the rejection instead of swallowing it — the composition root owns
 * error presentation (for example a capture already held by another session), so no competing
 * error block is rendered here.
 *
 * ## The live event counter
 *
 * While a capture id is present — the running capture's, or the last one's after it stopped — the
 * event count is shown beside the control through `Text` with tabular figures, so the row does
 * not jitter as the number climbs, and always with a visible unit word ("1 event", "1,204 events",
 * "0 events captured" after an empty capture). The counter is a labelled `group` stating what it
 * counts. It is deliberately NOT a live region: it can change many times per second and would
 * flood a screen reader; the running state is announced through the control's own name instead.
 * The count arrives as a prop from the store's capture slice, which the connection layer updates
 * from the `telemetry.tail` and `capture.*` pushes — nothing is polled or counted here.
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
 *
 * ## Design-system compliance (AAP 0.6.2, 0.6.4)
 *
 * Every visual value resolves through a renderer component — `Stack`, `Tooltip`, `Button` and
 * `Text` — and therefore through the `--dg-*` tokens behind them. This file writes no inline
 * style, no length, no colour and no class name of its own.
 *
 * BLITZY [DESIGN_SYSTEM_GAP]: the renderer's single disabled treatment is keyed on the native
 * `disabled` attribute and the class `Button` adds for it; it has no treatment for
 * `aria-disabled`. An unavailable-but-focusable control therefore keeps its variant's appearance.
 * Per the design-system rules the look is not faked with a class or a variant swap, and the
 * renderer's internals are not overridden; the missing state is flagged here instead. The
 * unavailability is conveyed by `aria-disabled`, the tooltip reason, the progress label while a
 * request is pending, and the session status badge the header renders beside these controls.
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

// ---------------------------------------------------------------------------
// Behaviour constants
// ---------------------------------------------------------------------------

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

/** The two requests this component can raise. */
type CaptureAction = 'start' | 'stop';

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
   * returned promise holds the control busy until it settles; a rejection is re-raised, never
   * swallowed, so the composition root presents it.
   */
  onStartCapture: () => Promise<void> | void;

  /**
   * Asks the service to close the running capture window. Called only when the session is
   * `capturing`, with the same promise handling as {@link CaptureControlsProps.onStartCapture}.
   */
  onStopCapture: () => Promise<void> | void;

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
 * reason in a `Tooltip` — followed by the live event counter while a capture id is present.
 *
 * @param props The props documented on {@link CaptureControlsProps}.
 * @returns The horizontal row holding the control and, when applicable, the counter.
 *
 * @example
 * // The composition root, with the store's capture slice and the port requests:
 * <CaptureControls
 *   sessionStatus={session?.status}
 *   captureId={capture.captureId}
 *   eventCount={capture.eventCount}
 *   onStartCapture={startCapture}
 *   onStopCapture={stopCapture}
 * />
 */
export function CaptureControls(props: CaptureControlsProps): ReactElement {
  const {
    sessionStatus,
    captureId,
    eventCount,
    onStartCapture,
    onStopCapture,
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
    const callback = slot.action === 'start' ? onStartCapture : onStopCapture;

    inFlightRef.current = true;
    let outcome: unknown;
    try {
      outcome = callback();
    } catch (error) {
      // A synchronous throw is the caller's failure to present: nothing was requested, so nothing
      // is held, and the error continues to the caller's error handling unchanged.
      inFlightRef.current = false;
      throw error;
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
        // `aria-busy`, and re-raise the rejection for the composition root's error handling.
        inFlightRef.current = false;
        setRequest((current) => (current === pending ? undefined : current));
        throw reason;
      },
    );
  };

  const live = sessionStatus === 'capturing';

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
    </Stack>
  );
}
