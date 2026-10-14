/**
 * `components/Timeline` — the canvas is drawn at its rendered width, one SVG
 * user unit to a CSS pixel.
 *
 * ## What this suite is protecting
 *
 * The stylesheet sizes the timeline's `<svg>` to its scroll viewport, and its
 * labels are set in a type role (`--dg-mono-sm`, 11 px). A drawing laid out in
 * a fixed logical width and scaled into that element renders every glyph at
 * `11 × rendered / logical` pixels — too small to read on a narrow panel, twice
 * the role's size on a wide one — and grows the drawing's height by the same
 * factor, pushing its last lanes out of the viewport's scroll cap. The view
 * therefore measures the element and lays the drawing out at exactly that
 * width:
 *
 *   - **Unmeasured, the fallback frame.** Before anything is measured — and in
 *     a DOM with no layout — the `viewBox` is `CHART_VIEWBOX_WIDTH` wide, so
 *     an unmeasured render is deterministic.
 *   - **Measured, one to one.** Once the observer reports a width, the
 *     `viewBox` is exactly that wide and as tall as the logical drawing; the
 *     gutters and rows keep their pixel extents and only the time axis between
 *     the gutters takes up the width, so the drawing is never magnified.
 *   - **Whole pixels, no jitter.** A reading is floored to a whole pixel, a
 *     reading inside the pixel already accepted changes nothing, and a reading
 *     that is not a usable width (an element not laid out) keeps the last one.
 *   - **Seeded before paint.** The canvas's own box is read when it mounts, so
 *     the first frame is already one to one, with or without `ResizeObserver`.
 *   - **Observer lifecycle.** The observer watches the canvas element itself,
 *     is disconnected when the view unmounts, and is replaced when the canvas
 *     is remounted, which keeps the width already accepted.
 *
 * ## Harness conventions (shared with `./Timeline.test.tsx`)
 *
 *   - Test API imported explicitly from `vitest`, with `afterEach(cleanup)`
 *     registered explicitly.
 *   - Stub providers built with the library's own `createDataProvider`, and a
 *     hand-built correlated trace: this package depends on
 *     `@debuggen/telemetry` for types only.
 *   - Generic fixture vocabulary only: no name, route or symbol of any
 *     inspected application.
 *   - **Layout is stubbed here, and only as far as the measurement reads it.**
 *     happy-dom lays nothing out and its `ResizeObserver` observes nothing, so
 *     each case installs a controllable observer double with
 *     `vi.stubGlobal` and reports widths through it inside `act`; the one case
 *     that exercises the mount-time seed stubs the canvas's own box, and no
 *     other element's. Globals and spies are restored after every case.
 *
 * @see ./Timeline for the component and "The canvas is drawn one user unit to
 *   a CSS pixel" in its header.
 * @see ./Timeline.test.tsx for the rest of the component's suite.
 */

