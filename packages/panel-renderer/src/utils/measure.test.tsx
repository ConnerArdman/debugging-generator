/**
 * `./measure` — text fitting and the chart viewport hook.
 *
 * The fitting helpers are pure and are tested with an exact, hand-written
 * measure so every expected string is derivable by hand. The hook is tested in
 * both of its modes: without layout (happy-dom's own behaviour — no width, no
 * canvas metrics), which is the mode every chart suite runs in, and with a
 * measured viewport, which the hook itself is responsible for and which this
 * suite alone drives by giving the viewport a width and the window a
 * controllable `ResizeObserver`.
 */

import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LABEL_FONT_SIZE,
  ELLIPSIS,
  ESTIMATE_NARROW_ADVANCE_EM,
  ESTIMATE_WIDE_ADVANCE_EM,
  createEstimateMeasure,
  estimateTextWidth,
  fitTextToWidth,
  splitGraphemes,
  useChartCanvas,
} from './measure';
import type { ChartCanvas, ChartCanvasOptions, TextMeasure } from './measure';

/** Ten pixels per grapheme: every fit below is arithmetic. */
const tenPerGrapheme: TextMeasure = (text) => splitGraphemes(text).length * 10;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('splitGraphemes', () => {
  it('keeps an emoji, a flag and an accented letter whole', () => {
    expect(splitGraphemes('a\u{1F680}b')).toEqual(['a', '\u{1F680}', 'b']);
    expect(splitGraphemes('\u{1F1EF}\u{1F1F5}x')).toEqual(['\u{1F1EF}\u{1F1F5}', 'x']);
    expect(splitGraphemes('e\u0301z')).toEqual(['e\u0301', 'z']);
  });
});

describe('estimateTextWidth', () => {
  it('advances 0.6 em per narrow grapheme and 1.25 em per wide one', () => {
    expect(estimateTextWidth('abcd', 10)).toBeCloseTo(4 * ESTIMATE_NARROW_ADVANCE_EM * 10);
    expect(estimateTextWidth('a\u{1F680}', 10)).toBeCloseTo(
      (ESTIMATE_NARROW_ADVANCE_EM + ESTIMATE_WIDE_ADVANCE_EM) * 10,
    );
    expect(estimateTextWidth('\u6f22\u5b57', 10)).toBeCloseTo(2 * ESTIMATE_WIDE_ADVANCE_EM * 10);
  });

  it('assumes the default label size for an unusable font size', () => {
    expect(estimateTextWidth('ab', Number.NaN)).toBeCloseTo(
      2 * ESTIMATE_NARROW_ADVANCE_EM * DEFAULT_LABEL_FONT_SIZE,
    );
    expect(createEstimateMeasure(-1)('ab')).toBeCloseTo(
      2 * ESTIMATE_NARROW_ADVANCE_EM * DEFAULT_LABEL_FONT_SIZE,
    );
  });
});

describe('fitTextToWidth', () => {
  it('returns the whole text when it fits', () => {
    expect(fitTextToWidth('query', 50, tenPerGrapheme)).toEqual({
      text: 'query',
      width: 50,
      truncated: false,
    });
  });

  it('keeps the longest prefix that fits with its ellipsis', () => {
    expect(fitTextToWidth('abcdefghij', 55, tenPerGrapheme)).toEqual({
      text: `abcd${ELLIPSIS}`,
      width: 50,
      truncated: true,
    });
  });

  it('never splits an emoji and never exceeds the width, even for a long hostile name', () => {
    const hostile = `${'span name '.repeat(24)}\u{1F680} tail`;
    const fit = fitTextToWidth(hostile, 916, tenPerGrapheme);

    expect(fit?.truncated).toBe(true);
    expect(fit?.text.endsWith(ELLIPSIS)).toBe(true);
    expect(fit?.width).toBeLessThanOrEqual(916);
    expect(tenPerGrapheme(fit?.text ?? '')).toBe(fit?.width);
    expect(splitGraphemes(fit?.text ?? '').every((g) => g !== '\uD83D')).toBe(true);
  });

  it('trims whitespace before the ellipsis', () => {
    expect(fitTextToWidth('ab   cdefgh', 60, tenPerGrapheme)?.text).toBe(`ab${ELLIPSIS}`);
  });

  it('draws nothing when not even the shortest acceptable prefix fits', () => {
    expect(fitTextToWidth('abcdef', 15, tenPerGrapheme)).toBeUndefined();
    expect(fitTextToWidth('abcdef', 30, tenPerGrapheme, { minGraphemes: 3 })).toBeUndefined();
    expect(fitTextToWidth('abcdef', 40, tenPerGrapheme, { minGraphemes: 3 })?.text).toBe(
      `abc${ELLIPSIS}`,
    );
  });

  it('draws nothing for empty text or an unusable width', () => {
    expect(fitTextToWidth('', 100, tenPerGrapheme)).toBeUndefined();
    expect(fitTextToWidth('abc', 0, tenPerGrapheme)).toBeUndefined();
    expect(fitTextToWidth('abc', Number.NaN, tenPerGrapheme)).toBeUndefined();
  });

  it('treats a measure that answers NaN as never fitting', () => {
    expect(fitTextToWidth('abc', 100, () => Number.NaN)).toBeUndefined();
  });
});

