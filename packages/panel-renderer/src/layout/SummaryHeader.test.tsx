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
 * - By default the Likely cause region renders only when there is a cause to
 *   list; with `showEmptyCauses` it always renders, holding one muted
 *   sentence, "No likely cause was identified.", when there is none. Either
 *   way it is a sibling of the Observed region, never part of it.
 * - Each confidence level is graded by fill as well as by word, tone and
 *   glyph: low is an outline badge, medium a soft one, high a solid one.
 * - The outline holds either way: both region headings sit one level below
 *   the title, whatever level the title takes.
 * - A later generation of the document is stated beside the title — a
 *   "Version n" badge and an "Updates version n-1" sentence — outside the
 *   heading, whose name stays the title; a first version, a missing version
 *   and a malformed one state nothing.
 * - Selectable evidence chips are one tab stop per region (WCAG 2.4.1): a
 *   roving `tabIndex` over every chip of every statement in the region, moved
 *   with the arrow keys, Home and End, returning to the last-focused chip or to
 *   the selected event's chip, activated with Enter and Space, and described by
 *   a visually hidden keyboard hint. The title is a script focus target, never
 *   a tab stop, and inert citations stay out of the tab order altogether.
 * - Model-authored and captured text displays its logical order: a Unicode
 *   direction control in the title, the headline, a fact, a cause or an
 *   evidence caption is printed as its visible escape (`\u202E`), nothing on
 *   screen, in a `title` or in an `aria-label` carries the raw control, the
 *   escaped markup never becomes an element, and every citation still carries
 *   — and selects — its raw event id.
 *
 * The copy below is generic product vocabulary written for this suite; it
 * names nothing of an inspected project. Every direction control is written as
 * an escape, never as the character, so this suite carries none itself.
 */

import type { Fact, Hypothesis, PanelSummary } from '@debuggen/panel-schema';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { containsDirectionControl } from '../utils/format';
import { SummaryHeader } from './SummaryHeader';

/** The panel title every case renders. */
const TITLE = 'Where the interaction spent its time';

/** The region names the DevTools panel and the editor webview both rely on. */
const OBSERVED_NAME = 'Observed';
const LIKELY_CAUSE_NAME = 'Likely cause';

/** The sentence the observed region holds when the summary lists no facts. */
const NO_FACTS_TEXT = 'No facts were observed.';

/** The sentence the likely-cause region holds under `showEmptyCauses` with no cause. */
const NO_CAUSES_TEXT = 'No likely cause was identified.';

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
    expect(screen.queryByText(NO_CAUSES_TEXT)).toBeNull();
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