import type { DataQuery, TimelineNode } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import type {
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import { DEFAULT_LABEL_FONT_SIZE, createEstimateMeasure } from '../utils/format';
import { CHART_VIEWBOX_WIDTH } from '../utils/scale';
import { Timeline } from './Timeline';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 * ---------------------------------------------------------------------------
 */

/** The trace every fixture span belongs to: 32 hex digits. */
const TRACE_ID = 'e4f5061728394a5b6c7d8e9f0a1b2c3d';

/** The session and capture the persisted events are attributed to. */
const SESSION_ID = 'session-example-0003';
const CAPTURE_ID = 'capture-example-0003';

/** The two producers of a cross-tier trace: the page agent and the dev-server preload. */
const BROWSER_PRODUCER_ID = 'producer-example-browser';
const SERVER_PRODUCER_ID = 'producer-example-server';

/** The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z. */
const BASE_START_MS = 1_767_225_600_000;

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.timeline';

/**
 * The widths the observer reports: a full-screen DevTools window, the chart
 * minimum's neighbourhood on a narrow panel, and one far below the canvas's own
 * gutters.
 */
const WIDE_WIDTH = 1880;
const NARROW_WIDTH = 760;
const SQUEEZED_WIDTH = 100;

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/** Fields a fixture span states; everything else is derived. */
interface EventSpec {
  readonly ordinal: number;
  readonly name: string;
  readonly kind: TelemetryKind;
  readonly tier: TelemetryTier;
  readonly offsetMs: number;
  readonly duration: number;
  readonly parentOrdinal?: number | undefined;
}

/**
 * One persisted span, schema-shaped: a 32-hex trace id, a 16-hex span id, an
 * epoch-millisecond start and a millisecond duration.
 *
 * @param spec The span's identity, tier, timing and parent.
 * @returns A fresh event.
 */
function makeEvent(spec: EventSpec): TelemetryEvent {
  const { ordinal, name, kind, tier, offsetMs, duration, parentOrdinal } = spec;

  return {
    id: `event-scale-${String(ordinal).padStart(4, '0')}`,
    traceId: TRACE_ID,
    spanId: spanIdFor(ordinal),
    kind,
    name,
    startTime: BASE_START_MS + offsetMs,
    duration,
    tier,
    attributes: {},
    status: 'ok',
    producerId: tier === 'browser' ? BROWSER_PRODUCER_ID : SERVER_PRODUCER_ID,
    seq: ordinal,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: ordinal,
    ...(parentOrdinal === undefined ? {} : { parentSpanId: spanIdFor(parentOrdinal) }),
  };
}

/** The page event at the trace's root: it spans the whole window. */
const PRESS = makeEvent({
  ordinal: 1,
  name: 'example.press',
  kind: 'interaction',
  tier: 'browser',
  offsetMs: 0,
  duration: 400,
});

/** The request the page event made. */
const REQUEST = makeEvent({
  ordinal: 2,
  name: 'example.request',
  kind: 'fetch',
  tier: 'browser',
  offsetMs: 10,
  duration: 380,
  parentOrdinal: 1,
});

/** The server span that answered it. */
const SERVER = makeEvent({
  ordinal: 3,
  name: 'example.server',
  kind: 'http.server',
  tier: 'server',
  offsetMs: 20,
  duration: 360,
  parentOrdinal: 2,
});

/** The handler inside the server span. */
const HANDLER = makeEvent({
  ordinal: 4,
  name: 'example.handler',
  kind: 'route.handler',
  tier: 'server',
  offsetMs: 40,
  duration: 320,
  parentOrdinal: 3,
});

/** The datastore call at the bottom, alone in the database lane. */
const QUERY = makeEvent({
  ordinal: 5,
  name: 'example.query',
  kind: 'db.query',
  tier: 'db',
  offsetMs: 100,
  duration: 200,
  parentOrdinal: 4,
});

/** Every fixture span, root first. */
const CHAIN: readonly TelemetryEvent[] = [PRESS, REQUEST, SERVER, HANDLER, QUERY];

/**
 * The chain as the correlator's tree, each span the only child of the one
 * before it, with its tree-level fields derived from its own nodes.
 */
function chainTree(): TraceTree {
  const nodes: TraceNode[] = [];
  let child: TraceNode | undefined;
  for (let index = CHAIN.length - 1; index >= 0; index -= 1) {
    const event = CHAIN[index];
    if (event === undefined) {
      continue;
    }
    child = {
      event,
      children: child === undefined ? [] : [child],
      depth: index,
      orphaned: false,
    };
    nodes.push(child);
  }
  if (child === undefined) {
    throw new Error('the fixture chain is empty');
  }

  const startTime = Math.min(...CHAIN.map((event) => event.startTime));
  const endTime = Math.max(...CHAIN.map((event) => event.startTime + event.duration));
  const tiers: TelemetryTier[] = [];
  const kinds: TelemetryKind[] = [];
  for (const event of CHAIN) {
    if (!tiers.includes(event.tier)) {
      tiers.push(event.tier);
    }
    if (!kinds.includes(event.kind)) {
      kinds.push(event.kind);
    }
  }

  return {
    traceId: TRACE_ID,
    roots: [child],
    nodeCount: nodes.length,
    maxDepth: nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0),
    startTime,
    endTime,
    totalDuration: Math.round(endTime - startTime),
    orphanCount: 0,
    tiers,
    kinds,
    producerIds: [BROWSER_PRODUCER_ID, SERVER_PRODUCER_ID],
    duplicateSpanIds: [],
    truncated: false,
    primaryRootSpanId: PRESS.spanId,
  };
}

