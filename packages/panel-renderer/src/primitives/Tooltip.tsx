/*
 * Tooltip - the on-demand explanation of @debuggen/panel-renderer.
 *
 * A generated debugging panel is dense by design: names are truncated to fit a column, durations
 * are bare numbers, a redacted URL has lost its query values and a kind badge is two letters of
 * colour. Each of those wants a longer sentence available on demand, and none of them has room
 * for it, so this primitive is the one sanctioned way to attach that sentence - to a table cell, a
 * chart bar, a metric card, a graph node or a control in either consumer surface.
 *
 * ## The four accessibility guarantees, and how each is met
 *
 * These describe the default, UNCONTROLLED tooltip. A tooltip whose owner holds it open (`open`,
 * below) hands the first and third guarantees to that owner; the second (subject to
 * `describesTrigger`) and the fourth hold either way.
 *
 *   - Hover AND keyboard focus. `onPointerEnter` opens after `openDelayMs`; React's `onFocus`
 *     (which bubbles, unlike the native `focus` event, so a focusable trigger anywhere inside is
 *     covered) opens immediately, because a reader who has tabbed to the trigger has already
 *     committed and a delay only reads as lag. Closing is symmetric - `onPointerLeave` and
 *     `onBlur` - and either one cancels a pending open.
 *
 *     A bubble whose description overflows its bounded height - the one that has to be scrolled to
 *     be read - is HOVERABLE (WCAG 1.4.13): the pointer may leave the trigger for the bubble and
 *     stay there, to read it or scroll it with the wheel, without the bubble closing under it.
 *     Every other open bubble lets the pointer pass straight through it, because it already shows
 *     everything it says, and a bubble that took the pointer would sit over the neighbouring
 *     rows' triggers and chips of a dense table - keeping their own descriptions from opening and
 *     swallowing the clicks meant for them. Which kind a bubble is, is measured on every placement
 *     (see "A bounded bubble" below).
 *
 *     A hoverable bubble is a DOM descendant of the wrapper that listens for enter and leave, so a
 *     pointer resting on it is still "inside"; what needs care is the gap between the two, which
 *     belongs to neither. A pointer that leaves the trigger therefore closes the bubble at once
 *     UNLESS the bubble is hoverable and the pointer is inside the hover corridor - the convex
 *     hull of the trigger's box and the bubble's box, measured afresh on every move and every
 *     scroll - in which case the bubble stays open for exactly as long as the pointer stays inside
 *     that hull, and closes the moment it steps out of it, a scroll carries the hull away from it,
 *     or it leaves the window. The corridor is spatial rather than a timer on purpose: a pointer
 *     heading anywhere but the bubble closes it immediately, so sweeping across a dense table
 *     never leaves a trail of lingering bubbles. A touch pointer, a pointer leaving the document
 *     and a bubble with no rendered box (nothing a pointer could reach) all close at once.
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
 * ## A bounded bubble, and a click inside it
 *
 * A description can be far longer than a sentence - a whole parameterized statement, a redacted
 * URL with every key it carried - so the stylesheet caps the open bubble's block size and lets it
 * scroll. Every placement of an open bubble also measures whether its description overflows that
 * box, and writes the answer as the `data-dg-scrollable` attribute (`markScrollable`, below): the
 * stylesheet lets exactly the marked bubble take the pointer, and the hover guarantee above holds
 * exactly that bubble open, which is what lets a pointer reach its scroll. The mark is removed
 * whenever the bubble closes, and re-measured when the description changes.
 *
 * Because a marked bubble accepts the pointer, a click inside it would otherwise bubble up to
 * whatever row or chart the trigger sits in and select or expand it, although the reader clicked
 * a description rather than that row. The bubble therefore stops a click's propagation at its own
 * edge - a description is never an action - and it does so for `click` only: a press still moves
 * focus to the nearest focusable ancestor exactly as it would anywhere else, so the row that owns
 * the trigger keeps its roving tab stop. An unmarked bubble never receives a click at all: it
 * reaches the control beneath it.
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
 * placement variant (and, when it overflows, the measured `data-dg-scrollable` mark); only those
 * attributes and the class list ever change.
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
 * ## What the bubble shows is the logical text
 *
 * A description is routinely the untruncated form of untrusted text - a whole span name, a whole
 * statement, a redacted URL - and an invisible Unicode direction control in it (U+202E and its
 * eleven siblings) would draw the glyphs after it in an order that was never captured. Every string
 * in `content` is therefore rendered through `formatUntrustedNode` from `./untrusted-text` - the
 * one helper this primitive imports from its folder, a pure function over strings - which prints
 * each control as its visible escape (`\u202E`) and changes nothing else: the glyphs in the bubble
 * are the characters given, in the order given. Only the bubble's content is revealed. The trigger
 * is the caller's element and renders its own text (a `Text` or `Code` trigger reveals its own),
 * and the placement effect still keys on `content` as given.
 *
 * ## No portal, no positioning library - but measured, fixed placement
 *
 * The bubble renders inside the panel's own DOM, positioned within the panel, which keeps it
 * inside the theme root the layout shell establishes, so it inherits the active `data-theme` token
 * set with no extra wiring; a portal to the document body would leave that root and need a second
 * theme carrier to get it back. It also keeps the bubble a descendant of its trigger's wrapper,
 * which is what lets a surface find the description of one row inside that row. The package ships
 * no positioning library: its third-party dependencies are `clsx`, `lucide-react` and
 * `@tanstack/react-virtual`.
 *
 * An open bubble is `position: fixed`, which is what lets it stay in place without being clipped.
 * Every `overflow` between the trigger and the panel - a table cell, a table's scroll viewport, the
 * shell's own scroll area - clips the boxes laid out inside it, but a fixed box is laid out against
 * the browser viewport rather than against any of those scroll containers, so none of their
 * overflow clips applies to it and the description of a table's first row is drawn over that
 * table's header. The bubble still sits exactly where it is in the DOM and in the theme cascade. A
 * fixed box needs coordinates, and those are the one thing this file computes (`positionBubble`,
 * below): the trigger's rect, the bubble's size and the viewport's size, measured in a layout
 * effect before the bubble is painted and again on every scroll and resize while it stays open.
 * From them it takes the requested side, flips to the opposite side when the requested one would
 * leave the viewport and the opposite one would not, and clamps the result inside the viewport.
 *
 * This is a deliberate exception to the package's rule of no measured coordinates and no inline
 * style, kept as narrow as the problem: the coordinates are two UNITLESS `--dgc-*` numbers written
 * on the bubble's own style - the same sanctioned channel `./DataTable` uses for its geometry,
 * consumed by `../styles/components.css` through the unit bridge, which takes the unit from the
 * `--dg-pixel-unit` token - and nothing else is. No colour, length, gap or stacking value is
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
 *                            type role and --dg-z-tooltip; open, it is capped at a token block
 *                            size inside the viewport, scrolling what does not fit, and lets the
 *                            pointer pass through it
 *   [data-dg-scrollable]     on the open bubble whose description overflows that capped box, and
 *                            on no other: the one bubble that accepts the pointer (so it is
 *                            hoverable, above). Written and removed by this file only
 *   dg-tooltip--top          the four placement variants; on the open bubble each states the gap
 *   dg-tooltip--bottom       to the trigger as a signed start margin on its axis
 *   dg-tooltip--start        `start` and `end` are the logical sides, so a right-to-left panel
 *   dg-tooltip--end          needs no second rule
 *   dg-is-open               the open state, always written coupled to the bubble: `position:
 *                            fixed` at the published coordinates. A closed bubble carries the
 *                            `hidden` attribute (and `dg-visually-hidden`) instead
 *
 *   --dgc-tooltip-block      the open bubble's block-start offset from the viewport, UNITLESS
 *   --dgc-tooltip-inline     its inline-start offset from the viewport, UNITLESS; both measured in
 *                            CSS pixels, consumed as
 *                            `calc(var(--dgc-tooltip-…, 0) * var(--dg-pixel-unit))` and already
 *                            corrected for the placement margin, so the border box lands where it
 *                            was computed
 *
 * A placement variant is written on the wrapper for the component's whole life and on the bubble
 * for as long as it is mounted, so an offset rule may hang off the wrapper or off the bubble -
 * whichever the stylesheet finds clearer - without either needing a class this file does not write.
 *
 * No colour, length, stacking value or motion is written here: the two coordinates above, and the
 * measured `data-dg-scrollable` state, are the whole of this file's style output. Transition timing comes from the `--dg-motion-*` design tokens
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
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react';

import { formatUntrustedNode } from './untrusted-text';

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
 *      its start edge) - while any part of the trigger is inside the viewport. A trigger scrolled
 *      wholly out of it takes its bubble along, unclamped: a bubble held open for keyboard focus
 *      whose row the page scrolled away must not stay pinned over unrelated content, where - were
 *      it a hoverable one - it would also take the clicks meant for that content.
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
  // Whether any part of the trigger is on screen. Only then is the bubble held inside the viewport;
  // otherwise it is placed against its trigger as measured, and leaves with it.
  const triggerShown =
    trigger.bottom > 0 &&
    trigger.top < viewportBlock &&
    triggerEnd > 0 &&
    triggerStart < viewportInline;

  const block = triggerShown ? clamp(blockFor(side), size.height, viewportBlock) : blockFor(side);
  const inline = triggerShown
    ? clamp(inlineFor(side), size.width, viewportInline)
    : inlineFor(side);

  bubble.style.setProperty('--dgc-tooltip-block', formatCoordinate(block - marginBlock));
  bubble.style.setProperty('--dgc-tooltip-inline', formatCoordinate(inline - marginInline));
}

/**
 * The attribute that marks an open bubble whose description overflows its capped box. The
 * stylesheet lets exactly the marked bubble take the pointer (`.dg-tooltip__bubble.dg-is-open
 * [data-dg-scrollable]` in ../styles/components.css), and `handlePointerLeave` holds exactly the
 * marked bubble open across the hover corridor.
 */