describe('SummaryHeader version indicator', () => {
  /** Any text the indicator could render, whatever the number in it. */
  const VERSION_TEXT = /version/iu;

  it('states a later generation beside the title, outside the heading', () => {
    render(
      <SummaryHeader
        title={TITLE}
        summary={summaryOf([FACT], [])}
        version={{ current: 2, supersedes: true }}
      />,
    );

    // The heading is still named by the document's title and nothing else.
    const heading = screen.getByRole('heading', { level: 2, name: TITLE });
    expect(heading.textContent).toBe(TITLE);

    // The badge names the generation, the sentence the one it updates, and
    // both sit in the title's row rather than inside the heading.
    const badge = screen.getByText('Version 2');
    const updates = screen.getByText('Updates version 1');
    expect(badge.classList.contains('dg-badge')).toBe(true);
    expect(heading.contains(badge)).toBe(false);
    expect(heading.contains(updates)).toBe(false);

    const row = heading.parentElement;
    expect(row?.classList.contains('dg-summary-header__title-row')).toBe(true);
    const indicator = row?.querySelector('.dg-summary-header__version');
    expect(indicator?.contains(badge)).toBe(true);
    expect(indicator?.contains(updates)).toBe(true);

    // Neither part is a control, and neither is prose a reader could take for
    // a fact: no button, no paragraph, nothing inside a region.
    expect(indicator?.querySelector('button, p, [tabindex]')).toBeNull();
    expect(observedRegion().contains(badge)).toBe(false);
  });

  it('names the predecessor as the previous generation for any later version', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([], [])} version={{ current: 7 }} />);

    expect(screen.getByText('Version 7')).toBeDefined();
    expect(screen.getByText('Updates version 6')).toBeDefined();
  });

  it('states the relation without inventing a number for a first version that supersedes', () => {
    render(
      <SummaryHeader
        title={TITLE}
        summary={summaryOf([], [])}
        version={{ current: 1, supersedes: true }}
      />,
    );

    expect(screen.getByText('Version 1')).toBeDefined();
    expect(screen.getByText('Updates an earlier version')).toBeDefined();
    expect(screen.queryByText(/version 0/iu)).toBeNull();
  });

  it.each([
    { what: 'no version', version: undefined },
    { what: 'a first version', version: { current: 1 } },
    { what: 'a first version that supersedes nothing', version: { current: 1, supersedes: false } },
    { what: 'a zero version', version: { current: 0, supersedes: true } },
    { what: 'a fractional version', version: { current: 2.5 } },
    { what: 'a non-numeric version', version: { current: Number.NaN, supersedes: true } },
  ])('states nothing for $what', ({ version }) => {
    const { container } = render(
      <SummaryHeader title={TITLE} summary={summaryOf([FACT], [])} version={version} />,
    );

    expect(screen.queryByText(VERSION_TEXT)).toBeNull();
    expect(container.querySelector('.dg-summary-header__version')).toBeNull();
    screen.getByRole('heading', { level: 2, name: TITLE });
  });
});

describe('SummaryHeader title id', () => {
  /** The id a host hands in so it can name a region of its own after the title. */
  const HOST_TITLE_ID = 'host-named-panel-title';

  it('gives the title heading the id a host supplies, so a region elsewhere can be named by it', () => {
    render(
      <>
        <div role="region" aria-labelledby={HOST_TITLE_ID} />
        <SummaryHeader title={TITLE} summary={summaryOf([FACT], [])} titleId={HOST_TITLE_ID} />
      </>,
    );

    const heading = screen.getByRole('heading', { level: 2, name: TITLE });
    expect(heading.id).toBe(HOST_TITLE_ID);
    expect(document.querySelectorAll(`[id="${HOST_TITLE_ID}"]`)).toHaveLength(1);

    // The host's region is announced by the visible title, and the head's own
    // regions keep their own names.
    screen.getByRole('region', { name: TITLE });
    expect(observedRegion().getAttribute('aria-labelledby')).not.toBe(HOST_TITLE_ID);
  });

  it.each([
    { what: 'no id', titleId: undefined },
    { what: 'a blank id', titleId: '   ' },
  ])('keeps a generated, non-empty title id for $what', ({ titleId }) => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([FACT], [])} titleId={titleId} />);

    const heading = screen.getByRole('heading', { level: 2, name: TITLE });
    expect(heading.id.trim()).not.toBe('');
    expect(heading.id).not.toBe(titleId);
  });
});

