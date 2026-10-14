/**
 * The fixed logical canvas width, lane compaction, layered-graph canvas size,
 * the layered graph's row bound and count-label placement, and the drawn-row
 * window in `./scale`.
 *
 * Every assertion here is exact: these helpers decide the coordinate system the
 * three canvases are drawn in, so a rounding change is a visual change.
 */

import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
} from '@debuggen/telemetry';
import { describe, expect, it } from 'vitest';

import { DESIGN_TOKENS } from '../tokens/tokens';
import {
  CHART_VIEWBOX_WIDTH,
  DEFAULT_GRAPH_COLUMN_GAP,
  DEFAULT_GRAPH_MAX_ROWS,
  DEFAULT_GRAPH_NODE_HEIGHT,
  DEFAULT_GRAPH_NODE_WIDTH,
  DEFAULT_GRAPH_ROW_GAP,
  DEFAULT_MAX_TRACE_ROWS,
  LABEL_ASCENT_EM,
  LABEL_DESCENT_EM,
  MAX_DRAWN_ROWS,
  graphCanvasSize,
  layoutDependencyGraph,
  nextWindowStart,
  placeEdgeLabels,
  planGraphRows,
  previousWindowStart,
  rankLaneDepths,
  windowContains,
  windowRows,
  windowStartFor,
} from './scale';
import type {
  DependencyGraphLayout,
  EdgeLabelLayout,
  EdgeLabelMetrics,
  GraphNodeBox,
  GraphRect,
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

/*
 * ---------------------------------------------------------------------------
 * Layered graph fixtures
 *
 * Application-neutral participants and relationships. Every participant
 * carries its layer, so each case reads its columns straight off the fixture,
 * and the boxes sit at the default rhythm: 168 by 44, 56 between columns and
 * 16 between rows.
 * ---------------------------------------------------------------------------
 */

/** One participant in column `layer`, standing for one record of `totalDurationMs`. */
function participant(id: string, layer: number, totalDurationMs = 10): DependencyGraphNode {
  return {
    id,
    kind: 'function',
    label: id,
    spanIds: [],
    count: 1,
    totalDurationMs,
    maxDurationMs: totalDurationMs,
    layer,
  };
}

/** One relationship that ran `count` times. */
function relationship(from: string, to: string, count: number): DependencyGraphEdge {
  return { id: `${from}=>${to}`, from, to, count, totalDurationMs: count };
}

/** A graph of these participants and relationships, whole and unbounded. */
function graphOf(
  nodes: readonly DependencyGraphNode[],
  edges: readonly DependencyGraphEdge[],
): DependencyGraphData {
  const layerCount = nodes.reduce((most, node) => Math.max(most, (node.layer ?? 0) + 1), 0);
  return { nodes, edges, layerCount, truncated: false };
}

/** The participant a star fans out from. */
const SOURCE_ID = 'example.source';

/** The id of a star's `index`-th target: `example.target.07`. */
function targetId(index: number): string {
  return `example.target.${String(index).padStart(2, '0')}`;
}

/**
 * One participant in column 0 calling `size` participants in column 1, listed
 * costliest first as the aggregate orders them; the relationship to the
 * `index`-th target ran `index + 2` times, so every one carries a count label.
 */
function star(size: number): DependencyGraphData {
  const targets = Array.from({ length: size }, (_, index) =>
    participant(targetId(index), 1, 1000 - index),
  );
  return graphOf(
    [participant(SOURCE_ID, 0, 5000), ...targets],
    targets.map((target, index) => relationship(SOURCE_ID, target.id, index + 2)),
  );
}

/** A three-participant chain, one column each, whose two relationships each repeated. */
function chain(): DependencyGraphData {
  return graphOf(
    [participant('example.a', 0), participant('example.b', 1), participant('example.c', 2)],
    [relationship('example.a', 'example.b', 3), relationship('example.b', 'example.c', 4)],
  );
}

/** The distance from one row's top to the next row's. */
const ROW_PITCH = DEFAULT_GRAPH_NODE_HEIGHT + DEFAULT_GRAPH_ROW_GAP;

/** The distance from one column's left edge to the next column's. */
const COLUMN_PITCH = DEFAULT_GRAPH_NODE_WIDTH + DEFAULT_GRAPH_COLUMN_GAP;

/** The vertical centre of row `row`, where its connectors anchor. */
function rowCentre(row: number): number {
  return row * ROW_PITCH + DEFAULT_GRAPH_NODE_HEIGHT / 2;
}

/** The value, or a failure naming what was missing. */
function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} is missing`);
  }
  return value;
}

describe('DEFAULT_GRAPH_MAX_ROWS', () => {
  it('keeps a bounded column, outline included, inside the viewport cap of every theme', () => {
    // The cap is `--dg-scroll-cap-md`: sixteen steps of `--dg-space-7`. The
    // bound was chosen against that token, so a change to either must keep
    // this inequality — which is the whole point of stating it as a test.
    const OUTLINE_INSET = 1;
    const drawn = graphCanvasSize(1, DEFAULT_GRAPH_MAX_ROWS).height + 2 * OUTLINE_INSET;

    expect(DEFAULT_GRAPH_MAX_ROWS).toBe(6);
    expect(drawn).toBe(6 * DEFAULT_GRAPH_NODE_HEIGHT + 5 * DEFAULT_GRAPH_ROW_GAP + 2);

    const CAP = /^calc\(var\(--dg-space-7\) \* (\d+)\)$/;
    for (const theme of [DESIGN_TOKENS.dark, DESIGN_TOKENS.light, DESIGN_TOKENS.highContrast]) {
      const factor = Number(CAP.exec(theme.scrollCapMd)?.[1]);
      const cap = Number.parseFloat(theme.space7) * factor;

      expect(Number.isFinite(cap)).toBe(true);
      expect(drawn).toBeLessThanOrEqual(cap);
    }
  });
});

describe('planGraphRows', () => {
  it('draws every participant of a column no taller than the bound in a box of its own', () => {
    const plan = planGraphRows(star(DEFAULT_GRAPH_MAX_ROWS));

    expect(plan.overflow).toEqual([]);
    expect(plan.gatheredCount).toBe(0);
    expect(plan.rowCount).toBe(DEFAULT_GRAPH_MAX_ROWS);
    expect(plan.nodeSlots.map(({ layer, row, collapsed }) => [layer, row, collapsed])).toEqual([
      [0, 0, false],
      ...Array.from({ length: DEFAULT_GRAPH_MAX_ROWS }, (_, row) => [1, row, false]),
    ]);
    expect(plan.connectors.map(({ count }) => count)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('draws the first five of a taller column and gathers the rest into an overflow box in its sixth row', () => {
    const data = star(20);
    const plan = planGraphRows(data);

    expect(plan).toMatchObject({
      maxRowsPerLayer: 6,
      rowCount: 6,
      maxNodesPerLayer: 20,
      layerCount: 2,
      gatheredCount: 15,
    });

    // Every participant keeps a slot, index-aligned with the input: the source,
    // the five costliest targets in rows 0 to 4, and the rest in the overflow
    // box's row.
    expect(plan.nodeSlots).toHaveLength(21);
    expect(plan.nodeSlots.slice(1, 6).map(({ row, collapsed }) => [row, collapsed])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, false],
      [4, false],
    ]);
    expect(
      plan.nodeSlots.slice(6).every((slot) => slot.layer === 1 && slot.row === 5 && slot.collapsed),
    ).toBe(true);

    const group = defined(plan.overflow[0], 'the overflow group');
    expect(plan.overflow).toHaveLength(1);
    expect([group.layer, group.row]).toEqual([1, 5]);
    expect(group.nodes.map(({ id }) => id)).toEqual(data.nodes.slice(6).map(({ id }) => id));
  });

  it('merges the relationships to gathered participants into one connector whose count is their sum', () => {
    const plan = planGraphRows(star(20));

    // Every relationship is still in the plan; only the curves merge.
    expect(plan.edges).toHaveLength(20);
    expect(plan.connectors.map(({ key }) => key)).toEqual([
      '0:0>1:0',
      '0:0>1:1',
      '0:0>1:2',
      '0:0>1:3',
      '0:0>1:4',
      '0:0>1:5',
    ]);
    expect(plan.connectors.slice(0, 5).map(({ count }) => count)).toEqual([2, 3, 4, 5, 6]);

    // Targets 5 to 19 ran 7 to 21 times: 210 records behind one curve.
    const merged = defined(plan.connectors.at(-1), 'the merged connector');
    expect(merged.edges.map(({ to }) => to)).toEqual(
      Array.from({ length: 15 }, (_, index) => targetId(index + 5)),
    );
    expect(merged.count).toBe(210);
  });

  it('draws no connector from a box to itself, though the relationship stays in the plan', () => {
    const base = star(8);
    const plan = planGraphRows(
      graphOf(base.nodes, [
        ...base.edges,
        // Two participants gathered into the same overflow box, and a
        // participant calling itself.
        relationship(targetId(5), targetId(6), 4),
        relationship(SOURCE_ID, SOURCE_ID, 3),
      ]),
    );

    expect(plan.edges).toHaveLength(10);
    expect(plan.connectors).toHaveLength(6);
    expect(
      plan.connectors.some(({ from, to }) => from.layer === to.layer && from.row === to.row),
    ).toBe(false);
  });

  it('plans the same connectors for any order the relationships arrive in', () => {
    const data = star(20);
    const summary = (graph: DependencyGraphData): (string | number)[][] =>
      planGraphRows(graph).connectors.map(({ key, count }) => [key, count]);

    expect(summary({ ...data, edges: data.edges.toReversed() })).toEqual(summary(data));
  });

  it('honours a usable row bound and reads an unusable one as the default', () => {
    expect(planGraphRows(star(20), { maxRowsPerLayer: 3 })).toMatchObject({
      maxRowsPerLayer: 3,
      rowCount: 3,
      gatheredCount: 18,
    });

    for (const maxRowsPerLayer of [1, 0, -4, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planGraphRows(star(20), { maxRowsPerLayer }).maxRowsPerLayer).toBe(
        DEFAULT_GRAPH_MAX_ROWS,
      );
    }
  });

  it('counts a relationship naming a participant the graph does not contain as dropped', () => {
    const plan = planGraphRows(
      graphOf(chain().nodes, [...chain().edges, relationship('example.a', 'example.absent', 2)]),
    );

    expect(plan.droppedEdgeCount).toBe(1);
    expect(plan.edges).toHaveLength(2);
    expect(plan.connectors).toHaveLength(2);
  });
});

describe('layoutDependencyGraph with a row bound', () => {
  it("anchors every gathered participant, and every relationship to one, on its column's overflow box", () => {
    const layout = layoutDependencyGraph(star(20));
    const overflow = defined(layout.overflow[0], 'the overflow box');

    expect(layout.overflow).toHaveLength(1);
    expect(overflow.box).toMatchObject({
      layer: 1,
      indexInLayer: 5,
      x: COLUMN_PITCH,
      y: 5 * ROW_PITCH,
    });
    expect(overflow.nodes).toHaveLength(15);

    const gathered = layout.nodes.filter(({ collapsed }) => collapsed);
    expect(gathered).toHaveLength(15);
    expect(gathered.every(({ box }) => box === overflow.box)).toBe(true);

    const merged = defined(layout.connectors.at(-1), 'the merged connector');
    expect(layout.connectors).toHaveLength(6);
    expect(merged.target).toBe(overflow.box);
    expect(merged.anchors.target).toEqual({ x: overflow.box.x, y: overflow.box.centerY });

    // Every relationship is still enumerated, anchored where it is drawn.
    expect(layout.edges).toHaveLength(20);
    expect(
      layout.edges.slice(5).every(({ anchors }) => anchors.target.y === overflow.box.centerY),
    ).toBe(true);

    // And the canvas is six rows tall, not twenty.
    expect(layout).toMatchObject({
      rowCount: 6,
      maxRowsPerLayer: 6,
      maxNodesPerLayer: 20,
      gatheredCount: 15,
      height: graphCanvasSize(2, 6).height,
    });
  });

  it('draws the plan it is handed, and makes the same one itself when it is not', () => {
    const data = star(20);
    const plan = planGraphRows(data, { maxRowsPerLayer: 3 });
    const handed = layoutDependencyGraph(data, undefined, undefined, plan);

    expect(handed).toMatchObject({ rowCount: 3, gatheredCount: 18 });
    expect(layoutDependencyGraph(data, { maxRowsPerLayer: 3 })).toEqual(handed);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Count-label placement
 *
 * The metrics the dependency graph places its labels with: an 11-unit mono
 * role, 4 units of clearance and a 1-unit outline reach, so a label's ink
 * keeps 5 units from every box. Every label here is 24 units wide.
 * ---------------------------------------------------------------------------
 */

const METRICS: EdgeLabelMetrics = { fontSize: 11, clearance: 4, outlineInset: 1 };

/** The clear space between a label's ink and a box's edge. */
const REACH = METRICS.clearance + METRICS.outlineInset;

/** Every fixture label's advance. */
const LABEL_WIDTH = 24;

/** A width for every connector that stands for more than one record. */
function labelWidths(
  layout: DependencyGraphLayout,
  width: number = LABEL_WIDTH,
): ReadonlyMap<string, number> {
  return new Map(
    layout.connectors.filter(({ count }) => count > 1).map(({ key }) => [key, width] as const),
  );
}

/** Lays `data` out and places its labels. */
function placed(data: DependencyGraphData): {
  readonly layout: DependencyGraphLayout;
  readonly labels: EdgeLabelLayout;
} {
  const layout = layoutDependencyGraph(data);
  return { layout, labels: placeEdgeLabels(layout, labelWidths(layout), METRICS) };
}

/** A box's rectangle, grown by `by` on every side. */
function grownBox(box: GraphNodeBox, by: number): GraphRect {
  return {
    left: box.x - by,
    top: box.y - by,
    right: box.x + box.width + by,
    bottom: box.y + box.height + by,
  };
}

/** Whether two rectangles share any area; touching edges do not. */
function overlaps(a: GraphRect, b: GraphRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** A label's ink box, centred on `x` with its baseline at `y`. */
function inkAt(x: number, y: number, width: number = LABEL_WIDTH): GraphRect {
  return {
    left: x - width / 2,
    top: y - METRICS.fontSize * LABEL_ASCENT_EM,
    right: x + width / 2,
    bottom: y + METRICS.fontSize * LABEL_DESCENT_EM,
  };
}

/** Every placed label keeps its clearance from every drawn box and every other label. */
function expectClearOfEverything(layout: DependencyGraphLayout, labels: EdgeLabelLayout): void {
  const boxes = [
    ...layout.nodes.filter(({ collapsed }) => !collapsed).map(({ box }) => box),
    ...layout.overflow.map(({ box }) => box),
  ];

  for (const [index, placement] of labels.placed.entries()) {
    for (const box of boxes) {
      expect(overlaps(placement.bounds, grownBox(box, REACH))).toBe(false);
    }
    for (const other of labels.placed.slice(index + 1)) {
      const spaced = {
        left: placement.bounds.left - METRICS.clearance,
        top: placement.bounds.top - METRICS.clearance,
        right: placement.bounds.right + METRICS.clearance,
        bottom: placement.bounds.bottom + METRICS.clearance,
      };
      expect(overlaps(spaced, other.bounds)).toBe(false);
    }
  }
}

describe('placeEdgeLabels', () => {
  it("keeps a plain chain's counts centred in their gaps", () => {
    const { labels } = placed(chain());
    const firstGap = DEFAULT_GRAPH_NODE_WIDTH + DEFAULT_GRAPH_COLUMN_GAP / 2;

    expect(labels.suppressed).toEqual([]);
    expect(labels.placed).toEqual([
      {
        key: '0:0>1:0',
        position: 'midpoint',
        x: firstGap,
        y: rowCentre(0),
        bounds: inkAt(firstGap, rowCentre(0)),
      },
      {
        key: '1:0>2:0',
        position: 'midpoint',
        x: firstGap + COLUMN_PITCH,
        y: rowCentre(0),
        bounds: inkAt(firstGap + COLUMN_PITCH, rowCentre(0)),
      },
    ]);
  });

  it("places a fan-out star's twenty counts beside their targets, clear of every box and of each other", () => {
    const layout = layoutDependencyGraph(star(20), { maxRowsPerLayer: 21 });
    const labels = placeEdgeLabels(layout, labelWidths(layout), METRICS);

    expect(labels.suppressed).toEqual([]);
    expect(labels.placed).toHaveLength(20);
    for (const [row, placement] of labels.placed.entries()) {
      expect(placement.position).toBe('near-target');
      expect(placement.x).toBe(COLUMN_PITCH - REACH - LABEL_WIDTH / 2);
      expect(placement.y).toBe(rowCentre(row));
    }
    expectClearOfEverything(layout, labels);
  });

  it("places a bounded star's summed count beside its overflow box", () => {
    const { layout, labels } = placed(star(20));

    expect(labels.suppressed).toEqual([]);
    expect(labels.placed.map(({ position }) => position)).toEqual(
      Array.from({ length: 6 }, () => 'near-target'),
    );
    expect(labels.placed.at(-1)).toMatchObject({ key: '0:0>1:5', y: rowCentre(5) });
    expect(layout.connectors.at(-1)?.count).toBe(210);
    expectClearOfEverything(layout, labels);
  });

  it("places a fan-in's counts beside their sources", () => {
    const callers = [0, 1, 2].map((index) =>
      participant(`example.caller.${String(index)}`, 0, 30 - index),
    );
    const { layout, labels } = placed(
      graphOf(
        [...callers, participant('example.callee', 1)],
        callers.map((caller, index) => relationship(caller.id, 'example.callee', index + 2)),
      ),
    );

    expect(labels.placed.map(({ position, x, y }) => [position, x, y])).toEqual(
      callers.map((_, row) => [
        'near-source',
        DEFAULT_GRAPH_NODE_WIDTH + REACH + LABEL_WIDTH / 2,
        rowCentre(row),
      ]),
    );
    expectClearOfEverything(layout, labels);
  });

  it('labels a connector that skips a column beside its target', () => {
    const { labels } = placed(
      graphOf(chain().nodes, [
        relationship('example.a', 'example.b', 1),
        relationship('example.b', 'example.c', 1),
        relationship('example.a', 'example.c', 4),
      ]),
    );

    expect(labels.placed).toEqual([
      {
        key: '0:0>2:0',
        position: 'near-target',
        x: 2 * COLUMN_PITCH - REACH - LABEL_WIDTH / 2,
        y: rowCentre(0),
        bounds: inkAt(2 * COLUMN_PITCH - REACH - LABEL_WIDTH / 2, rowCentre(0)),
      },
    ]);
  });

  it('places the counts of a connector that runs backwards beside the boxes it actually meets', () => {
    const { layout, labels } = placed(
      graphOf(
        [participant('example.y', 0), participant('example.z', 0), participant('example.x', 1)],
        [relationship('example.x', 'example.y', 3), relationship('example.x', 'example.z', 4)],
      ),
    );

    expect(layout.connectors.map(({ anchors }) => anchors.orientation)).toEqual([
      'backward',
      'backward',
    ]);
    expect(labels.placed.map(({ position, x, y }) => [position, x, y])).toEqual([
      ['near-target', DEFAULT_GRAPH_NODE_WIDTH + REACH + LABEL_WIDTH / 2, rowCentre(0)],
      ['near-target', DEFAULT_GRAPH_NODE_WIDTH + REACH + LABEL_WIDTH / 2, rowCentre(1)],
    ]);
    expectClearOfEverything(layout, labels);
  });

  it('moves a count that would overlap one already placed to its next candidate', () => {
    // Two crossing connectors between the same two columns share a midpoint.
    const { layout, labels } = placed(
      graphOf(
        [
          participant('example.upper.caller', 0),
          participant('example.lower.caller', 0),
          participant('example.upper.callee', 1),
          participant('example.lower.callee', 1),
        ],
        [
          relationship('example.upper.caller', 'example.lower.callee', 3),
          relationship('example.lower.caller', 'example.upper.callee', 5),
        ],
      ),
    );

    expect(labels.placed.map(({ key, position }) => [key, position])).toEqual([
      ['0:0>1:1', 'midpoint'],
      ['0:1>1:0', 'near-target'],
    ]);
    expectClearOfEverything(layout, labels);
  });

  it('leaves off a count that fits nowhere, and names its connector', () => {
    // Wider than the gap it would have to sit in.
    const wide = layoutDependencyGraph(chain());
    expect(placeEdgeLabels(wide, labelWidths(wide, 100), METRICS)).toEqual({
      placed: [],
      suppressed: ['0:0>1:0', '1:0>2:0'],
    });

    // Between two boxes of one column, where the row gap is shorter than a label.
    const stacked = layoutDependencyGraph(
      graphOf(
        [participant('example.a', 0), participant('example.b', 0)],
        [relationship('example.a', 'example.b', 3)],
      ),
    );
    expect(stacked.connectors[0]?.anchors.orientation).toBe('vertical');
    expect(placeEdgeLabels(stacked, labelWidths(stacked), METRICS)).toEqual({
      placed: [],
      suppressed: ['0:0>0:1'],
    });
  });

  it('places only the connectors it is given a width for', () => {
    expect(placeEdgeLabels(layoutDependencyGraph(chain()), new Map(), METRICS)).toEqual({
      placed: [],
      suppressed: [],
    });
  });

  it('places the same labels for any order the relationships arrive in', () => {
    const data = star(20);

    expect(placed({ ...data, edges: data.edges.toReversed() }).labels).toEqual(placed(data).labels);
  });

  it('reads an unusable width or metric as zero', () => {
    const layout = layoutDependencyGraph(chain());
    const labels = placeEdgeLabels(layout, labelWidths(layout, Number.NaN), {
      fontSize: Number.NaN,
      clearance: -4,
      outlineInset: Number.POSITIVE_INFINITY,
    });
    const middle = DEFAULT_GRAPH_NODE_WIDTH + DEFAULT_GRAPH_COLUMN_GAP / 2;

    expect(labels.suppressed).toEqual([]);
    expect(labels.placed[0]?.bounds).toEqual({
      left: middle,
      top: rowCentre(0),
      right: middle,
      bottom: rowCentre(0),
    });
  });
});
