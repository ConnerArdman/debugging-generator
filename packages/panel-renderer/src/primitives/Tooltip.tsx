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
 * These describe the default, UNCONTROLLED tooltip. A tooltip whose owner holds it open (`open`,
 * below) hands the first and third clauses to that owner; the second (subject to
 * `describesTrigger`) and the fourth hold either way.
 *
 *   - Hover AND keyboard focus. `onPointerEnter` opens after `openDelayMs`; React's `onFocus`
 *     (which bubbles, unlike the native `focus` event, so a focusable trigger anywhere inside is
 *     covered) opens immediately, because a reader who has tabbed to the trigger has already
 *     committed and a delay only reads as lag. Closing is symmetric - `onPointerLeave` and
 *     `onBlur` - and either one cancels a pending open.
 *   - `aria-describedby`. The trigger is cloned with the bubble's id MERGED into whatever
 *     description it already carried, never replacing it; see `mergeDescription` below. The
 *     bubble is mounted for the component's whole life, so the attribute never names an element
 *     that is not there, open or closed. The one exception is `describesTrigger={false}`, below,
 *     where the sentence is already the accessible name of the trigger's container.
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
 * ## Inside a DataTable: `tabIndex={-1}`, reached by the grid's arrow keys
 *
 * A trigger rendered in a `DataTable` cell, in an expanded detail row or in a column header is
 * `tabIndex={-1}`, never `0`. The grid is ONE Tab stop, its active row, and its arrow keys move
 * focus onto the controls inside a row (see ./DataTable); a trigger left at `0` adds a
 * Tab stop to every rendered row, which is the tab sequence the grid pattern exists to prevent.
 * The trigger's own element decides its tab index - this component never sets one - so the
 * caller passes `tabIndex={-1}` on the child it wraps.
 *
 * Opening on ANY focus, rather than only on keyboard-originated focus, is what makes that work:
 * the description opens the moment an arrow key lands on the trigger, exactly as it would on a
 * Tab. Escape then composes with the grid in two presses. The first, while the bubble is open, is
 * consumed here (`preventDefault` and `stopPropagation`), so the grid never sees it and focus stays
 * on the trigger; the second finds nothing of ours to dismiss, is left alone, and the grid answers
 * it by returning focus to the row.
 *
 * ## Why the bubble is always mounted, and hidden while it is closed
 *
 * Two guarantees pull in opposite directions. `aria-describedby` must RESOLVE whenever an
 * assistive technology reads the trigger's description, and the bubble's size must be measurable
 * the moment it opens (see the placement section below): both want the bubble mounted for the
 * component's whole life with its `id` and `role="tooltip"` fixed. But a generated panel carries a
 * description on nearly every cell, bar and header - well over a hundred on a dense panel - and a
 * closed bubble that stayed in the accessibility tree would be read out, out of context, by a
 * screen reader walking the page, and found by every query that looks for a tooltip.
 *
 * Both hold because a closed bubble carries the `hidden` attribute (and the `dg-visually-hidden`
 * utility from ../styles/base.css): it is out of rendering and out of the accessibility tree, so
 * at rest a panel exposes no tooltip at all, yet it is still in the DOM, so the trigger's
 * `aria-describedby` names an element that exists. A description target referenced directly by
 * `aria-describedby` contributes its text even while hidden, so the trigger is described whether
 * or not a bubble is being shown. Open, the bubble drops `hidden` and takes `dg-is-open` plus the
 * placement variant; only the attribute and the class list ever change.
 *
 * ## Controlled: a description its owner holds open (`open`, `describesTrigger`)
 *
 * Some triggers must never be focusable. A truncated label inside a tree row or a grid row is not a
 * Tab stop of its own, because the row is (see ../components/Waterfall, ../components/Timeline and
 * ../components/FlameChart), so its description cannot be opened by focusing the trigger. Those
 * views reveal the same sentence while the ROW holds keyboard focus instead, and they do it through
 * this primitive rather than by writing the bubble's markup themselves: an open bubble is
 * `position: fixed`, so it is only ever next to its trigger because `positionBubble` measured it,
 * and a bubble this file did not place is painted at the viewport's origin.
 *
 * `open`, when defined, decides visibility ALONE. Hover and focus do not open the bubble, leave
 * and blur do not close it, `disabled` is not consulted, and neither Escape layer exists: the owner
 * holds the state and answers Escape itself, because only the owner knows what the key dismisses
 * and when it must be left for a dialog above. Placement is the uncontrolled path's, unchanged -
 * the same layout effect measures the bubble before it is painted and again on every scroll and
 * resize while it stays open. `open={undefined}` hands the bubble back to hover and focus, and
 * every switch between the two modes starts the primitive's own state afresh - closed, nothing
 * pending, nothing suppressed - so a hover that ended while the owner was in control, unheard,
 * never reopens a bubble behind it.
 *
 * `describesTrigger={false}` is for a trigger whose container already carries the sentence as its
 * accessible name (a treeitem's `aria-label`), where a description as well would make a reader
 * hear it twice: the bubble is `aria-hidden` and the trigger's own `aria-describedby`, if any, is
 * passed through untouched. The bubble keeps its `role="tooltip"`, mounted and hidden while closed
 * exactly as above, so a trigger still has exactly one bubble whichever mode it is in.
 *
 * ## Non-interactive content only
 *
 * `content` may be text, a number, a formatted value or an inert element. It may not contain a
 * button, a link, a field or anything else focusable: focus never moves into the bubble, so a
 * control in there is unreachable from the keyboard and absent from the focus order. A surface
 * that needs interactive content in an overlay needs a popover - a different pattern, with its own
 * focus management - and this package does not provide one in v1.
 *
 * ## No portal, no positioning library - but measured, fixed placement
 *
 * The bubble renders inside the panel's own DOM ("positioned within the panel", AAP 0.6.2), which
 * keeps it inside the theme root the layout shell establishes, so it inherits the active
 * `data-theme` token set with no extra wiring; a portal to the document body would leave that root
 * and need a second theme carrier to get it back. It also keeps the bubble a descendant of its
 * trigger's wrapper, which is what lets a surface find the description of one row inside that row.
 * The package's dependency set is fixed by AAP 0.3.2 and contains no positioning library.
 *
 * Staying in place used to mean staying CLIPPED: the bubble was absolutely positioned inside its
 * wrapper, so every `overflow` between the trigger and the panel - a table cell, a table's scroll
 * viewport, the shell's own scroll area - cut it off, and the description of the first row of a
 * table was drawn under that table's header. An open bubble is therefore `position: fixed`, which
 * lays it out against the browser viewport and outside every scroll container, while leaving it
 * exactly where it is in the DOM and in the theme cascade. A fixed box needs coordinates, and those
 * are the one thing this file computes (`positionBubble`, below): the trigger's rect, the bubble's
 * size and the viewport's size, measured in a layout effect before the bubble is painted and again
 * on every scroll and resize while it stays open. From them it takes the requested side, flips to
 * the opposite side when the requested one would leave the viewport and the opposite one would
 * not, and clamps the result inside the viewport.
 *
 * This is a deliberate, documented departure from the v1 rule "no measured coordinates, no inline
 * style" that this file was first written against, and it is kept as narrow as the problem: the
 * coordinates are two UNITLESS `--dgc-*` numbers written on the bubble's own style - the same
 * sanctioned channel `./DataTable` uses for its geometry, consumed by `../styles/components.css`
 * through the unit bridge - and nothing else is. No colour, length, gap or stacking value is
 * written here: the gap to the trigger is the placement variant's margin in the stylesheet, which
 * this file reads back rather than restates.
 *
 * ## The styling contract this file declares for ../styles/components.css
 *
 *   dg-tooltip               the wrapper: an inline box and the positioning context of the closed,
 *                            visually hidden bubble
 *   dg-tooltip__trigger      the trigger's inline box inside that wrapper, and the box measured
 *   dg-tooltip__bubble       the bubble: --dg-surface-overlay behind --dg-border-subtle,
 *                            --dg-text-primary, --dg-radius-md, --dg-shadow-2, the --dg-text-sm
 *                            type role, --dg-z-tooltip, and no pointer events of its own so it can
 *                            never take a pointer away from the trigger beneath it
 *   dg-tooltip--top          the four placement variants; on the open bubble each states the gap
 *   dg-tooltip--bottom       to the trigger as a signed start margin on its axis
 *   dg-tooltip--start        `start` and `end` are the logical sides, so a right-to-left panel
 *   dg-tooltip--end          needs no second rule
 *   dg-is-open               the open state, always written coupled to the bubble: `position:
 *                            fixed` at the published coordinates. A closed bubble carries the
 *                            `hidden` attribute (and `dg-visually-hidden`) instead
 *
 *   --dgc-tooltip-block      the open bubble's block-start offset from the viewport, UNITLESS
 *   --dgc-tooltip-inline     its inline-start offset from the viewport, UNITLESS; both consumed as
 *                            `calc(var(--dgc-tooltip-…, 0) * 1px)` and already corrected for the
 *                            placement margin, so the border box lands where it was computed
 *
 * A placement variant is written on the wrapper for the component's whole life and on the bubble
 * for as long as it is mounted, so an offset rule may hang off the wrapper or off the bubble -
 * whichever the stylesheet finds clearer - without either needing a class this file does not write.
 *
 * No colour, length, stacking value or motion is written here: the two coordinates above are the
 * whole of this file's style output. Transition timing comes from the `--dg-motion-*` design tokens
 * in ../tokens/tokens.ts, consumed by ../styles/components.css and switched off by the
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
  useLayoutEffect,
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
 * Which side of the trigger the bubble prefers. `start` and `end` are the logical sides, so one
 * value describes both writing directions. The side is a preference: a bubble that would leave the
 * browser viewport on it, and would not on the opposite side of the same axis, opens on the
 * opposite side instead, and a bubble is always kept inside the viewport.
 */
export type TooltipPlacement = 'top' | 'bottom' | 'start' | 'end';

/** The opposite side of the same axis, which a bubble flips to when its own side does not fit. */
const OPPOSITE_PLACEMENT: Record<TooltipPlacement, TooltipPlacement> = {
  top: 'bottom',
  bottom: 'top',
  start: 'end',
  end: 'start',
};

/**
 * A pixel value from a computed style, or zero when the value is not a number (`auto`, or the
 * empty string a DOM without layout returns).
 */
function readPixels(value: string): number {
  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

/** A coordinate rounded to a hundredth of a pixel, as the unitless string a `--dgc-*` value is. */
function formatCoordinate(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Where an open bubble goes, written onto it as `--dgc-tooltip-block` / `--dgc-tooltip-inline`.
 *
 * Every measurement is in viewport coordinates, which is what a `position: fixed` box is laid out
 * against. The inline axis is measured from the viewport's inline START - the left edge in a
 * left-to-right panel, the right edge in a right-to-left one - because the stylesheet consumes the
 * value as `inset-inline-start`.
 *
 *   1. The gap is the placement variant's start margin in the stylesheet, read back from the
 *      computed style: its magnitude is the gap, and the margin is subtracted again at the end so
 *      the BORDER box lands on the computed point whatever side the bubble ends up on.
 *   2. The requested side is tried first. When the bubble would cross the viewport edge on that
 *      side, and would fit on the opposite side of the same axis, it flips.
 *   3. The result is clamped so the whole bubble stays inside the viewport, the same gap away from
 *      its edge as from the trigger (a bubble larger than the viewport is pinned at that gap from
 *      its start edge).
 *
 * The cross axis aligns the bubble with the trigger's start edge (top and bottom) or its top edge
 * (start and end), which is where a reader's eye already is.
 *
 * @param bubble The open bubble element.
 * @param anchor The trigger's box inside the wrapper.
 * @param placement The requested side.
 */
function positionBubble(
  bubble: HTMLElement,
  anchor: HTMLElement,
  placement: TooltipPlacement,
): void {
  const view = bubble.ownerDocument.defaultView;

  if (view === null) {
    return;
  }

  const style = view.getComputedStyle(bubble);
  const rtl = style.direction === 'rtl';
  const marginBlock = readPixels(style.marginTop);
  const marginInline = readPixels(rtl ? style.marginRight : style.marginLeft);
  const vertical = placement === 'top' || placement === 'bottom';
  const gap = Math.abs(vertical ? marginBlock : marginInline);
  const viewportInline = bubble.ownerDocument.documentElement.clientWidth;
  const viewportBlock = bubble.ownerDocument.documentElement.clientHeight;
  const trigger = anchor.getBoundingClientRect();
  const size = bubble.getBoundingClientRect();
  const triggerStart = rtl ? viewportInline - trigger.right : trigger.left;
  const triggerEnd = rtl ? viewportInline - trigger.left : trigger.right;

  const blockFor = (side: TooltipPlacement): number => {
    if (side === 'top') {
      return trigger.top - gap - size.height;
    }
    return side === 'bottom' ? trigger.bottom + gap : trigger.top;
  };
  const inlineFor = (side: TooltipPlacement): number => {
    if (side === 'start') {
      return triggerStart - gap - size.width;
    }
    return side === 'end' ? triggerEnd + gap : triggerStart;
  };
  const fits = (side: TooltipPlacement): boolean =>
    vertical
      ? blockFor(side) >= 0 && blockFor(side) + size.height <= viewportBlock
      : inlineFor(side) >= 0 && inlineFor(side) + size.width <= viewportInline;

  const opposite = OPPOSITE_PLACEMENT[placement];
  const side = !fits(placement) && fits(opposite) ? opposite : placement;
  // The clamp keeps the same gap from the viewport's edge as from the trigger, so a bubble pushed
  // against a window edge never sits flush with it.
  const clamp = (value: number, extent: number, available: number): number =>
    Math.min(Math.max(value, gap), Math.max(available - extent - gap, gap));

  const block = clamp(blockFor(side), size.height, viewportBlock);
  const inline = clamp(inlineFor(side), size.width, viewportInline);

  bubble.style.setProperty('--dgc-tooltip-block', formatCoordinate(block - marginBlock));
  bubble.style.setProperty('--dgc-tooltip-inline', formatCoordinate(inline - marginInline));
}

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
   * Exactly one trigger element, which is cloned with a merged `aria-describedby` for the
   * component's whole life, open or closed (the bubble it names is always mounted). The prop type
   * is what makes reading the element's existing description type-safe, so no cast is needed to
   * merge it. Anything that is not a valid element is rendered through unchanged: a tooltip must
   * never be the reason a panel fails to render.
   *
   * The trigger's `tabIndex` is the caller's to set and is passed through untouched. Inside a
   * `DataTable` it is `-1`: the grid's arrow keys reach it, and focus opens the bubble (see this
   * module's header).
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
   * Never shows the bubble: it stays mounted and `hidden`, and the trigger keeps its
   * `aria-describedby`, so the description does not appear and disappear under a reader. Use it
   * for a tooltip that has nothing to show in this instance - a value already shown in full -
   * rather than swapping the whole element out, so the trigger keeps its identity (and its focus)
   * when the description becomes relevant. Turning it on while the bubble is open closes the
   * bubble on the next render. Governs the uncontrolled tooltip only: while `open` is defined,
   * `open` alone decides.
   */
  disabled?: boolean;

  /**
   * Puts the bubble under its owner's control. Left `undefined` (the default), hover and focus
   * open it and leave, blur and Escape close it. Defined, this value ALONE decides whether the
   * bubble is shown: no hover or focus opens it, nothing closes it, `disabled` is ignored and no
   * Escape handler is installed - the owner answers Escape. A controlled open bubble is measured
   * and placed exactly as an uncontrolled one is, before it is painted and on every scroll and
   * resize. Switching between the two modes resets the primitive's own state, so the uncontrolled
   * mode always resumes closed. See this module's header. `undefined` is accepted explicitly, so
   * an owner that controls the bubble only some of the time writes `open={held ? true : undefined}`.
   */
  open?: boolean | undefined;

  /**
   * Whether the bubble is the trigger's accessible description. Defaults to `true`: the bubble's
   * id is merged into the trigger's `aria-describedby`. `false` is for a trigger whose container
   * already carries the same sentence as its accessible name, so a reader does not hear it twice:
   * the bubble is `aria-hidden` and the trigger is rendered with its own props untouched.
   */
  describesTrigger?: boolean;

  /**
   * Id for the bubble, and therefore the value merged into the trigger's `aria-describedby` for
   * the component's whole life. Defaults to a generated one; pass it only when something outside
   * this component has to name the bubble.
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
 * on keyboard focus, closes on leave, blur or Escape, and is in the accessibility tree exactly
 * while it is shown (closed, its bubble stays mounted but `hidden`, so the description resolves).
 * Given `open`, its owner decides instead (see this module's header).
 *
 * @example
 * ```tsx
 * <Tooltip content="Time from the first event of the trace to the last.">
 *   <button type="button">Total</button>
 * </Tooltip>
 *
 * // Held open by the row that owns the label while that row has keyboard focus, and back to
 * // hover otherwise; the row's own name already carries the sentence.
 * <Tooltip
 *   content={description}
 *   open={rowRevealed ? true : undefined}
 *   describesTrigger={!rowRevealed}
 *   placement="bottom"
 * >
 *   <Text truncate>{label}</Text>
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
    open: controlledOpen,
    describesTrigger = true,
    id,
    className,
  } = props;

  const generatedId = useId();
  const tooltipId = id ?? generatedId;

  /** Whether the owner decides visibility (`open` defined) rather than hover and focus. */
  const controlled = controlledOpen !== undefined;

  /** The uncontrolled mode's own open state; never consulted while `controlled`. */
  const [open, setOpen] = useState(false);

  // Every switch between the two modes discards the uncontrolled state, so returning to hover and
  // focus always starts closed: a pointer that left while the owner was in control was never heard
  // (the handlers are not attached then), and a bubble it had opened must not reappear. Adjusted
  // during render - the documented pattern for state derived from a changed prop - so the switch
  // and the reset land in the same commit, with no frame showing a stale bubble.
  const [modeControlled, setModeControlled] = useState(controlled);
  if (modeControlled !== controlled) {
    setModeControlled(controlled);
    setOpen(false);
  }

  /**
   * The pending hover open. `ReturnType<typeof setTimeout>` rather than `number` because this
   * package is type-checked with the Node typings visible (one colocated test reads a file), and
   * the two environments disagree on what a timer handle is.
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * Set by Escape, cleared by pointer leave, by blur and by a switch between the controlled and
   * uncontrolled modes. A ref rather than state: it changes nothing on screen by itself, and a
   * render per keystroke would be a render the panel's charts pay for.
   */
  const suppressedRef = useRef(false);

  /** The trigger's box, which the open bubble is placed against. */
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  /** The bubble itself, the one element this file writes coordinates onto. */
  const bubbleRef = useRef<HTMLSpanElement | null>(null);

  // `disabled` is applied here rather than in each handler's result, so flipping it while the
  // bubble is open hides the bubble on the next render instead of stranding it. A defined `open`
  // overrides both: the owner alone decides.
  const isOpen = controlledOpen ?? (open && !disabled);

  // Placement of the open bubble, whoever opened it: hover, focus or a controlling owner all reach
  // the screen through this one path. A LAYOUT effect, so the coordinates are written after the
  // open class lands and before the browser paints: the bubble is never seen at the viewport
  // origin it occupies for that instant. It is re-placed on every scroll - in the capture phase on
  // the window, so a scroll of ANY container between the trigger and the page is heard, since
  // scroll events do not bubble - and on every resize, for as long as it stays open; `content`
  // re-runs it because a new description is a new size. Closing removes the coordinates with the
  // listeners.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const anchor = anchorRef.current;

    if (!isOpen || bubble === null || anchor === null) {
      return undefined;
    }

    const place = () => {
      positionBubble(bubble, anchor, placement);
    };

    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);

    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      bubble.style.removeProperty('--dgc-tooltip-block');
      bubble.style.removeProperty('--dgc-tooltip-inline');
    };
  }, [content, isOpen, placement]);

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

  // The non-state half of the mode-switch reset above: a hover open still pending when the owner
  // takes control is cancelled, and a suppression armed by an earlier Escape is cleared, since the
  // leave or blur that would have cleared it goes unheard while the owner is in control. A LAYOUT
  // effect, so a pending timer cannot fire between the switch's commit and this cancellation.
  useLayoutEffect(() => {
    cancelPendingOpen();
    suppressedRef.current = false;
  }, [cancelPendingOpen, controlled]);

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
  // on one press. Never installed for a controlled bubble: its owner answers Escape.
  useEffect(() => {
    if (!isOpen || controlled) {
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
  }, [controlled, isOpen]);

  // Described by the bubble for the component's whole life: the bubble is always mounted (hidden
  // while closed), so the reference always resolves. The trigger is the same element type in the
  // same position either way, so opening and closing never remount it or move its focus. With
  // `describesTrigger` off the trigger is passed through as the caller wrote it: the same element
  // in the same position, so switching the option never remounts it either.
  const trigger =
    describesTrigger && isValidElement(children)
      ? cloneElement(children, {
          'aria-describedby': mergeDescription(children.props['aria-describedby'], tooltipId),
        })
      : children;

  return (
    <span
      className={clsx('dg-tooltip', PLACEMENT_CLASS[placement], className)}
      // Hover, focus and Escape are the uncontrolled mode's; a controlled tooltip listens to none
      // of them, so the owner's own key handling sees every key its trigger's container receives.
      onPointerEnter={controlled ? undefined : handlePointerEnter}
      onPointerLeave={controlled ? undefined : handlePointerLeave}
      onFocus={controlled ? undefined : handleFocus}
      onBlur={controlled ? undefined : handleBlur}
      onKeyDown={controlled ? undefined : handleKeyDown}
    >
      <span className="dg-tooltip__trigger" ref={anchorRef}>
        {trigger}
      </span>
      {/* Always mounted, so the trigger's description always resolves; `hidden` while closed, so
          no closed bubble is in the accessibility tree or found by a role query. `aria-hidden`
          when it describes nothing, so a sentence the container already names is heard once. */}
      <span
        ref={bubbleRef}
        id={tooltipId}
        role="tooltip"
        aria-hidden={describesTrigger ? undefined : true}
        hidden={!isOpen}
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
