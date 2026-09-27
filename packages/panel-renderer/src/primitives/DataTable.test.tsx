/**
 * The virtualization, keyboard, ARIA and reveal contracts of `primitives/DataTable`. Each group
 * pins a behaviour no other suite can see: the row count of a first paint and the options object
 * of a hook are both invisible to a test that only asks whether the table rendered.
 *
 *   **Bounded unmeasured first paint.** While virtualization is on and no viewport has been
 *   measured, rows render in normal flow as a window anchored on the active row - never the whole
 *   5 000-row result the panel-data route can return. Groups pin the bound, the two explicit ways a
 *   caller asks for every row, and the anchoring that keeps the roving tab stop in the DOM.
 *
 *   **`useFlushSync: false`.** The virtualizer's default of `true` flushes every synchronous
 *   notification with `flushSync`, which under React 19 lands while React is already rendering or
 *   committing. The option is invisible in the DOM, so one group asserts the options object the
 *   component passes, and the measured-path group drives a real virtualized update (mount,
 *   measure, scroll, re-window) and checks that React logged no `flushSync` warning.
 *
 *   **One Tab stop per grid.** The active row is the grid's only Tab stop, and the header sort
 *   controls leave the Tab order while rows exist. Arrow keys, Home/End, Enter, F2 and Escape reach
 *   the `tabIndex={-1}` controls in cells, in an open detail row and in the header; a text field, a
 *   scrollable box and a nested grid keep their own keys.
 *
 *   **No `aria-expanded` on a grid row.** ARIA supports the state on `treegrid` rows only, so the
 *   expansion state reaches the caller's toggle through the `DataTableCellMeta` each cell receives,
 *   and `detailRowId` names the rendered detail row exactly while it is rendered.
 *
 *   **Host-driven selection reveal.** A `selectedRowKey` moved from outside the table scrolls its
 *   row into the table's own viewport once, below the sticky header, without moving focus - and
 *   never for the reader's own activation, an unrelated re-render or an environment that measures
 *   nothing. It coexists with the reveal of a newly expanded row.
 *
 * The column width roles - the full floor of a compact role, the fit-to-panel track of a truncating
 * one - and the grid floor they sum to are pinned as well, both as the token expressions the rows
 * consume and, through a small evaluator of those expressions, as the widths they resolve to
 * across a sweep of panel widths: a table that fits at its readable floors keeps them, one just too
 * narrow truncates exactly as far as it must to fit, and one too narrow even for its minimums
 * takes its floors back and scrolls.
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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { DESIGN_TOKENS } from '../tokens/tokens';
import { DATA_TABLE_COLUMN_TRACKS, DataTable } from './DataTable';
import type {
  DataTableCellMeta,
  DataTableColumn,
  DataTableColumnWidth,
  DataTableSort,
} from './DataTable';
import { Input } from './Input';
import { Text } from './Text';
import { Tooltip } from './Tooltip';

/** The four option fields this suite asserts on, held as `unknown` so nothing is assumed. */
interface RecordedVirtualizerOptions {
  /** `count`: the row count handed to the virtualizer. */
  readonly count: unknown;

  /** `enabled`: whether the virtualizer is live. */
  readonly enabled: unknown;

  /** `overscan`: rows rendered beyond each viewport edge. */
  readonly overscan: unknown;

