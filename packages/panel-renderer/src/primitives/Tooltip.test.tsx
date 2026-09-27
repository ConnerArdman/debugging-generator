/**
 * Tooltip - measured, fixed placement of the open bubble.
 *
 * An open bubble is `position: fixed` at coordinates this primitive measures, which keeps it clear
 * of every scroll container's overflow clip between the trigger and the panel. These tests pin
 * that measurement: the requested side, the gap read back from the stylesheet's placement margin,
 * the flip to the opposite side, the clamp to the viewport, the right-to-left inline axis,
 * re-placement on scroll and on resize, and the clean-up on close. They also pin the structural
 * and focus guarantees the rest of the package relies on: the bubble never leaves its trigger's
 * wrapper (no portal), it stays mounted - described, hidden - while closed, and Escape closes it
 * without moving focus.
 *
 * The controlled mode (`open`, `describesTrigger`) is pinned next: an owner-held bubble is placed
 * by the same measurement, hover, focus and Escape are left to the owner, and handing control
 * back resumes the uncontrolled mode closed.
 *
 * Last, the hoverable bubble (WCAG 1.4.13): only a bubble whose description overflows its capped
 * box is marked `data-dg-scrollable` - measured on every placement, cleared on close - and only
 * that bubble takes the pointer; any other lets it through, so leaving the trigger closes it at
 * once and a neighbouring trigger's description opens in its turn. A pointer leaving the trigger
 * of a marked bubble keeps it open only while it stays inside the corridor between the trigger's
 * box and the bubble's box - judged again on every move and every scroll - while a touch pointer,
 * a pointer leaving the window and a bubble with no box close it at once. A click inside the
 * bubble never reaches the row around the trigger, and the stylesheet bounds the open bubble's
 * block size, scrolls its overflow and lets exactly the marked bubble take the pointer.
 *
 * happy-dom performs no layout, so every rect, the viewport size, the bubble's scroll extent and
 * its computed margin and direction are stubbed; what is asserted is the arithmetic and the DOM
 * contract, and the rendered geometry is verified in a real browser separately.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from './Tooltip';
import type { TooltipPlacement } from './Tooltip';

/** A rect in viewport coordinates, the four edges every measurement here reads. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The viewport the stubs report, in CSS pixels. */
const VIEWPORT = { width: 800, height: 600 } as const;

/** The size of the open bubble the stubs report. */
const BUBBLE_SIZE = { width: 120, height: 40 } as const;

/** The gap the stubbed placement margin carries, in CSS pixels. */
const GAP = 4;

/** The computed-style fields `positionBubble` reads, as the stub serves them. */
interface ComputedOverrides {
  readonly marginTop: string;
  readonly marginLeft: string;
  readonly marginRight: string;
  readonly direction: string;
}

/** The trigger rect the next measurement answers with; tests move it to simulate a scroll. */
let triggerBox: Box = { left: 100, top: 200, width: 80, height: 20 };

/**
 * The bubble rect the next measurement answers with. Only its size matters to placement, so it
 * sits at the origin by default; the hover-corridor cases put it where a top bubble opens.
 */
let bubbleBox: Box = { left: 0, top: 0, ...BUBBLE_SIZE };

/** The computed style the next measurement answers with for the bubble. */
let bubbleStyle: ComputedOverrides = {
  marginTop: `${String(-GAP)}px`,
  marginLeft: '0px',
  marginRight: '0px',
  direction: 'ltr',
};

