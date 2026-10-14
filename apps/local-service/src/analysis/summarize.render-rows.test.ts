/**
 * Which render statistics reach the analysis input when there are more than
 * the render section's row budget (`selectRenderStats`).
 *
 * A count-ordered cut lets framework and library components — typically
 * minified names with many renders — take the rows the project's own
 * components need, and drops a context provider whose own row (its trigger,
 * its declaration) is what lets the analysis follow a cascade back to where a
 * value is built. Every name here is invented.
 */

import { describe, expect, it } from 'vitest';

import type { RenderStat, RenderTrigger } from '@debuggen/telemetry';

import { selectRenderOccurrences, selectRenderStats } from './summarize.js';

/** How one fixture statistic is described. */
interface StatSpec {
  readonly component: string;
  readonly renderCount: number;
  readonly declared?: boolean;
  readonly contexts?: readonly string[];
}

/** One upstream render statistic, with only the fields the selection reads made distinctive. */
function stat(spec: StatSpec): RenderStat {
  const contexts = spec.contexts ?? [];
  return {
    id: `component:${spec.component}`,
    component: spec.component,
    renderCount: spec.renderCount,
    totalDurationMs: spec.renderCount,
    averageDurationMs: 1,
    maxDurationMs: 1,
    firstStartTime: 1_700_000_000_000,
    lastStartTime: 1_700_000_001_000,
    triggers: { props: 0, state: 0, context: spec.renderCount, unchanged: 0, unknown: 0 },
    unchangedRenderCount: 0,
    unknownTriggerCount: 0,
    phaseCounts: { mount: 0, update: spec.renderCount },
    changedPropKeys: [],
    changedPropCounts: {},
    changedContexts: contexts,
    changedContextCounts: Object.fromEntries(contexts.map((name) => [name, spec.renderCount])),
    occurrences: [],
    occurrencesTruncated: false,
    declaredInProject: spec.declared ?? false,
  };
}

/** Upstream order: most renders first, as `aggregateRenders` returns them. */
function upstream(specs: readonly StatSpec[]): readonly RenderStat[] {
  return [...specs].sort((left, right) => right.renderCount - left.renderCount).map(stat);
}

/** The component names of a selection, in the order it returns them. */
function names(stats: readonly RenderStat[]): readonly string[] {
  return stats.map((entry) => entry.component);
}

