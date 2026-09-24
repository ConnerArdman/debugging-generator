/**
 * Canvas sizing, lane compaction and graph column fitting in `./scale` — the
 * pure half of laying the SVG views out in CSS pixels from a measured
 * container (the measuring half is `./measure`).
 *
 * Every assertion here is exact: these helpers decide the coordinate system the
 * three canvases are drawn in, so a rounding change is a visual change.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_GRAPH_COLUMN_GAP,
  DEFAULT_GRAPH_NODE_WIDTH,
  MAX_GRAPH_COLUMN_GAP,
  MIN_CANVAS_WIDTH,
  MIN_GRAPH_COLUMN_GAP,
  fitGraphColumnGap,
  graphCanvasSize,
  isMeasuredWidth,
  rankLaneDepths,
  resolveCanvasWidth,
} from './scale';

describe('resolveCanvasWidth', () => {
  it('draws a measured container at its whole-pixel width', () => {
    expect(resolveCanvasWidth(1256)).toBe(1256);
    expect(resolveCanvasWidth(351.75)).toBe(351);
  });

  it('never draws narrower than the minimum, so a narrow viewport scrolls instead', () => {
    expect(resolveCanvasWidth(200)).toBe(MIN_CANVAS_WIDTH);
    expect(resolveCanvasWidth(200, { min: 480 })).toBe(480);
    expect(resolveCanvasWidth(200, { min: 0 })).toBe(200);
  });

  it('falls back to the unmeasured coordinate width when nothing was measured', () => {
    for (const unmeasured of [undefined, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, -40]) {
      expect(resolveCanvasWidth(unmeasured)).toBe(DEFAULT_CANVAS_WIDTH);
    }
    expect(resolveCanvasWidth(undefined, { fallback: 640 })).toBe(640);
  });

  it('sanitises unusable options back to their defaults', () => {
    expect(resolveCanvasWidth(undefined, { fallback: Number.NaN })).toBe(DEFAULT_CANVAS_WIDTH);
    expect(resolveCanvasWidth(undefined, { fallback: -1 })).toBe(DEFAULT_CANVAS_WIDTH);
    expect(resolveCanvasWidth(100, { min: Number.NaN })).toBe(MIN_CANVAS_WIDTH);
    expect(resolveCanvasWidth(100, { min: -5 })).toBe(MIN_CANVAS_WIDTH);
  });
});

describe('isMeasuredWidth', () => {
  it('accepts a finite width of at least one pixel only', () => {
    expect(isMeasuredWidth(1)).toBe(true);
    expect(isMeasuredWidth(744)).toBe(true);
    expect(isMeasuredWidth(0)).toBe(false);
    expect(isMeasuredWidth(0.99)).toBe(false);
    expect(isMeasuredWidth(undefined)).toBe(false);
    expect(isMeasuredWidth(Number.NaN)).toBe(false);
    expect(isMeasuredWidth(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('rankLaneDepths', () => {
  it('gives each distinct depth its own row with no gap for depths nothing occupies', () => {
    const { rowOf, rowCount } = rankLaneDepths([5, 1, 5]);

    expect(rowCount).toBe(2);
    expect(rowOf.get(1)).toBe(0);
    expect(rowOf.get(5)).toBe(1);
  });

  it('keeps nesting order: a deeper span still sits below a shallower one', () => {
    const { rowOf, rowCount } = rankLaneDepths([4, 2, 7, 3]);

    expect(rowCount).toBe(4);
    expect([2, 3, 4, 7].map((depth) => rowOf.get(depth))).toEqual([0, 1, 2, 3]);
  });

  it('reads an unusable depth as the root and leaves the input untouched', () => {
    const depths = [Number.NaN, -3, 1.5, 2];
    const { rowOf, rowCount } = rankLaneDepths(depths);

    expect(rowCount).toBe(2);
    expect(rowOf.get(0)).toBe(0);
    expect(rowOf.get(2)).toBe(1);
    expect(depths).toEqual([Number.NaN, -3, 1.5, 2]);
  });

  it('reports no rows for an empty lane', () => {
    expect(rankLaneDepths([]).rowCount).toBe(0);
  });
});

describe('fitGraphColumnGap', () => {
  it('spreads the columns so the canvas fills the container', () => {
    const gap = fitGraphColumnGap(1256, 6);
    const { width } = graphCanvasSize(6, 1, { columnGap: gap });

    expect(gap).toBe(49);
    expect(width).toBeLessThanOrEqual(1256);
    expect(1256 - width).toBeLessThan(6);
  });

  it('stops spreading at the widest gap, leaving the rest of a wide container empty', () => {
    expect(fitGraphColumnGap(4000, 3)).toBe(MAX_GRAPH_COLUMN_GAP);
  });

  it('tightens to the narrowest gap and no further, so a narrow container scrolls', () => {
    const gap = fitGraphColumnGap(351, 6);

    expect(gap).toBe(MIN_GRAPH_COLUMN_GAP);
    expect(graphCanvasSize(6, 1, { columnGap: gap }).width).toBe(
      6 * DEFAULT_GRAPH_NODE_WIDTH + 5 * MIN_GRAPH_COLUMN_GAP,
    );
  });

  it('keeps the unmeasured rhythm when there is no width or no gap to size', () => {
    expect(fitGraphColumnGap(undefined, 6)).toBe(DEFAULT_GRAPH_COLUMN_GAP);
    expect(fitGraphColumnGap(0, 6)).toBe(DEFAULT_GRAPH_COLUMN_GAP);
    expect(fitGraphColumnGap(1256, 1)).toBe(DEFAULT_GRAPH_COLUMN_GAP);
    expect(fitGraphColumnGap(1256, 0)).toBe(DEFAULT_GRAPH_COLUMN_GAP);
  });

  it('honours custom bounds and box width, swapping inverted bounds', () => {
    expect(fitGraphColumnGap(1000, 4, { nodeWidth: 100, minGap: 10, maxGap: 500 })).toBe(200);
    expect(fitGraphColumnGap(1000, 4, { nodeWidth: 100, minGap: 150, maxGap: 50 })).toBe(150);
  });
});
