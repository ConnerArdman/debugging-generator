/**
 * CaptureControls - starts and stops the runtime capture from the "Debug Generator" VS Code view
 * (AAP 0.7.3).
 *
 * Once the plan is applied and the session is ready, the developer reproduces the issue inside a
 * capture window. This component offers the two actions of that window and shows whether it is
 * open. It decides nothing: `App.tsx` derives every prop from the host's `WebviewState` snapshot
 * and maps `onStart` / `onStop` onto the `startCapture` / `stopCapture` webview-to-host messages,
 * which the extension host turns into `POST /sessions/:id/capture/start` and `.../stop` (AAP
 * 0.4.2). What the indicator shows is therefore the session's real state as reported by
 * `capture.started` / `capture.stopped`, never an optimistic guess made here.
 *
 * ## No event counter - deliberately (AAP 0.4.2, 0.5.4)
 *
 * The DevTools panel's capture controls show a live event counter because that panel receives the
 * redacted `telemetry.tail` stream. The editor does not: the service routes `telemetry.tail` to
 * DevTools only, so any number shown here would be fabricated, which AAP 0.5.4 forbids. The view
 * therefore shows *that* a capture is running - a token-coloured indicator beside a text label -
 * and never *how much* has been captured. This component accepts no count, renders no digit, and
 * runs no timer, so nothing can be counted locally either.
 *
 * ## The states, in precedence order (AAP 0.5.5)
 *
 *   error        `ErrorState`, which owns `role="alert"`, rendering the caller's message verbatim
 *                (for example the service's "No telemetry was captured..." recovery copy, or the
 *                capture already held by another session) with a "Capture again" control when
 *                `onRetry` is supplied. No diagnosis is composed here.
 *   pending      `LoadingState`, which owns `role="status"` and `aria-busy`, REPLACING the
 *                controls while a start or stop request is in flight - so neither action can be
 *                raised twice before the host reports the outcome.
 *   unavailable  `EmptyState` explaining that capture opens once instrumentation is ready (neither
 *                action is possible and no capture is running). An enabled-looking control that
 *                could not do anything is never rendered.
 *   controls     the "Start capture" and "Stop capture" buttons, the capture state region and,
 *                while the session is armed but not yet capturing, the "Reproduce the issue now."
 *                prompt.
 *
 * ## Accessibility
 *
 * The state region carries `role="status"` with `aria-live="polite"`, so the transition into and
 * out of capturing is announced, and it always holds a text label beside the indicator dot -
 * colour never carries the meaning alone (the dot is `aria-hidden`). Both buttons reference that
 * region through `aria-describedby`, so the reason a control is disabled ("Capturing", "Not
 * capturing") is conveyed in text. The two controls are distinct actions rather than one toggle,
 * so neither carries `aria-pressed`: a pressed "Start capture" would announce a toggle whose name
 * never changes while its meaning does. Native `disabled` is passed straight through `Button`.
 *
 * Because the pending state replaces the controls, the button a keyboard user just activated
 * leaves the document and focus falls back to the body. The component remembers which action it
 * raised and, once the host reports the outcome and the complementary control is enabled, moves
 * focus onto it ("Start capture" leads to "Stop capture" and back). It does so only when focus was
 * released - still on the document body or on one of these two buttons - so it never pulls focus
 * away from wherever the developer has moved it since. An outcome shown as an error or as the
 * unavailable state drops the remembered action instead; `ErrorState` announces itself.
 *
 * ## Design system (AAP 0.6.4)
 *
 * Only `@debuggen/panel-renderer` primitives render content - `Button`, `Text`, `Stack`,
 * `EmptyState`, `LoadingState` and `ErrorState` - with no raw form control, heading or inline
 * style. The `dgv-capture`, `dgv-capture__state`, `dgv-capture__indicator`,
 * `dgv-capture__indicator--capturing` and `dgv-capture__placeholder` blocks of `../styles.css`
 * resolve to `--dg-*` tokens only; the indicator is a static dot there, because the token set has
 * no motion family and so no pulse is declared at all. The placeholder block is what lets the
 * error, busy and unavailable states fill the row of controls they replace - it is passed through
 * each primitive's `className` slot and overrides none of their own styles. Nothing is written to the console, and every string on screen is generic
 * product copy (AAP 0.5.4, 0.5.2).
 */
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import { useEffect, useId, useRef } from 'react';
import type { ReactElement } from 'react';

/**
 * Props of {@link CaptureControls}.
 *
 * Every optional member spells `| undefined` because `exactOptionalPropertyTypes` is in force
 * repository-wide: `App.tsx` forwards values it may not have (`error={failure?.message}`), and
 * that must stay legal.
 */
