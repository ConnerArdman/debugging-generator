/**
 * The observed register of `layout/SummaryHeader` when the summary lists no
 * facts, and the outline it keeps either way.
 *
 * The head is the first thing a reader of a generated panel sees, and a
 * summary with neither facts nor causes is the shape a deterministic fallback
 * over an empty capture takes. The suite pins how that head presents:
 *
 * - The Observed region always renders. With no facts it holds one muted
 *   sentence, "No facts were observed.", where the list would be — never a
 *   list item, and never carrying a citation.
 * - The Likely cause region renders only when there is a cause to list, and
 *   is always a sibling of the Observed region, never part of it.
 * - The outline holds either way: both region headings sit one level below
 *   the title, whatever level the title takes.
 *
 * The copy below is generic product vocabulary written for this suite; it
 * names nothing of an inspected project.
 */

import type { Fact, Hypothesis, PanelSummary } from '@debuggen/panel-schema';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SummaryHeader } from './SummaryHeader';

/** The panel title every case renders. */
const TITLE = 'Where the interaction spent its time';

/** The region names the DevTools panel and the editor webview both rely on. */
const OBSERVED_NAME = 'Observed';
const LIKELY_CAUSE_NAME = 'Likely cause';

/** The sentence the observed region holds when the summary lists no facts. */
const NO_FACTS_TEXT = 'No facts were observed.';

/** One measured statement, with the citation the schema requires. */
const FACT: Fact = {
  statement: 'The slowest operation took most of the interaction.',
  evidence: [{ eventId: 'evt-observed', label: 'slowest span' }],
};

/** One ranked explanation, with its citation. */
const CAUSE: Hypothesis = {
  statement: 'A sequential call chain holds the interaction open.',
  evidence: [{ eventId: 'evt-cause', label: 'call chain' }],
  confidence: 'medium',
};

/**
 * A summary with the given registers and no headline.
 *
 * @param observed The observed facts.
 * @param likelyCauses The likely causes.
 */
function summaryOf(observed: readonly Fact[], likelyCauses: readonly Hypothesis[]): PanelSummary {
  return { observed: [...observed], likelyCauses: [...likelyCauses] };
}

/** The observed region, found by the name its heading gives it. */
function observedRegion(): HTMLElement {
  return screen.getByRole('region', { name: OBSERVED_NAME });
}

describe('SummaryHeader with no observed facts', () => {
  it('states that nothing was observed inside the labelled observed region', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([], [])} />);

    const region = observedRegion();
    const sentence = within(region).getByText(NO_FACTS_TEXT);

    // The register's answer, in the register's place and in its own muted
    // class — never a list item, and never carrying a citation.
    expect(sentence.classList.contains('dg-summary-header__none')).toBe(true);
    expect(sentence.tagName).toBe('P');
    expect(sentence.closest('li')).toBeNull();
    expect(within(region).queryByRole('list')).toBeNull();
    expect(within(region).queryAllByRole('button')).toHaveLength(0);

    // The head is still more than a title: its heading, then the region.
    screen.getByRole('heading', { level: 2, name: TITLE });
    screen.getByRole('heading', { level: 3, name: OBSERVED_NAME });
  });

  it('still omits the likely-cause region when there is no cause to list', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([], [])} />);

    // An absent inference is not a finding, so no heading introduces nothing.
    expect(screen.queryByRole('region', { name: LIKELY_CAUSE_NAME })).toBeNull();
    expect(screen.queryByRole('heading', { name: LIKELY_CAUSE_NAME })).toBeNull();
  });

  it('keeps the two registers apart when causes arrive without facts', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([], [CAUSE])} />);

    const observed = observedRegion();
    const causes = screen.getByRole('region', { name: LIKELY_CAUSE_NAME });

    // The empty observed register says so, and the inference stays in its
    // own sibling region rather than being read as what was observed.
    expect(within(observed).getByText(NO_FACTS_TEXT)).toBeDefined();
    expect(within(observed).queryByText(CAUSE.statement)).toBeNull();
    expect(within(causes).getByText(CAUSE.statement)).toBeDefined();
    expect(within(causes).queryByText(NO_FACTS_TEXT)).toBeNull();
    expect(observed.contains(causes)).toBe(false);
  });

  it('places both region headings one level below the title at any title level', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([], [CAUSE])} headingLevel={4} />);

    screen.getByRole('heading', { level: 4, name: TITLE });
    screen.getByRole('heading', { level: 5, name: OBSERVED_NAME });
    screen.getByRole('heading', { level: 5, name: LIKELY_CAUSE_NAME });
  });
});

describe('SummaryHeader with observed facts', () => {
  it('lists the facts and says nothing about an absence', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([FACT], [])} />);

    const region = observedRegion();

    // The fact is an item of the register's own list (its citations are a
    // nested list of their own, which is why the list is read by its class).
    const item = within(region).getByText(FACT.statement).closest('li');
    expect(item?.parentElement?.classList.contains('dg-summary-header__facts')).toBe(true);
    expect(screen.queryByText(NO_FACTS_TEXT)).toBeNull();
    expect(region.querySelector('.dg-summary-header__none')).toBeNull();
  });
});
