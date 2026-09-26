/**
 * The fixed logical canvas width, lane compaction, layered-graph canvas size
 * and the drawn-row window in `./scale`.
 *
 * Every assertion here is exact: these helpers decide the coordinate system the
 * three canvases are drawn in, so a rounding change is a visual change.
 */

import { describe, expect, it } from 'vitest';

import {
  CHART_VIEWBOX_WIDTH,
  DEFAULT_GRAPH_COLUMN_GAP,
  DEFAULT_GRAPH_NODE_HEIGHT,
  DEFAULT_GRAPH_NODE_WIDTH,
  DEFAULT_MAX_TRACE_ROWS,
  MAX_DRAWN_ROWS,
  graphCanvasSize,
  nextWindowStart,
  previousWindowStart,
  rankLaneDepths,
  windowContains,
  windowRows,
  windowStartFor,
} from './scale';

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

describe('graphCanvasSize', () => {
  it('sizes a layered graph at its fixed rhythm, with gaps only between columns and rows', () => {
    expect(graphCanvasSize(6, 1)).toEqual({
      width: 6 * DEFAULT_GRAPH_NODE_WIDTH + 5 * DEFAULT_GRAPH_COLUMN_GAP,
      height: DEFAULT_GRAPH_NODE_HEIGHT,
    });
    expect(graphCanvasSize(2, 3, { columnGap: 80, rowGap: 10 })).toEqual({
      width: 2 * DEFAULT_GRAPH_NODE_WIDTH + 80,
      height: 3 * DEFAULT_GRAPH_NODE_HEIGHT + 2 * 10,
    });
  });

  it('declares no extent along an axis with no columns or rows, or an unusable count', () => {
    expect(graphCanvasSize(0, 0)).toEqual({ width: 0, height: 0 });
    expect(graphCanvasSize(0, 4).width).toBe(0);
    expect(graphCanvasSize(3, 0).height).toBe(0);
    expect(graphCanvasSize(Number.NaN, 2).width).toBe(0);
  });
});

describe('windowRows', () => {
  it('draws every row of a walk that fits the budget', () => {
    expect(windowRows(120)).toEqual({
      start: 0,
      end: 120,
      count: 120,
      total: 120,
      before: 0,
      after: 0,
      budget: MAX_DRAWN_ROWS,
    });
  });

  it('never draws more than the budget, and counts what it leaves out on both sides', () => {
    const window = windowRows(100_000, 4000);

    expect(window.count).toBe(MAX_DRAWN_ROWS);
    expect(window.start).toBe(4000);
    expect(window.end).toBe(4000 + MAX_DRAWN_ROWS);
    expect(window.before).toBe(4000);
    expect(window.after).toBe(100_000 - 4000 - MAX_DRAWN_ROWS);
    expect(window.before + window.count + window.after).toBe(window.total);
  });

  it('keeps a shrunken walk visible by pulling a start past its end back to the last window', () => {
    expect(windowRows(4500, 9000, 2000)).toMatchObject({ start: 4000, end: 4500, count: 500 });
    expect(windowRows(4000, 4000, 2000)).toMatchObject({ start: 2000, end: 4000, count: 2000 });
  });

  it('reads unusable arguments as their documented defaults', () => {
    expect(windowRows(Number.NaN, 5)).toMatchObject({ start: 0, end: 0, count: 0, total: 0 });
    expect(windowRows(-3)).toMatchObject({ total: 0, count: 0 });
    expect(windowRows(10, -4)).toMatchObject({ start: 0, end: 10 });
    expect(windowRows(10, 2.5)).toMatchObject({ start: 0 });
    expect(windowRows(10, 0, 0).budget).toBe(MAX_DRAWN_ROWS);
    expect(windowRows(10, 0, Number.POSITIVE_INFINITY).budget).toBe(MAX_DRAWN_ROWS);
  });

  it('is the same absolute budget as the default walk bound', () => {
    expect(MAX_DRAWN_ROWS).toBe(DEFAULT_MAX_TRACE_ROWS);
  });
});

describe('window navigation', () => {
  it('pages forward by the budget and stops at the last window', () => {
    const first = windowRows(4500, 0, 2000);
    const second = windowRows(4500, nextWindowStart(first), 2000);
    const third = windowRows(4500, nextWindowStart(second), 2000);

    expect([first.start, second.start, third.start]).toEqual([0, 2000, 4000]);
    expect(third.count).toBe(500);
    expect(nextWindowStart(third)).toBe(third.start);
  });

  it('pages back by the budget and never before the first row', () => {
    expect(previousWindowStart(windowRows(4500, 4000, 2000))).toBe(2000);
    expect(previousWindowStart(windowRows(4500, 500, 2000))).toBe(0);
    expect(previousWindowStart(windowRows(4500, 0, 2000))).toBe(0);
  });

  it('finds the aligned window that holds a row, so revealing one agrees with paging', () => {
    expect(windowStartFor(0, 2000)).toBe(0);
    expect(windowStartFor(1999, 2000)).toBe(0);
    expect(windowStartFor(2000, 2000)).toBe(2000);
    expect(windowStartFor(4321, 2000)).toBe(4000);
    expect(windowStartFor(Number.NaN, 2000)).toBe(0);
    expect(windowStartFor(3, 0)).toBe(0);
  });

  it('says whether a row is drawn', () => {
    const window = windowRows(4500, 2000, 2000);

    expect(windowContains(window, 1999)).toBe(false);
    expect(windowContains(window, 2000)).toBe(true);
    expect(windowContains(window, 3999)).toBe(true);
    expect(windowContains(window, 4000)).toBe(false);
    expect(windowContains(window, 2000.5)).toBe(false);
  });
});

describe('CHART_VIEWBOX_WIDTH', () => {
  it('is the fixed thousand-unit logical width every placement is a per-mille of', () => {
    expect(CHART_VIEWBOX_WIDTH).toBe(1000);
  });
});