  /** `useFlushSync`: whether the virtualizer flushes its notifications through `flushSync`. */
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
 * The most rows a `POST /sessions/:id/panel-data` response can carry - the result an unbounded
 * first paint would put in the DOM whole.
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

describe('DataTable unmeasured first paint', () => {
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
    // assertion the bound exists for: an unbounded first paint would put all 5 000 here.
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

describe('DataTable explicit all-rows modes', () => {
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

describe('DataTable bounded window and the roving tab stop', () => {
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

describe('DataTable unmeasuredWindowRows sizing', () => {
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

describe('DataTable measured virtualized path', () => {
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

    // The notification reached React and the window MOVED - the update path `useFlushSync` governs,
    // rather than a render that merely survived the event.
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

    // The runtime symptom of `useFlushSync: true`, asserted negatively across the whole
    // mount-measure-scroll sequence: React 19 reports a `flushSync` that ran while it was rendering
    // or committing through `console.error`, and nothing here reported one. This is a regression
    // guard rather than the proof of the option - whether React notices depends on which phase the
    // notification arrives in, and `fireEvent` wraps this one in `act` - so the deterministic pin
    // for the option itself is the options assertion in the group below.
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

describe('DataTable virtualizer options', () => {
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

/** The row count of the ARIA and keyboard fixtures: enough for a first, a middle and a last row. */
const SHORT_RESULT_ROWS = 4;

/** The visible text of a fixture row's expand toggle. */
function toggleLabel(row: SampleRow): string {
  return `Toggle ${row.label}`;
}

/** The text a fixture row's detail renders. */
function detailText(row: SampleRow): string {
  return `Detail of ${row.label}`;
}

/**
 * Columns whose second cell is an expand toggle wired from `meta` exactly as the DataTable
 * contract asks: `aria-expanded` and `aria-controls` on the control, `tabIndex={-1}` on it.
 *
 * @param onToggle Called with the row key when the toggle is clicked.
 * @param recorded When given, receives each cell's meta under `<row id>:<column key>`, overwritten
 *   on every render so it always holds the latest commit's values.
 * @returns The two columns.
 */
function toggleColumns(
  onToggle: (key: string) => void,
  recorded?: Map<string, DataTableCellMeta>,
): readonly DataTableColumn<SampleRow>[] {
  return [
    {
      key: 'label',
      header: 'Label',
      rowHeader: true,
      cell: (row, _rowIndex, meta) => {
        recorded?.set(`${row.id}:label`, meta);

        return row.label;
      },
    },
    {
      key: 'toggle',
      header: 'Detail',
      cell: (row, _rowIndex, meta) => {
        recorded?.set(`${row.id}:toggle`, meta);

        return (
          <Button
            size="sm"
            tabIndex={-1}
            aria-expanded={meta.expanded}
            aria-controls={meta.detailRowId}
            onClick={() => {
              onToggle(row.id);
            }}
          >
            {toggleLabel(row)}
          </Button>
        );
      },
    },
  ];
}

/** Props of {@link ExpandableTable}. */
interface ExpandableTableProps {
  /** The table's caption, which also tells two instances apart. */
  readonly caption: string;

  /** The keys open on first render. */
  readonly initiallyExpanded?: readonly string[];
}

/**
 * A caller that owns its expansion set, the way every table component does: the toggle in a cell
 * and the table's own expand keys both flip the same controlled state.
 */
function ExpandableTable(props: ExpandableTableProps): ReactElement {
  const { caption, initiallyExpanded = [] } = props;
  const [expanded, setExpanded] = useState<readonly string[]>(initiallyExpanded);

  const toggle = (key: string): void => {
    setExpanded((current) =>
      current.includes(key) ? current.filter((open) => open !== key) : [...current, key],
    );
  };

  return (
    <DataTable
      caption={caption}
      rows={makeRows(SHORT_RESULT_ROWS)}
      rowKey={(row) => row.id}
      columns={toggleColumns(toggle)}
      expandedRowKeys={expanded}
      onRowToggle={(row) => {
        toggle(row.id);
      }}
      renderExpandedRow={(row) => detailText(row)}
    />
  );
}

/**
 * A row's expand toggle, found by its visible label.
 *
 * @param container Where to look.
 * @param row The fixture row.
 * @returns The toggle.
 */
function toggleOf(container: HTMLElement, row: SampleRow): HTMLElement {
  const toggle = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === toggleLabel(row),
  );

  if (toggle === undefined) {
    throw new Error(`no toggle is rendered for ${row.id}`);
  }

  return toggle;
}

/**
 * One fixture row by index.
 *
 * @param index The index into a {@link SHORT_RESULT_ROWS} result.
 * @returns The row.
 */
function sampleRow(index: number): SampleRow {
  const row = makeRows(SHORT_RESULT_ROWS)[index];

  if (row === undefined) {
    throw new Error(`the fixture has no row ${String(index)}`);
  }

  return row;
}

describe('DataTable expanded state on the toggle, not the row', () => {
  it('puts aria-expanded on no row, open or closed, and keeps the expanded styling', () => {
    const { container } = render(
      <DataTable
        caption="Expandable rows"
        rows={makeRows(SHORT_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={toggleColumns(() => {})}
        expandedRowKeys={['row-1']}
        onRowToggle={() => {}}
        renderExpandedRow={(row) => detailText(row)}
      />,
    );

    // The header row, every data row and the one open detail row: all of them `role="row"`, and
    // not one reports the state a `grid` row does not support.
    expect(container.querySelectorAll('[role="row"]')).toHaveLength(1 + SHORT_RESULT_ROWS + 1);
    expect(container.querySelectorAll('[role="row"][aria-expanded]')).toHaveLength(0);

    // The open row's appearance comes from a class, not an ARIA state.
    expect(
      container.querySelector('[data-row-index="1"]')?.classList.contains('dg-is-expanded'),
    ).toBe(true);
    expect(
      container.querySelector('[data-row-index="0"]')?.classList.contains('dg-is-expanded'),
    ).toBe(false);
  });

  it('hands every cell of a row one meta that names its rendered detail row', () => {
    const recorded = new Map<string, DataTableCellMeta>();
    const { container } = render(
      <DataTable
        caption="Expandable rows"
        rows={makeRows(SHORT_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={toggleColumns(() => {}, recorded)}
        expandedRowKeys={['row-0', 'row-2']}
        onRowToggle={() => {}}
        renderExpandedRow={(row) => detailText(row)}
      />,
    );

    const open = recorded.get('row-0:toggle');
    const closed = recorded.get('row-1:toggle');
    const secondOpen = recorded.get('row-2:toggle');

    // One object per row, shared by all of its cells.
    expect(recorded.get('row-0:label')).toBe(open);

    expect(open?.expanded).toBe(true);
    expect(closed).toEqual({ expanded: false, detailRowId: undefined });
    expect(secondOpen?.expanded).toBe(true);

    const detailRowId = open?.detailRowId ?? '';

    // A single id token that resolves to the detail row this table rendered for that row.
    expect(detailRowId).toMatch(/^\S+$/u);

    const detailRow = document.getElementById(detailRowId);

    expect(detailRow).not.toBeNull();
    expect(detailRow?.getAttribute('role')).toBe('row');
    expect(detailRow?.classList.contains('dg-data-table__expanded')).toBe(true);
    expect(detailRow?.getAttribute('data-detail-row-index')).toBe('0');
    expect(detailRow?.textContent).toBe(detailText(sampleRow(0)));

    // Unique per row.
    expect(secondOpen?.detailRowId).not.toBe(detailRowId);
    expect(document.getElementById(secondOpen?.detailRowId ?? '')?.textContent).toBe(
      detailText(sampleRow(2)),
    );

    // The toggle carries the expansion state; a closed toggle controls nothing, because its detail
    // row is not rendered.
    const openToggle = toggleOf(container, sampleRow(0));
    const closedToggle = toggleOf(container, sampleRow(1));

    expect(openToggle.getAttribute('aria-expanded')).toBe('true');
    expect(openToggle.getAttribute('aria-controls')).toBe(detailRowId);
    expect(closedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(closedToggle.hasAttribute('aria-controls')).toBe(false);
  });

  it('reports nothing expanded without renderExpandedRow, whatever expandedRowKeys says', () => {
    const recorded = new Map<string, DataTableCellMeta>();
    const { container } = render(
      <DataTable
        caption="Rows without detail"
        rows={makeRows(SHORT_RESULT_ROWS)}
        rowKey={(row) => row.id}
        columns={toggleColumns(() => {}, recorded)}
        expandedRowKeys={['row-0']}
      />,
    );

    expect(recorded.get('row-0:toggle')).toEqual({ expanded: false, detailRowId: undefined });
    expect(container.querySelector('.dg-data-table__expanded')).toBeNull();
    expect(container.querySelector('.dg-is-expanded')).toBeNull();
  });

  it('names the detail row only while it is rendered, across an open and a close', () => {
    const { container } = render(<ExpandableTable caption="Toggled rows" />);
    const toggle = toggleOf(container, sampleRow(1));

    expect(toggle.hasAttribute('aria-controls')).toBe(false);

    fireEvent.click(toggle);

    const controlled = toggleOf(container, sampleRow(1)).getAttribute('aria-controls') ?? '';

    expect(toggleOf(container, sampleRow(1)).getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(controlled)?.textContent).toBe(detailText(sampleRow(1)));

    fireEvent.click(toggleOf(container, sampleRow(1)));

    // Closed again: the detail row is gone, and so is the reference to it.
    expect(toggleOf(container, sampleRow(1)).getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf(container, sampleRow(1)).hasAttribute('aria-controls')).toBe(false);
    expect(document.getElementById(controlled)).toBeNull();
  });

  it('keeps detail row ids apart between two tables showing the same keys', () => {
    const { container } = render(
      <>
        <ExpandableTable caption="First table" initiallyExpanded={['row-0']} />
        <ExpandableTable caption="Second table" initiallyExpanded={['row-0']} />
      </>,
    );

    const ids = Array.from(container.querySelectorAll('.dg-data-table__expanded')).map(
      (row) => row.id,
    );

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

/** The visible text of the button rendered before the keyboard fixture's table. */
const BEFORE_TABLE = 'Before the table';

/** The visible text of the button rendered after the keyboard fixture's table. */
const AFTER_TABLE = 'After the table';

/** The first in-cell control of a keyboard fixture row. */
function inspectLabel(row: SampleRow): string {
  return `Inspect ${row.label}`;
}

/** The second in-cell control of a keyboard fixture row. */
function copyLabel(row: SampleRow): string {
  return `Copy ${row.label}`;
}

/** The control an expanded keyboard fixture row renders in its detail. */
function detailActionLabel(row: SampleRow): string {
  return `Open detail of ${row.label}`;
}

/** Props of {@link KeyboardTable}. */
interface KeyboardTableProps {
  /** How many rows to render. Defaults to {@link SHORT_RESULT_ROWS}. */
  readonly rowCount?: number;

  /** Whether rows expand: a toggle in the actions cell, the expand keys and a detail control. */
  readonly expandable?: boolean;

  /** Passed through to the table; omitted, the rows activate nothing. */
  readonly onRowActivate?: ((row: SampleRow, index: number) => void) | undefined;

  /** Called with the visible text of whichever fixture control was pressed. */
  readonly onControl?: (name: string) => void;

  /** Raised by the two sortable headers. */
  readonly onSortChange?: (sort: DataTableSort) => void;

  /** Columns appended after the fixture's own, for the cases that need one more kind of control. */
  readonly extraColumns?: readonly DataTableColumn<SampleRow>[];
}

/**
 * The keyboard fixture: a focusable button before and after a table whose rows each carry two
 * `tabIndex={-1}` buttons - the contract every table component follows - under two sortable
 * headers. Expansion, when asked for, is controlled state, the way the table components own it.
 */
function KeyboardTable(props: KeyboardTableProps): ReactElement {
  const {
    rowCount = SHORT_RESULT_ROWS,
    expandable = false,
    onRowActivate,
    onControl = () => {},
    onSortChange = () => {},
    extraColumns = [],
  } = props;
  const [expanded, setExpanded] = useState<readonly string[]>([]);

  const toggle = (key: string): void => {
    setExpanded((current) =>
      current.includes(key) ? current.filter((open) => open !== key) : [...current, key],
    );
  };

  const columns: readonly DataTableColumn<SampleRow>[] = [
    { key: 'label', header: 'Label', rowHeader: true, sortable: true, cell: (row) => row.label },
    {
      key: 'amount',
      header: 'Amount',
      align: 'end',
      sortable: true,
      defaultSortDirection: 'desc',
      cell: (row) => String(row.amount),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (row, _rowIndex, meta) => (
        <>
          {expandable ? (
            <Button
              size="sm"
              tabIndex={-1}
              aria-expanded={meta.expanded}
              aria-controls={meta.detailRowId}
              onClick={() => {
                toggle(row.id);
              }}
            >
              {toggleLabel(row)}
            </Button>
          ) : null}
          <Button
            size="sm"
            tabIndex={-1}
            onClick={() => {
              onControl(inspectLabel(row));
            }}
          >
            {inspectLabel(row)}
          </Button>
          <Button
            size="sm"
            tabIndex={-1}
            onClick={() => {
              onControl(copyLabel(row));
            }}
          >
            {copyLabel(row)}
          </Button>
        </>
      ),
    },
    ...extraColumns,
  ];

  return (
    <>
      <Button>{BEFORE_TABLE}</Button>
      <DataTable
        caption="Keyboard fixture"
        rows={makeRows(rowCount)}
        rowKey={(row) => row.id}
        columns={columns}
        sort={null}
        onSortChange={onSortChange}
        onRowActivate={onRowActivate}
        expandedRowKeys={expandable ? expanded : undefined}
        onRowToggle={
          expandable
            ? (row) => {
                toggle(row.id);
              }
            : undefined
        }
        renderExpandedRow={
          expandable
            ? (row) => (
                <Button
                  size="sm"
                  tabIndex={-1}
                  onClick={() => {
                    onControl(detailActionLabel(row));
                  }}
                >
                  {detailActionLabel(row)}
                </Button>
              )
            : undefined
        }
      />
      <Button>{AFTER_TABLE}</Button>
    </>
  );
}

/**
 * The element whose text is exactly `text` among the matches of `selector`.
 *
 * @param container Where to look.
 * @param text The visible text.
 * @param selector What to look among; buttons by default.
 * @returns The element.
 */
function byText(container: HTMLElement, text: string, selector = 'button'): HTMLElement {
  const found = Array.from(container.querySelectorAll(selector)).find(
    (element) => element.textContent === text,
  );

  if (!(found instanceof HTMLElement)) {
    throw new Error(`nothing matching ${selector} reads "${text}"`);
  }

  return found;
}

/**
 * One data row by index.
 *
 * @param container Where to look.
 * @param index The row index.
 * @returns The row element.
 */
function rowAt(container: HTMLElement, index: number): HTMLElement {
  const row = container.querySelector(`[data-row-index="${String(index)}"]`);

  if (!(row instanceof HTMLElement)) {
    throw new Error(`row ${String(index)} is not rendered`);
  }

  return row;
}

/**
 * The header's sort controls, left to right.
 *
 * @param container Where to look.
 * @returns The buttons inside the column headers.
 */
function sortButtons(container: HTMLElement): readonly HTMLElement[] {
  return Array.from(container.querySelectorAll('[role="columnheader"] button')).filter(
    (button): button is HTMLElement => button instanceof HTMLElement,
  );
}

/**
 * The first element of `container` with the given role.
 *
 * @param container Where to look.
 * @param role The role attribute value.
 * @returns The element.
 */
function firstWithRole(container: Element, role: string): HTMLElement {
  const element = container.querySelector(`[role="${role}"]`);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`nothing with role ${role} is rendered`);
  }

  return element;
}

/**
 * Focus an element the way a pointer or a script would, inside `act` so React commits whatever
 * the focus handlers set.
 *
 * @param element The element to focus.
 */
function focusDirectly(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
}

/**
 * The bubble a tooltip trigger names in its `aria-describedby`.
 *
 * @param trigger The trigger.
 * @returns The bubble.
 */
function bubbleOf(trigger: HTMLElement): HTMLElement {
  const bubble = document.getElementById(trigger.getAttribute('aria-describedby') ?? '');

  if (bubble === null) {
    throw new Error('the trigger names no bubble');
  }

  return bubble;
}

/** Props of {@link FieldCell}. */
interface FieldCellProps {
  /** The row the field annotates. */
  readonly row: SampleRow;
}

/** A controlled text field in a cell, with the `tabIndex={-1}` the DataTable contract asks for. */
function FieldCell(props: FieldCellProps): ReactElement {
  const [value, setValue] = useState('');

  return (
    <Input
      label={`Note for ${props.row.label}`}
      labelHidden
      value={value}
      onValueChange={setValue}
      tabIndex={-1}
    />
  );
}

/**
 * Give one element a layout in which it overflows its box along the inline axis, which happy-dom
 * never reports by itself.
 *
 * @param element The element.
 * @param overflowX Its `overflow-x`: `auto` scrolls the overflow, `hidden` clips it.
 */
function overflowInline(element: HTMLElement, overflowX: 'auto' | 'hidden'): void {
  element.style.overflowX = overflowX;
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 400 });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: 100 });
}

describe('DataTable one Tab stop per grid', () => {
  it('takes the header sort controls out of the Tab order only while rows exist', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<KeyboardTable />);

    expect(sortButtons(container).map((button) => button.getAttribute('tabindex'))).toEqual([
      '-1',
      '-1',
    ]);

    // No rows: no row to arrive through, so the sort controls are ordinary Tab stops again.
    rerender(<KeyboardTable rowCount={0} />);

    const [labelSort, amountSort] = sortButtons(container);

    expect(sortButtons(container).map((button) => button.hasAttribute('tabindex'))).toEqual([
      false,
      false,
    ]);

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    expect(document.activeElement).toBe(labelSort);
    await user.tab();
    expect(document.activeElement).toBe(amountSort);
    await user.tab();
    expect(document.activeElement).toBe(byText(container, AFTER_TABLE));
  });

  it('is entered on the active row by one Tab and left by the next, past every control', async () => {
    const user = userEvent.setup();
    const { container } = render(<KeyboardTable />);
    const grid = firstWithRole(container, 'grid');

    // Exactly one element inside the grid is in the Tab order, however many controls it holds.
    const tabbable = Array.from(grid.querySelectorAll('button, [tabindex]')).filter(
      (element) => element instanceof HTMLElement && element.tabIndex >= 0,
    );

    expect(tabbable).toEqual([rowAt(container, 0)]);

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    expect(document.activeElement).toBe(rowAt(container, 0));

    await user.tab();
    expect(document.activeElement).toBe(byText(container, AFTER_TABLE));

    // Back in on the row, and the roving stop is kept: move down, leave, return.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rowAt(container, 0));

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(container, 2));

    await user.tab();
    expect(document.activeElement).toBe(byText(container, AFTER_TABLE));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rowAt(container, 2));
  });

  it('returns Shift+Tab from a control to its row, and the next Shift+Tab leaves the grid', async () => {
    const user = userEvent.setup();
    const { container } = render(<KeyboardTable />);

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(byText(container, inspectLabel(sampleRow(0))));

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rowAt(container, 0));

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(byText(container, BEFORE_TABLE));
  });
});

describe('DataTable arrow keys inside a row', () => {
  it('moves into a row with ArrowRight and across its controls with ArrowRight and ArrowLeft', async () => {
    const user = userEvent.setup();
    const { container } = render(<KeyboardTable />);
    const inspect = byText(container, inspectLabel(sampleRow(0)));
    const copy = byText(container, copyLabel(sampleRow(0)));

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(inspect);

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(copy);

    // The last control stays put.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(copy);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(inspect);

    // ArrowLeft from the first control returns to the row.
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(rowAt(container, 0));

    // The row kept the roving stop all along; no control ever took a Tab stop.
    expect(rowAt(container, 0).getAttribute('tabindex')).toBe('0');
    expect(inspect.getAttribute('tabindex')).toBe('-1');
  });

  it('jumps to the first and last control with Home and End, and changes rows from a control', async () => {
    const user = userEvent.setup();
    const { container } = render(<KeyboardTable />);

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowRight}{End}');
    expect(document.activeElement).toBe(byText(container, copyLabel(sampleRow(0))));

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(byText(container, inspectLabel(sampleRow(0))));

    // Down from a control lands on the next row, which takes the roving stop.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(container, 1));
    expect(rowAt(container, 1).getAttribute('tabindex')).toBe('0');
    expect(rowAt(container, 0).getAttribute('tabindex')).toBe('-1');

    await user.keyboard('{ArrowRight}{ArrowUp}');
    expect(document.activeElement).toBe(rowAt(container, 0));

    // Up from a control in the first row clamps to that row, and focus lands on it.
    await user.keyboard('{ArrowRight}{ArrowUp}');
    expect(document.activeElement).toBe(rowAt(container, 0));

    // PageDown and PageUp count from the control's row and clamp to the result.
    await user.keyboard('{ArrowRight}{PageDown}');
    expect(document.activeElement).toBe(rowAt(container, SHORT_RESULT_ROWS - 1));

    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(container, SHORT_RESULT_ROWS - 1));

    await user.keyboard('{ArrowRight}{PageUp}');
    expect(document.activeElement).toBe(rowAt(container, 0));
  });

  it('returns to the row with Escape, after an open tooltip has taken the first Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <KeyboardTable
        extraColumns={[
          {
            key: 'note',
            header: 'Note',
            cell: (row) => (
              <Tooltip content={`About ${row.label}`}>
                <Text size="sm" tabIndex={-1}>
                  {`Note on ${row.label}`}
                </Text>
              </Tooltip>
            ),
          },
        ]}
      />,
    );

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(byText(container, inspectLabel(sampleRow(0))));

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowAt(container, 0));

    // An arrow key reaching the trigger opens its description, exactly as a Tab would.
    await user.keyboard('{ArrowRight}{End}');

    const trigger = byText(container, `Note on ${sampleRow(0).label}`, '[tabindex]');

    expect(document.activeElement).toBe(trigger);
    expect(bubbleOf(trigger).classList.contains('dg-is-open')).toBe(true);

    // The first Escape belongs to the open bubble, and focus stays on the trigger.
    await user.keyboard('{Escape}');
    expect(bubbleOf(trigger).classList.contains('dg-is-open')).toBe(false);
    expect(document.activeElement).toBe(trigger);

    // The second has nothing of the tooltip's to dismiss, and returns to the row.
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowAt(container, 0));
  });

  it('leaves Enter and Space on a control to the control, never activating the row', async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    const onControl = vi.fn();
    const { container } = render(
      <KeyboardTable onRowActivate={onRowActivate} onControl={onControl} />,
    );
    const inspect = byText(container, inspectLabel(sampleRow(0)));

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowRight}');

    await user.keyboard('{Enter}');
    expect(onControl).toHaveBeenLastCalledWith(inspectLabel(sampleRow(0)));

    await user.keyboard(' ');
    expect(onControl).toHaveBeenCalledTimes(2);

    expect(onRowActivate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(inspect);

    // On the row itself, Enter still activates it.
    await user.keyboard('{Escape}{Enter}');
    expect(onRowActivate).toHaveBeenCalledTimes(1);
    expect(onRowActivate).toHaveBeenCalledWith(sampleRow(0), 0);
  });

  it('moves into the row with Enter when the row activates nothing, and with F2 always', async () => {
    const user = userEvent.setup();
    const withoutActivation = render(<KeyboardTable />);

    focusDirectly(byText(withoutActivation.container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(
      byText(withoutActivation.container, inspectLabel(sampleRow(0))),
    );

    withoutActivation.unmount();

    const onRowActivate = vi.fn();
    const withActivation = render(<KeyboardTable onRowActivate={onRowActivate} />);

    focusDirectly(byText(withActivation.container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{F2}');
    expect(document.activeElement).toBe(
      byText(withActivation.container, inspectLabel(sampleRow(0))),
    );
    expect(onRowActivate).not.toHaveBeenCalled();
  });

  it('opens a collapsed row with ArrowRight first, then enters it and its detail row', async () => {
    const user = userEvent.setup();
    const onControl = vi.fn();
    const { container } = render(<KeyboardTable expandable onControl={onControl} />);
    const first = sampleRow(0);

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();

    // The first ArrowRight opens the row and leaves focus on it.
    await user.keyboard('{ArrowRight}');
    expect(byText(container, toggleLabel(first)).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(rowAt(container, 0));

    // The second moves into it, and the scope runs on into the open detail row.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(byText(container, toggleLabel(first)));

    await user.keyboard('{End}');

    const detailAction = byText(container, detailActionLabel(first));

    expect(document.activeElement).toBe(detailAction);
    expect(detailAction.closest('.dg-data-table__expanded')).not.toBeNull();

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(byText(container, copyLabel(first)));

    await user.keyboard('{ArrowRight}{Enter}');
    expect(onControl).toHaveBeenLastCalledWith(detailActionLabel(first));

    // Escape from the detail returns to its DATA row.
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowAt(container, 0));

    // Down from the detail's control counts from its data row.
    await user.keyboard('{ArrowRight}{End}{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(container, 1));

    // A pointer click into the detail moves the roving stop back to the row it belongs to.
    await user.click(byText(container, detailActionLabel(first)));
    expect(rowAt(container, 0).getAttribute('tabindex')).toBe('0');
    expect(rowAt(container, 1).getAttribute('tabindex')).toBe('-1');

    // ArrowLeft on the open row closes it, and a second ArrowLeft does nothing more.
    await user.keyboard('{Escape}{ArrowLeft}');
    expect(document.activeElement).toBe(rowAt(container, 0));
    expect(byText(container, toggleLabel(first)).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.dg-data-table__expanded')).toBeNull();

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(rowAt(container, 0));
    expect(byText(container, toggleLabel(first)).getAttribute('aria-expanded')).toBe('false');
  });

  it('moves the roving stop to the row of a control a pointer clicks', async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    const onControl = vi.fn();
    const { container } = render(
      <KeyboardTable onRowActivate={onRowActivate} onControl={onControl} />,
    );
    const copy = byText(container, copyLabel(sampleRow(2)));

    await user.click(copy);

    expect(onControl).toHaveBeenCalledWith(copyLabel(sampleRow(2)));
    expect(onRowActivate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(copy);
    expect(rowAt(container, 2).getAttribute('tabindex')).toBe('0');
    expect(rowAt(container, 0).getAttribute('tabindex')).toBe('-1');

    // Tab into the grid now lands on the row the click was in.
    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    expect(document.activeElement).toBe(rowAt(container, 2));
  });

  it('skips disabled and hidden controls', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <KeyboardTable
        extraColumns={[
          {
            key: 'more',
            header: 'More',
            cell: (row) => (
              <>
                <Button size="sm" tabIndex={-1} disabled>
                  {`Unavailable for ${row.label}`}
                </Button>
                <span aria-hidden="true">
                  <Button size="sm" tabIndex={-1}>
                    {`Concealed for ${row.label}`}
                  </Button>
                </span>
                <span hidden>
                  <Button size="sm" tabIndex={-1}>
                    {`Unrendered for ${row.label}`}
                  </Button>
                </span>
                <Button size="sm" tabIndex={-1}>
                  {`Last for ${row.label}`}
                </Button>
              </>
            ),
          },
        ]}
      />,
    );
    const last = byText(container, `Last for ${sampleRow(0).label}`);

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(last);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(byText(container, copyLabel(sampleRow(0))));

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(last);
  });
});

describe('DataTable header keys', () => {
  it('moves between the first row and the header with ArrowUp and ArrowDown', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    const { container } = render(<KeyboardTable onSortChange={onSortChange} />);
    const [labelSort, amountSort] = sortButtons(container);

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(labelSort);

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(amountSort);

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(amountSort);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(labelSort);

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(amountSort);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(labelSort);

    // Enter stays native: the sort control sorts, and focus stays in the header.
    await user.keyboard('{Enter}');
    expect(onSortChange).toHaveBeenCalledWith({ key: 'label', direction: 'asc' });
    expect(document.activeElement).toBe(labelSort);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(container, 0));

    // Only the first row leads up to the header.
    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(document.activeElement).toBe(rowAt(container, 0));
  });

  it('returns from the header to the row holding the roving stop', async () => {
    const user = userEvent.setup();
    const { container } = render(<KeyboardTable />);

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(container, 2));

    // Focus placed in the header directly - by a pointer, say - leaves the roving stop where it
    // was, and both ways back to the body return to that row rather than to the first.
    focusDirectly(byText(container, 'Amount'));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowAt(container, 2));

    focusDirectly(byText(container, 'Label'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(container, 2));
  });
});

describe('DataTable controls that keep their own keys', () => {
  it('leaves a text field its arrows and Home/End, and gives it only Escape', async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    const { container } = render(
      <KeyboardTable
        onRowActivate={onRowActivate}
        extraColumns={[{ key: 'field', header: 'Field', cell: (row) => <FieldCell row={row} /> }]}
      />,
    );

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowRight}{End}');

    const field = document.activeElement;

    if (!(field instanceof HTMLInputElement)) {
      throw new Error('End did not reach the field in the last column');
    }

    // `fireEvent` reports whether the event was cancelled: none of these may be.
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Enter']) {
      expect(fireEvent.keyDown(field, { key })).toBe(true);
      expect(document.activeElement).toBe(field);
    }

    expect(onRowActivate).not.toHaveBeenCalled();

    // Typing still types.
    await user.keyboard('abc');
    expect(field.value).toBe('abc');

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowAt(container, 0));
  });

  it("leaves an element that scrolls along a key's axis that axis's keys", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <KeyboardTable
        extraColumns={[
          {
            key: 'value',
            header: 'Value',
            cell: (row) => (
              <Text size="sm" tabIndex={-1}>
                {`Long value of ${row.label}`}
              </Text>
            ),
          },
        ]}
      />,
    );
    const scrolling = byText(container, `Long value of ${sampleRow(0).label}`, '[tabindex]');
    const clipped = byText(container, `Long value of ${sampleRow(1).label}`, '[tabindex]');

    overflowInline(scrolling, 'auto');
    overflowInline(clipped, 'hidden');

    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowRight}{End}');
    expect(document.activeElement).toBe(scrolling);

