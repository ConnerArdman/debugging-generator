/*
 * Tooltip - the on-demand explanation of @debuggen/panel-renderer.
 *
 * A generated debugging panel is dense by design: names are truncated to fit a column, durations
 * are bare numbers, a redacted URL has lost its query values and a kind badge is two letters of
 * colour. Each of those wants a longer sentence available on demand, and none of them has room
 * for it, so this primitive is the one sanctioned way to attach that sentence - to a table cell, a
 * chart bar, a metric card, a graph node or a control in either consumer surface.
 *
 * ## The four accessibility clauses of AAP 0.6.2, and how each is met
 *
 *   - Hover AND keyboard focus. `onPointerEnter` opens after `openDelayMs`; React's `onFocus`
 *     (which bubbles, unlike the native `focus` event, so a focusable trigger anywhere inside is
 *     covered) opens immediately, because a reader who has tabbed to the trigger has already
 *     committed and a delay only reads as lag. Closing is symmetric - `onPointerLeave` and
 *     `onBlur` - and either one cancels a pending open.
 *   - `aria-describedby`. The trigger is cloned with the bubble's id MERGED into whatever
 *     description it already carried, never replacing it; see `mergeDescription` below.
 *   - Escape to dismiss, in two layers, because a key event only reaches an element that has
 *     focus. `onKeyDown` on the wrapper is the primary handler: it closes a bubble that is open
 *     (or about to open) whenever the trigger owns focus, and it is the ONLY place the key is
 *     consumed - and then only when this tooltip actually had something to dismiss, because a
 *     dialog, a picking mode or an editor shortcut above it needs Escape too and swallowing it
 *     unconditionally is how those break. A bubble opened by hover has focus somewhere else
 *     entirely, so a second, non-consuming `keydown` listener on the document is attached for
 *     exactly as long as that bubble is shown: without it the only way to dismiss a hovered
 *     description would be to move the pointer, which is what WCAG 1.4.13 forbids. It neither
 *     prevents the default nor stops propagation, and it never exists while the bubble is closed.
 *     The two cannot both fire for one key press: the wrapper's handler stops propagation before
 *     the event can reach the document.
 *
 *     Either way the close arms a suppression flag, so the bubble cannot spring straight back
 *     while the pointer still rests on the trigger or focus stays put; leaving the trigger or
 *     moving focus away clears it.
 *   - No focus trap. Nothing here calls a focus method, nothing sets a tab index, and focus never
 *     enters the bubble - which is also why the bubble may hold no interactive content.
 *
 * ## Why the bubble is always in the DOM
 *
 * The temptation is to render it only while open. That reads cleanly and silently breaks the one
 * guarantee this component exists for: `aria-describedby` must RESOLVE at the moment the trigger
 * receives focus, and an assistive technology reads the description then, whether or not a sighted
 * reader is being shown a bubble. Conditional rendering - like `display: none` or `aria-hidden` -
 * takes the element out of the accessibility tree and the description is simply gone. So the
 * bubble is mounted for the component's whole life with its `id` and `role="tooltip"` fixed, and
 * only its class list changes: the global `dg-visually-hidden` utility from ../styles/base.css
 * while closed, `dg-is-open` plus the placement variant while open.
 *
 * ## Non-interactive content only
 *
 * `content` may be text, a number, a formatted value or an inert element. It may not contain a
 * button, a link, a field or anything else focusable: focus never moves into the bubble, so a
 * control in there is unreachable from the keyboard and absent from the focus order. A surface
 * that needs interactive content in an overlay needs a popover - a different pattern, with its own
 * focus management - and this package does not provide one in v1.
 *
 * ## No portal, no positioning library
 *
 * The bubble renders inside the panel's own DOM ("positioned within the panel", AAP 0.6.2), which
 * keeps it inside the theme root the layout shell establishes, so it inherits the active
 * `data-theme` token set with no extra wiring; a portal to the document body would leave that root
 * and need a second theme carrier to get it back. The package's dependency set is fixed by AAP
 * 0.3.2 and contains no positioning library, so placement is CSS-only - one variant class per side
 * and no measured coordinates anywhere in this file. The accepted v1 limitation of that choice: a
 * bubble on a trigger close to the edge of a scroll container can be clipped, which a caller
 * answers with a `placement` pointing inward rather than this file answering it with geometry.
 *
 * ## The styling contract this file declares for ../styles/components.css
 *
 *   dg-tooltip               the wrapper: an inline box and the positioning context
 *   dg-tooltip__trigger      the trigger's inline box inside that wrapper
 *   dg-tooltip__bubble       the bubble: --dg-surface-overlay behind --dg-border-subtle,
 *                            --dg-text-primary, --dg-radius-md, --dg-shadow-2, the --dg-text-sm
 *                            type role, --dg-z-tooltip, and no pointer events of its own so it can
 *                            never take a pointer away from the trigger beneath it
 *   dg-tooltip--top          the four placement variants, each offsetting the bubble to one side
 *   dg-tooltip--bottom
 *   dg-tooltip--start        `start` and `end` are the logical sides, so a right-to-left panel
 *   dg-tooltip--end          needs no second rule
 *   dg-is-open               the open state, always written coupled to the bubble
 *
 * A placement variant is written on the wrapper for the component's whole life and echoed on the
 * bubble while it is open, so an offset rule may hang off the wrapper or off the bubble - whichever
 * the stylesheet finds clearer - without either needing a class this file does not write.
 *
 * Not one CSS value is written here - no coordinate, no stacking value, no colour, no inline style
 * at all - and no motion either: transition timing comes from the `--dg-motion-*` design tokens in
 * ../tokens/tokens.ts, consumed by ../styles/components.css and switched off by the
 * `prefers-reduced-motion` block in ../styles/base.css, and animating from TSX would escape that
 * block.
 */

