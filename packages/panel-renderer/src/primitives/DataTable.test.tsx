/**
 * The virtualization contract of `primitives/DataTable` - the two states in which the grid decides
 * how many rows exist in the DOM, and the one option it hands the virtualizer that React 19 makes
 * mandatory.
 *
 * Every group below protects a named review finding, and each one is a behaviour that no other
 * suite can see: the row count of a first paint and the options object of a hook are both invisible
 * to a test that only asks whether the table rendered.
 *
 *   **R2-F26 - the unmeasured first paint is bounded.** While virtualization is on but the
 *   virtualizer has measured no viewport, rows render in normal flow. That state used to render
 *   EVERY row, so the 5 000-row result AAP 0.4.2 permits created 5 000 rows and all of their cells
 *   before virtualization engaged. The first group pins the bound, the second pins the two explicit
 *   ways a caller still asks for every row (so the bound cannot be "fixed" by removing them), and
 *   the third pins the anchoring: the window follows the active row, because the row holding the
 *   roving tab stop has to be in the DOM or the grid body is unreachable by Tab.
 *
 *   **R3-F03 - `useFlushSync: false`.** `@tanstack/react-virtual` 3.14.13 defaults that option to
 *   `true` and then calls `flushSync` for every synchronous notification, which under React 19.3.0
 *   lands while React is already rendering or committing (both versions are pinned by AAP 0.3.2).
 *   The option is not observable in the DOM, so the last group asserts the options object this
 *   component actually passes - that is the deterministic pin - and the measured-path group drives a
 *   real virtualized update (mount, measure, scroll, re-window) and guards that React logged no
 *   `flushSync` complaint while doing it.
 *
 * ## How the measured path is driven under happy-dom
 *
 * The environment answers zero for every dimension, which is exactly why the unmeasured state
 * exists - so the virtualized path has to be given a layout to measure. It takes one stub and no
 * fake timers, because of what `@tanstack/virtual-core` 3.17.11 actually reads: `getRect` reads
 * `offsetWidth`/`offsetHeight` off the scroll element, its default `measureElement` reads
 * `offsetHeight` off each row, and `observeElementRect` calls its handler SYNCHRONOUSLY when the
 * scroll element is attached (its `ResizeObserver` registration is inert here, because happy-dom's
 * `ResizeObserver` is a documented no-op). Defining those two properties on `HTMLElement.prototype`
 * is therefore the whole stub; `beforeEach` installs it only for the tests that ask for it and
 * `afterEach` puts the original descriptors back, so the unmeasured tests keep the zero-layout
 * environment they are about.
 *
 * ## Why this file mocks `@tanstack/react-virtual`
 *
 * To read the options object, and only that. The factory below delegates every call to the real
 * `useVirtualizer` after recording four of its fields, so every test in this file - including the
 * measured path - runs against the real virtualizer rather than a stand-in.
 */

import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';

/** The four option fields this suite asserts on, held as `unknown` so nothing is assumed. */
interface RecordedVirtualizerOptions {
  /** `count`: the row count handed to the virtualizer. */
  readonly count: unknown;

  /** `enabled`: whether the virtualizer is live. */
  readonly enabled: unknown;

  /** `overscan`: rows rendered beyond each viewport edge. */
  readonly overscan: unknown;

  /** `useFlushSync`: the React 19 opt-out of R3-F03. */
  readonly useFlushSync: unknown;
}

/**
 * Every options object `DataTable` has passed to `useVirtualizer` since the last `beforeEach`.
 *
 * Hoisted, because Vitest lifts the `vi.mock` factory above the imports and the factory closes over
 * this array.
 */
const recordedVirtualizerOptions = vi.hoisted<RecordedVirtualizerOptions[]>(() => []);

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();

  const useVirtualizer: typeof actual.useVirtualizer = (options) => {
    recordedVirtualizerOptions.push({
      count: options.count,
      enabled: options.enabled,
      overscan: options.overscan,
      useFlushSync: options.useFlushSync,
    });

    return actual.useVirtualizer(options);
  };

  return { ...actual, useVirtualizer };
});

/** One row of the fixture result: an identity, a label and a figure. */
interface SampleRow {
  /** The row key, `row-<index>`, so an index can be named from a test without a lookup. */
  readonly id: string;

