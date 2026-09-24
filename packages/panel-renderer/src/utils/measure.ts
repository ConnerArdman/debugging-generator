/**
 * Measurement — the one module in `./utils` that reads the DOM: how wide a
 * chart's viewport is, and how wide a string is in the font its labels are set
 * in.
 *
 * `Timeline`, `FlameChart` and `DependencyGraph` lay their SVG canvases out in
 * CSS pixels (see "Canvas width" in `./scale`), so each needs the inner width
 * of the scroll viewport it draws into, kept current as the panel is resized.
 * Their labels sit in or beside bars whose widths are data, so each needs to
 * know whether a label fits before drawing it — a character budget cannot
 * answer that, because glyphs differ in advance (an emoji is roughly two
 * columns wide in a monospace run) and a budget that is wrong by one glyph
 * draws the ellipsis outside the frame it was meant to end.
 *
 * ## Two halves
 *
 * - **Pure text fitting** — {@link splitGraphemes}, {@link estimateTextWidth},
 *   {@link createEstimateMeasure} and {@link fitTextToWidth} take a
 *   {@link TextMeasure} as an argument and touch nothing else, so they behave
 *   identically under test and in a browser.
 * - **The hook** — {@link useChartCanvas} observes a viewport element with
 *   `ResizeObserver`, resolves the label font from the element's computed
 *   typography token, and measures strings with a canvas 2D context in that
 *   font. It is the only code here with platform access.
 *
 * ## When nothing can be measured
 *
 * A test environment without layout reports a zero-width viewport and has no
 * canvas text metrics. The hook then reports `width: undefined` — a chart lays
 * out at `DEFAULT_CANVAS_WIDTH` and scales that drawing to its container — and
 * `measureText` falls back to {@link estimateTextWidth}, a deliberately
 * generous per-grapheme advance, so a label judged to fit by the estimate fits
 * in the real font too. Both fallbacks are deterministic, which is what lets
 * the chart suites assert label placement without stubbing layout.
 *
 * ## Layering
 *
 * Imports React (for the hook) and `../tokens/tokens` (to turn a typography
 * token key into its custom-property name, as `./color` does for colours).
 * Nothing in `./scale` or `./format` imports this module, and it imports
 * neither of them, so the utilities stay acyclic and `./scale` stays pure.
 * `src/index.ts` does not re-export `./utils`, so this surface is
 * package-internal.
 *
 * @packageDocumentation
 */

import { useCallback, useMemo, useState } from 'react';
import type { RefCallback } from 'react';

import { cssVarName } from '../tokens/tokens';
import type { TokenKey } from '../tokens/tokens';

/*
 * ---------------------------------------------------------------------------
 * Pure text fitting
 * ---------------------------------------------------------------------------
 */

/**
 * Measures a string's advance width in CSS pixels, in one fixed font.
 *
 * A measure is expected to be monotonic in the text — appending a grapheme
 * never makes a string narrower — which {@link fitTextToWidth} relies on to
 * search for a fit rather than try every length.
 */
export type TextMeasure = (text: string) => number;

/** The truncation mark every fitted label ends with: U+2026. */
export const ELLIPSIS = '\u2026';

/**
 * The advance {@link estimateTextWidth} assumes for one narrow grapheme, as a
 * fraction of the font size: 0.6 em, the advance of the common monospace faces
 * and wider than the average glyph of a proportional UI face, so the estimate
 * errs towards "does not fit".
 */
export const ESTIMATE_NARROW_ADVANCE_EM = 0.6;

/**
 * The advance {@link estimateTextWidth} assumes for one wide grapheme — an
 * emoji, or an East Asian wide or fullwidth character: 1.25 em, a little more
 * than a colour-emoji glyph or a CJK ideograph occupies.
 */
export const ESTIMATE_WIDE_ADVANCE_EM = 1.25;

/**
 * The font size, in CSS pixels, an estimate assumes when none is known: 11, the
 * size of the package's `monoSm` and `textXs` roles, which chart labels use.
 */
export const DEFAULT_LABEL_FONT_SIZE = 11;

/**
 * A grapheme that occupies two columns: an emoji (Extended_Pictographic), or a
 * character from the East Asian wide and fullwidth blocks.
 */
