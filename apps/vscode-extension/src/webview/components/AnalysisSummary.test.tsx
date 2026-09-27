/**
 * The contract of `components/AnalysisSummary` — the editor's mirror of the
 * generated DevTools panel head (AAP 0.7.3).
 *
 * The product guarantee this suite protects is AAP 0.8.4's: observed facts and
 * inferred causes are kept apart **structurally**, not merely in prose, and a
 * fallback view is never mistaken for a model-authored analysis. Pinned here:
 *
 *   - **Two separately labelled regions.** Every fact statement sits inside the
 *     "Observed" region and no hypothesis statement does; every hypothesis sits
 *     inside the "Likely cause" region with a confidence badge whose level is
 *     spelled in words. Every assertion is scoped to a region element, because
 *     a document-wide query would still pass if both lists were merged into one.
 *     An analysis that infers nothing keeps the "Likely cause" region, holding
 *     `SummaryHeader`'s muted no-cause sentence rather than vanishing.
 *   - **Evidence is cited, never actionable.** Each fact renders one chip per
 *     `EventRef` it cites, and those chips are inert: the editor holds no event
 *     store, so no chip is a button, takes focus or reaches any callback.
 *   - **Source navigation is untouched.** Activating a hypothesis's suggested
 *     location raises `onOpenSource` exactly once with the `SourceLocation` as
 *     the analysis carried it — no reshaping, no dropped field, no flattening.
 *   - **The fallback banner.** `fallback` renders AAP 0.5.5's notice outside
 *     both regions and before the head, never in any other state; without the
 *     flag no banner exists.
 *   - **No invented prose.** Beyond its generic title and, when flagged, the
 *     banner, the component adds no sentence of its own: an `AnalysisResult`
 *     has no headline.
 *   - **Long runs wrap between identifiers.** A whitespace-free run of twenty
 *     characters or more gains U+200B break opportunities after `,` `.` `)` and
 *     before `(` — never before closing punctuation — while prose is rendered
 *     exactly as written, the analysis is never mutated, and a copied
 *     selection loses the inserted characters again.
 *   - **The states and their precedence:** error > pending > empty > analysis.
 *     A failure is never shaped like an observed fact (AAP 0.5.5).
 *   - **Privacy.** Nothing is ever written to the console in any state (AAP
 *     0.5.2): findings are rendered, never logged.
 *
 * The fixture is built inline against the real `AnalysisResult` type with no
 * cast. Its text is neutral, synthetic vocabulary written for this suite; no
 * inspected project's component, route or file appears in it (AAP 0.5.4).
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SummaryHeaderProps } from '@debuggen/panel-renderer';
import type { AnalysisResult, SourceLocation } from '@debuggen/protocol';

import { AnalysisSummary } from './AnalysisSummary';
import type { AnalysisSummaryProps } from './AnalysisSummary';

afterEach(cleanup);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The accessible names `SummaryHeader` gives its two regions. */
const OBSERVED_REGION = 'Observed';
const LIKELY_CAUSE_REGION = 'Likely cause';

/** `SummaryHeader`'s sentence for an empty likely-cause register, which this view opts into. */
const NO_CAUSES_TEXT = 'No likely cause was identified.';

/** The component's own generic copy, which this suite pins. */
const DEFAULT_TITLE = 'Analysis';
const EMPTY_MESSAGE = 'No analysis yet. Capture an interaction to generate one.';
const LOADING_TEXT = 'Loading analysis…';
const ERROR_TITLE = 'Analysis unavailable';

/** AAP 0.5.5's developer-facing wording of the fallback banner, verbatim. */
const FALLBACK_SENTENCE =
  'Generated panel failed validation; showing a fallback view built from captured data.';

/** A synthetic failure message; it must never surface as an observed fact. */
const ERROR_TEXT = 'Synthetic failure: the analysis stage could not complete.';

/** A W3C-shaped trace id and span id that belong to no real capture. */
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

const FACT_ONE = 'The first sampled operation accounted for 640 ms of a 900 ms interaction.';
const FACT_TWO = 'Three identical sample requests were issued within 20 ms of each other.';
const CAUSE_ONE = 'The sampled loop may issue one query per item it visits.';
const CAUSE_TWO = 'A dependency value may be recreated on every render of the sample view.';