  /** The identity column's value. */
  readonly label: string;

  /** The numeric column's value. */
  readonly amount: number;
}

/**
 * The row count AAP 0.4.2 permits a `POST /sessions/:id/panel-data` response to reach - the size of
 * the first paint R2-F26 is about.
 */
const CAPPED_RESULT_ROWS = 5000;

/**
 * A result long enough to prove that a window is smaller than the whole, short enough that
 * rendering all of it stays instant. Used by the two all-rows tests and by the measured path.
 */
const MODEST_RESULT_ROWS = 300;

/**
 * The bound the unmeasured first paint must hold, pinned as a literal here and proven from the DOM
 * by `renders the auto-virtualize threshold whole and one row more as a window` below: the
 * component documents the bound as being the row count above which an unqualified table virtualizes
 * itself, and that threshold is observable - a table of exactly this many rows with `virtualize`
 * omitted renders whole, one row more renders as a window of exactly this many rows.
 */
const EXPECTED_UNMEASURED_BOUND = 60;

/** The default overscan the component documents, in rows. Asserted through the options object. */
const EXPECTED_DEFAULT_OVERSCAN = 8;

/** The block size the stubbed scroll element reports, in CSS pixels. */
const STUBBED_VIEWPORT_BLOCK_SIZE = 400;

/** The block size every stubbed row reports, in CSS pixels. */
const STUBBED_ROW_BLOCK_SIZE = 32;

/** The inline size every stubbed element reports, in CSS pixels. */
const STUBBED_INLINE_SIZE = 800;

/** How many rows' worth of offset the measured-path test scrolls by. A count. */
const SCROLLED_ROWS = 20;

/** A caller-chosen window size, small enough to be unmistakably neither the bound nor the result. */
const CUSTOM_WINDOW_ROWS = 12;

/**
 * The narrowest window a caller can ask for, and the one that proves the anchoring arithmetic: it
 * is narrower than {@link EXPECTED_DEFAULT_OVERSCAN}, so a window that simply opened the overscan
 * ahead of the anchor would not contain the anchor at all.
 */
const NARROWEST_WINDOW_ROWS = 1;

/** A window size the option must refuse, taking the default bound instead of rendering `NaN` rows. */
const UNUSABLE_WINDOW_ROWS = Number.NaN;

/** A window size that has to be raised to one row: a window of none strands the roving tab stop. */
const EMPTY_WINDOW_ROWS = 0;

/** A fractional window size, which has to be floored to whole rows. */
const FRACTIONAL_WINDOW_ROWS = 4.7;

/** {@link FRACTIONAL_WINDOW_ROWS}, floored. */
const FRACTIONAL_WINDOW_ROWS_FLOORED = 4;

/** The class `DataTable` puts on its scroll container, which the layout stub keys off. */
const VIEWPORT_CLASS = 'dg-virtual-viewport';

/** The class the component puts on a row wrapper the virtualizer is positioning. */
const VIRTUAL_ROW_CLASS = 'dg-virtual-row';

/**
 * Build a fixture result.
 *
 * @param count How many rows.
 * @returns The rows, in display order, keyed `row-0` upward.
 */
function makeRows(count: number): readonly SampleRow[] {
  const rows: SampleRow[] = [];

  for (let index = 0; index < count; index += 1) {
    rows.push({ id: `row-${String(index)}`, label: `Row ${String(index)}`, amount: index });
  }

  return rows;
}

/** Two columns - an identity column and a numeric one - which is enough to exercise a real row. */
const columns: readonly DataTableColumn<SampleRow>[] = [
  { key: 'label', header: 'Label', rowHeader: true, cell: (row) => row.label },
  { key: 'amount', header: 'Amount', align: 'end', cell: (row) => String(row.amount) },
];

/**
 * The data rows in the DOM, in document order.
 *
 * Keyed off `data-row-index`, which only a data row carries: the header row and an expanded detail
 * row are `role="row"` too, so a role query would count them.
 *
 * @param container The render container.
 * @returns The data row elements.
 */
function dataRows(container: HTMLElement): readonly Element[] {
  return Array.from(container.querySelectorAll(`[data-row-index]`));
}

/**
 * The `data-row-index` values in the DOM, as numbers.
 *
 * @param container The render container.
 * @returns The rendered row indices, in document order.
 */
