/**
 * `MetricCards` — the colocated suite.
 *
 * What it pins, in the order the file below asserts it:
 *
 *  1. **Selection and order come from the node.** One tile per requested id, in
 *     the node's own order and not the response's, because AAP 0.6.5 has the
 *     same component drawing the headline numbers of materially different
 *     panels: the only thing that differs between them is the `metrics` option.
 *  2. **A requested id the capture did not compute is still a tile**, marked
 *     unavailable, rather than a silently dropped one.
 *  3. **An unobservable value is `n/a`, never `0`** (AAP 0.6.6) — asserted
 *     through the package's own `NOT_AVAILABLE_LABEL` rather than a literal, so
 *     the test cannot drift from the spelling the product uses — and it carries
 *     no severity colour.
 *  4. **A measured duration carries its unit as its own element** and a
 *     severity token reference, taken from `../utils/color` rather than
 *     restated here.
 *  5. **All three states** (AAP 0.6.2), driven through a stub `DataProvider`:
 *     a provider that never settles, one that rejects (with a retry that
 *     actually re-queries), and one that answers with nothing.
 *  6. **A node asking for another source is reported, not mis-drawn** — and the
 *     provider is never called for it.
 *
 * The provider is a stub built with the library's own `createDataProvider`, so
 * these tests exercise the same seam the DevTools panel and the editor webview
 * implement. Nothing here reaches a network, a socket or a timer.
 */

import { DebuggenError } from '@debuggen/shared';
import type { MetricCardsNode } from '@debuggen/panel-schema';
import type { MetricId, MetricValue } from '@debuggen/telemetry';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DataProviderContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResponse } from '../host/DataProvider';
import { durationColorVar } from '../utils/color';
import { NOT_AVAILABLE_LABEL } from '../utils/format';
import { MetricCards } from './MetricCards';

/** A duration metric of 640 ms — the critical severity bucket (≥ 500 ms). */
const SLOW_DURATION_MS = 640;

/** A node asking for the given ids, in that order. */
function metricNode(metrics: readonly MetricId[]): MetricCardsNode {
  return {
    type: 'metricCards',
    id: 'layout.0.metrics',
    query: { source: 'metrics' },
    metrics: [...metrics],
  };
}

/** A provider that answers every query with `values`. */
function providerOf(values: readonly MetricValue[]): DataProvider {
  return createDataProvider((query) => Promise.resolve({ source: query.source, data: values }));
}

function renderCards(provider: DataProvider, node: MetricCardsNode): HTMLElement {
  const view = render(
    <DataProviderContext.Provider value={provider}>
      <MetricCards node={node} />
    </DataProviderContext.Provider>,
  );

  return view.container;
}

function tiles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.dg-metric-card'));
}

function textOf(tile: HTMLElement, part: string): string {
  return tile.querySelector(`.dg-metric-card__${part}`)?.textContent ?? '';
}

async function renderedTiles(
  provider: DataProvider,
  node: MetricCardsNode,
  expected: number,
): Promise<HTMLElement[]> {
  const container = renderCards(provider, node);

  await waitFor(() => {
    expect(tiles(container)).toHaveLength(expected);
  });

  return tiles(container);
}

const TOTAL_DURATION: MetricValue = {
  id: 'total_duration',
  label: 'Total duration',
  unit: 'milliseconds',
  available: true,
  value: SLOW_DURATION_MS,
};

const RENDER_COUNT: MetricValue = {
  id: 'render_count',
  label: 'Renders',
  unit: 'count',
  available: true,
  value: 48,
};

const UNCHANGED_RENDER_COUNT: MetricValue = {
  id: 'unchanged_render_count',
  label: 'Renders with stable inputs',
  unit: 'count',
  available: true,
  value: 44,
};

const TRIGGER_UNKNOWN_COUNT: MetricValue = {
  id: 'render_trigger_unknown_count',
  label: 'Renders with an undetermined trigger',
  unit: 'count',
  available: true,
  value: 3,
};