const SCROLLABLE_ATTRIBUTE = 'data-dg-scrollable';

/**
 * Writes whether an open bubble's description overflows the box the stylesheet caps it at - on
 * either axis, since a preformatted value can be wider than the bubble as well as taller - as the
 * {@link SCROLLABLE_ATTRIBUTE} mark. Called on every placement, so a scroll, a resize or a new
 * description re-measures it; a DOM without layout reports no overflow, so there the bubble is
 * never marked.
 *
 * Only an overflowing bubble has anything a pointer must reach: the rest show their whole
 * description where they are, and leaving them pointer-transparent is what keeps them from sitting
 * over - and taking the pointer and the clicks of - the neighbouring rows of a dense table.
 *
 * @param bubble The open, placed bubble element.
 */
function markScrollable(bubble: HTMLElement): void {
  const overflows =
    bubble.scrollHeight > bubble.clientHeight || bubble.scrollWidth > bubble.clientWidth;

  if (overflows) {
    bubble.setAttribute(SCROLLABLE_ATTRIBUTE, '');
  } else {
    bubble.removeAttribute(SCROLLABLE_ATTRIBUTE);
  }
}

/** Whether a bubble is marked as overflowing, and therefore accepts the pointer. */
function acceptsPointer(bubble: HTMLElement): boolean {
  return bubble.hasAttribute(SCROLLABLE_ATTRIBUTE);
}