function renderedRowIndices(container: HTMLElement): readonly number[] {
  return dataRows(container).map((row) => Number(row.getAttribute('data-row-index')));
}

/**
 * The property descriptors the layout stub replaced, or `null` while no stub is installed.
 *
 * `undefined` for a property happy-dom does not define at all, which is the case that has to be
 * restored by deleting rather than by redefining.
 */
let replacedLayoutDescriptors: {
  readonly offsetHeight: PropertyDescriptor | undefined;
  readonly offsetWidth: PropertyDescriptor | undefined;
} | null = null;

/**
 * Give happy-dom a layout, so the virtualizer can measure a viewport and produce a window.
 *
 * The scroll element is told it is {@link STUBBED_VIEWPORT_BLOCK_SIZE} tall and every other element
 * {@link STUBBED_ROW_BLOCK_SIZE}, which is what makes the settled window a known fraction of the
 * result rather than all of it.
 */
function installLayoutStub(): void {
  const prototype = HTMLElement.prototype;

  replacedLayoutDescriptors = {
    offsetHeight: Object.getOwnPropertyDescriptor(prototype, 'offsetHeight'),
    offsetWidth: Object.getOwnPropertyDescriptor(prototype, 'offsetWidth'),
  };

  Object.defineProperty(prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains(VIEWPORT_CLASS)
        ? STUBBED_VIEWPORT_BLOCK_SIZE
        : STUBBED_ROW_BLOCK_SIZE;
    },
  });

  Object.defineProperty(prototype, 'offsetWidth', {
    configurable: true,
    get(): number {
      return STUBBED_INLINE_SIZE;
    },
  });
}

/** Put happy-dom's own (zero) layout back, so the unmeasured tests are unaffected by the stub. */
function removeLayoutStub(): void {
  if (replacedLayoutDescriptors === null) {
    return;
  }

  const prototype = HTMLElement.prototype;
  const { offsetHeight, offsetWidth } = replacedLayoutDescriptors;

  if (offsetHeight === undefined) {
    Reflect.deleteProperty(prototype, 'offsetHeight');
  } else {
    Object.defineProperty(prototype, 'offsetHeight', offsetHeight);
  }

  if (offsetWidth === undefined) {
    Reflect.deleteProperty(prototype, 'offsetWidth');
  } else {
    Object.defineProperty(prototype, 'offsetWidth', offsetWidth);
  }

  replacedLayoutDescriptors = null;
}

beforeEach(() => {
  recordedVirtualizerOptions.length = 0;
});

afterEach(() => {
  removeLayoutStub();
  vi.restoreAllMocks();
});

describe('DataTable unmeasured first paint (R2-F26)', () => {
  it('renders a bounded window of a capped result rather than every row', () => {
    const { container } = render(
      <DataTable
        caption="Capped result"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true }}
      />,
    );

    // The bound, and nothing but the bound: one header row plus exactly that many data rows.
    expect(dataRows(container)).toHaveLength(EXPECTED_UNMEASURED_BOUND);
    expect(container.querySelectorAll('[role="row"]')).toHaveLength(EXPECTED_UNMEASURED_BOUND + 1);

    // The window starts at the active row (row 0 here, with no selection and no navigation) and
    // runs to the bound, so the last rendered index is the bound minus one.
    const indices = renderedRowIndices(container);

    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(EXPECTED_UNMEASURED_BOUND - 1);

    // The first row past the bound - and the last row of the result - are absent. This is the
    // assertion the finding is about: before the fix, all 5 000 were here.
    expect(
      container.querySelector(`[data-row-index="${String(EXPECTED_UNMEASURED_BOUND)}"]`),
    ).toBeNull();
    expect(
      container.querySelector(`[data-row-index="${String(CAPPED_RESULT_ROWS - 1)}"]`),
    ).toBeNull();

    // The canvas still advertises the scroll range of the WHOLE result while only a window of it
    // is in flow, so the scrollbar is right from this first paint rather than from the first
    // measurement. The stylesheet consumes the value as a minimum, so an estimate cannot clip the
    // rows that are actually rendered.
    expect(container.querySelector('.dg-virtual-canvas')?.getAttribute('style')).toContain(
      '--dgc-virtual-total',
    );
  });

  it('renders the auto-virtualize threshold whole and one row more as a window', () => {
    // At the threshold an unqualified table does not virtualize at all, so every row is present.
    const atThreshold = render(
      <DataTable
        caption="At the threshold"
        rows={makeRows(EXPECTED_UNMEASURED_BOUND)}
        rowKey={(row) => row.id}
        columns={columns}
      />,
    );

    expect(dataRows(atThreshold.container)).toHaveLength(EXPECTED_UNMEASURED_BOUND);

    // One row more crosses the threshold, virtualization turns itself on, nothing has been measured
    // - and the window that renders is exactly the threshold's worth of rows. That equality is
    // what the component documents, and it is what keeps an unmeasured first paint from ever
    // putting more rows in the DOM than an unvirtualized table already does.
    const pastThreshold = render(
      <DataTable
        caption="One past the threshold"
        rows={makeRows(EXPECTED_UNMEASURED_BOUND + 1)}
        rowKey={(row) => row.id}
        columns={columns}
      />,
    );

    expect(dataRows(pastThreshold.container)).toHaveLength(EXPECTED_UNMEASURED_BOUND);
  });
});