    // It scrolls horizontally, so the inline keys are its own.
    expect(fireEvent.keyDown(scrolling, { key: 'ArrowLeft' })).toBe(true);
    expect(fireEvent.keyDown(scrolling, { key: 'Home' })).toBe(true);
    expect(document.activeElement).toBe(scrolling);

    // It does not scroll vertically, so ArrowDown is still the grid's.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(container, 1));

    // A clipped, truncated value overflows too but scrolls nothing, so it moves on as usual.
    await user.keyboard('{ArrowRight}{End}');
    expect(document.activeElement).toBe(clipped);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(byText(container, copyLabel(sampleRow(1))));
  });

  it('leaves the keys of a grid nested in a cell to that grid', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <KeyboardTable
        extraColumns={[
          {
            key: 'nested',
            header: 'Nested',
            cell: (row) =>
              row.id === 'row-0' ? (
                <DataTable
                  caption="Nested fixture"
                  rows={makeRows(2)}
                  rowKey={(inner) => inner.id}
                  columns={columns}
                />
              ) : null,
          },
        ]}
      />,
    );
    const [, nestedGrid] = Array.from(container.querySelectorAll('[role="grid"]'));

    if (!(nestedGrid instanceof HTMLElement)) {
      throw new Error('the nested grid is not rendered');
    }

    const nestedFirstRow = rowAt(nestedGrid, 0);
    const outerFirstRow = container.querySelector('[data-row-index="0"]');

    expect(outerFirstRow).not.toBe(nestedFirstRow);

    // The outer table's own controls end before the nested grid: End from a control stays out.
    focusDirectly(byText(container, BEFORE_TABLE));
    await user.tab();
    await user.keyboard('{ArrowRight}{End}');
    expect(document.activeElement).toBe(byText(container, copyLabel(sampleRow(0))));

    // Down from the outer row reaches the OUTER second row, not the nested grid's row of the same
    // index, which comes earlier in document order.
    await user.keyboard('{Escape}{ArrowDown}');

    const outerRows = Array.from(container.querySelectorAll('[data-row-index="1"]')).filter(
      (row) => row.closest('[role="grid"]') !== nestedGrid,
    );

    expect(outerRows).toHaveLength(1);
    expect(document.activeElement).toBe(outerRows[0]);

    // Keys on the nested grid's rows are answered by that grid alone, and focus there does not
    // move the outer roving stop.
    focusDirectly(nestedFirstRow);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowAt(nestedGrid, 1));
    expect(outerRows[0]?.getAttribute('tabindex')).toBe('0');

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowAt(nestedGrid, 1));
  });
});