const TRANSFERRED_BYTES: MetricValue = {
  id: 'transferred_bytes',
  label: 'Transferred',
  unit: 'bytes',
  available: false,
  note: 'Transfer sizes are reported for same-origin responses only.',
};

describe('MetricCards selection and order', () => {
  it('draws one tile per requested id, in the order the node asked for them', async () => {
    // The response arrives in the vocabulary's order; the node asks for the
    // reverse. The node wins: its order is the author's emphasis.
    const node = metricNode(['render_count', 'total_duration']);
    const drawn = await renderedTiles(providerOf([TOTAL_DURATION, RENDER_COUNT]), node, 2);

    expect(drawn.map((tile) => textOf(tile, 'label'))).toEqual(['Renders', 'Total duration']);
  });

  it('draws the response in its arrival order when the node names no ids', async () => {
    const drawn = await renderedTiles(
      providerOf([TOTAL_DURATION, RENDER_COUNT]),
      metricNode([]),
      2,
    );

    expect(drawn.map((tile) => textOf(tile, 'label'))).toEqual(['Total duration', 'Renders']);
  });

  it('keeps the two render-trigger metrics apart rather than merging them', async () => {
    // `unchanged_render_count` and `render_trigger_unknown_count` are separate
    // metrics with separate meanings (AAP 0.2.3): three tiles, three figures,
    // and no total of the last two anywhere.
    const node = metricNode([
      'render_count',
      'unchanged_render_count',
      'render_trigger_unknown_count',
    ]);
    const drawn = await renderedTiles(
      providerOf([RENDER_COUNT, UNCHANGED_RENDER_COUNT, TRIGGER_UNKNOWN_COUNT]),
      node,
      3,
    );

    expect(drawn.map((tile) => textOf(tile, 'value'))).toEqual(['48', '44', '3']);
  });

  it('draws a requested id the capture did not compute as an unavailable tile', async () => {
    // The response holds one of the two requested ids. The other is still a
    // tile, still in position, and says that the value is absent.
    const node = metricNode(['total_duration', 'database_duration']);
    const drawn = await renderedTiles(providerOf([TOTAL_DURATION]), node, 2);

    const missing = drawn[1];

    expect(missing).toBeDefined();
    expect(missing?.classList.contains('dg-is-unavailable')).toBe(true);
    expect(missing === undefined ? '' : textOf(missing, 'value')).toBe(NOT_AVAILABLE_LABEL);
    // The heading still names the metric a reader asked for, humanized from its id.
    expect(missing === undefined ? '' : textOf(missing, 'label')).toBe('Database duration');
  });
});