import clsx from 'clsx';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
} from 'react';

/**
 * Which side of the trigger the bubble sits on. `start` and `end` are the logical sides, so one
 * value describes both writing directions. There is no automatic flipping: flipping needs
 * measurement, measurement needs a positioning library, and this package has none - a caller near
 * a container edge picks the side that points inward.
 */
export type TooltipPlacement = 'top' | 'bottom' | 'start' | 'end';

/**
 * Hover dwell before the bubble opens, in milliseconds. This is behaviour rather than appearance:
 * long enough that a pointer travelling across a dense table does not flash a bubble per cell,
 * short enough that a deliberate pause is answered promptly. Keyboard focus never waits.
 */
const DEFAULT_OPEN_DELAY_MS = 400;

/**
 * Placement to variant class, as a total map rather than an interpolated string. Interpolation
 * would put a class name in this file that no reader can grep for in ../styles/components.css, and
 * a map is what makes a new placement value a compile error here instead of a silently unstyled
 * bubble at runtime.
 */
const PLACEMENT_CLASS: Record<TooltipPlacement, string> = {
  top: 'dg-tooltip--top',
  bottom: 'dg-tooltip--bottom',
  start: 'dg-tooltip--start',
  end: 'dg-tooltip--end',
};

export interface TooltipProps {
  /**
   * The description. Text, a number, a formatted value or an inert element - never a button, a
   * link, a field or anything else focusable, because focus never enters the bubble.
   */
  content: ReactNode;

  /**
   * Exactly one trigger element, which is cloned with a merged `aria-describedby`. The prop type
   * is what makes reading the element's existing description type-safe, so no cast is needed to
   * merge it. Anything that is not a valid element is rendered through unchanged: a tooltip must
   * never be the reason a panel fails to render.
   */
  children: ReactElement<{ 'aria-describedby'?: string }>;

  /** Which side the bubble sits on. Defaults to `top`. */
  placement?: TooltipPlacement;

  /**
   * Hover dwell before the bubble opens, in milliseconds. Applies to pointer hover ONLY - keyboard
   * focus opens the bubble immediately. Defaults to {@link DEFAULT_OPEN_DELAY_MS}.
   */
  openDelayMs?: number;

  /**
   * Renders the trigger and keeps the description in the accessibility tree, but never shows the
   * bubble. Use it for a tooltip whose text is not available yet rather than swapping the whole
   * element out, so the trigger's `aria-describedby` does not appear and disappear under a reader.
   */
  disabled?: boolean;

  /**
   * Id for the bubble, and therefore the value merged into the trigger's `aria-describedby`.
   * Defaults to a generated one; pass it only when something outside this component has to name
   * the bubble.
   */
  id?: string;

  /** Extra class names for the wrapper. Never for the bubble: its classes are this file's state. */
  className?: string;
}

/**
 * The trigger's description after this tooltip has been added to it: its existing
 * `aria-describedby` tokens followed by the bubble's id, single-space joined, with the id added
 * only once. Returns a plain string - never `undefined` - so the cloned prop always satisfies
 * `exactOptionalPropertyTypes`.
 */
function mergeDescription(existing: string | undefined, tooltipId: string): string {
  const trimmed = existing === undefined ? '' : existing.trim();
  if (trimmed.length === 0) {
    return tooltipId;
  }
  return trimmed.split(/\s+/).includes(tooltipId) ? trimmed : `${trimmed} ${tooltipId}`;
}