describe('SummaryHeader evidence chips in the tab order', () => {
  /** Two facts citing three events between them, in one observed region. */
  const FACTS: readonly Fact[] = [
    {
      statement: 'The first operation waited on the second.',
      evidence: [
        { eventId: 'evt-one', label: 'citation one' },
        { eventId: 'evt-two', label: 'citation two' },
      ],
    },
    {
      statement: 'The second operation ran alone.',
      evidence: [{ eventId: 'evt-three', label: 'citation three' }],
    },
  ];

  /** One cause citing two events, with a suggested location after its chips. */
  const CAUSES: readonly Hypothesis[] = [
    {
      statement: 'The operations are chained rather than concurrent.',
      evidence: [
        { eventId: 'evt-four', label: 'citation four' },
        { eventId: 'evt-five', label: 'citation five' },
      ],
      confidence: 'high',
      suggestedLocation: {
        file: 'src/example/chain.ts',
        line: 3,
        column: 1,
        resolvedBy: 'code-graph',
        confidence: 0.5,
      },
    },
  ];

  /** The chip citing `label`. */
  function chip(label: string): HTMLElement {
    return screen.getByRole('button', { name: label });
  }

  /** The chips of a region that are in the tab order. */
  function tabStopsIn(region: HTMLElement): HTMLElement[] {
    return Array.from(region.querySelectorAll<HTMLElement>('.dg-summary-header__chip')).filter(
      (element) => element.tabIndex === 0,
    );
  }

  /** Renders the head with selectable chips and returns its selection spy. */
  function renderSelectable(selectedEventId?: string) {
    const selectEvent = vi.fn<(eventId: string, coordinates?: object) => void>();
    const view = render(
      <SummaryHeader
        title={TITLE}
        summary={summaryOf(FACTS, CAUSES)}
        selectEvent={selectEvent}
        selectedEventId={selectedEventId}
        openSource={vi.fn()}
      />,
    );

    return { selectEvent, ...view };
  }

  it('makes each region one tab stop, however many chips it holds', async () => {
    renderSelectable();
    const observed = observedRegion();
    const causes = screen.getByRole('region', { name: LIKELY_CAUSE_NAME });

    // Every chip is still a control; one per region is in the tab order.
    expect(tabStopsIn(observed)).toEqual([chip('citation one')]);
    expect(tabStopsIn(causes)).toEqual([chip('citation four')]);
    for (const label of ['citation two', 'citation three', 'citation five']) {
      expect(chip(label).getAttribute('tabindex')).toBe('-1');
    }

    // Tab: the observed stop, the causes stop, then the suggested location —
    // the title is a script focus target and never a stop of its own.
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(chip('citation one'));
    await user.tab();
    expect(document.activeElement).toBe(chip('citation four'));
    await user.tab();
    expect(document.activeElement?.closest('.dg-summary-header__location')).not.toBeNull();

    const title = screen.getByRole('heading', { level: 2, name: TITLE });
    expect(title.getAttribute('tabindex')).toBe('-1');
  });

  it('moves between the chips of every statement in a region with the arrow keys, Home and End', async () => {
    renderSelectable();
    const user = userEvent.setup();

    await user.tab();
    expect(document.activeElement).toBe(chip('citation one'));

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chip('citation two'));

    // Across statements, within the region.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(chip('citation three'));

    // Stops at the end rather than leaving the region or wrapping.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chip('citation three'));

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(chip('citation one'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(chip('citation one'));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(chip('citation three'));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(chip('citation two'));

    // The focused chip is the region's stop, so the region stays one stop.
    expect(tabStopsIn(observedRegion())).toEqual([chip('citation two')]);

    // A modified arrow is the browser's, not the region's.
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(document.activeElement).toBe(chip('citation two'));
  });

  it('returns Tab to the chip the reader last focused in a region', async () => {
    renderSelectable();
    const user = userEvent.setup();

    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chip('citation two'));

    // Out to the next region, and back again with Shift+Tab.
    await user.tab();
    expect(document.activeElement).toBe(chip('citation four'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(chip('citation two'));
  });

  it("puts the region's stop on the selected event's chip while focus is elsewhere", () => {
    const { rerender, selectEvent } = renderSelectable('evt-three');

    expect(tabStopsIn(observedRegion())).toEqual([chip('citation three')]);
    // A region that does not cite the selected event keeps its own stop.
    const causes = screen.getByRole('region', { name: LIKELY_CAUSE_NAME });
    expect(tabStopsIn(causes)).toEqual([chip('citation four')]);

    rerender(
      <SummaryHeader
        title={TITLE}
        summary={summaryOf(FACTS, CAUSES)}
        selectEvent={selectEvent}
        selectedEventId="evt-five"
        openSource={vi.fn()}
      />,
    );
    expect(tabStopsIn(causes)).toEqual([chip('citation five')]);
    expect(tabStopsIn(observedRegion())).toEqual([chip('citation one')]);
  });

  it('keeps a focused chip the stop even when another chip cites the selected event', () => {
    renderSelectable('evt-one');
    act(() => {
      chip('citation three').focus();
    });

    expect(tabStopsIn(observedRegion())).toEqual([chip('citation three')]);
  });

  it('selects the cited event with Enter and with Space', async () => {
    const { selectEvent } = renderSelectable();
    const user = userEvent.setup();

    await user.tab();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(selectEvent).toHaveBeenLastCalledWith('evt-two', {});

    await user.keyboard('{ArrowRight} ');
    expect(selectEvent).toHaveBeenLastCalledWith('evt-three', {});
    expect(selectEvent).toHaveBeenCalledTimes(2);
  });

  it('describes every chip with a visually hidden keyboard hint', () => {
    renderSelectable();

    const describedBy = new Set(
      Array.from(document.querySelectorAll('.dg-summary-header__chip'), (element) =>
        element.getAttribute('aria-describedby'),
      ),
    );
    expect(describedBy.size).toBe(1);

    const [chipHintId] = [...describedBy];
    const hint =
      chipHintId === null || chipHintId === undefined ? null : document.getElementById(chipHintId);
    expect(hint?.textContent).toMatch(/arrow keys/iu);
    expect(hint?.classList.contains('dg-visually-hidden')).toBe(true);

    // Outside both regions, so it is never read as part of either register.
    expect(observedRegion().contains(hint ?? null)).toBe(false);
  });

  it('leaves inert citations out of the tab order and adds no hint', async () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf(FACTS, [])} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.querySelector('[aria-describedby]')).toBeNull();
    expect(screen.queryByText(/arrow keys/iu)).toBeNull();
    for (const label of ['citation one', 'citation two', 'citation three']) {
      expect(screen.getByText(label).hasAttribute('tabindex')).toBe(false);
    }

    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('SummaryHeader with showEmptyCauses', () => {
  it('renders the labelled likely-cause region with its muted sentence when there is no cause', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([FACT], [])} showEmptyCauses />);

    const causes = screen.getByRole('region', { name: LIKELY_CAUSE_NAME });
    const sentence = within(causes).getByText(NO_CAUSES_TEXT);

    // The register's answer, not an inference: muted, in the shared class, and
    // never a list item, a confidence badge or a citation.
    expect(sentence.classList.contains('dg-summary-header__none')).toBe(true);
    expect(sentence.tagName).toBe('P');
    expect(sentence.closest('li')).toBeNull();
    expect(within(causes).queryByRole('list')).toBeNull();
    expect(within(causes).queryAllByRole('listitem')).toHaveLength(0);
    expect(causes.querySelector('.dg-summary-header__confidence')).toBeNull();
    expect(causes.querySelector('[data-event-id]')).toBeNull();

    // Still a sibling of the observed region, which keeps its fact.
    const observed = observedRegion();
    expect(observed.contains(causes)).toBe(false);
    expect(within(observed).getByText(FACT.statement)).toBeDefined();
    expect(within(observed).queryByText(NO_CAUSES_TEXT)).toBeNull();
    screen.getByRole('heading', { level: 3, name: LIKELY_CAUSE_NAME });
  });

  it('states both empty registers apart when neither facts nor causes exist', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([], [])} showEmptyCauses />);

    const observed = observedRegion();
    const causes = screen.getByRole('region', { name: LIKELY_CAUSE_NAME });
    expect(within(observed).getByText(NO_FACTS_TEXT)).toBeDefined();
    expect(within(observed).queryByText(NO_CAUSES_TEXT)).toBeNull();
    expect(within(causes).getByText(NO_CAUSES_TEXT)).toBeDefined();
    expect(within(causes).queryByText(NO_FACTS_TEXT)).toBeNull();
  });

  it('lists the causes and says nothing about an absence when there is a cause', () => {
    render(<SummaryHeader title={TITLE} summary={summaryOf([], [CAUSE])} showEmptyCauses />);

    const causes = screen.getByRole('region', { name: LIKELY_CAUSE_NAME });
    expect(within(causes).getByText(CAUSE.statement)).toBeDefined();
    expect(screen.queryByText(NO_CAUSES_TEXT)).toBeNull();
    expect(causes.querySelector('.dg-summary-header__none')).toBeNull();
  });
});