/**
 * The location the second hypothesis suggests. Every optional field is present
 * so a handler that dropped or reshaped any of them would fail the deep-equal.
 */
const SUGGESTED_LOCATION: SourceLocation = {
  file: 'src/features/alpha/alpha-worker.ts',
  line: 42,
  column: 7,
  symbol: 'runAlphaStep',
  endLine: 48,
  resolvedBy: 'code-graph',
  confidence: 0.75,
};

/** The evidence each fact cites, in order: one reference, then two. */
const FACT_ONE_EVIDENCE_IDS = ['evt-sample-001'];
const FACT_TWO_EVIDENCE_IDS = ['evt-sample-002', 'evt-sample-003'];

/**
 * A valid `AnalysisResult` with two facts and two hypotheses.
 *
 * The hypotheses are deliberately listed low-confidence first, so a component
 * that re-ranked them would change the order this suite asserts.
 *
 * @param overrides Fields to replace on the default fixture.
 * @returns A fresh analysis, never shared between tests.
 */
function makeAnalysis(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    id: 'analysis-sample-1',
    sessionId: 'session-sample-1',
    captureId: 'capture-sample-1',
    analysisVersion: 1,
    createdAt: 1_758_000_000_000,
    observed: [
      {
        statement: FACT_ONE,
        evidence: [
          {
            eventId: 'evt-sample-001',
            traceId: TRACE_ID,
            spanId: SPAN_ID,
            kind: 'db.query',
            label: 'sample query span',
          },
        ],
      },
      {
        statement: FACT_TWO,
        evidence: [{ eventId: 'evt-sample-002', kind: 'fetch' }, { eventId: 'evt-sample-003' }],
      },
    ],
    likelyCauses: [
      {
        statement: CAUSE_ONE,
        evidence: [{ eventId: 'evt-sample-001', label: 'sample query span' }],
        confidence: 'low',
      },
      {
        statement: CAUSE_TWO,
        evidence: [{ eventId: 'evt-sample-002', kind: 'fetch' }],
        confidence: 'high',
        suggestedLocation: SUGGESTED_LOCATION,
      },
    ],
    metrics: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** @returns The "Observed" region, which must exist exactly once. */
function observedRegion(): HTMLElement {
  return screen.getByRole('region', { name: OBSERVED_REGION });
}

/** @returns The "Likely cause" region, which must exist exactly once. */
function causesRegion(): HTMLElement {
  return screen.getByRole('region', { name: LIKELY_CAUSE_REGION });
}

/**
 * The list items of a region, one per finding.
 *
 * @param region The region element.
 * @returns Its finding items, in document order.
 */
function findingItems(region: HTMLElement): HTMLElement[] {
  return Array.from(region.querySelectorAll<HTMLElement>('li.dg-summary-header__fact'));
}

/**
 * The statement texts rendered inside a region, in document order.
 *
 * @param region The region element.
 * @returns The trimmed statement texts.
 */
function statementsIn(region: HTMLElement): string[] {
  return Array.from(
    region.querySelectorAll('.dg-summary-header__statement'),
    (element) => element.textContent?.trim() ?? '',
  );
}

/**
 * The finding item whose statement is `statement`.
 *
 * @param region The region to search.
 * @param statement The exact statement text.
 * @returns The single matching item.
 */
function itemFor(region: HTMLElement, statement: string): HTMLElement {
  const item = findingItems(region).find(
    (candidate) =>
      candidate.querySelector('.dg-summary-header__statement')?.textContent === statement,
  );
  if (item === undefined) {
    throw new Error(`expected a finding item for "${statement}"`);
  }
  return item;
}

/**
 * The evidence chips of one finding item.
 *
 * @param item A finding item.
 * @returns Its chips, in document order.
 */
function evidenceChips(item: HTMLElement): HTMLElement[] {
  return Array.from(item.querySelectorAll<HTMLElement>('[data-event-id]'));
}

/** @returns The fallback banner, or `null` when none is rendered. */
function fallbackBanner(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.dgv-analysis__fallback');
}

/**
 * Asserts that nothing shaped like an analysis head was rendered.
 */
function expectNoSummaryHead(): void {
  expect(screen.queryAllByRole('region')).toHaveLength(0);
  expect(screen.queryByRole('region', { name: OBSERVED_REGION })).toBeNull();
  expect(document.querySelector('.dg-summary-header')).toBeNull();
  expect(document.querySelectorAll('.dg-summary-header__statement')).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// The structural separation
// ---------------------------------------------------------------------------

describe('AnalysisSummary keeps observed facts and likely causes apart', () => {
  it('renders a labelled Observed region and a separately labelled Likely cause region', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} />);

    const observed = observedRegion();
    const causes = causesRegion();

    expect(observed).not.toBe(causes);
    expect(observed.contains(causes)).toBe(false);
    expect(causes.contains(observed)).toBe(false);
    expect(within(observed).getByRole('heading', { name: OBSERVED_REGION })).not.toBeNull();
    expect(within(causes).getByRole('heading', { name: LIKELY_CAUSE_REGION })).not.toBeNull();
  });

  it('places every fact, and no hypothesis, inside the Observed region, in the given order', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} />);

    const observed = observedRegion();
    const text = observed.textContent ?? '';

    expect(statementsIn(observed)).toEqual([FACT_ONE, FACT_TWO]);
    expect(text).not.toContain(CAUSE_ONE);
    expect(text).not.toContain(CAUSE_TWO);
    expect(observed.querySelectorAll('.dg-summary-header__confidence')).toHaveLength(0);
  });

  it('places every hypothesis, and no fact, inside the Likely cause region, unranked', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} />);

    const causes = causesRegion();
    const text = causes.textContent ?? '';

    expect(statementsIn(causes)).toEqual([CAUSE_ONE, CAUSE_TWO]);
    expect(text).not.toContain(FACT_ONE);
    expect(text).not.toContain(FACT_TWO);
  });

  it('renders one evidence chip per cited EventRef on every fact, each with visible text', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} />);

    const observed = observedRegion();
    const expected = [
      [FACT_ONE, FACT_ONE_EVIDENCE_IDS],
      [FACT_TWO, FACT_TWO_EVIDENCE_IDS],
    ] as const;

    for (const [statement, eventIds] of expected) {
      const chips = evidenceChips(itemFor(observed, statement));
      expect(chips.length).toBeGreaterThanOrEqual(1);
      expect(chips.map((chip) => chip.dataset['eventId'])).toEqual(eventIds);
      for (const chip of chips) {
        expect(chip.textContent?.trim()).not.toBe('');
      }
    }
  });

  it('gives each hypothesis a confidence badge that names its level in words', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} />);

    const causes = causesRegion();
    const expected = [
      [CAUSE_ONE, 'low'],
      [CAUSE_TWO, 'high'],
    ] as const;

    for (const [statement, level] of expected) {
      const badges = itemFor(causes, statement).querySelectorAll('.dg-summary-header__confidence');
      expect(badges).toHaveLength(1);
      expect(badges[0]?.textContent?.trim()).toBe(level);
    }
  });

  it('keeps the Likely cause region with its no-cause sentence when the analysis infers nothing', () => {
    render(<AnalysisSummary analysis={makeAnalysis({ likelyCauses: [] })} />);

    expect(statementsIn(observedRegion())).toEqual([FACT_ONE, FACT_TWO]);

    // The register answers rather than disappearing: its heading, then the
    // design system's muted sentence — never a finding, badge or citation.
    const causes = causesRegion();
    expect(within(causes).getByRole('heading', { name: LIKELY_CAUSE_REGION })).not.toBeNull();
    const sentence = within(causes).getByText(NO_CAUSES_TEXT);
    expect(sentence.classList.contains('dg-summary-header__none')).toBe(true);
    expect(findingItems(causes)).toHaveLength(0);
    expect(statementsIn(causes)).toEqual([]);
    expect(causes.querySelector('.dg-summary-header__confidence')).toBeNull();
    expect(causes.querySelector('[data-event-id]')).toBeNull();
    expect(observedRegion().contains(causes)).toBe(false);
  });

  it('hands the analysis arrays on as a SummaryHeader summary with no cast', () => {
    const analysis = makeAnalysis();
    // Compile-time half of the edge: protocol's `observed`/`likelyCauses` are the
    // panel summary's own `Fact[]`/`Hypothesis[]`, so this assignment needs no
    // cast. If the two ever drift apart, `pnpm typecheck` fails on this line.
    const summary: SummaryHeaderProps['summary'] = {
      observed: analysis.observed,
      likelyCauses: analysis.likelyCauses,
    };

    render(<AnalysisSummary analysis={analysis} />);

    expect(statementsIn(observedRegion())).toEqual(summary.observed.map((fact) => fact.statement));
    expect(statementsIn(causesRegion())).toEqual(
      summary.likelyCauses.map((hypothesis) => hypothesis.statement),
    );
  });
});