export interface CaptureControlsProps {
  /** Whether a capture window is open now, as the host last reported it. */
  capturing: boolean;

  /** Whether "Start capture" may be raised now. `App.tsx` decides this from the session status. */
  canStart: boolean;

  /** Whether "Stop capture" may be raised now. `App.tsx` decides this from the session status. */
  canStop: boolean;

  /** Raised, with no arguments, when "Start capture" is activated. Maps onto `startCapture`. */
  onStart: () => void;

  /** Raised, with no arguments, when "Stop capture" is activated. Maps onto `stopCapture`. */
  onStop: () => void;

  /**
   * Whether the session is armed - instrumentation is in place and the developer should reproduce
   * the issue. While it is `true` and no capture is running, the arming prompt is shown.
   */
  armed?: boolean | undefined;

  /** A start or stop request is in flight. Replaces the controls with a busy placeholder. */
  pending?: boolean | undefined;

  /**
   * Why the last capture request failed or yielded nothing, as the host reported it. A non-blank
   * value takes precedence over every other state and is rendered verbatim.
   */
  error?: string | undefined;

  /** Recovers from the reported error. The "Capture again" control renders only when supplied. */
  onRetry?: (() => void) | undefined;

  /** Extra classes composed after the `dgv-capture` block, for the layout `App.tsx` owns. */
  className?: string | undefined;
}

/** The block class every state renders on its root, so `App.tsx` places each state alike. */
const ROOT_CLASS = 'dgv-capture';

/** The capture state region: the indicator dot and its text label. */
const STATE_CLASS = 'dgv-capture__state';

/**
 * Carried by the error, busy and unavailable placeholders so each fills the row of controls it
 * replaces; without it the busy skeleton collapses inside the wrapping `dgv-capture` row.
 */
const PLACEHOLDER_CLASS = 'dgv-capture__placeholder';

/** The indicator dot at rest - a neutral token colour. */
const INDICATOR_CLASS = 'dgv-capture__indicator';

/** Added to the indicator while a capture is running - the danger ("recording") token colour. */
const INDICATOR_CAPTURING_CLASS = 'dgv-capture__indicator--capturing';

/** The start control's label, which is also its accessible name. */
const START_LABEL = 'Start capture';

/** The stop control's label, which is also its accessible name. */
const STOP_LABEL = 'Stop capture';

/** The state label while a capture window is open. */
const CAPTURING_LABEL = 'Capturing';

/** The state label while the session is armed and waiting for the capture to start. */
const ARMED_LABEL = 'Ready to capture';

/** The state label while no capture is running and the session is not armed. */
const IDLE_LABEL = 'Not capturing';

/**
 * The arming prompt (AAP 0.7.3). Product copy about the pipeline state; `ProgressSteps` shows the
 * same sentence as the progress list's call to action.
 */
const ARMED_PROMPT = 'Reproduce the issue now.';

/** The copy of the unavailable state - generic product vocabulary only (AAP 0.5.4). */
const UNAVAILABLE_MESSAGE = 'Capture becomes available once instrumentation is ready.';

/** Announced, not painted, while a request is in flight; `LoadingState` appends the `…`. */
const PENDING_LABEL = 'Updating the capture';

/** One skeleton bar: the silhouette of the single row of controls it stands in for. */
const PENDING_ROWS = 1;

/** The first line of the error state, replacing `ErrorState`'s generic view-loading title. */
const ERROR_TITLE = 'Capture needs attention';

/** The retry control's label - the "Capture again" affordance of AAP 0.5.5. */
const RETRY_LABEL = 'Capture again';

/** Which of the four states the props select, in precedence order. */
type CaptureView = 'error' | 'pending' | 'unavailable' | 'controls';

/**
 * The control that should receive focus once the outcome of an activated action arrives: after
 * "Start capture" the next action is "Stop capture", and the other way round.
 */
type FocusTarget = 'start' | 'stop';

/**
 * Whether a string carries anything other than whitespace.
 *
 * @param value The string to check.
 * @returns `true` for a non-blank string.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Compose the root class list without `clsx`, which is not a dependency of this workspace.
 *
 * @param className The caller's extra classes, if any.
 * @returns `dgv-capture`, followed by the caller's classes when they are not blank.
 */
function composeRootClassName(className: string | undefined): string {
  const extra = className?.trim() ?? '';
  return extra.length === 0 ? ROOT_CLASS : `${ROOT_CLASS} ${extra}`;
}

/**
 * Select the state to render, applying the precedence error > pending > unavailable > controls.
 *
 * A running capture always shows the controls, even when neither action is currently permitted,
 * so the developer can still see that the capture window is open.
 *
 * @param props See {@link CaptureControlsProps}.
 * @returns The state to render.
 */