describe('SummaryHeader confidence badges', () => {
  it.each([
    ['low', 'dg-badge--outline'],
    ['medium', 'dg-badge--soft'],
    ['high', 'dg-badge--solid'],
  ] as const)('grades a %s-confidence cause with the %s fill', (level, fillClass) => {
    const cause: Hypothesis = { ...CAUSE, confidence: level };
    render(<SummaryHeader title={TITLE} summary={summaryOf([], [cause])} />);

    const causes = screen.getByRole('region', { name: LIKELY_CAUSE_NAME });
    const badges = causes.querySelectorAll('.dg-summary-header__confidence');
    expect(badges).toHaveLength(1);
    const badge = badges[0];

    // The level word stays the badge's text; the fill is one visual signal
    // beside it, and exactly one fill class is applied.
    expect(badge?.textContent?.trim()).toBe(level);
    expect(badge?.classList.contains(fillClass)).toBe(true);
    const fills = ['dg-badge--outline', 'dg-badge--soft', 'dg-badge--solid'].filter((name) =>
      badge?.classList.contains(name),
    );
    expect(fills).toEqual([fillClass]);
  });

  it('gives the three levels three different fills side by side', () => {
    const levels = ['low', 'medium', 'high'] as const;
    render(
      <SummaryHeader
        title={TITLE}
        summary={summaryOf(
          [],
          levels.map((confidence, index) => ({
            ...CAUSE,
            statement: `${CAUSE.statement} (${String(index + 1)})`,
            confidence,
          })),
        )}
      />,
    );

    const badges = Array.from(document.querySelectorAll('.dg-summary-header__confidence'));
    const signatures = badges.map((badge) => badge.className);
    expect(badges.map((badge) => badge.textContent.trim())).toEqual([...levels]);
    expect(new Set(signatures).size).toBe(levels.length);
  });
});