// ---------------------------------------------------------------------------
// Evidence chips are citations, not controls
// ---------------------------------------------------------------------------

describe('AnalysisSummary evidence chips', () => {
  it('accepts no event-selection callback at all', () => {
    // The editor holds no event store, so the component's props must not offer
    // a selection callback. Adding one makes this literal fail to type-check.
    type SelectionProps = Extract<
      keyof AnalysisSummaryProps,
      'onSelectEvent' | 'selectEvent' | 'selectedEventId'
    >;
    const selectionProps: [SelectionProps] extends [never] ? 'none' : 'present' = 'none';

    expect(selectionProps).toBe('none');
  });

  it('renders every chip as inert text: no button, no pressed state, no focus stop', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} onOpenSource={vi.fn()} onRetry={vi.fn()} />);

    const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-event-id]'));
    expect(chips.length).toBeGreaterThanOrEqual(
      FACT_ONE_EVIDENCE_IDS.length + FACT_TWO_EVIDENCE_IDS.length,
    );
    for (const chip of chips) {
      expect(chip.tagName).toBe('SPAN');
      expect(chip.closest('button, a, [role="button"], [role="link"]')).toBeNull();
      expect(chip.hasAttribute('aria-pressed')).toBe(false);
      expect(chip.hasAttribute('tabindex')).toBe(false);
    }

    expect(within(observedRegion()).queryAllByRole('button')).toHaveLength(0);
    // The one control in the whole head is the suggested location's source chip.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('calls none of the provided callbacks, and throws nothing, when a chip is clicked', async () => {
    const user = userEvent.setup();
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();
    const onRetry = vi.fn<() => void>();
    render(
      <AnalysisSummary analysis={makeAnalysis()} onOpenSource={onOpenSource} onRetry={onRetry} />,
    );

    for (const chip of Array.from(document.querySelectorAll<HTMLElement>('[data-event-id]'))) {
      await user.click(chip);
    }

    expect(onOpenSource).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(statementsIn(observedRegion())).toEqual([FACT_ONE, FACT_TWO]);
  });

  it('skips the chips in the tab order, landing first on the source control', async () => {
    const user = userEvent.setup();
    render(<AnalysisSummary analysis={makeAnalysis()} onOpenSource={vi.fn()} />);

    await user.tab();

    const focused = document.activeElement;
    expect(focused?.tagName).toBe('BUTTON');
    expect(focused?.closest('[data-event-id]')).toBeNull();
    expect(causesRegion().contains(focused)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source navigation
// ---------------------------------------------------------------------------

describe('AnalysisSummary source navigation', () => {
  it('raises onOpenSource once with the suggested SourceLocation exactly as carried', async () => {
    const user = userEvent.setup();
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();
    render(<AnalysisSummary analysis={makeAnalysis()} onOpenSource={onOpenSource} />);

    const item = itemFor(causesRegion(), CAUSE_TWO);
    await user.click(within(item).getByRole('button', { name: /alpha-worker\.ts:42/ }));

    expect(onOpenSource).toHaveBeenCalledTimes(1);
    expect(onOpenSource.mock.calls[0]).toHaveLength(1);
    expect(onOpenSource.mock.calls[0]?.[0]).toEqual(SUGGESTED_LOCATION);
  });

  it('is operable from the keyboard', async () => {
    const user = userEvent.setup();
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();
    render(<AnalysisSummary analysis={makeAnalysis()} onOpenSource={onOpenSource} />);

    // Focus moves through user-event (wrapped in `act`), never `element.focus()`:
    // the source chip's tooltip opens on focus, and that state update must land
    // inside `act` to keep React from reporting it.
    await user.tab();
    expect(document.activeElement).toBe(
      within(itemFor(causesRegion(), CAUSE_TWO)).getByRole('button'),
    );
    await user.keyboard('{Enter}');

    expect(onOpenSource.mock.calls).toEqual([[SUGGESTED_LOCATION]]);
  });

  it('attaches the location only to the hypothesis that suggested it', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} onOpenSource={vi.fn()} />);

    const causes = causesRegion();
    expect(itemFor(causes, CAUSE_ONE).querySelector('.dg-source-link')).toBeNull();
    expect(itemFor(causes, CAUSE_TWO).querySelector('.dg-source-link')).not.toBeNull();
    expect(observedRegion().querySelector('.dg-source-link')).toBeNull();
  });

  it('still shows where the analysis points, as static text, when onOpenSource is omitted', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} />);

    const item = itemFor(causesRegion(), CAUSE_TWO);
    const chip = item.querySelector('.dg-source-link');

    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('alpha-worker.ts:42');
    expect(within(item).queryByRole('button')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The fallback banner and the absence of invented prose
// ---------------------------------------------------------------------------

describe('AnalysisSummary fallback banner', () => {
  it('renders the explanatory banner before the head and outside both regions', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} fallback />);

    const banner = fallbackBanner();
    if (banner === null) {
      throw new Error('expected the fallback banner');
    }
    const text = banner.textContent?.trim() ?? '';
    expect(text).not.toBe('');
    expect(text).toContain(FALLBACK_SENTENCE);

    const observed = observedRegion();
    expect(observed.contains(banner)).toBe(false);
    expect(causesRegion().contains(banner)).toBe(false);
    expect(banner.closest('.dg-summary-header')).toBeNull();
    expect(observed.textContent).not.toContain(FALLBACK_SENTENCE);

    // The banner is the head's preceding sibling: above it, and part of neither.
    const head = document.querySelector('.dg-summary-header');
    expect(head).not.toBeNull();
    expect(banner.nextElementSibling).toBe(head);
  });

  it('keeps the facts intact and reports no failure beside a fallback banner', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} fallback />);

    expect(statementsIn(observedRegion())).toEqual([FACT_ONE, FACT_TWO]);
    expect(statementsIn(causesRegion())).toEqual([CAUSE_ONE, CAUSE_TWO]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['false', false],
    ['undefined', undefined],
  ] as const)('renders no banner when fallback is %s', (_label, fallback) => {
    render(<AnalysisSummary analysis={makeAnalysis()} fallback={fallback} />);

    expect(fallbackBanner()).toBeNull();
    expect(document.body.textContent).not.toContain(FALLBACK_SENTENCE);
    expect(statementsIn(observedRegion())).toEqual([FACT_ONE, FACT_TWO]);
  });

  it.each([
    ['an error', { analysis: makeAnalysis(), error: ERROR_TEXT }],
    ['pending', { analysis: makeAnalysis(), pending: true }],
    ['no analysis', { analysis: undefined }],
  ] as const)('never decorates %s with the banner', (_label, props) => {
    render(<AnalysisSummary {...props} fallback />);

    expect(fallbackBanner()).toBeNull();
    expectNoSummaryHead();
  });
});