describe('MetricCards figures', () => {
  it('splits a measured duration into a figure and its own unit element, coloured by severity', async () => {
    const [tile] = await renderedTiles(
      providerOf([TOTAL_DURATION]),
      metricNode(['total_duration']),
      1,
    );

    expect(tile).toBeDefined();

    const value = tile?.querySelector<HTMLElement>('.dg-metric-card__value');
    const unit = tile?.querySelector<HTMLElement>('.dg-metric-card__unit');

    // The unit is beside the number, never inside it.
    expect(value?.textContent).toBe('640.00');
    expect(unit?.textContent).toBe('ms');

    // Severity arrives as a token reference from ../utils/color, not as a colour.
    expect(value?.getAttribute('style')).toContain('--dgc-severity-color');
    expect(value?.getAttribute('style')).toContain(durationColorVar(SLOW_DURATION_MS));
    expect(tile?.classList.contains('dg-is-unavailable')).toBe(false);
  });

  it('gives a count no unit element and no severity colour', async () => {
    const [tile] = await renderedTiles(providerOf([RENDER_COUNT]), metricNode(['render_count']), 1);

    expect(tile?.querySelector('.dg-metric-card__unit')).toBeNull();
    expect(tile?.querySelector('.dg-metric-card__value')?.getAttribute('style')).toBeNull();
    expect(tile === undefined ? '' : textOf(tile, 'value')).toBe('48');
  });

  it('renders an unobservable value as the absent label, never as a zero', async () => {
    const [tile] = await renderedTiles(
      providerOf([TRANSFERRED_BYTES]),
      metricNode(['transferred_bytes']),
      1,
    );

    expect(tile).toBeDefined();
    expect(tile?.classList.contains('dg-is-unavailable')).toBe(true);

    const value = tile?.querySelector<HTMLElement>('.dg-metric-card__value');

    expect(value?.textContent).toBe(NOT_AVAILABLE_LABEL);
    expect(value?.textContent).not.toContain('0');
    // An absence is never dressed as a measurement: no unit, no severity.
    expect(tile?.querySelector('.dg-metric-card__unit')).toBeNull();
    expect(value?.getAttribute('style')).toBeNull();
  });

  it('shows a measured byte size as one figure, since the byte scale has no parts formatter', async () => {
    const [tile] = await renderedTiles(
      providerOf([
        {
          id: 'transferred_bytes',
          label: 'Transferred',
          unit: 'bytes',
          available: true,
          value: 1_500_000,
        },
      ]),
      metricNode(['transferred_bytes']),
      1,
    );

    expect(tile?.classList.contains('dg-is-unavailable')).toBe(false);
    expect(tile === undefined ? '' : textOf(tile, 'value')).toBe('1.5 MB');
    // No separate unit element, and no severity colour: severity is a duration
    // judgement and a size has no threshold to be read against.
    expect(tile?.querySelector('.dg-metric-card__unit')).toBeNull();
    expect(tile?.querySelector('.dg-metric-card__value')?.getAttribute('style')).toBeNull();
  });

  it('treats a value that cannot be measured as unavailable even when flagged available', async () => {
    // A contradictory record - available, but with a value no formatter can
    // express - must not be styled as a measurement while showing the absent
    // label. This is the totality the two availability checks exist for.
    const [tile] = await renderedTiles(
      providerOf([
        {
          id: 'frontend_duration',
          label: 'Frontend duration',
          unit: 'milliseconds',
          available: true,
          value: Number.NaN,
        },
      ]),
      metricNode(['frontend_duration']),
      1,
    );

    expect(tile?.classList.contains('dg-is-unavailable')).toBe(true);
    expect(tile === undefined ? '' : textOf(tile, 'value')).toBe(NOT_AVAILABLE_LABEL);
    expect(tile?.querySelector('.dg-metric-card__value')?.getAttribute('style')).toBeNull();
  });

  it('falls back to the humanized id when a value arrives with a blank heading', async () => {
    const [tile] = await renderedTiles(
      providerOf([
        { id: 'blocking_time', label: '', unit: 'milliseconds', available: true, value: 120 },
      ]),
      metricNode(['blocking_time']),
      1,
    );

    expect(tile === undefined ? '' : textOf(tile, 'label')).toBe('Blocking time');
  });

  it('names every tile by pairing its heading with its figure and unit', async () => {
    const [tile] = await renderedTiles(
      providerOf([TOTAL_DURATION]),
      metricNode(['total_duration']),
      1,
    );

    expect(tile).toBeDefined();

    const label = tile === undefined ? '' : textOf(tile, 'label');
    const value = tile === undefined ? '' : textOf(tile, 'value');
    const unit = tile === undefined ? '' : textOf(tile, 'unit');

    expect(tile?.getAttribute('aria-label')).toBe(`${label}: ${value} ${unit}`);
  });

  it('exposes the group and its tiles as a list whatever the stylesheet sets display to', async () => {
    const container = renderCards(providerOf([TOTAL_DURATION]), metricNode(['total_duration']));

    await waitFor(() => {
      expect(tiles(container)).toHaveLength(1);
    });

    const group = container.querySelector('.dg-metric-cards');

    expect(group?.getAttribute('role')).toBe('list');
    expect(group?.getAttribute('aria-label')).toBe('Metrics');
    expect(tiles(container)[0]?.getAttribute('role')).toBe('listitem');
  });

  it('surfaces a coverage note as a keyboard-reachable tooltip description', async () => {
    const [tile] = await renderedTiles(
      providerOf([TRANSFERRED_BYTES]),
      metricNode(['transferred_bytes']),
      1,
    );

    const affordance = tile?.querySelector<HTMLElement>('.dg-metric-card__hint');

    expect(affordance).toBeDefined();
    // Focusable, because focus is how a keyboard reader opens a tooltip.
    expect(affordance?.getAttribute('tabindex')).toBe('0');

    // Looked up by id rather than by selector: React's generated ids are not
    // required to be valid CSS identifiers, and a selector would throw on one.
    const describedBy = affordance?.getAttribute('aria-describedby') ?? '';
    const bubble = describedBy === '' ? null : document.getElementById(describedBy);

    // The description is the note itself, reachable even while the bubble is closed.
    expect(bubble?.textContent).toBe(TRANSFERRED_BYTES.note);
  });
});