describe('DataTable explicit all-rows modes (R2-F26)', () => {
  it('keeps every row when unmeasuredWindowRows is "all"', () => {
    const { container } = render(
      <DataTable
        caption="No layout at all"
        rows={makeRows(MODEST_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true, unmeasuredWindowRows: 'all' }}
      />,
    );

    expect(dataRows(container)).toHaveLength(MODEST_RESULT_ROWS);
    expect(
      container.querySelector(`[data-row-index="${String(MODEST_RESULT_ROWS - 1)}"]`),
    ).not.toBeNull();
  });

  it('keeps every row when virtualization is switched off', () => {
    const { container } = render(
      <DataTable
        caption="Unvirtualized"
        rows={makeRows(MODEST_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={false}
      />,
    );

    expect(dataRows(container)).toHaveLength(MODEST_RESULT_ROWS);
    expect(
      container.querySelector(`[data-row-index="${String(MODEST_RESULT_ROWS - 1)}"]`),
    ).not.toBeNull();
  });
});

describe('DataTable bounded window and the roving tab stop (R2-F26)', () => {
  it('anchors the window on a selected row far past the bound', () => {
    const selectedIndex = 4000;
    const { container } = render(
      <DataTable
        caption="Arrived with a selection"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        selectedRowKey={`row-${String(selectedIndex)}`}
        virtualize={{ enabled: true }}
      />,
    );

    // Still bounded - anchoring moves the window, it does not widen it.
    expect(dataRows(container)).toHaveLength(EXPECTED_UNMEASURED_BOUND);

    const selectedRow = container.querySelector(`[data-row-index="${String(selectedIndex)}"]`);

    expect(selectedRow).not.toBeNull();
    // The selected row owns the roving tab stop, so it is the one row in the body reachable by Tab.
    // A window pinned to row zero would have left this row out of the DOM entirely.
    expect(selectedRow?.getAttribute('tabindex')).toBe('0');
    expect(selectedRow?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-row-index="0"]')).toBeNull();
  });

  it('follows the End key to the last row of a capped result', () => {
    const { container } = render(
      <DataTable
        caption="Keyboard navigation"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true }}
      />,
    );

    const firstRow = container.querySelector('[data-row-index="0"]');

    expect(firstRow).not.toBeNull();

    if (firstRow === null) {
      return;
    }

    fireEvent.keyDown(firstRow, { key: 'End' });

    // The window re-anchored on the row End moved to, the row exists, and the focus effect reached
    // it - which is the whole reason the bound is anchored rather than pinned to row zero.
    const lastIndex = CAPPED_RESULT_ROWS - 1;
    const lastRow = container.querySelector(`[data-row-index="${String(lastIndex)}"]`);

    expect(lastRow).not.toBeNull();
    expect(dataRows(container)).toHaveLength(EXPECTED_UNMEASURED_BOUND);
    expect(document.activeElement).toBe(lastRow);
  });
});