describe('AnalysisSummary adds no prose of its own', () => {
  it('renders no headline and no sentence beyond the findings when the analysis has none', () => {
    const { container } = render(<AnalysisSummary analysis={makeAnalysis()} />);

    expect(container.querySelector('.dg-summary-header__headline')).toBeNull();
    expect(Array.from(container.querySelectorAll('p'), (p) => p.textContent?.trim())).toEqual([
      FACT_ONE,
      FACT_TWO,
      CAUSE_ONE,
      CAUSE_TWO,
    ]);
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      DEFAULT_TITLE,
      OBSERVED_REGION,
      LIKELY_CAUSE_REGION,
    ]);
  });

  it('adds only the banner sentence when the view is a fallback', () => {
    const { container } = render(<AnalysisSummary analysis={makeAnalysis()} fallback />);

    expect(Array.from(container.querySelectorAll('p'), (p) => p.textContent?.trim())).toEqual([
      FALLBACK_SENTENCE,
      FACT_ONE,
      FACT_TWO,
      CAUSE_ONE,
      CAUSE_TWO,
    ]);
  });

  it('titles the head with the caller title, falling back to the generic one when blank', () => {
    const { unmount } = render(
      <AnalysisSummary analysis={makeAnalysis()} title="Latest sample findings" />,
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Latest sample findings');
    expect(screen.getByRole('heading', { level: 4, name: OBSERVED_REGION })).not.toBeNull();
    unmount();

    render(<AnalysisSummary analysis={makeAnalysis()} title="   " />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(DEFAULT_TITLE);
  });
});