describe('MetricCards states', () => {
  it('renders the loading state while the query has not settled', () => {
    const pending = createDataProvider(() => new Promise<DataQueryResponse>(() => undefined));
    const container = renderCards(pending, metricNode(['total_duration']));

    expect(container.querySelector('.dg-metric-cards__loading')).not.toBeNull();
    expect(container.querySelector('.dg-loading-state')).not.toBeNull();
    expect(tiles(container)).toHaveLength(0);
  });

  it('renders the empty state when the capture computed nothing', async () => {
    const container = renderCards(providerOf([]), metricNode(['total_duration']));

    await waitFor(() => {
      expect(container.querySelector('.dg-empty-state')).not.toBeNull();
    });

    expect(container.querySelector('.dg-metric-cards__empty')).not.toBeNull();
    expect(tiles(container)).toHaveLength(0);
  });

  it('renders the error state with the failure code and a retry that re-queries', async () => {
    const resolve = vi.fn(() =>
      Promise.reject(new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel is closed.')),
    );
    const container = renderCards(createDataProvider(resolve), metricNode(['total_duration']));

    await waitFor(() => {
      expect(container.querySelector('.dg-error-state')).not.toBeNull();
    });

    expect(container.querySelector('.dg-metric-cards__error')).not.toBeNull();
    expect(container.textContent).toContain('TRANSPORT_DISCONNECTED');
    expect(resolve).toHaveBeenCalledTimes(1);

    const retry = container.querySelector<HTMLButtonElement>('.dg-error-state__action button');

    expect(retry).not.toBeNull();
    if (retry !== null) {
      fireEvent.click(retry);
    }

    await waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(2);
    });
  });

  it('reports a node whose query names another source instead of drawing it', async () => {
    const resolve = vi.fn(() => Promise.resolve<DataQueryResponse>({ source: 'spans', data: [] }));
    const node: MetricCardsNode = {
      type: 'metricCards',
      id: 'layout.0.metrics',
      query: { source: 'spans' },
      metrics: ['total_duration'],
    };

    const container = renderCards(createDataProvider(resolve), node);

    await waitFor(() => {
      expect(container.querySelector('.dg-error-state')).not.toBeNull();
    });

    // The mismatch is reported without asking the provider for anything.
    expect(resolve).not.toHaveBeenCalled();
    expect(container.textContent).toContain('metrics');
    expect(tiles(container)).toHaveLength(0);
  });

  it('keeps the caller class name on the root in every state', async () => {
    const withClass = (element: ReactElement): HTMLElement => render(element).container;

    const loading = withClass(
      <DataProviderContext.Provider
        value={createDataProvider(() => new Promise<DataQueryResponse>(() => undefined))}
      >
        <MetricCards node={metricNode(['total_duration'])} className="panel-slot" />
      </DataProviderContext.Provider>,
    );

    expect(loading.querySelector('.dg-metric-cards.panel-slot')).not.toBeNull();

    const settled = withClass(
      <DataProviderContext.Provider value={providerOf([TOTAL_DURATION])}>
        <MetricCards node={metricNode(['total_duration'])} className="panel-slot" />
      </DataProviderContext.Provider>,
    );

    await waitFor(() => {
      expect(settled.querySelector('.dg-metric-card')).not.toBeNull();
    });

    expect(settled.querySelector('ul.dg-metric-cards.panel-slot')).not.toBeNull();
  });
});