/**
 * The grid element of a rendered table.
 *
 * @param container The render container.
 * @returns The `role="grid"` element.
 */
function gridOf(container: HTMLElement): HTMLElement {
  const grid = container.querySelector('[role="grid"]');

  if (!(grid instanceof HTMLElement)) {
    throw new Error('the table rendered no grid');
  }

  return grid;
}

/** A table's column list, one column per width role the test chooses (`undefined` = no role). */
function columnsWithWidths(
  widths: readonly (DataTableColumnWidth | undefined)[],
): readonly DataTableColumn<SampleRow>[] {
  return widths.map((width, index) => ({
    key: `column-${String(index)}`,
    header: `Column ${String(index)}`,
    rowHeader: index === 0,
    ...(width === undefined ? {} : { width }),
    cell: (row: SampleRow) => row.label,
  }));
}

/** Every custom property name the token table declares. */
const TOKEN_PROPERTY_NAMES: ReadonlySet<string> = new Set(
  Object.keys(DESIGN_TOKENS.dark).map((key) => `--dg-${kebabOf(key)}`),
);

/**
 * A token key in the kebab form its custom property carries, computed independently of the
 * product's `cssVarName` so a drift between the two cannot pass here.
 *
 * @param key A camel-case token key.
 * @returns The key's kebab form, digit boundaries included.
 */
function kebabOf(key: string): string {
  return key
    .replace(/([A-Z])/gu, '-$1')
    .replace(/([A-Za-z])(\d)/gu, '$1-$2')
    .toLowerCase();
}

/**
 * The value a `var(--dg-…)` reference resolves to in one theme.
 *
 * @param reference A single `var(--dg-…)` reference.
 * @param values The theme's token values; the default theme when omitted.
 * @returns The referenced token's value in that theme.
 */
function tokenValueOf(
  reference: string,
  values: Readonly<Record<string, string>> = DESIGN_TOKENS.dark,
): string {
  const property = /^var\((--dg-[a-z0-9-]+)\)$/u.exec(reference)?.[1];
  const key = Object.keys(values).find((name) => `--dg-${kebabOf(name)}` === property);

  if (key === undefined) {
    throw new Error(`${reference} references no token the table declares`);
  }

  return values[key] ?? '';
}

/** The roles whose content truncates, and which narrow first when the floors do not fit. */
const TRUNCATING_ROLES: readonly DataTableColumnWidth[] = ['name', 'text'];

/** The roles whose content does not survive being cut, and which keep their full floor. */
const COMPACT_ROLES: readonly DataTableColumnWidth[] = [
  'ordinal',
  'count',
  'quantity',
  'status',
  'label',
  'standard',
];

/** The yield token's reference, spelled here rather than through the product's `cssVar`. */
const YIELD_REFERENCE = 'var(--dg-column-yield)';

/** Every theme's token values, each of which must give every role a usable minimum. */
const THEME_VALUES: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['dark', DESIGN_TOKENS.dark],
  ['light', DESIGN_TOKENS.light],
  ['highContrast', DESIGN_TOKENS.highContrast],
];

/**
 * A role's readable-floor reference, spelled independently of the product's `cssVar`.
 *
 * @param role A column width role.
 * @returns `var(--dg-column-min-<role>)`.
 */
function floorReferenceOf(role: string): string {
  return `var(--dg-column-min-${role})`;
}

/**
 * A truncating role's guaranteed minimum: its readable floor scaled by the yield token.
 *
 * @param role A column width role.
 * @returns `calc(var(--dg-column-min-<role>) * var(--dg-column-yield))`.
 */
function yieldedFloorOf(role: string): string {
  return `calc(${floorReferenceOf(role)} * ${YIELD_REFERENCE})`;
}

/**
 * The grid-published properties a truncating track reads, besides tokens. Nothing else may appear
 * in a track: a column's geometry is tokens and the grid's own sums.
 */
const GRID_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  '--dgc-readable-inline',
  '--dgc-min-inline',
  '--dgc-yield-count',
  '--dgc-column-count',
]);

/**
 * A truncating role's track, spelled out independently of the product: the floor less this
 * column's part of the shortfall (an equal share, or what the other truncating columns cannot
 * absorb), clamped between the yielded minimum and the floor.
 *
 * @param role A truncating column width role.
 * @param share The role's `--dg-column-share-*` suffix.
 * @returns The track the role must resolve to.
 */
function yieldingTrackOf(role: string, share: string): string {
  const floor = floorReferenceOf(role);
  const minimum = yieldedFloorOf(role);
  const shortfall =
    '(var(--dgc-readable-inline) + var(--dgc-column-count) * var(--dg-space-2) - ' +
    'var(--dg-space-2) - var(--dg-size-full))';
  const capacity = '(var(--dgc-readable-inline) - var(--dgc-min-inline))';

  return (
    `minmax(clamp(${minimum}, ${floor} - max(${shortfall} / var(--dgc-yield-count), ` +
    `${shortfall} - ${capacity} + ${floor} - ${minimum}), ${floor}), ` +
    `var(--dg-column-share-${share}))`
  );
}

/**
 * The component stylesheet, read from disk relative to this file. Joined with `node:path` rather
 * than resolved with `new URL(…)`: under happy-dom the global `URL` is the DOM's, which Node's
 * `fileURLToPath` rejects.
 */
const COMPONENT_STYLESHEET = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'components.css'),
  'utf8',
);

/** The grid floor declaration, read from the stylesheet on first use. */
let cachedGridFloorDeclaration: string | undefined;

/**
 * The grid's `min-inline-size` as the stylesheet declares it - the half of the fit rule the rows
 * cannot state, since it sizes the grid element they sit in.
 *
 * @returns The declaration's value, whitespace collapsed.
 */
function gridFloorDeclaration(): string {
  cachedGridFloorDeclaration ??= readGridFloorDeclaration();
  return cachedGridFloorDeclaration;
}

/**
 * Reads the grid's `min-inline-size` declaration out of the stylesheet.
 *
 * @returns The declaration's value, whitespace collapsed.
 */
function readGridFloorDeclaration(): string {
  const selector = "\n.dg-data-table [role='grid'] {";
  const start = COMPONENT_STYLESHEET.indexOf(selector);

  if (start === -1) {
    throw new Error('the grid rule is missing from components.css');
  }

  const body = COMPONENT_STYLESHEET.slice(
    start + selector.length,
    COMPONENT_STYLESHEET.indexOf('\n}', start),
  );
  const value = /min-inline-size:([^;]*);/u.exec(body)?.[1];

  if (value === undefined) {
    throw new Error('the grid rule declares no min-inline-size');
  }

  return value.replace(/\s+/gu, ' ').trim();
}

/** A fixed `ch` width for the evaluator: only proportions matter, so any positive width will do. */
const CH_IN_PX = 7;

/**
 * The inline width of the row's inline-start edge, `--dg-border-width-marker` (`medium`, which a
 * browser draws three pixels wide). The stylesheet covers it with `--dg-space-1`, so the row's
 * content box is the grid's width less this.
 */
const ROW_EDGE_PX = 3;

/** What one evaluation substitutes: the theme's tokens, the grid's properties and `100%`. */
interface EvaluationScope {
  readonly tokens: Readonly<Record<string, string>>;
  readonly properties: Readonly<Record<string, string>>;
  readonly percentBase: number;
}

/**
 * The index of the parenthesis that closes the one opened at `open`.
 *
 * @param text The expression.
 * @param open The index of an opening parenthesis.
 * @returns The index of its match.
 */
function closingParenthesisOf(text: string, open: number): number {
  let depth = 0;

  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error(`unbalanced parentheses in ${text}`);
}

/**
 * The index of the first comma at the top level of a function's argument list.
 *
 * @param text The text between a function's parentheses.
 * @returns The comma's index, or `-1` when there is none.
 */
function topLevelCommaOf(text: string): number {
  let depth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      return index;
    }
  }

  return -1;
}

/** Each theme's token values keyed by custom property name, built once per theme. */
const TOKEN_PROPERTY_VALUES = new WeakMap<object, ReadonlyMap<string, string>>();

/**
 * A theme's token values keyed by the custom property each is published as.
 *
 * @param tokens The theme's token values.
 * @returns The values by `--dg-*` property name.
 */
function tokenPropertiesOf(tokens: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  let byProperty = TOKEN_PROPERTY_VALUES.get(tokens);

  if (byProperty === undefined) {
    byProperty = new Map(
      Object.entries(tokens).map(([key, value]) => [`--dg-${kebabOf(key)}`, value]),
    );
    TOKEN_PROPERTY_VALUES.set(tokens, byProperty);
  }

  return byProperty;
}

/**
 * Every `var()` reference replaced, innermost values first, by what it resolves to: a grid
 * property's published value, a token's theme value, or the reference's own fallback.
 *
 * @param text An expression that may contain `var()` references.
 * @param scope The values to substitute.
 * @returns The expression with no `var()` left, each substitution parenthesized.
 */
