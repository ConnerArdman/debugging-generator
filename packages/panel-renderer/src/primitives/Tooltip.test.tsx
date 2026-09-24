/**
 * Tooltip - measured, fixed placement of the open bubble (Q4-B2 F03).
 *
 * The bubble used to be absolutely positioned inside its wrapper, so every `overflow` between the
 * trigger and the panel clipped it - the description of a table's first row was cut off under the
 * table's own header. An open bubble is now `position: fixed` at coordinates this primitive
 * measures, and these tests pin that measurement: the requested side, the gap read back from the
 * stylesheet's placement margin, the flip to the opposite side, the clamp to the viewport, the
 * right-to-left inline axis, re-placement on scroll, and the clean-up on close. They also pin the
 * two structural guarantees the rest of the package relies on: the bubble never leaves its
 * trigger's wrapper (no portal), and it stays mounted - described, hidden - while closed.
 *
 * The controlled mode (`open`, `describesTrigger`) is pinned last: an owner-held bubble is placed
 * by the same measurement, hover, focus and Escape are left to the owner, and handing control
 * back resumes the uncontrolled mode closed.
 *
 * happy-dom performs no layout, so every rect, the viewport size and the bubble's computed margin
 * and direction are stubbed; what is asserted is the arithmetic and the DOM contract, and the
 * rendered geometry is verified in a real browser separately.
 */

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

/** The computed style the next measurement answers with for the bubble. */
let bubbleStyle: ComputedOverrides = {
  marginTop: `${String(-GAP)}px`,
  marginLeft: '0px',
  marginRight: '0px',
  direction: 'ltr',
};

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
  bubbleStyle = { ...bubbleStyle, ...marginsFor('top'), marginRight: '0px', direction: 'ltr' };

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
      return toRect({ left: 0, top: 0, ...BUBBLE_SIZE });
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
});

describe('Tooltip fixed placement (Q4-B2 F03)', () => {
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

describe('Tooltip structure (Q4-B2 F03)', () => {
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