/** What the open bubble's scroll box reports: its content's extent and its own, per axis. */
interface ScrollExtent {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** A description that fits the bubble's capped box on both axes. */
const FITTING_EXTENT: ScrollExtent = {
  scrollHeight: BUBBLE_SIZE.height,
  clientHeight: BUBBLE_SIZE.height,
  scrollWidth: BUBBLE_SIZE.width,
  clientWidth: BUBBLE_SIZE.width,
};

/** A description taller than the bubble's capped box: the bubble must be scrolled to read it. */
const OVERFLOWING_EXTENT: ScrollExtent = { ...FITTING_EXTENT, scrollHeight: 400 };

/** The scroll extent the next measurement of a bubble answers with. */
let bubbleExtent: ScrollExtent = FITTING_EXTENT;

/** Puts back every scroll-extent accessor `stubBubbleExtent` replaced. */
const extentRestorers: (() => void)[] = [];

/**
 * Answers one scroll-extent accessor from `bubbleExtent` for a tooltip bubble, and from the DOM's
 * own accessor for every other element. The accessor is replaced where the DOM defines it - on
 * whichever prototype of `HTMLElement` owns it - and put back after each test.
 */
function stubBubbleExtent(name: keyof ScrollExtent): void {
  let owner: object | null = HTMLElement.prototype;
  let inherited: PropertyDescriptor | undefined;

  while (owner !== null && inherited === undefined) {
    inherited = Object.getOwnPropertyDescriptor(owner, name);
    if (inherited === undefined) {
      owner = Object.getPrototypeOf(owner) as object | null;
    }
  }
  if (owner === null || inherited === undefined) {
    throw new Error(`the DOM defines no ${name} accessor to stub`);
  }

  const target = owner;
  const saved = inherited;

  Object.defineProperty(target, name, {
    configurable: true,
    get(this: Element): number {
      if (this instanceof HTMLElement && this.classList.contains('dg-tooltip__bubble')) {
        return bubbleExtent[name];
      }
      const value: unknown = saved.get?.call(this);

      return typeof value === 'number' ? value : 0;
    },
  });
  extentRestorers.push(() => {
    Object.defineProperty(target, name, saved);
  });
}

/** A DOMRect-shaped value for a box. */
function toRect(box: Box): DOMRect {
  return {
    x: box.left,
    y: box.top,
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  };
}

/**
 * The computed start margin a placement variant carries in `../styles/components.css`: the gap as
 * a negative block margin for `top`, positive for `bottom`, and the same on the inline axis for
 * `start` and `end`.
 */
function marginsFor(
  placement: TooltipPlacement,
): Pick<ComputedOverrides, 'marginTop' | 'marginLeft'> {
  switch (placement) {
    case 'top':
      return { marginTop: `${String(-GAP)}px`, marginLeft: '0px' };
    case 'bottom':
      return { marginTop: `${String(GAP)}px`, marginLeft: '0px' };
    case 'start':
      return { marginTop: '0px', marginLeft: `${String(-GAP)}px` };
    case 'end':
      return { marginTop: '0px', marginLeft: `${String(GAP)}px` };
  }
}

/** Renders one tooltip on a focusable trigger and returns its elements. */
function renderTooltip(placement: TooltipPlacement = 'top') {
  const view = render(
    <div data-testid="scroller">
      <Tooltip content="Full description" placement={placement}>
        <button type="button">Trigger</button>
      </Tooltip>
    </div>,
  );
  const trigger = screen.getByRole('button', { name: 'Trigger' });
  const bubble = document.getElementById(trigger.getAttribute('aria-describedby') ?? '');

  if (!(bubble instanceof HTMLElement)) {
    throw new Error('the trigger does not describe itself with the bubble');
  }

  return { view, trigger, bubble };
}

/** An element's class list, in order, as a plain array an assertion can compare. */
function classesOf(element: Element): string[] {
  return [...element.classList];
}

/** The coordinates written on the bubble, as numbers, or `null` where a property is absent. */
function readCoordinates(bubble: HTMLElement): { block: number | null; inline: number | null } {
  const block = bubble.style.getPropertyValue('--dgc-tooltip-block');
  const inline = bubble.style.getPropertyValue('--dgc-tooltip-inline');

  return {
    block: block === '' ? null : Number(block),
    inline: inline === '' ? null : Number(inline),
  };
}

beforeEach(() => {
  triggerBox = { left: 100, top: 200, width: 80, height: 20 };
  bubbleBox = { left: 0, top: 0, ...BUBBLE_SIZE };
  bubbleExtent = FITTING_EXTENT;
  bubbleStyle = { ...bubbleStyle, ...marginsFor('top'), marginRight: '0px', direction: 'ltr' };

  for (const name of ['scrollHeight', 'clientHeight', 'scrollWidth', 'clientWidth'] as const) {
    stubBubbleExtent(name);
  }

  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    get: () => VIEWPORT.width,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT.height,
  });

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('dg-tooltip__trigger')) {
      return toRect(triggerBox);
    }
    if (this.classList.contains('dg-tooltip__bubble')) {
      return toRect(bubbleBox);
    }
    return toRect({ left: 0, top: 0, width: 0, height: 0 });
  });

  const originalComputedStyle = window.getComputedStyle.bind(window);

  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const computed = originalComputedStyle(element, pseudo);

    if (!(element instanceof HTMLElement) || !element.classList.contains('dg-tooltip__bubble')) {
      return computed;
    }

    const overrides = new Map<string, string>(Object.entries(bubbleStyle));

    return new Proxy(computed, {
      get(target, key) {
        const override = typeof key === 'string' ? overrides.get(key) : undefined;

        if (override !== undefined) {
          return override;
        }
        const value: unknown = Reflect.get(target, key);

        if (typeof value !== 'function') {
          return value;
        }

        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);

          return result;
        };
      },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document.documentElement, 'clientWidth');
  Reflect.deleteProperty(document.documentElement, 'clientHeight');
  for (const restore of extentRestorers.splice(0).reverse()) {
    restore();
  }
});