/*
 * ---------------------------------------------------------------------------
 * The observer double
 * ---------------------------------------------------------------------------
 */

/** One `ResizeObserver` the component constructed, and what it was asked to do. */
interface ObserverRecord {
  /** The elements it is observing, in the order it was asked to observe them. */
  readonly observed: Element[];
  /** Whether `disconnect()` has been called. */
  readonly isDisconnected: () => boolean;
  /**
   * Delivers one observation of `target` at `width` CSS pixels, as a browser
   * does after layout. Throws for an element it is not observing, or once it is
   * disconnected, since a browser would deliver nothing then.
   */
  readonly report: (target: Element, width: number) => void;
}

/**
 * The entry a browser delivers for an element whose content box is `width`
 * pixels wide. The block size is the element's declared height, which the
 * measurement does not read.
 */
function entryFor(target: Element, width: number): ResizeObserverEntry {
  const blockSize = Number(target.getAttribute('height') ?? 0);
  const size: ResizeObserverSize = { inlineSize: width, blockSize };

  return {
    target,
    contentRect: new DOMRectReadOnly(0, 0, width, blockSize),
    contentBoxSize: [size],
    borderBoxSize: [size],
    devicePixelContentBoxSize: [size],
  };
}

/**
 * Replaces the global `ResizeObserver` with a controllable double for one case;
 * `vi.unstubAllGlobals()` in `afterEach` restores happy-dom's own.
 *
 * @returns Every observer the component constructs, in construction order.
 */
function installObserverDouble(): readonly ObserverRecord[] {
  const records: ObserverRecord[] = [];

  class ResizeObserverDouble implements ResizeObserver {
    readonly #observed: Element[] = [];
    #disconnected = false;

    constructor(callback: ResizeObserverCallback) {
      records.push({
        observed: this.#observed,
        isDisconnected: () => this.#disconnected,
        report: (target, width) => {
          if (this.#disconnected || !this.#observed.includes(target)) {
            throw new Error('the observer is not observing that element');
          }
          callback([entryFor(target, width)], this);
        },
      });
    }

    observe(target: Element): void {
      if (!this.#observed.includes(target)) {
        this.#observed.push(target);
      }
    }

    unobserve(target: Element): void {
      const index = this.#observed.indexOf(target);
      if (index >= 0) {
        this.#observed.splice(index, 1);
      }
    }

    disconnect(): void {
      this.#disconnected = true;
      this.#observed.length = 0;
    }
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverDouble);

  return records;
}

/** The most recently constructed observer, failing loudly when there is none. */
function latestObserver(records: readonly ObserverRecord[]): ObserverRecord {
  const record = records.at(-1);
  if (record === undefined) {
    throw new Error('the component constructed no ResizeObserver');
  }

  return record;
}

/** Asserts that `observer` is observing `element` itself, and nothing else. */
function expectObservingOnly(observer: ObserverRecord, element: Element): void {
  expect(observer.observed).toHaveLength(1);
  expect(observer.observed[0]).toBe(element);
}

/**
 * Reports `width` for `canvas` through `observer`, inside `act` so the state
 * update it raises is committed before the case reads the canvas again.
 */
function reportWidth(observer: ObserverRecord, canvas: Element, width: number): void {
  act(() => {
    observer.report(canvas, width);
  });
}

/**
 * Gives the timeline canvas — and no other element — a laid-out box `width`
 * pixels wide, as a browser's layout would before the mount-time seed reads it.
 * Every other SVG keeps happy-dom's zero box.
 */
function stubCanvasBox(width: number): void {
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: SVGSVGElement,
  ): DOMRect {
    return this.classList.contains('dg-timeline__canvas')
      ? new DOMRect(0, 0, width, 0)
      : new DOMRect();
  });
}