function resolveReferences(text: string, scope: EvaluationScope): string {
  let resolved = '';
  let cursor = 0;

  for (;;) {
    const at = text.indexOf('var(', cursor);
    if (at === -1) {
      return resolved + text.slice(cursor);
    }

    const close = closingParenthesisOf(text, at + 'var'.length);
    const inner = text.slice(at + 'var('.length, close);
    const comma = topLevelCommaOf(inner);
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const value =
      scope.properties[name] ??
      tokenPropertiesOf(scope.tokens).get(name) ??
      (comma === -1 ? undefined : inner.slice(comma + 1));

    if (value === undefined) {
      throw new Error(`${name} resolves to nothing and has no fallback`);
    }

    resolved += `${text.slice(cursor, at)}(${resolveReferences(value, scope)})`;
    cursor = close + 1;
  }
}

/**
 * The CSS math expression evaluated to CSS pixels: `calc()`, `min()`, `max()` and `clamp()` over
 * `+`, `-`, `*` and `/`, with `ch`, `px` and `%` lengths and unitless numbers.
 *
 * @param expression A length expression, `var()` references included.
 * @param scope The values its references and its percentages resolve against.
 * @returns The length in CSS pixels.
 */
function evaluateLength(expression: string, scope: EvaluationScope): number {
  const source = resolveReferences(expression, scope);
  const tokens = [...source.matchAll(/(\d+(?:\.\d+)?|\.\d+)(ch|px|%)?|[a-z]+(?=\()|[-+*/(),]/gu)];
  let position = 0;

  // Nothing may be skipped: a keyword or a unit the evaluator does not know would otherwise drop
  // out of the expression silently and still yield a number.
  if (tokens.map((token) => token[0]).join('') !== source.replace(/\s+/gu, '')) {
    throw new Error(`${source} holds input this evaluator does not understand`);
  }

  const peek = (): string | undefined => tokens[position]?.[0];
  const take = (expected?: string): string => {
    const token = tokens[position]?.[0];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`expected ${expected ?? 'a token'} at ${String(position)} in ${source}`);
    }
    position += 1;
    return token;
  };

  function sum(): number {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      value = take() === '+' ? value + product() : value - product();
    }
    return value;
  }

  function product(): number {
    let value = operand();
    while (peek() === '*' || peek() === '/') {
      value = take() === '*' ? value * operand() : value / operand();
    }
    return value;
  }

  function operand(): number {
    const match = tokens[position];
    const token = take();

    if (token === '(') {
      const value = sum();
      take(')');
      return value;
    }
    if (token === '-') {
      return -operand();
    }
    if (/^[a-z]+$/u.test(token)) {
      take('(');
      const argumentsOf: number[] = [sum()];
      while (peek() === ',') {
        take(',');
        argumentsOf.push(sum());
      }
      take(')');
      return applyMathFunction(token, argumentsOf);
    }

    const magnitude = Number(match?.[1]);
    switch (match?.[2]) {
      case 'ch':
        return magnitude * CH_IN_PX;
      case '%':
        return (magnitude * scope.percentBase) / 100;
      default:
        return magnitude;
    }
  }

  const value = sum();
  if (position !== tokens.length) {
    throw new Error(`unparsed input after ${String(position)} in ${source}`);
  }
  return value;
}

/**
 * One CSS math function applied to its evaluated arguments.
 *
 * @param name `calc`, `min`, `max` or `clamp`.
 * @param values Its arguments, in pixels.
 * @returns The function's result.
 */
function applyMathFunction(name: string, values: readonly number[]): number {
  const [first = Number.NaN, second = Number.NaN, third = Number.NaN] = values;

  switch (name) {
    case 'calc':
      return first;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'clamp':
      return Math.max(first, Math.min(second, third));
    default:
      throw new Error(`${name}() is not a math function this evaluator knows`);
  }
}

/**
 * A track's minimum sizing function: the first argument of its `minmax()`, or the whole track for
 * a fixed one.
 *
 * @param track A grid track.
 * @returns Its minimum.
 */
function trackMinimumOf(track: string): string {
  if (!track.startsWith('minmax(')) {
    return track;
  }

  const inner = track.slice('minmax('.length, closingParenthesisOf(track, 'minmax'.length));
  return inner.slice(0, topLevelCommaOf(inner)).trim();
}

/**
 * The magnitude of a `ch` length token value.
 *
 * @param value A resolved token value such as `24ch`.
 * @returns Its number of `ch`.
 */
function chOf(value: string): number {
  const magnitude = /^(\d+(?:\.\d+)?)ch$/u.exec(value)?.[1];

  if (magnitude === undefined) {
    throw new Error(`${value} is not a ch length`);
  }

  return Number(magnitude);
}

/**
 * The yield token's factor in one theme: a unitless number, because it scales a `ch` floor inside
 * a `calc()` and a length times a length is no valid CSS.
 *
 * @param values The theme's token values.
 * @returns The factor.
 */
function yieldFactorOf(values: Readonly<Record<string, string>>): number {
  const value = tokenValueOf(YIELD_REFERENCE, values);

  if (!/^\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error(`the column yield ${value} is not a unitless factor`);
  }

  return Number(value);
}

/**
 * A track minimum resolved against one theme, in `ch`: the floor token's magnitude, scaled by the
 * yield factor when the minimum is a yielded floor.
 *
 * @param minimum A `DataTableColumnTrack` minimum: a floor reference or a yielded floor.
 * @param values The theme's token values.
 * @returns The minimum's width in `ch`.
 */
function resolvedMinimumCh(minimum: string, values: Readonly<Record<string, string>>): number {
  const yieldedFloor =
    /^calc\((var\(--dg-column-min-[a-z]+\)) \* var\(--dg-column-yield\)\)$/u.exec(minimum)?.[1];

  return yieldedFloor === undefined
    ? chOf(tokenValueOf(minimum, values))
    : chOf(tokenValueOf(yieldedFloor, values)) * yieldFactorOf(values);
}