describe('selectRenderStats', () => {
  it('returns every statistic unchanged when they all fit', () => {
    const stats = upstream([
      { component: 'xA', renderCount: 30 },
      { component: 'PanelView', renderCount: 20, declared: true },
    ]);

    expect(selectRenderStats(stats, 20)).toBe(stats);
  });

  it('keeps the project components ahead of busier undeclared ones, in upstream order', () => {
    const framework = Array.from({ length: 12 }, (_, index) => ({
      component: `f${String(index)}`,
      renderCount: 1_000 - index,
    }));
    const project = Array.from({ length: 6 }, (_, index) => ({
      component: `ProjectView${String(index)}`,
      renderCount: 100 - index,
      declared: true,
    }));
    const selected = selectRenderStats(upstream([...framework, ...project]), 8);

    expect(selected).toHaveLength(8);
    // Every declared row survives; the two undeclared rows that fill the
    // budget are the busiest ones, and upstream order is preserved.
    expect(names(selected)).toEqual([
      'f0',
      'f1',
      'ProjectView0',
      'ProjectView1',
      'ProjectView2',
      'ProjectView3',
      'ProjectView4',
      'ProjectView5',
    ]);
  });

  it('keeps the providers a kept row names, following providers of providers', () => {
    const consumers = Array.from({ length: 30 }, (_, index) => ({
      component: `ItemView${String(index)}`,
      renderCount: 5_000 - index,
      declared: true,
      contexts: index === 0 ? ['BasketSource'] : [],
    }));
    const stats = upstream([
      ...consumers,
      { component: 'BasketSource', renderCount: 40, declared: true, contexts: ['ClockSource'] },
      { component: 'ClockSource', renderCount: 40, declared: true },
      { component: 'UnnamedSource', renderCount: 39, declared: true },
    ]);
    const selected = names(selectRenderStats(stats, 20));

    expect(selected).toHaveLength(20);
    expect(selected).toContain('ItemView0');
    expect(selected).toContain('BasketSource');
    expect(selected).toContain('ClockSource');
    // A low-count row no kept row names gets no reserved place.
    expect(selected).not.toContain('UnnamedSource');
    // Upstream order still holds: the providers sit after every consumer.
    expect(selected.slice(-2)).toEqual(['BasketSource', 'ClockSource']);
  });

  it('bounds the provider reserve and spends an unused reserve on the next rows', () => {
    const stats = upstream(
      Array.from({ length: 12 }, (_, index) => ({
        component: `RowView${String(index)}`,
        renderCount: 200 - index,
        declared: true,
        contexts: [`SourceView${String(index)}`],
      })).concat(
        Array.from({ length: 12 }, (_, index) => ({
          component: `SourceView${String(index)}`,
          renderCount: 10 - index / 100,
          declared: true,
          contexts: [],
        })),
      ),
    );
    const selected = names(selectRenderStats(stats, 8));

    expect(selected).toHaveLength(8);
    // Six rows by rank, then the providers of the first two kept rows only.
    expect(selected.filter((name) => name.startsWith('RowView'))).toHaveLength(6);
    expect(selected.filter((name) => name.startsWith('SourceView'))).toEqual([
      'SourceView0',
      'SourceView1',
    ]);

    const noProviders = upstream(
      Array.from({ length: 12 }, (_, index) => ({
        component: `RowView${String(index)}`,
        renderCount: 200 - index,
        declared: true,
      })),
    );
    expect(names(selectRenderStats(noProviders, 8))).toEqual(
      Array.from({ length: 8 }, (_, index) => `RowView${String(index)}`),
    );
  });

  it('reads a statistic persisted without the newer fields as undeclared and naming nothing', () => {
    const legacy = (spec: StatSpec): RenderStat => {
      const stored: Partial<RenderStat> = { ...stat(spec) };
      delete stored.changedContexts;
      delete stored.changedContextCounts;
      delete stored.declaredInProject;
      return stored as RenderStat;
    };
    const stats = [
      legacy({ component: 'xB', renderCount: 90 }),
      legacy({ component: 'xC', renderCount: 80 }),
      stat({ component: 'OwnView', renderCount: 10, declared: true }),
    ];

    expect(names(selectRenderStats(stats, 2))).toEqual(['xB', 'OwnView']);
  });

  it('keeps nothing for a zero budget', () => {
    expect(selectRenderStats(upstream([{ component: 'xD', renderCount: 3 }]), 0)).toEqual([]);
  });
});

describe('selectRenderOccurrences', () => {
  /** A carried render with only the fields the selection reads. */
  const carried = (triggers: readonly RenderTrigger[]): { id: number; trigger: RenderTrigger }[] =>
    triggers.map((trigger, id) => ({ id, trigger }));
  const HISTOGRAM = { props: 500, unchanged: 300, unknown: 20, context: 10, state: 0 };

  it('keeps every occurrence, in order, while they fit', () => {
    const occurrences = carried(['props', 'unchanged', 'props']);

    expect(selectRenderOccurrences(occurrences, HISTOGRAM, 5)).toEqual(occurrences);
  });

  it('keeps the earliest render of each trigger, then the earliest others, in upstream order', () => {
    const occurrences = carried([
      'props',
      'props',
      'props',
      'props',
      'props',
      'unchanged',
      'unchanged',
      'unknown',
      'context',
    ]);

    expect(selectRenderOccurrences(occurrences, HISTOGRAM, 5).map(({ id }) => id)).toEqual([
      0, 1, 5, 7, 8,
    ]);
  });

  it('gives the scarce slots to the triggers the statistic counts most often', () => {
    const occurrences = carried(['context', 'unknown', 'unchanged', 'props']);

    expect(selectRenderOccurrences(occurrences, HISTOGRAM, 2).map(({ id }) => id)).toEqual([2, 3]);
  });

  it('breaks equal counts by first appearance and keeps nothing for a zero or invalid budget', () => {
    const occurrences = carried(['state', 'props', 'props']);
    const even = { props: 1, state: 1 };

    expect(selectRenderOccurrences(occurrences, even, 1).map(({ id }) => id)).toEqual([0]);
    expect(selectRenderOccurrences(occurrences, even, 0)).toEqual([]);
    expect(selectRenderOccurrences(occurrences, even, Number.NaN)).toEqual([]);
  });
});