const WIDE_GRAPHEME =
  /[\p{Extended_Pictographic}\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;

/** A user-perceived-character segmenter, where the platform provides one. */
const GRAPHEME_SEGMENTER: Intl.Segmenter | undefined =
  typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

/**
 * Splits `text` into graphemes — user-perceived characters — so a truncation
 * never cuts an emoji's surrogate pair, a flag's regional-indicator pair or a
 * letter from its combining accent.
 *
 * Uses `Intl.Segmenter` where available and falls back to code points, which
 * still keeps surrogate pairs together.
 */
export function splitGraphemes(text: string): string[] {
  if (GRAPHEME_SEGMENTER !== undefined) {
    return Array.from(GRAPHEME_SEGMENTER.segment(text), (segment) => segment.segment);
  }
  return Array.from(text);
}

/** `value` when it is finite and strictly positive, otherwise `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * An estimate of `text`'s advance width at `fontSize` pixels, for when no font
 * metrics are available: {@link ESTIMATE_NARROW_ADVANCE_EM} per grapheme and
 * {@link ESTIMATE_WIDE_ADVANCE_EM} per wide grapheme.
 *
 * Deterministic and platform-free. A non-finite or non-positive `fontSize`
 * uses {@link DEFAULT_LABEL_FONT_SIZE}.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  const size = positiveOr(fontSize, DEFAULT_LABEL_FONT_SIZE);
  let ems = 0;
  for (const grapheme of splitGraphemes(text)) {
    ems += WIDE_GRAPHEME.test(grapheme) ? ESTIMATE_WIDE_ADVANCE_EM : ESTIMATE_NARROW_ADVANCE_EM;
  }
  return ems * size;
}

/** A {@link TextMeasure} backed by {@link estimateTextWidth} at `fontSize`. */
export function createEstimateMeasure(fontSize: number = DEFAULT_LABEL_FONT_SIZE): TextMeasure {
  const size = positiveOr(fontSize, DEFAULT_LABEL_FONT_SIZE);
  return (text) => estimateTextWidth(text, size);
}

/** A string that fits a width, as {@link fitTextToWidth} returns it. */
export interface TextFit {
  /** The text to draw: the input unchanged, or a prefix ending in {@link ELLIPSIS}. */
  readonly text: string;
  /** Its measured advance width in CSS pixels, never more than the width asked for. */
  readonly width: number;
  /** Whether the input was shortened. */
  readonly truncated: boolean;
}

/** Options of {@link fitTextToWidth}. */
export interface FitTextOptions {
  /**
   * The fewest graphemes of the input a truncated result may keep before its
   * ellipsis; a width that cannot hold that many yields no fit at all. Defaults
   * to `1`. A label of one letter and an ellipsis still identifies a frame in a
   * sequence; a caller for whom it would not raises this.
   */
  readonly minGraphemes?: number;
}

/** A measure's answer made safe to compare: a non-finite or negative width never fits. */
function measured(measure: TextMeasure, text: string): number {
  const width = measure(text);
  return typeof width === 'number' && Number.isFinite(width) && width >= 0
    ? width
    : Number.POSITIVE_INFINITY;
}

/**
 * The longest form of `text` that fits `maxWidth` pixels in the font `measure`
 * measures in: the whole string when it fits, otherwise the longest grapheme
 * prefix that fits with {@link ELLIPSIS} appended, otherwise `undefined`.
 *
 * Trailing whitespace is trimmed before the ellipsis, so a cut never draws
 * "name …". The search is a binary search over prefix lengths, so fitting a
 * long label costs a logarithmic number of measurements.
 *
 * `undefined` — draw nothing — is returned for empty text, for a `maxWidth`
 * that is not finite and positive, and when not even `minGraphemes` graphemes
 * and the ellipsis fit.
 *
 * @param text The label.
 * @param maxWidth The room available, in CSS pixels.
 * @param measure Measures a string in the label's font.
 * @param options The shortest acceptable prefix.
 */
export function fitTextToWidth(
  text: string,
  maxWidth: number,
  measure: TextMeasure,
  options: FitTextOptions = {},
): TextFit | undefined {
  if (text.length === 0 || !(Number.isFinite(maxWidth) && maxWidth > 0)) {
    return undefined;
  }

  const whole = measured(measure, text);
  if (whole <= maxWidth) {
    return { text, width: whole, truncated: false };
  }

  const graphemes = splitGraphemes(text);
  const requested = options.minGraphemes;
  const minimum =
    typeof requested === 'number' && Number.isInteger(requested) && requested > 0 ? requested : 1;

  let low = minimum;
  let high = graphemes.length - 1;
  let best: TextFit | undefined;

  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const prefix = graphemes.slice(0, keep).join('').trimEnd();
    const candidate = prefix + ELLIPSIS;
    const width = measured(measure, candidate);

    if (width <= maxWidth) {
      // A prefix of nothing but whitespace trims to a bare ellipsis, which
      // names nothing; it is not a fit, but a longer prefix may still be.
      if (prefix.length > 0) {
        best = { text: candidate, width, truncated: true };
      }
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }

  return best;
}

/*
 * ---------------------------------------------------------------------------
 * Platform measurement
 * ---------------------------------------------------------------------------
 */

/** How many distinct strings one canvas measure caches before starting over. */
const MEASURE_CACHE_LIMIT = 4096;

/** The pixel size a CSS `font` shorthand declares, if it declares one in pixels. */
function fontSizeOf(font: string | undefined): number | undefined {
  const match = font === undefined ? null : /(\d+(?:\.\d+)?)px/.exec(font);
  const size = match === null ? Number.NaN : Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/**
 * A typography token's value as a canvas `font`: the `/line-height` component
 * is dropped, since a canvas has no line box and some engines reject it.
 */
function canvasFont(font: string): string {
  return font.replace(/(\d(?:[\d.]*)(?:px|pt|em|rem|%))\s*\/\s*[^\s,]+/, '$1').trim();
}

/**
 * A {@link TextMeasure} that measures with a canvas 2D context set to `font`,
 * or `undefined` where the platform has no usable canvas text metrics (a
 * layout-free test environment) or rejects the font.
 */
function createCanvasMeasure(document: Document, font: string): TextMeasure | undefined {
  let context: CanvasRenderingContext2D | null;
  try {
    context = document.createElement('canvas').getContext('2d');
  } catch {
    return undefined;
  }
  if (context === null || typeof context.measureText !== 'function') {
    return undefined;
  }

  const declared = canvasFont(font);
  context.font = declared;
  const size = fontSizeOf(declared);
  // An engine that rejects a font keeps its previous one; a context whose font
  // does not carry the declared size is measuring in something else.
  if (size === undefined || fontSizeOf(context.font) !== size) {
    return undefined;
  }
  if (!(context.measureText('M').width > 0)) {
    return undefined;
  }

  const metrics = context;
  const cache = new Map<string, number>();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) {
      return hit;
    }
    if (cache.size >= MEASURE_CACHE_LIMIT) {
      cache.clear();
    }
    const width = metrics.measureText(text).width;
    cache.set(text, width);
    return width;
  };
}