describe('DataTable column width roles and the horizontal-scroll floor', () => {
  it("publishes each role's token-built track, both sums and both counts", () => {
    const widths = ['name', 'quantity', undefined, 'ordinal', 'text', 'status'] as const;
    const { container } = render(
      <DataTable
        caption="Tracks"
        rows={makeRows(2)}
        rowKey={(row) => row.id}
        columns={columnsWithWidths(widths)}
      />,
    );
    const grid = gridOf(container);

    // Pinned literally as well as through the exported table, so the token form the rows consume is
    // asserted and not only whatever the table currently holds.
    expect(grid.style.getPropertyValue('--dgc-columns')).toBe(
      `${yieldingTrackOf('name', 'wide')} ` +
        'minmax(var(--dg-column-min-quantity), var(--dg-column-share-compact)) ' +
        'minmax(var(--dg-column-min-standard), var(--dg-column-share-default)) ' +
        'var(--dg-column-min-ordinal) ' +
        `${yieldingTrackOf('text', 'widest')} ` +
        'minmax(var(--dg-column-min-status), var(--dg-column-share-compact))',
    );
    expect(grid.style.getPropertyValue('--dgc-columns')).toBe(
      widths.map((width) => DATA_TABLE_COLUMN_TRACKS[width ?? 'standard'].track).join(' '),
    );
    // Every column contributes its guaranteed minimum - the yielded floor of the name and text
    // columns, the full floor of every other - to the width below which nothing fits ...
    expect(grid.style.getPropertyValue('--dgc-min-inline')).toBe(
      'calc(calc(var(--dg-column-min-name) * var(--dg-column-yield)) + ' +
        'var(--dg-column-min-quantity) + var(--dg-column-min-standard) + ' +
        'var(--dg-column-min-ordinal) + ' +
        'calc(var(--dg-column-min-text) * var(--dg-column-yield)) + ' +
        'var(--dg-column-min-status))',
    );
    // ... and its readable floor to the width at which every column reads in full.
    expect(grid.style.getPropertyValue('--dgc-readable-inline')).toBe(
      'calc(var(--dg-column-min-name) + var(--dg-column-min-quantity) + ' +
        'var(--dg-column-min-standard) + var(--dg-column-min-ordinal) + ' +
        'var(--dg-column-min-text) + var(--dg-column-min-status))',
    );
    expect(grid.style.getPropertyValue('--dgc-yield-count')).toBe('2');
    expect(grid.style.getPropertyValue('--dgc-column-count')).toBe(String(widths.length));
  });

  it('publishes no readable sum or truncating count when no column truncates', () => {
    const widths = ['status', 'quantity', 'label'] as const;
    const { container } = render(
      <DataTable
        caption="Compact"
        rows={makeRows(1)}
        rowKey={(row) => row.id}
        columns={columnsWithWidths(widths)}
      />,
    );
    const grid = gridOf(container);

    // Both sums would be equal, so only the one the stylesheet falls back to is written.
    expect(grid.style.getPropertyValue('--dgc-min-inline')).toBe(
      'calc(var(--dg-column-min-status) + var(--dg-column-min-quantity) + ' +
        'var(--dg-column-min-label))',
    );
    expect(grid.style.getPropertyValue('--dgc-readable-inline')).toBe('');
    expect(grid.style.getPropertyValue('--dgc-yield-count')).toBe('');
  });

  it('gives every unsized column the token-backed standard role', () => {
    const { container } = render(
      <DataTable caption="Default" rows={makeRows(1)} rowKey={(row) => row.id} columns={columns} />,
    );
    const grid = gridOf(container);

    expect(grid.style.getPropertyValue('--dgc-columns')).toBe(
      'minmax(var(--dg-column-min-standard), var(--dg-column-share-default)) ' +
        'minmax(var(--dg-column-min-standard), var(--dg-column-share-default))',
    );
    expect(grid.style.getPropertyValue('--dgc-min-inline')).toBe(
      'calc(var(--dg-column-min-standard) + var(--dg-column-min-standard))',
    );
    expect(grid.style.getPropertyValue('--dgc-column-count')).toBe('2');
  });

  it('falls back to the standard role for a role an untyped caller invents', () => {
    const [column] = columnsWithWidths(['name']);
    if (column === undefined) {
      throw new Error('the fixture built no column');
    }
    const untyped = { ...column };
    // An untyped caller's value: neither a role nor a track, and an inherited property name besides.
    Reflect.set(untyped, 'width', 'constructor');

    const { container } = render(
      <DataTable
        caption="Untyped"
        rows={makeRows(1)}
        rowKey={(row) => row.id}
        columns={[untyped]}
      />,
    );
    const grid = gridOf(container);

    expect(grid.style.getPropertyValue('--dgc-columns')).toBe(
      DATA_TABLE_COLUMN_TRACKS.standard.track,
    );
    expect(grid.style.getPropertyValue('--dgc-min-inline')).toBe(
      `calc(${DATA_TABLE_COLUMN_TRACKS.standard.minimum})`,
    );
  });

  it('publishes no floor and no tracks for a table without columns', () => {
    const { container } = render(
      <DataTable caption="Bare" rows={makeRows(1)} rowKey={(row) => row.id} columns={[]} />,
    );
    const grid = gridOf(container);

    expect(grid.style.getPropertyValue('--dgc-min-inline')).toBe('');
    expect(grid.style.getPropertyValue('--dgc-readable-inline')).toBe('');
    expect(grid.style.getPropertyValue('--dgc-column-count')).toBe('0');
  });

  for (const [role, { track, floor, minimum }] of Object.entries(DATA_TABLE_COLUMN_TRACKS)) {
    it(`builds the ${role} role from catalogued column tokens alone`, () => {
      const references = [...track.matchAll(/var\((--[a-z0-9-]+)\)/gu)].map((m) => m[1] ?? '');

      expect(references.length, `${role} reads no token at all`).toBeGreaterThan(0);
      expect(
        references.filter(
          (name) => !TOKEN_PROPERTY_NAMES.has(name) && !GRID_PROPERTY_NAMES.has(name),
        ),
      ).toEqual([]);
      // Nothing but token and grid references inside math frames: no number, no unit, no
      // keyword, and no function beyond the four the track needs.
      const residue = track.replace(/var\(--[a-z0-9-]+\)/gu, '');
      expect(residue).toMatch(/^[a-z(), +*/-]*$/u);
      expect(
        [...residue.matchAll(/[a-z]+/gu)]
          .map((m) => m[0])
          .filter((name) => !['minmax', 'clamp', 'calc', 'max'].includes(name)),
      ).toEqual([]);
      expect(floor).toBe(floorReferenceOf(role));
      expect(minimum.replace(/var\(--[a-z0-9-]+\)/gu, '')).toMatch(/^(?:|calc\( \* \))$/u);
      expect(minimum, `${role}'s minimum must open on its floor token`).toContain(
        floorReferenceOf(role),
      );
      expect(track === floor || track.startsWith('minmax(')).toBe(true);
    });

    it(`keeps the ${role} role readable: a non-zero ch floor and minimum in every theme`, () => {
      for (const [theme, values] of THEME_VALUES) {
        expect(
          chOf(tokenValueOf(floorReferenceOf(role), values)),
          `${role}'s ${theme} floor`,
        ).toBeGreaterThan(0);
        expect(resolvedMinimumCh(minimum, values), `${role}'s ${theme} minimum`).toBeGreaterThan(0);
      }
    });
  }

  for (const [role, share] of [
    ['name', 'wide'],
    ['text', 'widest'],
  ] as const) {
    it(`fits the truncating ${role} role to its panel, between its yielded minimum and its floor`, () => {
      const { track, floor, minimum, yields } = DATA_TABLE_COLUMN_TRACKS[role];

      expect(yields).toBe(true);
      expect(floor).toBe(floorReferenceOf(role));
      expect(minimum).toBe(yieldedFloorOf(role));
      expect(track).toBe(yieldingTrackOf(role, share));

      // Resolved, the minimum is a real yield: narrower than the readable floor, never nothing.
      for (const [theme, values] of THEME_VALUES) {
        const floorCh = chOf(tokenValueOf(floorReferenceOf(role), values));

        expect(resolvedMinimumCh(minimum, values), `${role}'s ${theme} minimum`).toBeLessThan(
          floorCh,
        );
        expect(resolvedMinimumCh(minimum, values)).toBeCloseTo(floorCh * yieldFactorOf(values));
      }
    });
  }

  it('lists exactly the truncating roles as the ones that yield', () => {
    expect(
      Object.entries(DATA_TABLE_COLUMN_TRACKS)
        .filter(([, entry]) => entry.yields)
        .map(([role]) => role)
        .sort(),
    ).toEqual([...TRUNCATING_ROLES].sort());
  });

  for (const role of COMPACT_ROLES) {
    it(`keeps the compact ${role} role at its bare floor, in its track and its minimum`, () => {
      const { track, floor, minimum, yields } = DATA_TABLE_COLUMN_TRACKS[role];

      expect(yields).toBe(false);
      expect(minimum).toBe(floorReferenceOf(role));
      expect(floor).toBe(minimum);
      expect(track === minimum || track.startsWith(`minmax(${minimum}, `)).toBe(true);
      expect(track).not.toContain(YIELD_REFERENCE);
      expect(track).not.toContain('--dgc-');
    });
  }

  it('sums the yielded floors of name and text columns and the bare floors of the rest', () => {
    // The shape of the editor's modifications list (a file name and two status columns), with a
    // free-text and a count column besides.
    const widths = ['name', 'status', 'status', 'text', 'count'] as const;
    const { container } = render(
      <DataTable
        caption="Yield"
        rows={makeRows(2)}
        rowKey={(row) => row.id}
        columns={columnsWithWidths(widths)}
      />,
    );
    const grid = gridOf(container);
    const minimumInline = grid.style.getPropertyValue('--dgc-min-inline');

    expect(minimumInline).toBe(
      `calc(${yieldedFloorOf('name')} + ${floorReferenceOf('status')} + ` +
        `${floorReferenceOf('status')} + ${yieldedFloorOf('text')} + ${floorReferenceOf('count')})`,
    );
    expect(grid.style.getPropertyValue('--dgc-readable-inline')).toBe(
      `calc(${widths.map((role) => floorReferenceOf(role)).join(' + ')})`,
    );
    expect(grid.style.getPropertyValue('--dgc-yield-count')).toBe('2');

    // Resolved in every theme, the table's minimum is every compact floor whole plus the yield of
    // every truncating floor - strictly less than the sum of the readable floors, so a panel
    // between the two narrows its names and free text instead of scrolling its status columns
    // away.
    for (const [theme, values] of THEME_VALUES) {
      const floorOf = (role: DataTableColumnWidth): number =>
        chOf(tokenValueOf(floorReferenceOf(role), values));
      const readableFloors = widths.reduce((sum, role) => sum + floorOf(role), 0);
      const expected =
        floorOf('status') * 2 +
        floorOf('count') +
        (floorOf('name') + floorOf('text')) * yieldFactorOf(values);
      const resolved = widths.reduce(
        (sum, role) => sum + resolvedMinimumCh(DATA_TABLE_COLUMN_TRACKS[role].minimum, values),
        0,
      );

      expect(resolved, `${theme} table minimum`).toBeCloseTo(expected);
      expect(resolved, `${theme} table minimum`).toBeLessThan(readableFloors);
    }
  });

  it('publishes a template and a floor with no digit outside a token reference', () => {
    const widths = [...TRUNCATING_ROLES, ...COMPACT_ROLES];
    const { container } = render(
      <DataTable
        caption="Every role"
        rows={makeRows(1)}
        rowKey={(row) => row.id}
        columns={columnsWithWidths(widths)}
      />,
    );
    const grid = gridOf(container);

    for (const property of ['--dgc-columns', '--dgc-min-inline', '--dgc-readable-inline']) {
      const value = grid.style.getPropertyValue(property);
      const references = [...value.matchAll(/var\((--[a-z0-9-]+)\)/gu)].map((m) => m[1] ?? '');
      // Only the template may read the grid's own sums; the sums themselves are tokens alone.
      const allowed = (name: string): boolean =>
        TOKEN_PROPERTY_NAMES.has(name) ||
        (property === '--dgc-columns' && GRID_PROPERTY_NAMES.has(name));

      expect(references.length, `${property} reads no token at all`).toBeGreaterThan(0);
      expect(references.filter((name) => !allowed(name))).toEqual([]);
      expect(value.replace(/var\(--[a-z0-9-]+\)/gu, ''), property).not.toMatch(/\d/u);
    }
  });

  it('offers exactly the documented roles, each either truncating or compact', () => {
    expect(Object.keys(DATA_TABLE_COLUMN_TRACKS).sort()).toEqual(
      ['count', 'label', 'name', 'ordinal', 'quantity', 'standard', 'status', 'text'].sort(),
    );
    expect([...TRUNCATING_ROLES, ...COMPACT_ROLES].sort()).toEqual(
      Object.keys(DATA_TABLE_COLUMN_TRACKS).sort(),
    );
  });
});

/** One panel width's resolved geometry: the grid, the row box and every track's minimum. */
interface ResolvedGeometry {
  readonly grid: number;
  readonly row: number;
  readonly minimums: readonly number[];
}

/**
 * The geometry a table of the given column roles resolves to in a viewport of the given width, from
 * the properties the rendered grid publishes, the stylesheet's grid floor and the role tracks.
 *
 * @param properties The grid's published `--dgc-*` properties.
 * @param widths The columns' roles, in order.
 * @param viewport The viewport's content width, in CSS pixels.
 * @param tokens The theme's token values.
 * @returns The grid's width, its rows' content width and each track's resolved minimum.
 */
function resolveGeometry(
  properties: Readonly<Record<string, string>>,
  widths: readonly DataTableColumnWidth[],
  viewport: number,
  tokens: Readonly<Record<string, string>>,
): ResolvedGeometry {
  const grid = evaluateLength(gridFloorDeclaration(), {
    tokens,
    properties,
    percentBase: viewport,
  });
  const row = grid - ROW_EDGE_PX;
  const minimums = widths.map((role) =>
    evaluateLength(trackMinimumOf(DATA_TABLE_COLUMN_TRACKS[role].track), {
      tokens,
      properties,
      percentBase: row,
    }),
  );

  return { grid, row, minimums };
}