/** A point in viewport coordinates, in CSS pixels - where a pointer event says the pointer is. */
interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

/** The four corners of a box, in viewport coordinates. */
function cornersOf(box: DOMRect): ViewportPoint[] {
  return [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
}

/**
 * The turn from `a` through `b` to `c`: positive for one rotational sense, negative for the other
 * and zero when the three are collinear. Only its sign is ever read, and only against itself, so
 * whether the viewport's block axis points down or up never matters.
 */
function turn(a: ViewportPoint, b: ViewportPoint, c: ViewportPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Appends a point to one chain of the hull, first dropping every earlier point that no longer
 * makes a strict turn in the chain's sense. Collinear and repeated points are dropped too, so the
 * hull never carries a zero-length edge.
 */
function appendToHull(chain: ViewportPoint[], point: ViewportPoint): void {
  for (;;) {
    const last = chain.at(-1);
    const beforeLast = chain.at(-2);
    if (last === undefined || beforeLast === undefined || turn(beforeLast, last, point) > 0) {
      break;
    }
    chain.pop();
  }
  chain.push(point);
}

/**
 * The convex hull of a set of points (Andrew's monotone chain), every edge turning in the same
 * sense, so a point is inside exactly when it is on the same side of every edge.
 */
function convexHull(points: readonly ViewportPoint[]): ViewportPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: ViewportPoint[] = [];
  const upper: ViewportPoint[] = [];

  for (const point of sorted) {
    appendToHull(lower, point);
  }
  for (const point of [...sorted].reverse()) {
    appendToHull(upper, point);
  }
  // Each chain ends on the point the other starts from.
  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

/**
 * The hover corridor of an open bubble: the convex hull of the trigger's box and the bubble's box,
 * which is every point a pointer can pass through on its way from one to the other - the gap
 * between them included, whichever side the bubble flipped to and wherever the viewport clamp put
 * it. Measured when it is asked for, never cached, because a scroll or a resize moves both boxes.
 *
 * @returns The hull, or `null` when the bubble has no rendered box: a bubble nothing can be seen
 *   in is not somewhere a pointer can go, so there is no corridor to it.
 */
function hoverCorridor(anchor: HTMLElement, bubble: HTMLElement): readonly ViewportPoint[] | null {
  const bubbleBox = bubble.getBoundingClientRect();

  if (!(bubbleBox.width > 0 && bubbleBox.height > 0)) {
    return null;
  }

  const hull = convexHull([...cornersOf(anchor.getBoundingClientRect()), ...cornersOf(bubbleBox)]);

  return hull.length < 3 ? null : hull;
}

/** Whether a point is inside a convex hull or on its boundary. */
function corridorContains(hull: readonly ViewportPoint[], point: ViewportPoint): boolean {
  return hull.every((vertex, index) => {
    const next = hull[(index + 1) % hull.length] ?? vertex;

    return turn(vertex, next, point) >= 0;
  });
}

/**
 * The bubble's click handler: the click stops at the bubble, so reading - or selecting text in -
 * a description never selects, expands or activates the row or chart the trigger sits in (see this
 * module's header). Only a bubble marked as overflowing ever receives one; any other lets the
 * pointer, and the click, through to what lies beneath it. Module scope, so every tooltip shares
 * one stable handler.
 */
function containBubbleClick(event: ReactMouseEvent<HTMLSpanElement>): void {
  event.stopPropagation();
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

/**
 * The inputs of one tooltip: a single trigger element (`children`) and the inert description it
 * reveals (`content`), which never holds anything focusable.
 *
 * Visibility is uncontrolled by default - hover after `openDelayMs` and focus open the bubble,
 * leave, blur and Escape close it, and `disabled` keeps it shut. Passing a boolean `open` makes it
 * controlled: that value alone decides, and the owner answers Escape. `describesTrigger`, `id`,
 * `placement` and `className` apply in both modes.
 */
export interface TooltipProps {
  /**
   * The description. Text, a number, a formatted value or an inert element - never a button, a
   * link, a field or anything else focusable, because focus never enters the bubble. Every string
   * in it, directly or in an array, is shown with its direction controls revealed (see this
   * module's header); an element in it renders its own text.
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
 * on keyboard focus, stays open while the pointer crosses onto a bubble too long to show whole
 * (which is then hoverable and scrollable; any other lets the pointer pass through it), closes on
 * leave, blur or Escape, and is in the
 * accessibility tree exactly while it is shown (closed, its bubble stays mounted but `hidden`, so
 * the description resolves). Given `open`, its owner decides instead (see this module's header).
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

  /**
   * Removes the document listeners of a pointer crossing the hover corridor from the trigger to
   * the bubble (see `handlePointerLeave`), or `undefined` while no crossing is under way. A ref: a
   * crossing changes nothing on screen until it ends, and ending it closes the bubble through
   * state.
   */
  const crossingRef = useRef<(() => void) | undefined>(undefined);

  // `disabled` is applied here rather than in each handler's result, so flipping it while the
  // bubble is open hides the bubble on the next render instead of stranding it. A defined `open`
  // overrides both: the owner alone decides.
  const isOpen = controlledOpen ?? (open && !disabled);

  // Every opening starts at the top of the description. The closed bubble stays mounted, and a
  // browser restores the scroll offset a box had when it is shown again, so without this a bubble
  // a reader had scrolled to its end would reopen there - showing the tail of a statement first.
  // Keyed on `isOpen` alone: a re-render while the bubble stays open (a new `content` element, a
  // chart's hover state) must never pull the reader's scroll back. Declared before placement, so
  // the offset is reset before the bubble is measured and painted.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;

    if (isOpen && bubble !== null) {
      bubble.scrollTop = 0;
      bubble.scrollLeft = 0;
    }
  }, [isOpen]);

  // Placement of the open bubble, whoever opened it: hover, focus or a controlling owner all reach
  // the screen through this one path. A LAYOUT effect, so the coordinates are written after the
  // open class lands and before the browser paints: the bubble is never seen at the viewport
  // origin it occupies for that instant. It is re-placed on every scroll - in the capture phase on
  // the window, so a scroll of ANY container between the trigger and the page is heard, since
  // scroll events do not bubble - and on every resize, for as long as it stays open; `content`
  // re-runs it because a new description is a new size. Every placement also re-measures whether
  // the description overflows the capped box (`markScrollable`), which is what decides whether the
  // bubble takes the pointer. Closing removes the coordinates and the mark with the listeners.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const anchor = anchorRef.current;

    if (!isOpen || bubble === null || anchor === null) {
      return undefined;
    }

    const place = () => {
      positionBubble(bubble, anchor, placement);
      markScrollable(bubble);
    };

    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);

    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      bubble.style.removeProperty('--dgc-tooltip-block');
      bubble.style.removeProperty('--dgc-tooltip-inline');
      bubble.removeAttribute(SCROLLABLE_ATTRIBUTE);
    };
  }, [content, isOpen, placement]);

  const cancelPendingOpen = useCallback(() => {
    const pending = timerRef.current;
    if (pending !== undefined) {
      clearTimeout(pending);
      timerRef.current = undefined;
    }
  }, []);

  const endCrossing = useCallback(() => {
    const stop = crossingRef.current;
    if (stop !== undefined) {
      crossingRef.current = undefined;
      stop();
    }
  }, []);

  // Unmount cleanup, and nothing else: a timer that fires after unmount would set state on a gone
  // component - a warning in a consumer and a flake in a test - and a crossing's document
  // listeners would outlive the bubble they measure.
  useEffect(
    () => () => {
      cancelPendingOpen();
      endCrossing();
    },
    [cancelPendingOpen, endCrossing],
  );

  // A crossing only ever keeps an OPEN bubble open, so however the bubble closed - Escape, blur,
  // `disabled`, the owner taking control - its listeners go with it.
  useEffect(() => {
    if (!isOpen) {
      endCrossing();
    }
  }, [endCrossing, isOpen]);

  // The non-state half of the mode-switch reset above: a hover open still pending when the owner
  // takes control is cancelled, a crossing under way is ended, and a suppression armed by an
  // earlier Escape is cleared, since the leave or blur that would have cleared it goes unheard
  // while the owner is in control. A LAYOUT effect, so a pending timer cannot fire between the
  // switch's commit and this cancellation.
  useLayoutEffect(() => {
    cancelPendingOpen();
    endCrossing();
    suppressedRef.current = false;
  }, [cancelPendingOpen, controlled, endCrossing]);

  const handlePointerEnter = useCallback(() => {
    // Back on the trigger, or arrived on the bubble (a descendant of this wrapper): a crossing of
    // the corridor, if one was under way, is complete.
    endCrossing();
    if (disabled || suppressedRef.current || isOpen) {
      return;
    }
    cancelPendingOpen();
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      setOpen(true);
    }, openDelayMs);
  }, [cancelPendingOpen, disabled, endCrossing, isOpen, openDelayMs]);

  // Leaving the wrapper - the trigger, or the bubble inside it. The bubble closes at once unless it
  // is open, marked as overflowing (the only bubble a pointer can rest on - every other one lets it
  // through to the row beneath, see this module's header), and the pointer is still inside the
  // hover corridor between the trigger and the bubble, which is where a pointer on its way to the
  // bubble is. Then the bubble stays open while every further move stays inside the corridor, and
  // closes on the first one that leaves it, on a scroll that carries the corridor away from where
  // the pointer last was, or when the pointer leaves the window. A touch pointer cannot hover, and
  // a pointer that left the document will send no move to judge, so both close at once. Leaving
  // the document is read off the NATIVE event's `relatedTarget`, which is `null` exactly then:
  // React's synthetic one stands in the window for any element React does not manage, so it
  // cannot tell a pointer that left the page from one over a host's own markup.
  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      cancelPendingOpen();
      endCrossing();
      suppressedRef.current = false;

      const anchor = anchorRef.current;
      const bubble = bubbleRef.current;

      if (
        !isOpen ||
        anchor === null ||
        bubble === null ||
        !acceptsPointer(bubble) ||
        event.pointerType === 'touch' ||
        event.nativeEvent.relatedTarget === null
      ) {
        setOpen(false);
        return;
      }

      const corridor = hoverCorridor(anchor, bubble);

      if (
        corridor === null ||
        !corridorContains(corridor, { x: event.clientX, y: event.clientY })
      ) {
        setOpen(false);
        return;
      }

      const ownerDocument = anchor.ownerDocument;
      const view = ownerDocument.defaultView;
      // Where the pointer last was: a scroll moves the boxes without moving the pointer, and sends
      // no pointer event to say where it is.
      let pointer: ViewportPoint = { x: event.clientX, y: event.clientY };
      const close = () => {
        endCrossing();
        setOpen(false);
      };
      // Re-measured on every judgement: a scroll during the crossing moves both boxes.
      const judge = () => {
        const current = hoverCorridor(anchor, bubble);
        if (current === null || !corridorContains(current, pointer)) {
          close();
        }
      };
      const followMove = (move: PointerEvent) => {
        pointer = { x: move.clientX, y: move.clientY };
        judge();
      };
      const followExit = (out: PointerEvent) => {
        if (out.relatedTarget === null) {
          close();
        }
      };

      ownerDocument.addEventListener('pointermove', followMove);
      ownerDocument.addEventListener('pointerout', followExit);
      // A scroll of any container, heard in the capture phase as placement hears it - and after
      // placement has moved the bubble, since that listener was added when the bubble opened. A
      // scroll that carries the corridor away from a still pointer closes the bubble at once,
      // rather than leaving it open, over whatever scrolled in, until the pointer next moves.
      view?.addEventListener('scroll', judge, true);
      crossingRef.current = () => {
        ownerDocument.removeEventListener('pointermove', followMove);
        ownerDocument.removeEventListener('pointerout', followExit);
        view?.removeEventListener('scroll', judge, true);
      };
    },
    [cancelPendingOpen, endCrossing, isOpen],
  );

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
          when it describes nothing, so a sentence the container already names is heard once.
          A click inside it stops here: a bubble marked as overflowing accepts the pointer so it
          can be read and scrolled, and a description is never the row or chart beneath it. */}
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
        onClick={containBubbleClick}
      >
        {formatUntrustedNode(content)}
      </span>
    </span>
  );
}