describe('DataTable unmeasuredWindowRows sizing (R2-F26)', () => {
  it('renders exactly the number of rows the caller asked for', () => {
    const { container } = render(
      <DataTable
        caption="A caller-sized window"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true, unmeasuredWindowRows: CUSTOM_WINDOW_ROWS }}
      />,
    );

    expect(dataRows(container)).toHaveLength(CUSTOM_WINDOW_ROWS);
    expect(renderedRowIndices(container)[0]).toBe(0);
    expect(container.querySelector(`[data-row-index="${String(CUSTOM_WINDOW_ROWS)}"]`)).toBeNull();
  });

  it('keeps the anchor inside a window narrower than the overscan', () => {
    const selectedIndex = 4000;
    const { container } = render(
      <DataTable
        caption="The narrowest window"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        selectedRowKey={`row-${String(selectedIndex)}`}
        virtualize={{ enabled: true, unmeasuredWindowRows: NARROWEST_WINDOW_ROWS }}
      />,
    );

    // One row, and it is the anchor: the window cannot open its overscan ahead of the active row
    // without leaving that row - the one holding the roving tab stop - out of the DOM.
    expect(renderedRowIndices(container)).toEqual([selectedIndex]);
    expect(
      container
        .querySelector(`[data-row-index="${String(selectedIndex)}"]`)
        ?.getAttribute('tabindex'),
    ).toBe('0');
  });

  it('refuses a window size it cannot use and rounds one it can', () => {
    // Not finite: the default bound stands, rather than `Math.min` producing a window of NaN rows.
    const unusable = render(
      <DataTable
        caption="An unusable size"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true, unmeasuredWindowRows: UNUSABLE_WINDOW_ROWS }}
      />,
    );

    expect(dataRows(unusable.container)).toHaveLength(EXPECTED_UNMEASURED_BOUND);

    // Zero: raised to one row, because a window of none would render no rows while rows exist and
    // leave the grid body unreachable by Tab.
    const empty = render(
      <DataTable
        caption="An empty size"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true, unmeasuredWindowRows: EMPTY_WINDOW_ROWS }}
      />,
    );

    expect(dataRows(empty.container)).toHaveLength(NARROWEST_WINDOW_ROWS);

    // Fractional: floored to whole rows, since half a row cannot be rendered.
    const fractional = render(
      <DataTable
        caption="A fractional size"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true, unmeasuredWindowRows: FRACTIONAL_WINDOW_ROWS }}
      />,
    );

    expect(dataRows(fractional.container)).toHaveLength(FRACTIONAL_WINDOW_ROWS_FLOORED);
  });
});