/*
 * ---------------------------------------------------------------------------
 * Providers, rendering and readers
 * ---------------------------------------------------------------------------
 */

/** A provider answering every query with the fixture trace. */
function traceProvider(): DataProvider {
  const response: DataQueryResponse = { source: 'trace', data: chainTree() };
  const resolve = vi.fn<DataQueryResolver>(() => Promise.resolve(response));

  return createDataProvider(resolve);
}

/**
 * The node for the correlated fixture trace.
 *
 * @param minDuration An optional filter bound, which makes a different query
 *   (and so a fresh load and a remounted canvas) without changing the rows.
 */
function traceNode(minDuration?: number): TimelineNode {
  const query: DataQuery = {
    source: 'trace',
    filter: { traceId: TRACE_ID, ...(minDuration === undefined ? {} : { minDuration }) },
  };

  return { type: 'timeline', id: NODE_ID, query };
}

/** Fresh host actions, spied on. */
function makeActions(): PanelActions {
  return {
    onSelectEvent: vi.fn<(ref: PanelEventRef) => void>(),
    onOpenSource: vi.fn<(location: SourceLocation) => void>(),
  };
}

/** The view inside both host contexts. */
function hosted(node: TimelineNode, provider: DataProvider, actions: PanelActions): ReactElement {
  return (
    <DataProviderContext.Provider value={provider}>
      <PanelSessionContext.Provider value={SESSION_ID}>
        <PanelActionsContext.Provider value={actions}>
          <Timeline node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>
  );
}

/** The canvas — the chart's one `figure` — obtained by its role once the trace has resolved. */
async function findCanvas(): Promise<HTMLElement> {
  return screen.findByRole('figure');
}

/** A numeric SVG attribute, failing loudly when it is absent. */
function numericAttribute(element: Element, name: string): number {
  const value = element.getAttribute(name);
  if (value === null) {
    throw new Error(`the element has no "${name}" attribute`);
  }

  return Number(value);
}

/** The canvas's `viewBox` width and height. */
function viewBoxOf(canvas: Element): { readonly width: number; readonly height: number } {
  const [minX, minY, width, height] = (canvas.getAttribute('viewBox') ?? '').split(' ').map(Number);
  expect([minX, minY]).toEqual([0, 0]);

  return { width: width ?? Number.NaN, height: height ?? Number.NaN };
}

/** The lane background bands, top to bottom — the accent stripes carry a style and are excluded. */
function laneBandsOf(canvas: Element): Element[] {
  return Array.from(canvas.querySelectorAll('rect.dg-timeline__lane')).filter(
    (lane) => lane.getAttribute('style') === null,
  );
}

/** The bar whose SVG title describes the named operation. */
function barTitled(canvas: Element, name: string): Element {
  const bar = Array.from(canvas.querySelectorAll('rect.dg-timeline__bar')).find((candidate) =>
    (candidate.querySelector('title')?.textContent ?? '').startsWith(`${name} `),
  );
  if (bar === undefined) {
    throw new Error(`no bar on the canvas describes "${name}"`);
  }

  return bar;
}

/** The measure the component fits its labels with, so a drawn label's run can be read back. */
const LABEL_MEASURE = createEstimateMeasure(DEFAULT_LABEL_FONT_SIZE);

/**
 * Everything about the drawing a width may and may not change: the `viewBox`,
 * the element's declared height, the lanes, the lane labels, every bar's run
 * and row and every label's run.
 */
interface Drawing {
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly declaredHeight: number;
  readonly laneWidths: readonly number[];
  readonly laneRows: readonly (readonly [number, number])[];
  readonly laneLabelXs: readonly number[];
  /** Per fixture span, in {@link CHAIN} order: its bar's left edge. */
  readonly barStarts: readonly number[];
  /** Per fixture span, in {@link CHAIN} order: its bar's right edge. */
  readonly barEnds: readonly number[];
  /** Per fixture span, in {@link CHAIN} order: its bar's top edge and height. */
  readonly barRows: readonly (readonly [number, number])[];
  /** Every bar label drawn beside its bar, as the run it covers. */
  readonly besideLabels: readonly { readonly start: number; readonly end: number }[];
}