/** Renders a viewport through the hook and reports what the hook last returned. */
function renderCanvas(
  options: ChartCanvasOptions,
  prepare?: (element: HTMLDivElement) => void,
): { readonly latest: () => ChartCanvas<HTMLDivElement> } {
  let latest: ChartCanvas<HTMLDivElement> | undefined;
  function Probe(): ReactElement {
    const canvas = useChartCanvas<HTMLDivElement>(options);
    latest = canvas;
    return (
      <div
        data-testid="viewport"
        ref={(element) => {
          if (element !== null) {
            prepare?.(element);
          }
          return canvas.ref(element);
        }}
      />
    );
  }
  render(<Probe />);
  return {
    latest: () => {
      if (latest === undefined) {
        throw new Error('the probe never rendered');
      }
      return latest;
    },
  };
}

describe('useChartCanvas without layout', () => {
  it('reports no width and measures with the estimate', () => {
    const { latest } = renderCanvas({ font: 'monoSm' });

    expect(latest().width).toBeUndefined();
    expect(latest().textMetricsExact).toBe(false);
    expect(latest().measureText('abc')).toBeCloseTo(
      estimateTextWidth('abc', DEFAULT_LABEL_FONT_SIZE),
    );
  });

  it('keeps the same measure across renders, so geometry memoised on it is stable', () => {
    let measures: TextMeasure[] = [];
    function Probe(props: { readonly tick: number }): ReactElement {
      const canvas = useChartCanvas<HTMLDivElement>({ font: 'monoSm' });
      measures = [...measures, canvas.measureText];
      return <div ref={canvas.ref} data-tick={props.tick} />;
    }
    const { rerender } = render(<Probe tick={0} />);
    rerender(<Probe tick={1} />);

    expect(measures.length).toBeGreaterThanOrEqual(2);
    expect(new Set(measures).size).toBe(1);
  });
});

describe('useChartCanvas with a measured viewport', () => {
  it('reports the content width in whole pixels, follows resizes and keeps it while hidden', () => {
    let width = 744.6;
    const callbacks: (() => void)[] = [];
    const view = document.defaultView as unknown as { ResizeObserver: unknown };
    const original = view.ResizeObserver;
    class ControlledObserver {
      private readonly callback: () => void;
      public constructor(callback: () => void) {
        this.callback = callback;
      }
      public observe(): void {
        callbacks.push(this.callback);
      }
      public disconnect(): void {
        callbacks.splice(callbacks.indexOf(this.callback), 1);
      }
    }
    view.ResizeObserver = ControlledObserver;

    try {
      const { latest } = renderCanvas({}, (element) => {
        Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width });
      });

      expect(latest().width).toBe(744);

      width = 351.2;
      act(() => {
        for (const callback of callbacks) {
          callback();
        }
      });
      expect(latest().width).toBe(351);

      // Hidden (the panel switched away): the last real width is kept, so the
      // chart does not fall back to the unmeasured layout while out of view.
      width = 0;
      act(() => {
        for (const callback of callbacks) {
          callback();
        }
      });
      expect(latest().width).toBe(351);

      // Shown again at a new size: measured afresh.
      width = 1256;
      act(() => {
        for (const callback of callbacks) {
          callback();
        }
      });
      expect(latest().width).toBe(1256);

      cleanup();
      expect(callbacks).toHaveLength(0);
    } finally {
      view.ResizeObserver = original;
    }
  });

  it('measures with canvas metrics in the resolved label font', () => {
    const fonts: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
      let font = '10px sans-serif';
      return {
        get font() {
          return font;
        },
        set font(value: string) {
          fonts.push(value);
          font = value;
        },
        measureText: (text: string) => ({ width: splitGraphemes(text).length * 7 }),
      } as unknown as CanvasRenderingContext2D;
    });

    const { latest } = renderCanvas({ font: 'monoSm' }, (element) => {
      element.style.setProperty('--dg-mono-sm', '400 11px/16px monospace');
    });

    expect(latest().textMetricsExact).toBe(true);
    expect(latest().measureText('abcd')).toBe(28);
    expect(fonts).toContain('400 11px monospace');
  });

  it('falls back to the estimate when the engine rejects the font', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
      return {
        get font() {
          return '10px sans-serif';
        },
        set font(_value: string) {
          // An engine that cannot parse a font keeps its previous one.
        },
        measureText: () => ({ width: 99 }),
      } as unknown as CanvasRenderingContext2D;
    });

    const { latest } = renderCanvas({ font: 'monoSm' }, (element) => {
      element.style.setProperty('--dg-mono-sm', '400 13px/16px monospace');
    });

    // The fake context ignores the assignment and keeps 10px, so the hook must
    // not trust its metrics; the estimate uses the token's declared 13px.
    expect(latest().textMetricsExact).toBe(false);
    expect(latest().measureText('ab')).toBeCloseTo(estimateTextWidth('ab', 13));
  });
});