describe('Tooltip fixed placement', () => {
  it('places a top bubble above its trigger, corrected for the placement margin', () => {
    const { trigger, bubble } = renderTooltip('top');

    fireEvent.focus(trigger);

    expect(classesOf(bubble)).toEqual(['dg-tooltip__bubble', 'dg-is-open', 'dg-tooltip--top']);
    // Border box: 200 (trigger top) - 4 (gap) - 40 (height) = 156; the -4 margin is cancelled.
    expect(readCoordinates(bubble)).toEqual({ block: 160, inline: 100 });
  });

  it('places bottom, start and end bubbles on their own side of the trigger', () => {
    const expected: Record<Exclude<TooltipPlacement, 'top'>, { block: number; inline: number }> = {
      // 220 (trigger bottom) + 4, margin +4 cancelled.
      bottom: { block: 220, inline: 100 },
      // 100 (trigger start) - 4 - 120 = -24 does not fit: flips to end, 180 + 4 = 184.
      start: { block: 200, inline: 188 },
      // 180 (trigger end) + 4 = 184, margin +4 cancelled.
      end: { block: 200, inline: 180 },
    };

    for (const placement of ['bottom', 'start', 'end'] as const) {
      bubbleStyle = { ...bubbleStyle, ...marginsFor(placement) };
      const { view, trigger, bubble } = renderTooltip(placement);

      fireEvent.focus(trigger);

      expect(readCoordinates(bubble), placement).toEqual(expected[placement]);
      view.unmount();
    }
  });

  it('keeps a start bubble at the start when it fits there', () => {
    triggerBox = { left: 400, top: 200, width: 80, height: 20 };
    bubbleStyle = { ...bubbleStyle, ...marginsFor('start') };
    const { trigger, bubble } = renderTooltip('start');

    fireEvent.focus(trigger);

    // 400 - 4 - 120 = 276; the -4 margin cancelled gives 280.
    expect(readCoordinates(bubble)).toEqual({ block: 200, inline: 280 });
  });

  it('flips a top bubble below a trigger at the top of the viewport', () => {
    // The first row of a table directly under the viewport's top edge: no room above.
    triggerBox = { left: 100, top: 10, width: 80, height: 20 };
    const { trigger, bubble } = renderTooltip('top');

    fireEvent.focus(trigger);

    // Flipped to the bottom: 30 + 4 = 34 for the border box; the top variant's -4 margin is still
    // applied by the stylesheet, so the published value is 38.
    expect(readCoordinates(bubble)).toEqual({ block: 38, inline: 100 });
  });

  it('clamps a bubble that would cross the viewport inline end', () => {
    triggerBox = { left: 750, top: 200, width: 40, height: 20 };
    const { trigger, bubble } = renderTooltip('top');

    fireEvent.focus(trigger);

    expect(readCoordinates(bubble)).toEqual({
      block: 160,
      // Clamped to the viewport's inline end, keeping the gap from its edge: 800 - 120 - 4.
      inline: VIEWPORT.width - BUBBLE_SIZE.width - GAP,
    });
  });

  it('measures the inline axis from the right edge in a right-to-left panel', () => {
    bubbleStyle = { ...bubbleStyle, direction: 'rtl' };
    const { trigger, bubble } = renderTooltip('top');

    fireEvent.focus(trigger);

    // The trigger's inline start is its right edge: 800 - (100 + 80) = 620.
    expect(readCoordinates(bubble)).toEqual({ block: 160, inline: 620 });
  });

  it('re-places the bubble when any ancestor scrolls, and stops once it closes', () => {
    const { trigger, bubble } = renderTooltip('top');
    const scroller = screen.getByTestId('scroller');

    fireEvent.focus(trigger);
    expect(readCoordinates(bubble).block).toBe(160);

    triggerBox = { ...triggerBox, top: 300 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(readCoordinates(bubble).block).toBe(260);

    fireEvent.blur(trigger);
    expect(classesOf(bubble)).toContain('dg-visually-hidden');
    expect(readCoordinates(bubble)).toEqual({ block: null, inline: null });

    triggerBox = { ...triggerBox, top: 400 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(readCoordinates(bubble)).toEqual({ block: null, inline: null });
  });

  it('lets a bubble leave with a trigger scrolled wholly out of the viewport, and holds it again on return', () => {
    const { trigger, bubble } = renderTooltip('top');
    const scroller = screen.getByTestId('scroller');

    fireEvent.focus(trigger);
    expect(readCoordinates(bubble).block).toBe(160);

    // The trigger is now below the viewport's bottom edge (600). A clamped bubble would be pinned
    // at 600 - 40 - 4 = 556 (published 560) over whatever the page scrolled in; instead it stays
    // against its trigger, 700 - 4 - 40 = 656 (published 660), and leaves the screen with it.
    triggerBox = { ...triggerBox, top: 700 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(readCoordinates(bubble)).toEqual({ block: 660, inline: 100 });
    expect(classesOf(bubble)).toContain('dg-is-open');

    // Scrolled back into view, the bubble is placed and held on screen as before.
    triggerBox = { ...triggerBox, top: 200 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(readCoordinates(bubble)).toEqual({ block: 160, inline: 100 });
  });

  it('re-places the bubble on a viewport resize', () => {
    triggerBox = { left: 750, top: 200, width: 40, height: 20 };
    const { trigger, bubble } = renderTooltip('top');

    fireEvent.focus(trigger);
    expect(readCoordinates(bubble).inline).toBe(VIEWPORT.width - BUBBLE_SIZE.width - GAP);

    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      get: () => 1000,
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(readCoordinates(bubble).inline).toBe(750);
  });

  it('writes no coordinates while the bubble is closed or disabled', () => {
    const { bubble } = renderTooltip('top');

    expect(readCoordinates(bubble)).toEqual({ block: null, inline: null });

    const disabled = render(
      <Tooltip content="Disabled description" disabled>
        <button type="button">Disabled trigger</button>
      </Tooltip>,
    );
    const disabledTrigger = disabled.getByRole('button', { name: 'Disabled trigger' });
    fireEvent.focus(disabledTrigger);
    const disabledBubble = document.getElementById(
      disabledTrigger.getAttribute('aria-describedby') ?? '',
    );

    expect(disabledBubble === null ? [] : classesOf(disabledBubble)).toContain(
      'dg-visually-hidden',
    );
    expect(disabledBubble?.style.getPropertyValue('--dgc-tooltip-block')).toBe('');
  });
});

describe('Tooltip structure', () => {
  it('keeps the open bubble inside its trigger wrapper rather than portalling it', () => {
    const { trigger, bubble } = renderTooltip('top');

    fireEvent.focus(trigger);

    const wrapper = trigger.closest('.dg-tooltip');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.contains(bubble)).toBe(true);
    expect(bubble.getAttribute('role')).toBe('tooltip');
  });

  it('stays mounted and described while closed, and Escape closes it without moving focus', () => {
    const { trigger, bubble } = renderTooltip('top');

    expect(classesOf(bubble)).toContain('dg-visually-hidden');
    expect(bubble.textContent).toBe('Full description');

    act(() => {
      trigger.focus();
    });
    expect(classesOf(bubble)).toContain('dg-is-open');

    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(classesOf(bubble)).toContain('dg-visually-hidden');
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Controlled mode: a description held open by its owner.
 *
 * A tree row or a grid row that holds keyboard focus reveals its label's
 * description through this primitive (the label itself is never a Tab stop).
 * The bubble must reach the screen through the same measured placement as a
 * hovered one - a bubble nobody placed is `position: fixed` at the viewport
 * origin - while hover, focus and Escape stay the owner's business.
 * ---------------------------------------------------------------------------
 */

/** What an owner decides about the tooltip it renders. */
interface ControlledOptions {
  readonly open: boolean | undefined;
  readonly describesTrigger?: boolean;
  readonly placement?: TooltipPlacement;
}

/** The id of the description the trigger carries before any tooltip is merged into it. */
const OWN_HINT_ID = 'own-hint';

/** The tree an owner renders: one tooltip whose trigger already carries a description. */
function controlledTree(options: ControlledOptions) {
  const extra =
    options.describesTrigger === undefined ? {} : { describesTrigger: options.describesTrigger };

  return (
    <div data-testid="scroller">
      <Tooltip
        content="Owned description"
        placement={options.placement ?? 'top'}
        open={options.open}
        {...extra}
      >
        <button type="button" aria-describedby={OWN_HINT_ID}>
          Owned trigger
        </button>
      </Tooltip>
      <span id={OWN_HINT_ID}>Own hint</span>
    </div>
  );
}

/** Renders an owner's tooltip and returns its elements and a way to re-render it. */
function renderControlled(options: ControlledOptions) {
  const view = render(controlledTree(options));
  const trigger = screen.getByRole('button', { name: 'Owned trigger' });
  // `hidden: true`: a closed bubble is `hidden`, and one that describes nothing is `aria-hidden`.
  const bubble = screen.getByRole('tooltip', { hidden: true });
  const rerender = (next: ControlledOptions) => {
    view.rerender(controlledTree(next));
  };

  return { view, trigger, bubble, rerender };
}

/** Whether the bubble is shown: open classes, no `hidden` attribute. */
function isShownBubble(bubble: HTMLElement): boolean {
  return bubble.classList.contains('dg-is-open') && !bubble.hidden;
}

describe('Tooltip controlled mode', () => {
  it('opens a controlled bubble with no hover or focus, placed from the measured rects', () => {
    bubbleStyle = { ...bubbleStyle, ...marginsFor('bottom') };
    const { trigger, bubble } = renderControlled({ open: true, placement: 'bottom' });

    // Nothing touched the trigger: the owner alone opened it.
    expect(document.activeElement).not.toBe(trigger);
    expect(isShownBubble(bubble)).toBe(true);
    expect(classesOf(bubble)).toEqual(['dg-tooltip__bubble', 'dg-is-open', 'dg-tooltip--bottom']);
    // The same arithmetic as a hovered bubble: 220 (trigger bottom) + 4, margin +4 cancelled.
    expect(readCoordinates(bubble)).toEqual({ block: 220, inline: 100 });
  });

  it('re-places a controlled bubble on scroll and on resize while it stays open', () => {
    triggerBox = { left: 750, top: 200, width: 40, height: 20 };
    const { bubble } = renderControlled({ open: true });
    const scroller = screen.getByTestId('scroller');

    expect(readCoordinates(bubble)).toEqual({
      block: 160,
      inline: VIEWPORT.width - BUBBLE_SIZE.width - GAP,
    });

    triggerBox = { ...triggerBox, top: 300 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(readCoordinates(bubble).block).toBe(260);

    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      get: () => 1000,
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(readCoordinates(bubble).inline).toBe(750);
  });

  it('closes when the owner sets open to false, removing the coordinates and the listeners', () => {
    const { bubble, rerender } = renderControlled({ open: true });
    const scroller = screen.getByTestId('scroller');

    expect(readCoordinates(bubble).block).toBe(160);

    rerender({ open: false });

    expect(isShownBubble(bubble)).toBe(false);
    expect(bubble.hidden).toBe(true);
    expect(classesOf(bubble)).toEqual(['dg-tooltip__bubble', 'dg-visually-hidden']);
    expect(readCoordinates(bubble)).toEqual({ block: null, inline: null });

    // Still mounted - the same element - and no longer re-placed.
    expect(screen.getByRole('tooltip', { hidden: true })).toBe(bubble);
    triggerBox = { ...triggerBox, top: 400 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(readCoordinates(bubble)).toEqual({ block: null, inline: null });

    rerender({ open: true });
    expect(isShownBubble(bubble)).toBe(true);
    expect(readCoordinates(bubble).block).toBe(360);
  });

  it('ignores hover, focus, leave, blur and Escape: the owner alone decides', () => {
    vi.useFakeTimers();

    try {
      const { trigger, bubble, rerender } = renderControlled({ open: false });

      fireEvent.pointerEnter(trigger);
      fireEvent.focus(trigger);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(isShownBubble(bubble)).toBe(false);

      rerender({ open: true });

      fireEvent.pointerLeave(trigger);
      fireEvent.blur(trigger);
      // Escape on the trigger is left for the owner - neither consumed nor acted on - and no
      // document listener dismisses it either.
      expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(true);
      expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
      expect(isShownBubble(bubble)).toBe(true);
      expect(readCoordinates(bubble).block).toBe(160);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending hover open when the owner takes control', () => {
    vi.useFakeTimers();

    try {
      const { trigger, bubble, rerender } = renderControlled({ open: undefined });

      // The hover dwell is running when the owner takes control and hands it straight back...
      fireEvent.pointerEnter(trigger);
      rerender({ open: false });
      rerender({ open: undefined });

      // ...so the dwell elapsing afterwards opens nothing: the pending open was cancelled.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(isShownBubble(bubble)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears an Escape suppression when the owner takes control, so focus opens it again after', () => {
    const { trigger, bubble, rerender } = renderControlled({ open: undefined });

    // Uncontrolled: focus opens it, and Escape dismisses it and keeps it dismissed while focus stays.
    fireEvent.focus(trigger);
    expect(isShownBubble(bubble)).toBe(true);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(isShownBubble(bubble)).toBe(false);
    fireEvent.focus(trigger);
    expect(isShownBubble(bubble)).toBe(false);

    // The blur that would clear the suppression goes unheard while the owner is in control, so
    // the switch itself clears it.
    rerender({ open: true });
    rerender({ open: undefined });
    expect(isShownBubble(bubble)).toBe(false);

    fireEvent.focus(trigger);
    expect(isShownBubble(bubble)).toBe(true);
    expect(readCoordinates(bubble).block).toBe(160);
  });

  it('does not reopen a hovered bubble after an owner held it and let go', () => {
    const { trigger, bubble, rerender } = renderControlled({ open: undefined });

    fireEvent.focus(trigger);
    expect(isShownBubble(bubble)).toBe(true);

    rerender({ open: true });
    expect(isShownBubble(bubble)).toBe(true);

    rerender({ open: undefined });
    expect(isShownBubble(bubble)).toBe(false);
    expect(readCoordinates(bubble)).toEqual({ block: null, inline: null });
  });

  it('describes nothing with describesTrigger off: aria-hidden bubble, trigger left as written', () => {
    const { trigger, bubble, rerender } = renderControlled({ open: true, describesTrigger: false });

    expect(bubble.getAttribute('aria-hidden')).toBe('true');
    expect(bubble.getAttribute('role')).toBe('tooltip');
    expect(trigger.getAttribute('aria-describedby')).toBe(OWN_HINT_ID);
    expect(isShownBubble(bubble)).toBe(true);
    expect(readCoordinates(bubble)).toEqual({ block: 160, inline: 100 });

    // The default merges the bubble into the trigger's own description and exposes it.
    rerender({ open: true });
    expect(bubble.hasAttribute('aria-hidden')).toBe(false);
    expect(trigger.getAttribute('aria-describedby')).toBe(`${OWN_HINT_ID} ${bubble.id}`);

    // One bubble per trigger in every mode, and the trigger is never remounted by the switch.
    expect(screen.getAllByRole('tooltip', { hidden: true })).toEqual([bubble]);
    expect(screen.getByRole('button', { name: 'Owned trigger' })).toBe(trigger);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The hoverable bubble (WCAG 1.4.13).
 *
 * A description longer than the bubble's bounded height is read - and scrolled
 * - with the pointer ON the bubble, so a pointer travelling from the trigger to
 * such a bubble must not close it on the way. The suite's bubble therefore
 * overflows by default (OVERFLOWING_EXTENT); the cases that need a description
 * which fits say so. The rects below put a `top` bubble where it opens: 4 px
 * above the trigger (100, 200, 80 x 20), 120 x 40, so the gap between the two
 * is the band y = 196..200 and the corridor is the hull of both boxes.
 * ---------------------------------------------------------------------------
 */

/** The mark an overflowing open bubble carries, and the only bubble that takes the pointer. */
const SCROLLABLE_MARK = 'data-dg-scrollable';

/** Where a `top` bubble opens above the stubbed trigger: 200 - 4 - 40 = 156. */
const OPEN_TOP_BUBBLE: Box = { left: 100, top: 156, ...BUBBLE_SIZE };

/** A point in the gap between the trigger's top edge and the bubble's bottom edge. */
const IN_GAP = { clientX: 140, clientY: 198 } as const;

/** A point on the bubble itself. */
const ON_BUBBLE = { clientX: 150, clientY: 170 } as const;

/** A point beside the trigger, outside the corridor in every direction. */
const AWAY = { clientX: 500, clientY: 400 } as const;

/** Opens the bubble by hover: the pointer enters and the dwell elapses. Needs fake timers. */
function hoverOpen(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
}

/** Whether the uncontrolled bubble is shown. */
function isOpenBubble(bubble: HTMLElement): boolean {
  return bubble.classList.contains('dg-is-open') && !bubble.hidden;
}

/** The declaration block of one selector in `../styles/components.css`. */
function stylesheetRule(selector: string): string {
  const stylesheet = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'components.css'),
    'utf8',
  );
  const start = stylesheet.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const open = stylesheet.indexOf('{', start);

  return stylesheet.slice(open + 1, stylesheet.indexOf('}', open));
}

describe('Tooltip hoverable bubble', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bubbleBox = OPEN_TOP_BUBBLE;
    bubbleExtent = OVERFLOWING_EXTENT;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks only a bubble whose description overflows, re-measured on every placement and cleared on close', () => {
    bubbleExtent = FITTING_EXTENT;
    const { trigger, bubble } = renderTooltip('top');
    const scroller = screen.getByTestId('scroller');

    // Closed, nothing is measured or marked.
    expect(bubble.hasAttribute(SCROLLABLE_MARK)).toBe(false);

    fireEvent.focus(trigger);
    expect(isOpenBubble(bubble)).toBe(true);
    expect(bubble.hasAttribute(SCROLLABLE_MARK), 'fits').toBe(false);

    // Taller than its capped box: marked on the next placement a scroll makes.
    bubbleExtent = OVERFLOWING_EXTENT;
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(bubble.hasAttribute(SCROLLABLE_MARK), 'taller').toBe(true);

    // Fitting again after a resize: the mark goes.
    bubbleExtent = FITTING_EXTENT;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(bubble.hasAttribute(SCROLLABLE_MARK), 'fits again').toBe(false);

    // Wider than its box - a preformatted value - overflows as well.
    bubbleExtent = { ...FITTING_EXTENT, scrollWidth: 360 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(bubble.hasAttribute(SCROLLABLE_MARK), 'wider').toBe(true);

    // Closing removes the mark with the coordinates.
    fireEvent.blur(trigger);
    expect(isOpenBubble(bubble)).toBe(false);
    expect(bubble.hasAttribute(SCROLLABLE_MARK), 'closed').toBe(false);
  });

  it('reopens a scrolled bubble at the top of its description, and never moves the scroll while it stays open', () => {
    const view = render(
      <Tooltip content={<span>Long description</span>}>
        <button type="button">Scrolled trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Scrolled trigger' });

    fireEvent.focus(trigger);
    const bubble = screen.getByRole('tooltip');
    bubble.scrollTop = 300;

    // A re-render while open - a new content element - leaves the reader where they were.
    view.rerender(
      <Tooltip content={<span>Long description</span>}>
        <button type="button">Scrolled trigger</button>
      </Tooltip>,
    );
    expect(bubble.scrollTop, 'held open').toBe(300);

    fireEvent.blur(trigger);
    bubble.scrollTop = 300;
    fireEvent.focus(trigger);
    expect(isOpenBubble(bubble)).toBe(true);
    expect(bubble.scrollTop, 'reopened').toBe(0);
    expect(bubble.scrollLeft, 'reopened').toBe(0);
  });

  it('lets the pointer through a bubble that shows its whole description: leaving the trigger closes it, even toward the bubble', () => {
    bubbleExtent = FITTING_EXTENT;
    const added = vi.spyOn(document, 'addEventListener');
    const { trigger, bubble } = renderTooltip('top');

    hoverOpen(trigger);
    expect(isOpenBubble(bubble)).toBe(true);
    expect(bubble.hasAttribute(SCROLLABLE_MARK)).toBe(false);

    // Into the gap, which would be the corridor of a bubble a pointer can rest on.
    fireEvent.pointerLeave(trigger, {
      pointerType: 'mouse',
      relatedTarget: document.body,
      ...IN_GAP,
    });

    expect(isOpenBubble(bubble)).toBe(false);
    expect(added.mock.calls.some(([type]) => type === 'pointermove')).toBe(false);
  });

  it('opens a neighbouring trigger in its turn once the pointer leaves a bubble that fits, one bubble at a time', () => {
    bubbleExtent = FITTING_EXTENT;
    render(
      <div>
        <Tooltip content="First description" placement="bottom">
          <button type="button">First</button>
        </Tooltip>
        <Tooltip content="Second description" placement="bottom">
          <button type="button">Second</button>
        </Tooltip>
      </div>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });

    hoverOpen(first);
    expect(screen.getAllByRole('tooltip').map((bubble) => bubble.textContent)).toEqual([
      'First description',
    ]);

    // The pointer moves down onto the next row, which the first bubble is drawn over: it passes
    // through that bubble to the second trigger.
    fireEvent.pointerLeave(first, { pointerType: 'mouse', relatedTarget: second, ...IN_GAP });
    expect(screen.queryAllByRole('tooltip')).toEqual([]);

    hoverOpen(second);
    expect(screen.getAllByRole('tooltip').map((bubble) => bubble.textContent)).toEqual([
      'Second description',
    ]);
  });

  it('stays open while the pointer crosses the gap onto the bubble, and rests there', () => {
    const { trigger, bubble } = renderTooltip('top');

    hoverOpen(trigger);
    expect(isOpenBubble(bubble)).toBe(true);

    // Off the trigger and into the gap, which belongs to neither box but to the corridor.
    fireEvent.pointerLeave(trigger, {
      pointerType: 'mouse',
      relatedTarget: document.body,
      ...IN_GAP,
    });
    expect(isOpenBubble(bubble)).toBe(true);
    fireEvent.pointerMove(document.body, { pointerType: 'mouse', ...ON_BUBBLE });
    expect(isOpenBubble(bubble)).toBe(true);

    // On the bubble - a descendant of the wrapper - the crossing is over, and the dwell that an
    // enter would start never re-opens or re-times anything.
    fireEvent.pointerEnter(bubble, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    fireEvent.pointerMove(document.body, { pointerType: 'mouse', ...AWAY });
    expect(isOpenBubble(bubble)).toBe(true);

    // Leaving the bubble for anywhere outside the corridor closes it at once.
    fireEvent.pointerLeave(bubble, { pointerType: 'mouse', relatedTarget: document.body, ...AWAY });
    expect(isOpenBubble(bubble)).toBe(false);
  });

  it('closes at once when the pointer leaves the trigger for anywhere but the bubble', () => {
    const { trigger, bubble } = renderTooltip('top');

    hoverOpen(trigger);
    fireEvent.pointerLeave(trigger, {
      pointerType: 'mouse',
      relatedTarget: document.body,
      ...AWAY,
    });

    expect(isOpenBubble(bubble)).toBe(false);
  });

  it('closes on the first move out of the corridor, and stops listening once it has', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const { trigger, bubble } = renderTooltip('top');

    hoverOpen(trigger);
    fireEvent.pointerLeave(trigger, {
      pointerType: 'mouse',
      relatedTarget: document.body,
      ...IN_GAP,
    });
    const follow = added.mock.calls.find(([type]) => type === 'pointermove')?.[1];
    expect(follow).toBeDefined();

    fireEvent.pointerMove(document.body, { pointerType: 'mouse', clientX: 400, clientY: 198 });

    expect(isOpenBubble(bubble)).toBe(false);
    expect(
      removed.mock.calls.some(([type, listener]) => type === 'pointermove' && listener === follow),
    ).toBe(true);
  });

  it('judges a crossing again on every scroll, closing it once the corridor moves off a still pointer', () => {
    const view = document.defaultView;
    if (view === null) {
      throw new Error('the test document has no window');
    }
    const added = vi.spyOn(view, 'addEventListener');
    const removed = vi.spyOn(view, 'removeEventListener');
    const { trigger, bubble } = renderTooltip('top');
    const scroller = screen.getByTestId('scroller');

    hoverOpen(trigger);
    fireEvent.pointerLeave(trigger, {
      pointerType: 'mouse',
      relatedTarget: document.body,
      ...IN_GAP,
    });
    expect(isOpenBubble(bubble)).toBe(true);

    // A one-pixel scroll leaves the still pointer (y = 198) in the new gap, y = 195..199.
    triggerBox = { ...triggerBox, top: 199 };
    bubbleBox = { ...OPEN_TOP_BUBBLE, top: 155 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(isOpenBubble(bubble), 'still in the corridor').toBe(true);

    // A long scroll carries both boxes away from it: the bubble closes without a pointer move.
    triggerBox = { ...triggerBox, top: 500 };
    bubbleBox = { ...OPEN_TOP_BUBBLE, top: 456 };
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(isOpenBubble(bubble), 'carried away').toBe(false);

    // Every scroll listener the bubble and its crossing added is gone with it.
    const scrollListeners = added.mock.calls
      .filter(([type]) => type === 'scroll')
      .map(([, listener]) => listener);
    expect(scrollListeners).toHaveLength(2);
    for (const listener of scrollListeners) {
      expect(
        removed.mock.calls.some(([type, gone]) => type === 'scroll' && gone === listener),
      ).toBe(true);
    }
  });

  it('closes a crossing bubble when the pointer leaves the window', () => {
    const { trigger, bubble } = renderTooltip('top');

    hoverOpen(trigger);
    fireEvent.pointerLeave(trigger, {
      pointerType: 'mouse',
      relatedTarget: document.body,
      ...IN_GAP,
    });
    expect(isOpenBubble(bubble)).toBe(true);

    fireEvent.pointerOut(document.body, { pointerType: 'mouse', relatedTarget: null });

    expect(isOpenBubble(bubble)).toBe(false);
  });

  it('closes at once for a touch pointer, a pointer leaving the document and a bubble with no box', () => {
    const touch = renderTooltip('top');
    hoverOpen(touch.trigger);
    fireEvent.pointerLeave(touch.trigger, {
      pointerType: 'touch',
      relatedTarget: document.body,
      ...IN_GAP,
    });
    expect(isOpenBubble(touch.bubble), 'touch').toBe(false);
    touch.view.unmount();

    const exit = renderTooltip('top');
    hoverOpen(exit.trigger);
    fireEvent.pointerLeave(exit.trigger, { pointerType: 'mouse', relatedTarget: null, ...IN_GAP });
    expect(isOpenBubble(exit.bubble), 'document exit').toBe(false);
    exit.view.unmount();

    // Nothing laid out - the layout-free DOM every other suite renders in - is nowhere a pointer
    // can go, so there is no corridor to keep the bubble open for.
    bubbleBox = { left: 0, top: 0, width: 0, height: 0 };
    const boxless = renderTooltip('top');
    hoverOpen(boxless.trigger);
    fireEvent.pointerLeave(boxless.trigger, {
      pointerType: 'mouse',
      relatedTarget: document.body,
      ...IN_GAP,
    });
    expect(isOpenBubble(boxless.bubble), 'no box').toBe(false);
  });

  it('ends a crossing with Escape, and nothing re-opens the bubble while the pointer stays put', () => {
    const removed = vi.spyOn(document, 'removeEventListener');
    const { trigger, bubble } = renderTooltip('top');

    hoverOpen(trigger);
    fireEvent.pointerLeave(trigger, {
      pointerType: 'mouse',
      relatedTarget: document.body,
      ...IN_GAP,
    });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(isOpenBubble(bubble)).toBe(false);
    expect(removed.mock.calls.some(([type]) => type === 'pointermove')).toBe(true);

    fireEvent.pointerMove(document.body, { pointerType: 'mouse', ...ON_BUBBLE });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(isOpenBubble(bubble)).toBe(false);
  });

  it('keeps a click inside the bubble from reaching the row around the trigger', () => {
    const onRowClick = vi.fn();
    render(
      <div data-testid="row" onClick={onRowClick}>
        <Tooltip content="Row description">
          <button type="button">Row trigger</button>
        </Tooltip>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'Row trigger' });

    fireEvent.focus(trigger);
    const bubble = screen.getByRole('tooltip');
    fireEvent.click(bubble);
    expect(onRowClick).not.toHaveBeenCalled();
    // Still open: a click is reading, not dismissing.
    expect(isOpenBubble(bubble)).toBe(true);

    // The trigger's own click is untouched.
    fireEvent.click(trigger);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('declares a bounded, scrolling open bubble in tokens only, taking the pointer only when marked', () => {
    const open = stylesheetRule('.dg-tooltip__bubble.dg-is-open');

    for (const declaration of [
      'max-block-size: min(var(--dg-code-block-max-block-size), var(--dg-size-full));',
      'overflow: auto;',
      'overscroll-behavior: contain;',
      'pointer-events: none;',
      'max-inline-size: var(--dg-tooltip-max-inline-size);',
    ]) {
      expect(open, declaration).toContain(declaration);
    }

    // Exactly the bubble whose description overflows accepts the pointer.
    expect(stylesheetRule(`.dg-tooltip__bubble.dg-is-open[${SCROLLABLE_MARK}]`)).toContain(
      'pointer-events: auto;',
    );

    // The closed bubble's paint rule says nothing about the pointer: the open state decides.
    expect(stylesheetRule('.dg-tooltip__bubble')).not.toContain('pointer-events');
  });
});