/** Reads the drawing off the canvas as it is now. */
function drawingOf(canvas: Element): Drawing {
  const viewBox = viewBoxOf(canvas);
  const bands = laneBandsOf(canvas);
  const bars = CHAIN.map((event) => barTitled(canvas, event.name));
  const besideLabels = Array.from(canvas.querySelectorAll('text.dg-timeline__bar-label'))
    .filter((text) => !text.classList.contains('dg-timeline__bar-label--inside'))
    .map((text) => {
      const width = LABEL_MEASURE(text.textContent ?? '');
      const at = numericAttribute(text, 'x');
      const start = text.getAttribute('text-anchor') === 'end' ? at - width : at;

      return { start, end: start + width };
    });

  return {
    viewWidth: viewBox.width,
    viewHeight: viewBox.height,
    declaredHeight: numericAttribute(canvas, 'height'),
    laneWidths: bands.map((band) => numericAttribute(band, 'width')),
    laneRows: bands.map((band) => [numericAttribute(band, 'y'), numericAttribute(band, 'height')]),
    laneLabelXs: Array.from(canvas.querySelectorAll('text.dg-timeline__lane-label')).map((label) =>
      numericAttribute(label, 'x'),
    ),
    barStarts: bars.map((bar) => numericAttribute(bar, 'x')),
    barEnds: bars.map((bar) => numericAttribute(bar, 'x') + numericAttribute(bar, 'width')),
    barRows: bars.map((bar) => [numericAttribute(bar, 'y'), numericAttribute(bar, 'height')]),
    besideLabels,
  };
}

/** The root bar's left edge: where the lane-label gutter ends. */
function laneColumnOf(drawing: Drawing): number {
  const start = drawing.barStarts[0];
  if (start === undefined) {
    throw new Error('the drawing holds no root bar');
  }

  return start;
}

/** The trailing gutter: from the root bar's right edge to the canvas's edge. */
function trailingGutterOf(drawing: Drawing): number {
  const end = drawing.barEnds[0];
  if (end === undefined) {
    throw new Error('the drawing holds no root bar');
  }

  return drawing.viewWidth - end;
}

/**
 * Asserts that `measured` is `fallback` laid out at a different width and
 * nothing else: the same height, lanes, rows and gutters, with every bar's
 * offset along the time axis stretched by the ratio of the two plot widths.
 */