/**
 * The content-box width of `element` in whole CSS pixels — its client width
 * less its inline padding, so a vertical scrollbar is already excluded — or
 * `undefined` when there is no layout to report one.
 */
function contentWidthOf(element: HTMLElement): number | undefined {
  const view = element.ownerDocument.defaultView;
  const style = view === null ? undefined : view.getComputedStyle(element);
  const padding =
    style === undefined
      ? 0
      : (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const width = Math.floor(element.clientWidth - padding);
  return Number.isFinite(width) && width >= 1 ? width : undefined;
}

/** Options of {@link useChartCanvas}. */
export interface ChartCanvasOptions {
  /**
   * The typography token the chart's labels are set in, for example `monoSm`.
   * `measureText` measures in the font it resolves to on the viewport element;
   * without it, `measureText` is the estimate.
   */
  readonly font?: TokenKey | undefined;
  /**
   * The font size the estimate assumes while the token has not resolved.
   * Defaults to the size the token declares, else
   * {@link DEFAULT_LABEL_FONT_SIZE}.
   */
  readonly fallbackFontSize?: number | undefined;
}

/** What {@link useChartCanvas} reports about one chart's viewport. */
export interface ChartCanvas<T extends HTMLElement> {
  /**
   * Attach to the chart's scroll viewport — the element the canvas is drawn
   * into — not to the canvas itself, whose width is the result.
   */
  readonly ref: RefCallback<T>;
  /**
   * The viewport's inner width in whole CSS pixels, or `undefined` until it has
   * been measured and wherever there is no layout. Once measured, a later zero
   * reading — the viewport hidden — keeps the last width. Pass it to
   * `resolveCanvasWidth` (`./scale`).
   */
  readonly width: number | undefined;
  /**
   * Measures a string in the labels' font. Stable until the font changes, so it
   * is safe as a `useMemo` dependency of a chart's geometry.
   */
  readonly measureText: TextMeasure;
  /** Whether `measureText` uses the rendered font rather than the estimate. */
  readonly textMetricsExact: boolean;
}

/**
 * Observes a chart's viewport: its inner width, kept current with
 * `ResizeObserver`, and a text measure in the chart's label font.
 *
 * The first measurement is taken while React attaches the ref, in the commit
 * that mounts the viewport, and the state it sets is flushed before the
 * browser paints — so a measured chart never shows a frame at the fallback
 * width. Later measurements follow every resize of the viewport; an unchanged
 * whole-pixel width sets no state, so a resize that moves nothing re-renders
 * nothing.
 *
 * The viewport should not take its inline size from its content (the package
 * stylesheet gives chart viewports inline-size containment), otherwise a
 * canvas drawn at the measured width would hold the viewport at that width and
 * the chart could never shrink.
 *
 * @param options The label font token and the estimate's fallback size.
 */
export function useChartCanvas<T extends HTMLElement = HTMLDivElement>(
  options: ChartCanvasOptions = {},
): ChartCanvas<T> {
  const fontVariable = options.font === undefined ? undefined : cssVarName(options.font);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const [resolved, setResolved] = useState<ResolvedFont | undefined>(undefined);

  const ref = useCallback(
    (element: T | null) => {
      if (element === null) {
        return undefined;
      }
      const document = element.ownerDocument;
      const view = document.defaultView;
      // The font this attachment last read, so a web-font load can rebuild the
      // measure for it.
      let currentFont: string | undefined;

      const update = (): void => {
        const nextWidth = contentWidthOf(element);
        // A viewport that measures nothing after it has measured something has
        // been hidden (a DevTools panel switched away, a collapsed section, a
        // `display: none` ancestor), not narrowed to nothing: the last real
        // width is kept, so the chart is not re-laid out at the unmeasured
        // fallback — and shown stretched for the frame before the next
        // measurement — every time it is hidden and shown again.
        setWidth((previous) =>
          nextWidth === undefined || previous === nextWidth ? previous : nextWidth,
        );
        if (fontVariable !== undefined && view !== null) {
          const value = view.getComputedStyle(element).getPropertyValue(fontVariable).trim();
          const nextFont = value === '' ? undefined : value;
          currentFont = nextFont;
          // Compared against the state rather than this closure, so an
          // unchanged font sets no state however often the ref is re-attached
          // (a caller composing refs inline re-attaches on every render). The
          // measure is built inside the updater only when the font changed;
          // building one is idempotent, so a repeated call is harmless.
          setResolved((previous) => {
            if (nextFont === undefined) {
              return undefined;
            }
            return previous?.font === nextFont
              ? previous
              : { font: nextFont, measure: createCanvasMeasure(document, nextFont) };
          });
        }
      };
      update();

      const Observer = view?.ResizeObserver;
      const observer = typeof Observer === 'function' ? new Observer(update) : undefined;
      observer?.observe(element);

      // A web font that finishes loading changes every advance width, so the
      // measure (and its cache) is rebuilt and the chart re-fits its labels.
      const fonts = document.fonts as FontFaceSet | undefined;
      const onFontsLoaded = (): void => {
        const font = currentFont;
        if (font !== undefined) {
          setResolved({ font, measure: createCanvasMeasure(document, font) });
        }
      };
      fonts?.addEventListener('loadingdone', onFontsLoaded);

      return () => {
        observer?.disconnect();
        fonts?.removeEventListener('loadingdone', onFontsLoaded);
      };
    },
    [fontVariable],
  );

  const fallbackFontSize = positiveOr(
    options.fallbackFontSize,
    fontSizeOf(resolved?.font) ?? DEFAULT_LABEL_FONT_SIZE,
  );
  const estimate = useMemo(() => createEstimateMeasure(fallbackFontSize), [fallbackFontSize]);
  const exact = resolved?.measure;

  return {
    ref,
    width,
    measureText: exact ?? estimate,
    textMetricsExact: exact !== undefined,
  };
}

/** The label font a viewport resolved, and the canvas measure built for it. */
interface ResolvedFont {
  /** The token's computed value, a CSS `font` shorthand. */
  readonly font: string;
  /** A canvas measure in that font, or `undefined` where there are no canvas metrics. */
  readonly measure: TextMeasure | undefined;
}