function resolveView(props: CaptureControlsProps): CaptureView {
  if (hasText(props.error)) {
    return 'error';
  }
  if (props.pending === true) {
    return 'pending';
  }
  if (!props.canStart && !props.canStop && !props.capturing) {
    return 'unavailable';
  }
  return 'controls';
}

/**
 * The text label of the capture state region.
 *
 * @param capturing Whether a capture window is open.
 * @param armed Whether the session is armed.
 * @returns The label that accompanies the indicator dot.
 */
function stateLabel(capturing: boolean, armed: boolean): string {
  if (capturing) {
    return CAPTURING_LABEL;
  }
  return armed ? ARMED_LABEL : IDLE_LABEL;
}

/**
 * Renders the capture controls in whichever of their four states the props select.
 *
 * @param props See {@link CaptureControlsProps}.
 * @returns The `dgv-capture` block holding the error, busy, unavailable or controls state.
 */
export function CaptureControls(props: CaptureControlsProps): ReactElement {
  const {
    capturing,
    canStart,
    canStop,
    onStart,
    onStop,
    armed = false,
    error,
    onRetry,
    className,
  } = props;

  const view = resolveView(props);

  // Declared before any branch, as hooks must be, so they survive the switch between states.
  const stateId = useId();
  const startRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  // The control to focus once the outcome of the action raised from here arrives; see the module
  // header. `null` when this component raised nothing that is still awaiting an outcome.
  const focusTargetRef = useRef<FocusTarget | null>(null);

  // Runs after every commit on purpose: the outcome arrives as new props from the host at an
  // unknown later render, and there is nothing to subscribe to or clean up.
  useEffect(() => {
    const target = focusTargetRef.current;
    if (target === null || view === 'pending') {
      // Nothing awaited, or the request is still in flight.
      return;
    }
    if (view !== 'controls') {
      // The outcome is an error or the unavailable state: there is no control to hand focus to.
      focusTargetRef.current = null;
      return;
    }
    const button = target === 'stop' ? stopRef.current : startRef.current;
    if (button === null || button.disabled) {
      // The host has not reported the outcome yet; keep waiting for it.
      return;
    }
    focusTargetRef.current = null;
    const active = button.ownerDocument.activeElement;
    const focusReleased =
      active === null ||
      active === button.ownerDocument.body ||
      active === startRef.current ||
      active === stopRef.current;
    if (focusReleased) {
      button.focus();
    }
  });

  const rootClassName = composeRootClassName(className);

  if (view === 'error') {
    return (
      <div className={rootClassName}>
        <ErrorState
          className={PLACEHOLDER_CLASS}
          title={ERROR_TITLE}
          message={error ?? ''}
          onRetry={onRetry}
          retryLabel={RETRY_LABEL}
        />
      </div>
    );
  }

  if (view === 'pending') {
    return (
      <div className={rootClassName}>
        <LoadingState
          className={PLACEHOLDER_CLASS}
          variant="rows"
          rows={PENDING_ROWS}
          label={PENDING_LABEL}
        />
      </div>
    );
  }

  if (view === 'unavailable') {
    return (
      <div className={rootClassName}>
        <EmptyState className={PLACEHOLDER_CLASS} message={UNAVAILABLE_MESSAGE} />
      </div>
    );
  }

  const handleStart = (): void => {
    focusTargetRef.current = 'stop';
    onStart();
  };

  const handleStop = (): void => {
    focusTargetRef.current = 'start';
    onStop();
  };

  const indicatorClassName = capturing
    ? `${INDICATOR_CLASS} ${INDICATOR_CAPTURING_CLASS}`
    : INDICATOR_CLASS;
  const showPrompt = armed && !capturing;

  return (
    <div className={rootClassName}>
      <Stack direction="horizontal" gap={2} align="center" wrap>
        <Button
          ref={startRef}
          variant="primary"
          disabled={!canStart}
          aria-describedby={stateId}
          onClick={handleStart}
        >
          {START_LABEL}
        </Button>
        <Button
          ref={stopRef}
          variant="secondary"
          disabled={!canStop}
          aria-describedby={stateId}
          onClick={handleStop}
        >
          {STOP_LABEL}
        </Button>
      </Stack>
      <Text
        as="div"
        size="sm"
        tone="secondary"
        id={stateId}
        role="status"
        aria-live="polite"
        className={STATE_CLASS}
      >
        <span className={indicatorClassName} aria-hidden="true" />
        {stateLabel(capturing, armed)}
      </Text>
      {showPrompt ? (
        <Text as="p" size="sm" weight="medium">
          {ARMED_PROMPT}
        </Text>
      ) : null}
    </div>
  );
}