function expectRelaidAtWidth(measured: Drawing, fallback: Drawing, width: number): void {
  // One user unit to a CSS pixel: the viewBox is the element's own width.
  expect(measured.viewWidth).toBe(width);
  expect(measured.laneWidths).toEqual(fallback.laneWidths.map(() => width));

  // Nothing grows vertically: the drawing keeps its logical height, and the
  // element declares that same height.
  expect(measured.viewHeight).toBe(fallback.viewHeight);
  expect(measured.declaredHeight).toBe(measured.viewHeight);
  expect(measured.laneRows).toEqual(fallback.laneRows);
  expect(measured.barRows).toEqual(fallback.barRows);

  // The gutters are pixel extents, not shares of the width.
  expect(measured.laneLabelXs).toEqual(fallback.laneLabelXs);
  const laneColumn = laneColumnOf(fallback);
  expect(laneColumnOf(measured)).toBe(laneColumn);
  expect(trailingGutterOf(measured)).toBeCloseTo(trailingGutterOf(fallback), 9);

  // Only the time axis between them takes the width: every offset from the
  // window's start stretches by the ratio of the two plot widths.
  const gutters = laneColumn + trailingGutterOf(fallback);
  const stretch = (width - gutters) / (fallback.viewWidth - gutters);
  measured.barStarts.forEach((start, index) => {
    const before = fallback.barStarts[index] ?? Number.NaN;
    expect(start - laneColumn).toBeCloseTo((before - laneColumn) * stretch, 9);
  });

  // Every label beside its bar stays between the lane labels and the edge.
  for (const label of measured.besideLabels) {
    expect(label.start).toBeGreaterThanOrEqual(laneColumn);
    expect(label.end).toBeLessThanOrEqual(width);
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Timeline canvas width', () => {
  it('draws in the fixed fallback frame while nothing has measured the canvas', async () => {
    const observers = installObserverDouble();

    render(hosted(traceNode(), traceProvider(), makeActions()));
    const canvas = await findCanvas();
    const drawing = drawingOf(canvas);

    // The observer is watching, but has reported nothing, and happy-dom's box
    // is zero wide: the drawing is the deterministic fallback.
    expectObservingOnly(latestObserver(observers), canvas);
    expect(drawing.viewWidth).toBe(CHART_VIEWBOX_WIDTH);
    expect(drawing.laneWidths).toEqual([
      CHART_VIEWBOX_WIDTH,
      CHART_VIEWBOX_WIDTH,
      CHART_VIEWBOX_WIDTH,
    ]);
    expect(drawing.declaredHeight).toBe(drawing.viewHeight);
    expect(canvas.getAttribute('width')).toBe('100%');
    expect(canvas.getAttribute('preserveAspectRatio')).toBe('xMinYMin meet');
    // Nothing measured is written back as a style: the stylesheet sizes the element.
    expect(canvas.getAttribute('style')).toBeNull();
  });

  it('lays the drawing out one unit to a CSS pixel at the width the observer reports', async () => {
    const observers = installObserverDouble();

    render(hosted(traceNode(), traceProvider(), makeActions()));
    const canvas = await findCanvas();
    const fallback = drawingOf(canvas);

    reportWidth(latestObserver(observers), canvas, WIDE_WIDTH);

    expectRelaidAtWidth(drawingOf(canvas), fallback, WIDE_WIDTH);
    // The same element, re-laid rather than replaced, and still unstyled.
    expect(screen.getByRole('figure')).toBe(canvas);
    expect(canvas.getAttribute('style')).toBeNull();
  });

  it('follows the canvas down to a narrower width and refits the labels inside it', async () => {
    const observers = installObserverDouble();

    render(hosted(traceNode(), traceProvider(), makeActions()));
    const canvas = await findCanvas();
    const fallback = drawingOf(canvas);
    const observer = latestObserver(observers);

    reportWidth(observer, canvas, WIDE_WIDTH);
    expect(drawingOf(canvas).viewWidth).toBe(WIDE_WIDTH);

    reportWidth(observer, canvas, NARROW_WIDTH);

    const narrow = drawingOf(canvas);
    expectRelaidAtWidth(narrow, fallback, NARROW_WIDTH);
    // Every bar still carries its label at the narrower width: inside the bar
    // where it fits, and otherwise beside it within the canvas (checked above).
    expect(canvas.querySelectorAll('text.dg-timeline__bar-label')).toHaveLength(CHAIN.length);
  });

  it('floors a reading to whole pixels, ignores sub-pixel jitter and keeps the last width over an unusable reading', async () => {
    const observers = installObserverDouble();

    render(hosted(traceNode(), traceProvider(), makeActions()));
    const canvas = await findCanvas();
    const observer = latestObserver(observers);
    const widthNow = (): number => viewBoxOf(canvas).width;

    reportWidth(observer, canvas, WIDE_WIDTH + 0.6);
    expect(widthNow()).toBe(WIDE_WIDTH);

    // Inside the pixel already accepted: nothing changes.
    reportWidth(observer, canvas, WIDE_WIDTH + 0.95);
    expect(widthNow()).toBe(WIDE_WIDTH);
    reportWidth(observer, canvas, WIDE_WIDTH + 0.05);
    expect(widthNow()).toBe(WIDE_WIDTH);

    // An element that is not laid out reports no usable width; the drawing
    // keeps the last one rather than falling back and re-laying twice.
    for (const unusable of [0, 0.5, -24, Number.NaN, Number.POSITIVE_INFINITY]) {
      reportWidth(observer, canvas, unusable);
      expect(widthNow()).toBe(WIDE_WIDTH);
    }

    // A whole pixel's change is followed, floored.
    reportWidth(observer, canvas, WIDE_WIDTH + 1.2);
    expect(widthNow()).toBe(WIDE_WIDTH + 1);
    reportWidth(observer, canvas, WIDE_WIDTH - 0.4);
    expect(widthNow()).toBe(WIDE_WIDTH - 1);
  });

  it('never lays the time axis out narrower than its own gutters, however narrow the reading', async () => {
    const observers = installObserverDouble();

    render(hosted(traceNode(), traceProvider(), makeActions()));
    const canvas = await findCanvas();
    const fallback = drawingOf(canvas);

    reportWidth(latestObserver(observers), canvas, SQUEEZED_WIDTH);

    // The frame is floored above the reading, and `meet` fits it into the
    // narrower element; the axis runs forwards, clear of the lane labels.
    const squeezed = drawingOf(canvas);
    expect(squeezed.viewWidth).toBeGreaterThan(SQUEEZED_WIDTH);
    expect(squeezed.viewWidth).toBeGreaterThan(laneColumnOf(fallback) + trailingGutterOf(fallback));
    expectRelaidAtWidth(squeezed, fallback, squeezed.viewWidth);
    squeezed.barStarts.forEach((start, index) => {
      expect(start).toBeGreaterThanOrEqual(laneColumnOf(fallback));
      expect(squeezed.barEnds[index] ?? Number.NaN).toBeGreaterThan(start);
    });
  });

  it('seeds the width from the canvas box when it mounts, with no ResizeObserver at all', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const seeded = 1440;
    stubCanvasBox(seeded);

    render(hosted(traceNode(), traceProvider(), makeActions()));
    const canvas = await findCanvas();

    // Laid out at the box's width by the time the canvas is first found: no
    // observation was needed, and none could have been delivered.
    const drawing = drawingOf(canvas);
    expect(drawing.viewWidth).toBe(seeded);
    expect(drawing.declaredHeight).toBe(drawing.viewHeight);
  });

  it('keeps the fallback frame, and renders, where there is neither a ResizeObserver nor a layout', async () => {
    vi.stubGlobal('ResizeObserver', undefined);

    render(hosted(traceNode(), traceProvider(), makeActions()));
    const canvas = await findCanvas();

    expect(viewBoxOf(canvas).width).toBe(CHART_VIEWBOX_WIDTH);
  });

  it('disconnects the observer when the view unmounts', async () => {
    const observers = installObserverDouble();

    const { unmount } = render(hosted(traceNode(), traceProvider(), makeActions()));
    const canvas = await findCanvas();
    const observer = latestObserver(observers);
    reportWidth(observer, canvas, WIDE_WIDTH);
    expect(observer.isDisconnected()).toBe(false);

    unmount();

    expect(observers).toHaveLength(1);
    expect(observer.isDisconnected()).toBe(true);
    expect(observer.observed).toEqual([]);
  });

  it('hands a remounted canvas to a fresh observer and keeps the width already accepted', async () => {
    const observers = installObserverDouble();
    const provider = traceProvider();
    const actions = makeActions();

    const { rerender } = render(hosted(traceNode(), provider, actions));
    const first = await findCanvas();
    const firstObserver = latestObserver(observers);
    reportWidth(firstObserver, first, WIDE_WIDTH);

    // A changed query loads again: the canvas leaves the tree while it does and
    // a new one is mounted when the rows arrive.
    rerender(hosted(traceNode(0), provider, actions));
    const second = await findCanvas();

    expect(second).not.toBe(first);
    expect(firstObserver.isDisconnected()).toBe(true);
    const secondObserver = latestObserver(observers);
    expect(secondObserver).not.toBe(firstObserver);
    expectObservingOnly(secondObserver, second);
    // The viewport has not changed width, so neither has the drawing.
    expect(viewBoxOf(second).width).toBe(WIDE_WIDTH);

    reportWidth(secondObserver, second, NARROW_WIDTH);
    expect(viewBoxOf(second).width).toBe(NARROW_WIDTH);
  });
});