describe('DataTable measured virtualized path (R2-F26, R3-F03)', () => {
  beforeEach(() => {
    installLayoutStub();
  });

  it('windows a measured viewport and survives a scroll without a flushSync warning', () => {
    const consoleError = vi.spyOn(console, 'error');
    const consoleWarn = vi.spyOn(console, 'warn');

    const { container } = render(
      <DataTable
        caption="Measured"
        rows={makeRows(MODEST_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true }}
      />,
    );

    // The virtualizer measured the stubbed viewport and produced a window: fewer rows than the
    // result, and each one positioned by the component's own custom property rather than in flow.
    const windowedRows = dataRows(container);

    expect(windowedRows.length).toBeGreaterThan(0);
    expect(windowedRows.length).toBeLessThan(MODEST_RESULT_ROWS);

    const wrappers = Array.from(container.querySelectorAll(`.${VIRTUAL_ROW_CLASS}`));

    expect(wrappers).toHaveLength(windowedRows.length);
    expect(
      wrappers.every((wrapper) =>
        (wrapper.getAttribute('style') ?? '').includes('--dgc-virtual-start'),
      ),
    ).toBe(true);
    expect(container.querySelector('.dg-virtual-canvas')?.getAttribute('style')).toContain(
      '--dgc-virtual-total',
    );

    // A real virtualized update: the scroll notification is the one `useFlushSync` would have
    // flushed synchronously.
    const viewport = container.querySelector(`.${VIEWPORT_CLASS}`);

    expect(viewport).not.toBeNull();

    if (viewport === null) {
      return;
    }

    const firstIndexBeforeScroll = renderedRowIndices(container)[0];

    viewport.scrollTop = STUBBED_ROW_BLOCK_SIZE * SCROLLED_ROWS;
    fireEvent.scroll(viewport);

    const afterScroll = renderedRowIndices(container);
    const firstIndexAfterScroll = afterScroll[0];

    // The notification reached React and the window MOVED - the update path R3-F03 is about, rather
    // than a render that merely survived the event.
    expect(afterScroll.length).toBeGreaterThan(0);
    expect(afterScroll.length).toBeLessThan(MODEST_RESULT_ROWS);
    expect(firstIndexBeforeScroll).toBeDefined();
    expect(firstIndexAfterScroll).toBeDefined();
    expect(firstIndexAfterScroll ?? 0).toBeGreaterThan(firstIndexBeforeScroll ?? 0);

    // The scroll left the active row (row 0, never navigated) outside the window, which is the
    // state the tab-stop fallback exists for: with every rendered row carrying `tabIndex={-1}` the
    // grid body would be unreachable by Tab, so the topmost rendered row takes the stop instead.
    const topRendered = container.querySelector(
      `[data-row-index="${String(firstIndexAfterScroll ?? 0)}"]`,
    );

    expect(topRendered).not.toBeNull();
    expect(topRendered?.getAttribute('tabindex')).toBe('0');
    expect(container.querySelector('[data-row-index="0"]')).toBeNull();

    // R3-F03's runtime symptom, asserted negatively across the whole mount-measure-scroll sequence:
    // React 19 reports a `flushSync` that ran while it was rendering or committing through
    // `console.error`, and nothing here reported one. This is a regression guard rather than the
    // proof of the option - whether React notices depends on which phase the notification arrives
    // in, and `fireEvent` wraps this one in `act` - so the deterministic pin for the option itself
    // is the options assertion in the group below.
    const logged = [...consoleError.mock.calls, ...consoleWarn.mock.calls].map((call) =>
      call.map((argument) => String(argument)).join(' '),
    );

    expect(logged.filter((message) => message.includes('flushSync'))).toEqual([]);
  });

  it('moves focus to the next row while the virtualizer drives the render', () => {
    const { container } = render(
      <DataTable
        caption="Measured, keyboard"
        rows={makeRows(MODEST_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true }}
      />,
    );

    const firstRow = container.querySelector('[data-row-index="0"]');

    expect(firstRow).not.toBeNull();

    if (firstRow === null) {
      return;
    }

    fireEvent.keyDown(firstRow, { key: 'ArrowDown' });

    // The row moved to is inside the measured window (the overscan guarantees it), so the focus
    // effect finds it on the commit that follows the key. This is the virtualized half of that
    // effect's contract: it waits on whether the ACTIVE ROW IS RENDERED, asked of the virtual
    // items on this path and of the flow range on the other, and both halves must land focus.
    const secondRow = container.querySelector('[data-row-index="1"]');

    expect(secondRow).not.toBeNull();
    expect(document.activeElement).toBe(secondRow);
    expect(secondRow?.getAttribute('tabindex')).toBe('0');
    expect(firstRow.getAttribute('tabindex')).toBe('-1');
  });
});

describe('DataTable virtualizer options (R3-F03)', () => {
  it('opts out of flushSync and passes the resolved count, mode and overscan', () => {
    render(
      <DataTable
        caption="Options"
        rows={makeRows(CAPPED_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true }}
      />,
    );

    expect(recordedVirtualizerOptions.length).toBeGreaterThan(0);

    // Every render of the component, not just the first: the option is part of the options object
    // the component builds, so a conditional or a later re-render cannot reinstate the default.
    expect(recordedVirtualizerOptions.every((options) => options.useFlushSync === false)).toBe(
      true,
    );

    const first = recordedVirtualizerOptions[0];

    expect(first).toBeDefined();
    expect(first?.count).toBe(CAPPED_RESULT_ROWS);
    expect(first?.enabled).toBe(true);
    expect(first?.overscan).toBe(EXPECTED_DEFAULT_OVERSCAN);
  });

  it('reports the virtualizer disabled when the caller switches virtualization off', () => {
    render(
      <DataTable
        caption="Options, unvirtualized"
        rows={makeRows(MODEST_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={false}
      />,
    );

    const first = recordedVirtualizerOptions[0];

    expect(first).toBeDefined();
    expect(first?.enabled).toBe(false);
    expect(first?.useFlushSync).toBe(false);
  });
});