/**
 * An accessible tooltip: a description that opens on hover after a short dwell, opens immediately
 * on keyboard focus, closes on leave, blur or Escape, and is readable by an assistive technology
 * whether or not it is on screen.
 *
 * @example
 * ```tsx
 * <Tooltip content="Time from the first event of the trace to the last.">
 *   <button type="button">Total</button>
 * </Tooltip>
 * ```
 */
export function Tooltip(props: TooltipProps): ReactElement {
  const {
    content,
    children,
    placement = 'top',
    openDelayMs = DEFAULT_OPEN_DELAY_MS,
    disabled = false,
    id,
    className,
  } = props;

  const generatedId = useId();
  const tooltipId = id ?? generatedId;

  const [open, setOpen] = useState(false);

  /**
   * The pending hover open. `ReturnType<typeof setTimeout>` rather than `number` because this
   * package is type-checked with the Node typings visible (one colocated test reads a file), and
   * the two environments disagree on what a timer handle is.
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * Set by Escape, cleared by pointer leave and by blur. A ref rather than state: it changes
   * nothing on screen by itself, and a render per keystroke would be a render the panel's charts
   * pay for.
   */
  const suppressedRef = useRef(false);

  // `disabled` is applied here rather than in each handler's result, so flipping it while the
  // bubble is open hides the bubble on the next render instead of stranding it.
  const isOpen = open && !disabled;

  const cancelPendingOpen = useCallback(() => {
    const pending = timerRef.current;
    if (pending !== undefined) {
      clearTimeout(pending);
      timerRef.current = undefined;
    }
  }, []);

  // Unmount cleanup, and nothing else: a timer that fires after unmount would set state on a gone
  // component - a warning in a consumer and a flake in a test.
  useEffect(() => cancelPendingOpen, [cancelPendingOpen]);

  const handlePointerEnter = useCallback(() => {
    if (disabled || suppressedRef.current) {
      return;
    }
    cancelPendingOpen();
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      setOpen(true);
    }, openDelayMs);
  }, [cancelPendingOpen, disabled, openDelayMs]);

  const handlePointerLeave = useCallback(() => {
    cancelPendingOpen();
    suppressedRef.current = false;
    setOpen(false);
  }, [cancelPendingOpen]);

  const handleFocus = useCallback(() => {
    if (disabled || suppressedRef.current) {
      return;
    }
    cancelPendingOpen();
    setOpen(true);
  }, [cancelPendingOpen, disabled]);

  const handleBlur = useCallback(
    (event: ReactFocusEvent<HTMLSpanElement>) => {
      // Focus moving between two focusable parts of one trigger is not a departure.
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) {
        return;
      }
      cancelPendingOpen();
      suppressedRef.current = false;
      setOpen(false);
    },
    [cancelPendingOpen],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== 'Escape') {
        return;
      }
      const hadPendingOpen = timerRef.current !== undefined;
      cancelPendingOpen();
      if (!isOpen && !hadPendingOpen) {
        // Nothing of ours was showing or on its way, so this Escape belongs to whatever is above.
        return;
      }
      suppressedRef.current = true;
      setOpen(false);
      if (isOpen) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [cancelPendingOpen, isOpen],
  );

  // The second Escape layer, and the reason a hovered description is dismissible at all: while the
  // bubble is shown, a key press goes to whatever holds focus - which, for a bubble opened by
  // hover, is not this trigger. The listener therefore lives on the document, exists only while
  // the bubble is shown, and consumes nothing: no `preventDefault`, no `stopPropagation`, so a
  // dialog or a picking mode that also answers Escape still sees the key. The handler above runs
  // first when the trigger does hold focus and stops propagation there, so the two never both act
  // on one press.
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      suppressedRef.current = true;
      setOpen(false);
    };
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
    };
  }, [isOpen]);

  const trigger = isValidElement(children)
    ? cloneElement(children, {
        'aria-describedby': mergeDescription(children.props['aria-describedby'], tooltipId),
      })
    : children;

  return (
    <span
      className={clsx('dg-tooltip', PLACEMENT_CLASS[placement], className)}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <span className="dg-tooltip__trigger">{trigger}</span>
      <span
        id={tooltipId}
        role="tooltip"
        className={clsx(
          'dg-tooltip__bubble',
          isOpen ? ['dg-is-open', PLACEMENT_CLASS[placement]] : 'dg-visually-hidden',
        )}
      >
        {content}
      </span>
    </span>
  );
}