describe('SummaryHeader with direction controls in untrusted text', () => {
  /** The QA report's payload: an override that draws an escaped script tag backwards. */
  const PAYLOAD = 'QA_BIDI \u202E</td><script>alert(7)</script>\u202C';

  /** The payload as it must display: both controls as the printable characters of their escape. */
  const REVEALED = 'QA_BIDI \\u202E</td><script>alert(7)</script>\\u202C';

  /** A cited event id carrying an override, which must reach every data path raw. */
  const RAW_EVENT_ID = 'evt-\u202Eobserved';

  /** The same id as a chip that falls back to it for a caption displays it. */
  const SHOWN_EVENT_ID = 'evt-\\u202Eobserved';

  /** The trace and span the observed citation records, raw like its id. */
  const RAW_TRACE_ID = 'trace-\u202Ecited';
  const RAW_SPAN_ID = 'span-\u202Ecited';

  /** The two attributes a reader hovers or hears, which must match the visible text. */
  const DISPLAY_ATTRIBUTES = ['title', 'aria-label'] as const;

  /** A fact whose statement and captions carry the payload, and one caption falling back to its id. */
  const HOSTILE_FACT: Fact = {
    statement: `Fact ${PAYLOAD}`,
    evidence: [
      {
        eventId: RAW_EVENT_ID,
        traceId: RAW_TRACE_ID,
        spanId: RAW_SPAN_ID,
        label: `chip ${PAYLOAD}`,
      },
      { eventId: RAW_EVENT_ID },
    ],
  };

  /** A cause whose statement and caption carry the payload. */
  const HOSTILE_CAUSE: Hypothesis = {
    statement: `Cause ${PAYLOAD}`,
    evidence: [{ eventId: 'evt-cause', label: `cause chip ${PAYLOAD}` }],
    confidence: 'high',
  };

  /** The summary every case renders: the payload in the headline, a fact and a cause. */
  function hostileSummary(): PanelSummary {
    return {
      headline: `Headline ${PAYLOAD}`,
      observed: [HOSTILE_FACT],
      likelyCauses: [HOSTILE_CAUSE],
    };
  }

  /**
   * Asserts the rendered head displays nothing a direction control could
   * reorder — no raw control in its text, a `title` or an `aria-label` — and
   * that the payload's escaped markup stayed text.
   *
   * @param root The element `render` mounted into.
   */
  function expectNothingReorders(root: HTMLElement): void {
    expect(containsDirectionControl(root.textContent)).toBe(false);
    for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
      for (const attribute of DISPLAY_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value !== null) {
          expect(containsDirectionControl(value)).toBe(false);
        }
      }
    }
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('td')).toBeNull();
  }

  it('prints every control in the title, headline, statements and inert citations as its escape', () => {
    const { container } = render(
      <SummaryHeader title={`Panel ${PAYLOAD}`} summary={hostileSummary()} />,
    );

    // The heading's name is the revealed title, so a screen reader hears the
    // logical order too, and the markers are the visible text.
    const heading = screen.getByRole('heading', { level: 2, name: `Panel ${REVEALED}` });
    expect(heading.textContent).toBe(`Panel ${REVEALED}`);
    expect(screen.getByText(`Headline ${REVEALED}`).tagName).toBe('P');

    const observed = observedRegion();
    const causes = screen.getByRole('region', { name: LIKELY_CAUSE_NAME });
    expect(within(observed).getByText(`Fact ${REVEALED}`)).toBeDefined();
    expect(within(causes).getByText(`Cause ${REVEALED}`)).toBeDefined();

    // Without a selection handler every citation is an inert badge: its
    // caption is revealed, the id it falls back to is revealed, and the
    // `data-event-id` it carries is the raw id — data, not display.
    const captions = Array.from(
      observed.querySelectorAll<HTMLElement>('.dg-summary-header__evidence [data-event-id]'),
    );
    expect(captions.map((caption) => caption.textContent.trim())).toEqual([
      `chip ${REVEALED}`,
      SHOWN_EVENT_ID,
    ]);
    for (const caption of captions) {
      expect(caption.classList.contains('dg-badge')).toBe(true);
      expect(caption.getAttribute('data-event-id')).toBe(RAW_EVENT_ID);
    }
    expect(within(causes).getByText(`cause chip ${REVEALED}`)).toBeDefined();
    expect(screen.queryAllByRole('button')).toHaveLength(0);

    expectNothingReorders(container);
  });

  it('reveals selectable chips and still selects, and marks, the raw cited event', async () => {
    const selectEvent = vi.fn<(eventId: string, coordinates?: object) => void>();
    const user = userEvent.setup();
    const { container } = render(
      <SummaryHeader
        title={`Panel ${PAYLOAD}`}
        summary={hostileSummary()}
        selectEvent={selectEvent}
        selectedEventId={RAW_EVENT_ID}
      />,
    );

    // Each chip is a button named by its revealed caption.
    const labelled = screen.getByRole('button', { name: `chip ${REVEALED}` });
    const fallback = screen.getByRole('button', { name: SHOWN_EVENT_ID });
    const cause = screen.getByRole('button', { name: `cause chip ${REVEALED}` });

    // The pressed state is decided on the raw id: both observed chips cite the
    // selected event, the cause's chip does not.
    expect(labelled.getAttribute('aria-pressed')).toBe('true');
    expect(fallback.getAttribute('aria-pressed')).toBe('true');
    expect(cause.getAttribute('aria-pressed')).toBe('false');
    expect(labelled.getAttribute('data-event-id')).toBe(RAW_EVENT_ID);

    expectNothingReorders(container);

    // Activation hands the host the raw id and the raw coordinates the
    // citation recorded, never the escaped form a reader sees.
    await user.click(labelled);
    expect(selectEvent).toHaveBeenLastCalledWith(RAW_EVENT_ID, {
      traceId: RAW_TRACE_ID,
      spanId: RAW_SPAN_ID,
    });

    await user.click(fallback);
    expect(selectEvent).toHaveBeenLastCalledWith(RAW_EVENT_ID, {});

    await user.click(cause);
    expect(selectEvent).toHaveBeenLastCalledWith('evt-cause', {});
    expect(selectEvent).toHaveBeenCalledTimes(3);
  });
});