// ---------------------------------------------------------------------------
// The states and their precedence
// ---------------------------------------------------------------------------

describe('AnalysisSummary states', () => {
  it('renders an error as an alert, never as an observed fact, even over a stale analysis', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} error={ERROR_TEXT} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(ERROR_TEXT);
    expect(alert.textContent).toContain(ERROR_TITLE);
    expect(screen.getByText(ERROR_TEXT).closest('[role="alert"]')).toBe(alert);

    expectNoSummaryHead();
    expect(document.body.textContent).not.toContain(FACT_ONE);
    expect(document.body.textContent).not.toContain(CAUSE_ONE);
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('offers a retry action in the error state that calls onRetry exactly once', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    render(<AnalysisSummary error={ERROR_TEXT} onRetry={onRetry} />);

    await user.click(within(screen.getByRole('alert')).getByRole('button'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('treats a blank error as no error', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(statementsIn(observedRegion())).toEqual([FACT_ONE, FACT_TWO]);
  });

  it('renders the loading state while pending, even over an analysis', () => {
    render(<AnalysisSummary analysis={makeAnalysis()} pending />);

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    const status = statuses[0];
    expect(status?.getAttribute('aria-busy')).toBe('true');
    expect(status?.textContent).toContain(LOADING_TEXT);
    expectNoSummaryHead();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders its own generic empty message when there is no analysis', () => {
    render(<AnalysisSummary analysis={undefined} />);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe(EMPTY_MESSAGE);
    expect(status.hasAttribute('aria-busy')).toBe(false);
    expectNoSummaryHead();
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['without an analysis', undefined],
    ['over a stale analysis', makeAnalysis()],
  ] as const)('lets an error outrank pending %s: only the alert renders', (_label, analysis) => {
    render(<AnalysisSummary analysis={analysis} pending error={ERROR_TEXT} fallback />);

    expect(screen.getByRole('alert').textContent).toContain(ERROR_TEXT);
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelector('[aria-busy]')).toBeNull();
    expect(document.body.textContent).not.toContain(EMPTY_MESSAGE);
    expectNoSummaryHead();
  });

  it.each([
    ['the analysis', { analysis: makeAnalysis() }],
    ['the error state', { error: ERROR_TEXT }],
    ['the loading state', { pending: true }],
    ['the empty state', {}],
  ] as const)('keeps its root class and appends the caller class in %s', (_label, props) => {
    const { container } = render(<AnalysisSummary {...props} className="extra-layout" />);

    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.className).toBe('dgv-analysis extra-layout');
  });
});