describe('DataTable fit-to-panel geometry, resolved', () => {
  // Four shapes: the editor's modifications list (one truncating column), two truncating columns of
  // unequal floors, three of equal floors, and a table with none.
  const CASES: readonly (readonly DataTableColumnWidth[])[] = [
    ['name', 'status', 'status'],
    ['name', 'quantity', 'text', 'status', 'count'],
    ['text', 'text', 'text', 'count'],
    ['status', 'quantity', 'label'],
  ];

  for (const widths of CASES) {
    it(`keeps, fits or hands back the floors of [${widths.join(', ')}] at every panel width`, () => {
      const { container } = render(
        <DataTable
          caption="Geometry"
          rows={makeRows(1)}
          rowKey={(row) => row.id}
          columns={columnsWithWidths(widths)}
        />,
      );
      const style = gridOf(container).style;
      const properties: Record<string, string> = {};
      for (const name of GRID_PROPERTY_NAMES) {
        const value = style.getPropertyValue(name);
        if (value !== '') {
          properties[name] = value;
        }
      }

      for (const [theme, tokens] of THEME_VALUES) {
        const px = (expression: string): number =>
          evaluateLength(expression, { tokens, properties, percentBase: 0 });
        const floors = widths.map((role) => px(DATA_TABLE_COLUMN_TRACKS[role].floor));
        const minimums = widths.map((role) => px(DATA_TABLE_COLUMN_TRACKS[role].minimum));
        const gaps = (widths.length - 1) * px('var(--dg-space-2)');
        const edge = px('var(--dg-space-1)');
        const readableRow = floors.reduce((sum, value) => sum + value, 0) + gaps;
        const minimumRow = minimums.reduce((sum, value) => sum + value, 0) + gaps;
        const capacity = readableRow - minimumRow;
        const knee = minimumRow + edge;
        // Below the knee the grid grows by the return scale per pixel of shortfall, so the table is
        // back at its readable floors this far below it.
        const cliff = knee - capacity / px('var(--dg-column-yield-return-scale)');
        const at = (viewport: number): ResolvedGeometry =>
          resolveGeometry(properties, widths, viewport, tokens);

        expect(edge, 'the edge allowance covers the row edge').toBeGreaterThanOrEqual(ROW_EDGE_PX);
        expect(knee - cliff, 'the change of regime spans less than a pixel').toBeLessThan(1);

        const sweep = new Set<number>([
          knee,
          (knee + cliff) / 2,
          cliff,
          knee - capacity,
          readableRow + edge,
          readableRow,
        ]);
        for (
          let viewport = Math.floor(knee - capacity - 40);
          viewport <= readableRow + 80;
          viewport += 1
        ) {
          sweep.add(viewport);
        }

        let previous: ResolvedGeometry | undefined;
        for (const viewport of [...sweep].sort((a, b) => a - b)) {
          const geometry = at(viewport);
          const label = `${theme} [${widths.join(', ')}] at ${String(viewport)}px`;
          const used = geometry.minimums.reduce((sum, value) => sum + value, 0) + gaps;

          // Every track stays between its minimum and its floor, and a compact one at its floor.
          geometry.minimums.forEach((value, index) => {
            expect(value, label).toBeGreaterThanOrEqual((minimums[index] ?? 0) - 1e-6);
            expect(value, label).toBeLessThanOrEqual((floors[index] ?? 0) + 1e-6);
            if (!DATA_TABLE_COLUMN_TRACKS[widths[index] ?? 'standard'].yields) {
              expect(value, label).toBeCloseTo(floors[index] ?? 0, 6);
            }
          });
          // The row always holds every column: no track is pushed past the grid's edge.
          expect(used, label).toBeLessThanOrEqual(geometry.row + 1e-6);
          // The grid is never narrower than its viewport.
          expect(geometry.grid, label).toBeGreaterThanOrEqual(viewport - 1e-6);

          if (viewport >= readableRow + edge) {
            // Room for every readable floor: the table lays out at its floors, unscrolled.
            expect(geometry.grid, label).toBeCloseTo(viewport, 6);
            geometry.minimums.forEach((value, index) => {
              expect(value, label).toBeCloseTo(floors[index] ?? 0, 6);
            });
          } else if (viewport >= knee) {
            // Just too narrow: the table does not scroll, and its truncating columns narrow
            // exactly as far as the row needs - it is filled to the pixel.
            expect(geometry.grid, label).toBeCloseTo(viewport, 6);
            expect(used, label).toBeCloseTo(Math.min(geometry.row, readableRow), 6);
          } else if (viewport <= cliff) {
            // Too narrow even for the minimums: truncating no longer buys a fit, so every column is
            // back at its readable floor and the table scrolls, exactly as with no truncating
            // column at all.
            expect(geometry.grid, label).toBeCloseTo(readableRow + edge, 6);
            geometry.minimums.forEach((value, index) => {
              expect(value, label).toBeCloseTo(floors[index] ?? 0, 6);
            });
          } else {
            // Within the sub-pixel change of regime the grid grows by the return scale per pixel
            // of shortfall, and the tracks take back exactly what it grows by.
            expect(geometry.grid, label).toBeCloseTo(
              knee + (knee - viewport) * px('var(--dg-column-yield-return-scale)'),
              6,
            );
            expect(used, label).toBeCloseTo(Math.min(geometry.row, readableRow), 6);
          }

          // Narrowing the viewport never widens a column while the table still fits, and below the
          // knee never narrows one: the yield is spent on fitting and nothing else.
          if (previous !== undefined) {
            const widening = viewport <= knee;
            geometry.minimums.forEach((value, index) => {
              const before = previous?.minimums[index] ?? 0;
              if (widening) {
                expect(value, label).toBeLessThanOrEqual(before + 1e-6);
              } else {
                expect(value, label).toBeGreaterThanOrEqual(before - 1e-6);
              }
            });
          }
          previous = geometry;
        }
      }
    });
  }

  it('fits three or more truncating columns of unequal floors to within one column yield', () => {
    // The shape of the state-transition table: names and free text alternating.
    const widths = ['name', 'text', 'name', 'text', 'label'] as const;
    const { container } = render(
      <DataTable
        caption="Unequal"
        rows={makeRows(1)}
        rowKey={(row) => row.id}
        columns={columnsWithWidths(widths)}
      />,
    );
    const style = gridOf(container).style;
    const properties: Record<string, string> = {};
    for (const name of GRID_PROPERTY_NAMES) {
      properties[name] = style.getPropertyValue(name);
    }
    const tokens = DESIGN_TOKENS.dark;
    const px = (expression: string): number =>
      evaluateLength(expression, { tokens, properties, percentBase: 0 });
    const gaps = (widths.length - 1) * px('var(--dg-space-2)');
    const edge = px('var(--dg-space-1)');
    const minimumRow =
      widths.reduce((sum, role) => sum + px(DATA_TABLE_COLUMN_TRACKS[role].minimum), 0) + gaps;
    const readableRow =
      widths.reduce((sum, role) => sum + px(DATA_TABLE_COLUMN_TRACKS[role].floor), 0) + gaps;
    const smallestYield = px('var(--dg-column-min-name)') - px(yieldedFloorOf('name'));

    for (
      let viewport = Math.ceil(minimumRow + edge);
      viewport <= readableRow + edge;
      viewport += 1
    ) {
      const geometry = resolveGeometry(properties, widths, viewport, tokens);
      const used = geometry.minimums.reduce((sum, value) => sum + value, 0) + gaps;

      // Equal shares with the remainder left to the others are exact for one or two truncating
      // columns and for equal floors; with more of unequal floors a column that reaches its
      // minimum early can leave a remainder no other absorbs, which the table then scrolls by.
      expect(geometry.grid).toBeCloseTo(viewport, 6);
      expect(used - geometry.row, `at ${String(viewport)}px`).toBeLessThan(smallestYield);
    }
  });
});

/** A viewport-coordinate rect for the reveal stubs. */
function rectAt(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    left: 0,
    top,
    width: STUBBED_INLINE_SIZE,
    height,
    right: STUBBED_INLINE_SIZE,
    bottom: top + height,
    toJSON: () => ({ top, height }),
  };
}

/** The viewport, header and row geometry the reveal tests lay out, in CSS pixels. */
const REVEAL_GEOMETRY = {
  viewportTop: 100,
  viewportClientHeight: 300,
  headerHeight: 30,
  rowHeight: 32,
} as const;

describe('DataTable reveals a newly expanded row', () => {
  /**
   * Lays out the viewport at {@link REVEAL_GEOMETRY} and the toggled row and its detail wherever
   * the test says, in viewport coordinates.
   */
  function stubRevealLayout(rowTop: number, detailHeight: number): void {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains(VIEWPORT_CLASS) ? REVEAL_GEOMETRY.viewportClientHeight : 0;
      },
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains(VIEWPORT_CLASS)) {
        return rectAt(REVEAL_GEOMETRY.viewportTop, REVEAL_GEOMETRY.viewportClientHeight);
      }
      if (this.classList.contains('dg-data-table__head')) {
        return rectAt(REVEAL_GEOMETRY.viewportTop, REVEAL_GEOMETRY.headerHeight);
      }
      if (this.classList.contains('dg-data-table__row')) {
        return rectAt(rowTop, REVEAL_GEOMETRY.rowHeight);
      }
      if (this.classList.contains('dg-data-table__expanded')) {
        return rectAt(rowTop + REVEAL_GEOMETRY.rowHeight, detailHeight);
      }
      return rectAt(0, 0);
    });

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);

      return 1;
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  });

  /** An expandable table with the given rows expanded. */
  function renderExpandable(expandedRowKeys: readonly string[]) {
    return (
      <DataTable
        caption="Expandable"
        rows={makeRows(8)}
        rowKey={(row) => row.id}
        columns={columns}
        expandedRowKeys={expandedRowKeys}
        onRowToggle={() => undefined}
        renderExpandedRow={(row) => `Detail of ${row.label}`}
      />
    );
  }

  it('scrolls a detail that opens below the viewport into view and the table into the page', () => {
    // Row at 360..392, detail 392..492; the visible band is 130 (under the header) to 400.
    stubRevealLayout(360, 100);
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { container, rerender } = render(renderExpandable([]));
    const viewport = container.querySelector(`.${VIEWPORT_CLASS}`);

    if (!(viewport instanceof HTMLElement)) {
      throw new Error('the table rendered no viewport');
    }
    viewport.scrollTop = 0;
    rerender(renderExpandable(['row-5']));

    // min(492 - 400, 360 - 130) = 92: the whole detail comes into view.
    expect(viewport.scrollTop).toBe(92);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });

    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  it('never scrolls the toggled row itself under the sticky header', () => {
    // A detail taller than the viewport: row at 300, detail 332..832.
    stubRevealLayout(300, 500);

    const { container, rerender } = render(renderExpandable([]));
    const viewport = container.querySelector(`.${VIEWPORT_CLASS}`);

    if (!(viewport instanceof HTMLElement)) {
      throw new Error('the table rendered no viewport');
    }
    viewport.scrollTop = 0;
    rerender(renderExpandable(['row-2']));

    // min(832 - 400, 300 - 130) = 170: the row stops just under the header.
    expect(viewport.scrollTop).toBe(170);
  });

  it('does not scroll a table that mounts with rows already expanded, nor on a collapse', () => {
    stubRevealLayout(360, 100);

    const { container, rerender } = render(renderExpandable(['row-5']));
    const viewport = container.querySelector(`.${VIEWPORT_CLASS}`);

    if (!(viewport instanceof HTMLElement)) {
      throw new Error('the table rendered no viewport');
    }
    viewport.scrollTop = 0;
    rerender(renderExpandable(['row-5']));
    rerender(renderExpandable([]));

    expect(viewport.scrollTop).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The host-driven selection reveal
 *
 * When `selectedRowKey` moves to a row because of something outside this table - a selection
 * made in another view, an evidence chip, a host surface driving it - the row is brought into
 * this table's own viewport. These cases give happy-dom a geometry to reveal against: a viewport
 * {@link REVEAL_VIEWPORT_BLOCK_SIZE} tall whose sticky header is one row tall, and rows of
 * {@link STUBBED_ROW_BLOCK_SIZE} laid out in order under it, each placed by the viewport's live
 * `scrollTop` so a scroll moves them exactly as a browser would.
 * ---------------------------------------------------------------------------
 */

/** The visible block size of the stubbed viewport in the reveal cases, in CSS pixels. */
const REVEAL_VIEWPORT_BLOCK_SIZE = 200;

/** The sticky header's block size in the reveal cases: one row. */
const REVEAL_HEADER_BLOCK_SIZE = STUBBED_ROW_BLOCK_SIZE;

/** How many rows the flow-path reveal cases render: several viewports' worth. */
const REVEAL_RESULT_ROWS = 30;

/** The class of the header rowgroup, which the geometry stub keys off. */
const HEAD_CLASS = 'dg-data-table__head';

/** The class of the body rowgroup the virtualizer positions rows in. */
const CANVAS_CLASS = 'dg-virtual-canvas';

/** The descriptors the reveal geometry stub replaced, restored by {@link removeRevealGeometry}. */
let replacedRevealDescriptors: {
  readonly clientHeight: PropertyDescriptor | undefined;
  readonly scrollHeight: PropertyDescriptor | undefined;
} | null = null;

/**
 * A `DOMRect` for one block-axis span, the only axis the reveal reads.
 *
 * @param top The leading edge, in viewport coordinates.
 * @param height The block size.
 * @returns The rectangle.
 */
function blockRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: STUBBED_INLINE_SIZE,
    width: STUBBED_INLINE_SIZE,
    height,
    toJSON: () => ({}),
  };
}