// ---------------------------------------------------------------------------
// The analysis version
// ---------------------------------------------------------------------------

describe('AnalysisSummary analysis version', () => {
  it("states a follow-up analysis's version beside the unchanged title", () => {
    const { container } = render(
      <AnalysisSummary
        analysis={makeAnalysis({
          id: 'analysis-sample-2',
          analysisVersion: 2,
          supersedes: 'analysis-sample-1',
        })}
      />,
    );

    // The head's own indicator, drawn by `SummaryHeader` beside the title and
    // outside the heading, whose name stays the title.
    const heading = screen.getByRole('heading', { level: 3, name: DEFAULT_TITLE });
    expect(heading.textContent).toBe(DEFAULT_TITLE);
    const indicator = container.querySelector<HTMLElement>('.dg-summary-header__version');
    if (indicator === null) {
      throw new Error('the head rendered no version indicator');
    }
    expect(within(indicator).getByText('Version 2')).toBeDefined();
    expect(within(indicator).getByText('Updates version 1')).toBeDefined();
    expect(heading.contains(indicator)).toBe(false);

    // Still no prose of its own: the version is not a paragraph.
    expect(Array.from(container.querySelectorAll('p'), (p) => p.textContent?.trim())).toEqual([
      FACT_ONE,
      FACT_TWO,
      CAUSE_ONE,
      CAUSE_TWO,
    ]);
  });

  it('states no version for a first analysis', () => {
    const { container } = render(<AnalysisSummary analysis={makeAnalysis()} />);

    expect(container.querySelector('.dg-summary-header__version')).toBeNull();
    expect(screen.queryByText(/^Version \d/u)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Line breaks in long statements
// ---------------------------------------------------------------------------

/** U+200B ZERO WIDTH SPACE, the break opportunity the component inserts. */
const ZWSP = '\u200B';

/** A fact quoting a statement shape whose column list is one long run. */
const SQL_FACT =
  '12 sample queries shared one shape (INSERT INTO "sample"."sample_rows" ("id","alpha_value","beta_value")).';

/** {@link SQL_FACT} as displayed: breaks between identifiers, none before closing punctuation. */
const SQL_FACT_DISPLAYED = `12 sample queries shared one shape (INSERT INTO "sample".${ZWSP}"sample_rows" ("id",${ZWSP}"alpha_value",${ZWSP}"beta_value")).`;

/** A hypothesis naming a call chain, whose run breaks before `(` and after `.`. */
const CALL_CAUSE = 'The chain sampleLookup(alpha).then(beta) may run once per item.';

/** {@link CALL_CAUSE} as displayed. */
const CALL_CAUSE_DISPLAYED = `The chain sampleLookup${ZWSP}(alpha).${ZWSP}then${ZWSP}(beta) may run once per item.`;

/**
 * An analysis with one long-run fact and one long-run hypothesis beside the
 * default fixture's prose, frozen throughout so any mutation throws.
 *
 * @returns The frozen analysis.
 */
function makeLongRunAnalysis(): AnalysisResult {
  const base = makeAnalysis();
  const analysis: AnalysisResult = {
    ...base,
    observed: [
      { statement: SQL_FACT, evidence: [{ eventId: 'evt-sample-009' }] },
      ...base.observed,
    ],
    likelyCauses: [
      ...base.likelyCauses,
      {
        statement: CALL_CAUSE,
        evidence: [{ eventId: 'evt-sample-009' }],
        confidence: 'medium',
      },
    ],
  };
  return deepFreeze(analysis);
}

/**
 * Freezes a value and everything reachable from it.
 *
 * @param value The value to freeze.
 * @returns The same value, frozen.
 */
function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value)) {
      deepFreeze(member);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Selects the whole text of an element in the document's selection.
 *
 * @param element The element whose contents to select.
 */
function selectContents(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = document.getSelection();
  if (selection === null) {
    throw new Error('expected the document to expose a selection');
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('AnalysisSummary long statements', () => {
  it('inserts break opportunities only inside long unbroken runs, at identifier boundaries', () => {
    render(<AnalysisSummary analysis={makeLongRunAnalysis()} />);

    expect(statementsIn(observedRegion())).toEqual([SQL_FACT_DISPLAYED, FACT_ONE, FACT_TWO]);
    expect(statementsIn(causesRegion())).toEqual([CAUSE_ONE, CAUSE_TWO, CALL_CAUSE_DISPLAYED]);
  });

  it('changes nothing but the invisible characters, and never the analysis', () => {
    const analysis = makeLongRunAnalysis();
    render(<AnalysisSummary analysis={analysis} />);

    const shown = [...statementsIn(observedRegion()), ...statementsIn(causesRegion())];
    expect(shown.map((statement) => statement.replaceAll(ZWSP, ''))).toEqual([
      ...analysis.observed.map((fact) => fact.statement),
      ...analysis.likelyCauses.map((hypothesis) => hypothesis.statement),
    ]);
    expect(analysis.observed[0]?.statement).toBe(SQL_FACT);
    expect(analysis.likelyCauses[2]?.statement).toBe(CALL_CAUSE);
    // The long-run finding keeps its citations and its level.
    expect(
      evidenceChips(itemFor(observedRegion(), SQL_FACT_DISPLAYED)).map(
        (chip) => chip.dataset['eventId'],
      ),
    ).toEqual(['evt-sample-009']);
    expect(
      itemFor(causesRegion(), CALL_CAUSE_DISPLAYED).querySelector('.dg-summary-header__confidence')
        ?.textContent,
    ).toBe('medium');
  });

  it('copies a selected statement without the inserted characters', () => {
    const setData = vi.fn<(format: string, data: string) => void>();
    render(<AnalysisSummary analysis={makeLongRunAnalysis()} />);

    const statement = itemFor(observedRegion(), SQL_FACT_DISPLAYED).querySelector(
      '.dg-summary-header__statement',
    );
    if (statement === null) {
      throw new Error('expected the long-run statement element');
    }
    selectContents(statement);
    const notPrevented = fireEvent.copy(statement, { clipboardData: { setData } });

    expect(notPrevented).toBe(false);
    expect(setData.mock.calls).toEqual([['text/plain', SQL_FACT]]);
  });

  it('leaves a copy without inserted characters to the browser', () => {
    const setData = vi.fn<(format: string, data: string) => void>();
    render(<AnalysisSummary analysis={makeLongRunAnalysis()} />);

    const statement = itemFor(observedRegion(), FACT_ONE).querySelector(
      '.dg-summary-header__statement',
    );
    if (statement === null) {
      throw new Error('expected the prose statement element');
    }
    selectContents(statement);
    const notPrevented = fireEvent.copy(statement, { clipboardData: { setData } });

    expect(notPrevented).toBe(true);
    expect(setData).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe('AnalysisSummary privacy', () => {
  it('writes nothing to the console in any state or interaction', async () => {
    const silent = (): void => undefined;
    const spies = {
      log: vi.spyOn(console, 'log').mockImplementation(silent),
      info: vi.spyOn(console, 'info').mockImplementation(silent),
      warn: vi.spyOn(console, 'warn').mockImplementation(silent),
      error: vi.spyOn(console, 'error').mockImplementation(silent),
      debug: vi.spyOn(console, 'debug').mockImplementation(silent),
    };
    const user = userEvent.setup();

    const states: readonly AnalysisSummaryProps[] = [
      { analysis: makeAnalysis(), onOpenSource: vi.fn() },
      { analysis: makeAnalysis(), fallback: true },
      { analysis: makeAnalysis({ likelyCauses: [] }) },
      { analysis: makeAnalysis(), error: ERROR_TEXT, onRetry: vi.fn() },
      { analysis: makeAnalysis(), pending: true },
      { analysis: undefined },
      { analysis: undefined, pending: true, error: ERROR_TEXT, fallback: true },
    ];

    for (const props of states) {
      const { unmount } = render(<AnalysisSummary {...props} />);
      for (const button of screen.queryAllByRole('button')) {
        await user.click(button);
      }
      for (const chip of Array.from(document.querySelectorAll<HTMLElement>('[data-event-id]'))) {
        await user.click(chip);
      }
      unmount();
    }

    expect({
      log: spies.log.mock.calls.length,
      info: spies.info.mock.calls.length,
      warn: spies.warn.mock.calls.length,
      error: spies.error.mock.calls.length,
      debug: spies.debug.mock.calls.length,
    }).toEqual({ log: 0, info: 0, warn: 0, error: 0, debug: 0 });
  });
});