/**
 * Give happy-dom the geometry the reveal reads: the viewport's visible and scrollable block sizes,
 * and the on-screen boxes of the viewport, its sticky header, its body rowgroup and each data row.
 *
 * @param rowCount How many rows the table under test holds, for the scrollable size.
 */
function installRevealGeometry(rowCount: number): void {
  const prototype = HTMLElement.prototype;

  replacedRevealDescriptors = {
    clientHeight: Object.getOwnPropertyDescriptor(prototype, 'clientHeight'),
    scrollHeight: Object.getOwnPropertyDescriptor(prototype, 'scrollHeight'),
  };

  Object.defineProperty(prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains(VIEWPORT_CLASS) ? REVEAL_VIEWPORT_BLOCK_SIZE : 0;
    },
  });

  Object.defineProperty(prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains(VIEWPORT_CLASS)
        ? REVEAL_HEADER_BLOCK_SIZE + rowCount * STUBBED_ROW_BLOCK_SIZE
        : 0;
    },
  });

  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const viewport = this.closest(`.${VIEWPORT_CLASS}`);
    const scrolled = viewport instanceof HTMLElement ? viewport.scrollTop : 0;

    if (this === viewport) {
      return blockRect(0, REVEAL_VIEWPORT_BLOCK_SIZE);
    }

    if (this.classList.contains(HEAD_CLASS)) {
      // Sticky: pinned to the viewport's leading edge whatever the scroll.
      return blockRect(0, REVEAL_HEADER_BLOCK_SIZE);
    }

    if (this.classList.contains(CANVAS_CLASS)) {
      return blockRect(REVEAL_HEADER_BLOCK_SIZE - scrolled, rowCount * STUBBED_ROW_BLOCK_SIZE);
    }

    const index = this.getAttribute('data-row-index');

    if (index !== null) {
      return blockRect(
        REVEAL_HEADER_BLOCK_SIZE + Number(index) * STUBBED_ROW_BLOCK_SIZE - scrolled,
        STUBBED_ROW_BLOCK_SIZE,
      );
    }

    return blockRect(0, 0);
  });
}

/** Put happy-dom's own (zero) block sizes back; the rect spy is restored by `afterEach`. */
function removeRevealGeometry(): void {
  if (replacedRevealDescriptors === null) {
    return;
  }

  const prototype = HTMLElement.prototype;

  for (const name of ['clientHeight', 'scrollHeight'] as const) {
    const descriptor = replacedRevealDescriptors[name];

    if (descriptor === undefined) {
      Reflect.deleteProperty(prototype, name);
    } else {
      Object.defineProperty(prototype, name, descriptor);
    }
  }

  replacedRevealDescriptors = null;
}

/**
 * The table's scroll container.
 *
 * @param container The render container.
 * @returns The viewport element.
 */
function viewportOf(container: HTMLElement): HTMLElement {
  const viewport = container.querySelector(`.${VIEWPORT_CLASS}`);

  if (!(viewport instanceof HTMLElement)) {
    throw new Error('the table rendered no scroll container');
  }

  return viewport;
}

/** What {@link FlowTable} is handed by a case. */
interface FlowTableProps {
  /** The rows to draw. */
  readonly rows: readonly SampleRow[];

  /** The key a host drives, or `null` for none. */
  readonly selectedRowKey: string | null;

  /** The caption, which a case may change to cause an unrelated re-render. */
  readonly caption?: string | undefined;
}

/**
 * A table whose selection is driven from outside, in normal flow (every row in the DOM).
 *
 * @param props See {@link FlowTableProps}.
 * @returns The table.
 */
function FlowTable(props: FlowTableProps): ReactElement {
  return (
    <DataTable
      caption={props.caption ?? 'Driven selection'}
      rows={props.rows}
      rowKey={(row) => row.id}
      columns={columns}
      virtualize={false}
      selectedRowKey={props.selectedRowKey}
    />
  );
}

/**
 * A table that keeps its own selection, set from its own row activation - what a view does when
 * the reader clicks one of its rows.
 *
 * @param props The rows to draw.
 * @returns The table.
 */
function SelfSelectingTable(props: { readonly rows: readonly SampleRow[] }): ReactElement {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <DataTable
      caption="Self-selecting"
      rows={props.rows}
      rowKey={(row) => row.id}
      columns={columns}
      virtualize={false}
      selectedRowKey={selected}
      onRowActivate={(row) => {
        setSelected(row.id);
      }}
    />
  );
}

describe('DataTable host-driven selection reveal', () => {
  afterEach(() => {
    removeRevealGeometry();
  });

  it('scrolls a selected row below the fold into its own viewport, and never moves focus', () => {
    installRevealGeometry(REVEAL_RESULT_ROWS);
    const rows = makeRows(REVEAL_RESULT_ROWS);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    const view = render(<FlowTable rows={rows} selectedRowKey={null} />);
    const viewport = viewportOf(view.container);

    expect(viewport.scrollTop).toBe(0);

    view.rerender(<FlowTable rows={rows} selectedRowKey="row-20" />);

    // Just far enough that the row's trailing edge meets the viewport's: row 20 ends at
    // header + 21 rows, and the viewport shows REVEAL_VIEWPORT_BLOCK_SIZE of the content.
    const rowEnd = REVEAL_HEADER_BLOCK_SIZE + 21 * STUBBED_ROW_BLOCK_SIZE;
    expect(viewport.scrollTop).toBe(rowEnd - REVEAL_VIEWPORT_BLOCK_SIZE);
    expect(rowAt(view.container, 20).getAttribute('aria-selected')).toBe('true');

    // The reader's focus is where they left it, and the page was not the thing scrolled.
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('brings a row above the visible band to just under the sticky header', () => {
    installRevealGeometry(REVEAL_RESULT_ROWS);
    const rows = makeRows(REVEAL_RESULT_ROWS);

    const view = render(<FlowTable rows={rows} selectedRowKey={null} />);
    const viewport = viewportOf(view.container);
    viewport.scrollTop = 20 * STUBBED_ROW_BLOCK_SIZE;

    view.rerender(<FlowTable rows={rows} selectedRowKey="row-3" />);

    // Row 3 starts at header + 3 rows; placed under the header, the scroll offset is 3 rows.
    expect(viewport.scrollTop).toBe(3 * STUBBED_ROW_BLOCK_SIZE);
  });

  it('leaves a row that is already fully visible where it is', () => {
    installRevealGeometry(REVEAL_RESULT_ROWS);
    const rows = makeRows(REVEAL_RESULT_ROWS);

    const view = render(<FlowTable rows={rows} selectedRowKey={null} />);
    view.rerender(<FlowTable rows={rows} selectedRowKey="row-2" />);

    expect(viewportOf(view.container).scrollTop).toBe(0);
  });

  it('reveals a selection once, and never again on an unrelated re-render', () => {
    installRevealGeometry(REVEAL_RESULT_ROWS);
    const rows = makeRows(REVEAL_RESULT_ROWS);

    const view = render(<FlowTable rows={rows} selectedRowKey={null} />);
    const viewport = viewportOf(view.container);

    view.rerender(<FlowTable rows={rows} selectedRowKey="row-20" />);
    expect(viewport.scrollTop).toBeGreaterThan(0);

    // The reader scrolls back up; re-renders that do not change the selection - new row objects
    // with the same content, a new caption, a re-ordered result that moves the selected row to
    // another off-screen position - must not pull them back down.
    viewport.scrollTop = 0;
    view.rerender(<FlowTable rows={makeRows(REVEAL_RESULT_ROWS)} selectedRowKey="row-20" />);
    view.rerender(
      <FlowTable rows={rows} selectedRowKey="row-20" caption="Driven selection, retitled" />,
    );
    view.rerender(<FlowTable rows={[...rows].reverse()} selectedRowKey="row-20" />);

    expect(rowAt(view.container, 9).getAttribute('aria-selected')).toBe('true');
    expect(viewport.scrollTop).toBe(0);
  });

  it('reveals a table that mounts with a selection, and waits for a row it has not loaded', () => {
    installRevealGeometry(REVEAL_RESULT_ROWS);

    const mounted = render(
      <FlowTable rows={makeRows(REVEAL_RESULT_ROWS)} selectedRowKey="row-25" />,
    );
    expect(viewportOf(mounted.container).scrollTop).toBeGreaterThan(0);
    mounted.unmount();

    // A key no loaded row carries stays armed until a page that holds it arrives.
    const view = render(<FlowTable rows={makeRows(5)} selectedRowKey="row-24" />);
    const viewport = viewportOf(view.container);

    expect(viewport.scrollTop).toBe(0);

    view.rerender(<FlowTable rows={makeRows(REVEAL_RESULT_ROWS)} selectedRowKey="row-24" />);

    const rowEnd = REVEAL_HEADER_BLOCK_SIZE + 25 * STUBBED_ROW_BLOCK_SIZE;
    expect(viewport.scrollTop).toBe(rowEnd - REVEAL_VIEWPORT_BLOCK_SIZE);
  });

  it("does not scroll the table under the reader's own click on a visible row", () => {
    installRevealGeometry(REVEAL_RESULT_ROWS);

    const view = render(<SelfSelectingTable rows={makeRows(REVEAL_RESULT_ROWS)} />);
    const viewport = viewportOf(view.container);

    // Row 5 straddles the viewport's trailing edge: a host-driven selection of it would scroll it
    // fully into view, but the reader is pointing at it already.
    fireEvent.click(rowAt(view.container, 5));

    expect(rowAt(view.container, 5).getAttribute('aria-selected')).toBe('true');
    expect(viewport.scrollTop).toBe(0);
  });

  it('does nothing in an environment that measures nothing', () => {
    const rows = makeRows(REVEAL_RESULT_ROWS);

    const view = render(<FlowTable rows={rows} selectedRowKey={null} />);
    view.rerender(<FlowTable rows={rows} selectedRowKey="row-20" />);

    expect(viewportOf(view.container).scrollTop).toBe(0);
    expect(rowAt(view.container, 20).getAttribute('aria-selected')).toBe('true');
  });

  it('scrolls a selected row outside the virtual window into view', () => {
    installLayoutStub();
    installRevealGeometry(MODEST_RESULT_ROWS);
    const rows = makeRows(MODEST_RESULT_ROWS);
    const target = 200;
    const table = (selectedRowKey: string | null): ReactElement => (
      <DataTable
        caption="Measured, driven selection"
        rows={rows}
        rowKey={(row) => row.id}
        columns={columns}
        virtualize={{ enabled: true }}
        selectedRowKey={selectedRowKey}
      />
    );

    const view = render(table(null));
    const viewport = viewportOf(view.container);

    expect(view.container.querySelector(`[data-row-index="${String(target)}"]`)).toBeNull();

    view.rerender(table(`row-${String(target)}`));

    const rowEnd = REVEAL_HEADER_BLOCK_SIZE + (target + 1) * STUBBED_ROW_BLOCK_SIZE;
    expect(viewport.scrollTop).toBe(rowEnd - REVEAL_VIEWPORT_BLOCK_SIZE);

    // The scroll brings the window to the row, which renders selected.
    fireEvent.scroll(viewport);

    expect(rowAt(view.container, target).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(document.body);
  });
});
